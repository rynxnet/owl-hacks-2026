// Heart-rate pipeline unit tests: VitalsFilter + StressEngine on synthetic streams.
// Plain node, no server, no network:   cd backend && node test/bpm.test.mjs
import { register } from 'node:module';

// Thresholds first: config.js and stress.js read process.env when they are imported.
// (dotenv never overrides variables that are already set, so backend/.env can't interfere.)
Object.assign(process.env, {
  BASELINE_MS: '10000',
  WINDOW_MS: '5000',
  HOLD_MS: '3000',
  ELEVATED_PCT: '0.15',
  OVERLOAD_PCT: '0.30',
  BASELINE_MIN_SAMPLES: '8',
  BASELINE_MAX_GAP_MS: '5000',
  BASELINE_STEADY_N: '3',
  PRESAGE_MIN_CONFIDENCE: '0.5',
  FILTER_JUMP_BPM: '25',
  FILTER_JUMP_CONFIRM: '3',
  FILTER_JUMP_WINDOW_MS: '5000',
  FILTER_HISTORY_N: '5',
  FILTER_SMOOTH_N: '3',
  FILTER_STALE_MS: '5000',
});

// config.js imports 'dotenv/config'. If node_modules isn't installed, stand in an empty module
// so these pure-logic tests still run.
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(spec, ctx, next) {
      try { return await next(spec, ctx); }
      catch (err) { if (spec === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }; throw err; }
    }`),
);

const { VitalsFilter, median } = await import('../src/vitalsFilter.js');
const { StressEngine } = await import('../src/stress.js');
const { config } = await import('../src/config.js');

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}

const T0 = 1_780_000_000_000; // any epoch ms
const SEC = 1000;

// Same wiring as server.js ingestReading: filter first, engine gets the smoothed value.
function pipeline() {
  const filter = new VitalsFilter();
  const engine = new StressEngine();
  const log = []; // one entry per reading: { ts, sent, ok, reason, hr, hrSmooth, snap }
  const push = (reading) => {
    const r = filter.push(reading, reading.ts ?? Date.now());
    const entry = { ts: reading.ts, sent: reading.hr, ok: r.ok, reason: r.reason };
    if (r.ok) Object.assign(entry, { hr: r.hr, hrSmooth: r.hrSmooth, snap: engine.add(r.ts, r.hrSmooth) });
    log.push(entry);
    return entry;
  };
  const state = () => engine.state;
  return { filter, engine, log, push, state };
}

// Deterministic "noise": +-0.8 bpm
const jitter = (i) => Math.sin(i * 1.7) * 0.8;

// Feed 1 Hz readings from second `from` to `to` (exclusive), hr = f(second)
function feed(p, from, to, f) {
  for (let i = from; i < to; i++) p.push({ ts: T0 + i * SEC, hr: +f(i).toFixed(1) });
}

// ---------------------------------------------------------------------------
console.log('-- VitalsFilter');

{
  const f = new VitalsFilter();
  const bad = [30, 250, NaN, 'abc', null, undefined, -5, Infinity];
  const res = bad.map((hr, i) => f.push({ hr, ts: T0 + i }, T0 + i));
  check('out-of-range / non-numeric hr rejected', res.every((r) => !r.ok && r.reason === 'range'), JSON.stringify(res));
  check('35 and 220 are inside the range', f.push({ hr: 35, ts: T0 + 100 }).ok && new VitalsFilter().push({ hr: 220, ts: T0 }).ok);
}

{
  const f = new VitalsFilter();
  const ts = [1000, 2000, 2000, 1500, 3000, 3000, 4000].map((x) => T0 + x);
  const res = ts.map((t) => f.push({ hr: 72, ts: t }, t));
  check(
    'duplicate / out-of-order ts dropped',
    res.map((r) => (r.ok ? 'ok' : r.reason)).join() === 'ok,ok,duplicate,duplicate,ok,duplicate,ok',
    res.map((r) => (r.ok ? 'ok' : r.reason)).join(),
  );
  check('stats count the drops', f.stats.duplicate === 3 && f.stats.accepted === 4, JSON.stringify(f.stats));
}

{
  const f = new VitalsFilter(); // PRESAGE_MIN_CONFIDENCE=0.5 from env
  const low = f.push({ hr: 72, ts: T0 + 1, confidence: 0.3 });
  const high = f.push({ hr: 72, ts: T0 + 2, confidence: 0.8 });
  const none = f.push({ hr: 72, ts: T0 + 3 });
  check('low confidence dropped (PRESAGE_MIN_CONFIDENCE from env)', !low.ok && low.reason === 'confidence');
  check('good confidence kept and passed through', high.ok && high.confidence === 0.8);
  check('missing confidence is fine (simulator / relay)', none.ok && none.confidence === null && none.br === null);
  const again = f.push({ hr: 72, ts: T0 + 1, confidence: 0.9 });
  check('late reading with an older ts dropped even when confident', !again.ok && again.reason === 'duplicate');
}

{
  const loose = new VitalsFilter({ requireStable: false });
  const strict = new VitalsFilter({ requireStable: true });
  check('stable:false kept by default', loose.push({ hr: 72, ts: T0, stable: false }).ok);
  check('stable:false dropped with FILTER_REQUIRE_STABLE=1', strict.push({ hr: 72, ts: T0, stable: false }).reason === 'unstable');
}

{
  const f = new VitalsFilter();
  const now = 5_000_000;
  const a = f.push({ hr: 70 }, now);
  const b = f.push({ hr: 71 }, now); // same arrival ms
  check('missing ts uses arrival time, and same-ms readings both count', a.ok && b.ok && a.ts === now && b.ts === now + 1, `${a.ts} ${b.ts}`);
}

{
  const f = new VitalsFilter();
  const out = [70, 74, 72, 90, 71].map((hr, i) => f.push({ hr, ts: T0 + i * SEC }, T0 + i * SEC).hrSmooth);
  check('hrSmooth is the median of the last 3', out.join() === '70,72,72,74,72', out.join());
}

{
  const f = new VitalsFilter();
  const seq = [72, 73, 72, 115, 72, 73, 112, 113, 72]; // glitch, then two glitches in a row
  const res = seq.map((hr, i) => f.push({ hr, ts: T0 + i * SEC }, T0 + i * SEC));
  check('single +43 glitch rejected as jump', res[3].reason === 'jump');
  check('two consecutive glitches still rejected (confirm=3)', res[6].reason === 'jump' && res[7].reason === 'jump');
  check('normal readings around the glitches accepted', [0, 1, 2, 4, 5, 8].every((i) => res[i].ok));
}

{
  const f = new VitalsFilter();
  const seq = [72, 72, 73, 110, 111, 110, 112, 111];
  const res = seq.map((hr, i) => f.push({ hr, ts: T0 + i * SEC }, T0 + i * SEC));
  check('sustained step +38 accepted after 3 agreeing readings', !res[3].ok && !res[4].ok && res[5].ok && res[6].ok && res[7].ok,
    res.map((r) => (r.ok ? r.hr : r.reason)).join());
  check('smoothing restarts at the new level (no blend with old level)', res[5].hrSmooth === 110, String(res[5].hrSmooth));
}

{
  const f = new VitalsFilter();
  f.push({ hr: 72, ts: T0 }, T0);
  const after = f.push({ hr: 105, ts: T0 + 8 * SEC }, T0 + 8 * SEC); // after a dropout longer than the jump window
  check('after a dropout the next reading starts fresh (no stale reference)', after.ok);
}

{
  const f = new VitalsFilter();
  check('not stale before any reading', !f.isStale(T0 + 60 * SEC));
  f.push({ hr: 72, ts: T0 }, T0);
  check('not stale within FILTER_STALE_MS', !f.isStale(T0 + 4900));
  check('stale after FILTER_STALE_MS without an accepted reading', f.isStale(T0 + 5100));
  f.push({ hr: 20, ts: T0 + 5200 }, T0 + 5200); // rejected reading doesn't refresh
  check('rejected readings do not count as a pulse', f.isStale(T0 + 5300));
}

check('median helper', median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5 && Number.isNaN(median([])));

// ---------------------------------------------------------------------------
console.log('-- StressEngine (BASELINE_MS=10s, WINDOW_MS=5s, HOLD_MS=3s, +15% / +30%)');
check('config picked up test thresholds', config.baselineMs === 10000 && config.holdMs === 3000 && config.windowMs === 5000);

{
  const p = pipeline();
  feed(p, 0, 60, (i) => 72 + jitter(i));
  const snap = p.log.at(-1).snap;
  check('steady 72 bpm -> calm', p.state() === 'calm', p.state());
  check('baseline ~72', Math.abs(snap.baseline - 72) < 1, String(snap.baseline));
  check('snapshot keeps its public shape', ['state', 'baseline', 'rollingHr', 'baselineProgress'].every((k) => k in snap) && snap.baselineProgress === 1);
  check('never left calm on a steady stream', p.log.filter((e) => e.snap && e.snap.state !== 'calm' && e.snap.state !== 'baseline').length === 0);
}

// Warm up 20 s at 72, then ramp over `rampS` seconds to `target`, hold `holdS`
function rampTo(target, rampS = 8, holdS = 30) {
  const p = pipeline();
  feed(p, 0, 20, (i) => 72 + jitter(i));
  feed(p, 20, 20 + rampS, (i) => 72 + ((target - 72) * (i - 19)) / rampS + jitter(i));
  feed(p, 20 + rampS, 20 + rampS + holdS, (i) => target + jitter(i));
  return p;
}

{
  const p = rampTo(72 * 1.2);
  const base = p.log.find((e) => e.snap?.baseline)?.snap.baseline;
  const crossed = p.log.find((e) => e.snap?.rollingHr >= base * (1 + config.elevatedPct));
  const flipped = p.log.find((e) => e.snap?.state === 'elevated');
  check('+20% held -> elevated', p.state() === 'elevated', p.state());
  check('elevated only after HOLD_MS above the line', flipped && crossed && flipped.ts - crossed.ts >= config.holdMs,
    flipped && crossed ? `${flipped.ts - crossed.ts} ms` : 'never');
  check('+20% never reads as overloaded', !p.log.some((e) => e.snap?.state === 'overloaded'));
  check('ramp readings all accepted (real change is not a glitch)', p.log.every((e) => e.ok));
}

{
  const p = rampTo(72 * 1.35);
  check('+35% held -> overloaded', p.state() === 'overloaded', p.state());
}

{
  const p = pipeline();
  // Steady 72 with a +40 single-reading glitch every 7 s, and one double glitch.
  feed(p, 0, 90, (i) => (i % 7 === 3 || i === 47 || i === 48 ? 112 : 72 + jitter(i)));
  const glitches = p.log.filter((e) => e.sent > 100);
  check('single / double glitch spikes never accepted', glitches.length > 10 && glitches.every((e) => !e.ok && e.reason === 'jump'),
    `${glitches.filter((e) => e.ok).length} of ${glitches.length} accepted`);
  check('glitch spikes do NOT change state', p.state() === 'calm' && !p.log.some((e) => e.snap && !['calm', 'baseline'].includes(e.snap.state)));
  check('baseline not dragged by glitches', Math.abs(p.engine.baseline - 72) < 1, String(p.engine.baseline));
}

{
  const p = pipeline();
  feed(p, 0, 30, (i) => 72 + jitter(i));
  feed(p, 30, 60, (i) => 105 + jitter(i)); // abrupt, sustained +33 bpm (+46%)
  const firstAccepted = p.log.find((e) => e.ts >= T0 + 30 * SEC && e.ok);
  check('real sustained spike gets through the jump filter', firstAccepted && firstAccepted.ts <= T0 + 33 * SEC);
  check('real sustained spike DOES change state (overloaded)', p.state() === 'overloaded', p.state());
}

{
  // Empty rolling window must not read as "calm".
  const p = rampTo(72 * 1.2);
  const lastTs = p.log.at(-1).ts;
  const snap = p.engine.evaluate(lastTs + 60 * SEC); // nothing in the last WINDOW_MS
  check('empty window keeps the current state (no spurious calm)', snap.state === 'elevated' && snap.rollingHr === null, JSON.stringify(snap));
  // Signal comes back at resting level: must be seen for HOLD_MS before calm.
  const back = p.engine.add(lastTs + 61 * SEC, 72);
  check('after the gap, calm still needs HOLD_MS', back.state === 'elevated', back.state);
  let s;
  for (let i = 62; i <= 66; i++) s = p.engine.add(lastTs + i * SEC, 72);
  check('...and then does go calm', s.state === 'calm', s.state);
  const e2 = new StressEngine();
  const r = e2.add(T0, NaN);
  check('non-finite hr ignored, state untouched', r.state === 'baseline' && e2.samples.length === 0);
}

{
  // Readings every 4 s: regular (gap <= 5 s) but sparse. After BASELINE_MS only 3-4 samples exist.
  const e = new StressEngine();
  let snap;
  let lockedAt = null;
  for (let i = 0; i <= 40; i += 4) {
    snap = e.add(T0 + i * SEC, 72 + (i % 3));
    if (snap.baseline && lockedAt === null) lockedAt = i;
  }
  check('baseline waits for BASELINE_MIN_SAMPLES (not just BASELINE_MS)', lockedAt === 28, `locked at ${lockedAt}s`);
  const e3 = new StressEngine();
  let at12;
  for (let i = 0; i <= 12; i += 4) at12 = e3.add(T0 + i * SEC, 72);
  check('baseline progress reflects the missing samples', at12.baselineProgress < 1 && at12.baseline === null, JSON.stringify(at12));
}

{
  // Warm-up: the camera sends a reading now and then (gaps > 5 s), then settles to 1 Hz.
  const e = new StressEngine();
  const early = [0, 9, 18].map((s) => e.add(T0 + s * SEC, 95)); // junk while the face locks
  check('baseline clock does not start on irregular readings', early.every((x) => x.baselineProgress === 0), JSON.stringify(early.map((x) => x.baselineProgress)));
  let snap;
  let lockedAt = null;
  for (let s = 25; s <= 45; s++) {
    snap = e.add(T0 + s * SEC, 70 + (s % 2));
    if (snap.baseline && lockedAt === null) lockedAt = s;
  }
  check('baseline window starts when readings turn regular', lockedAt === 35, `locked at ${lockedAt}s`);
  check('warm-up junk excluded from baseline', snap.baseline <= 71, String(snap.baseline));
}

{
  // Median baseline: an outlier fed straight to the engine (bypassing the filter) can't drag it.
  const e = new StressEngine();
  for (let s = 0; s <= 12; s++) e.add(T0 + s * SEC, s === 5 ? 180 : 72);
  check('baseline is the median (robust to an outlier)', e.baseline === 72, String(e.baseline));
  const dup = e.add(T0 + 12 * SEC, 150);
  check('engine ignores a repeated timestamp', e.samples.at(-1).hr === 72 && dup.state === 'calm');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
