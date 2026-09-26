// End-to-end test of presage.js -> presageWorker.js (child process) with a STUB SmartSpectra SDK.
// Run from backend/:   node test/presage-worker.test.mjs
//
// The real @smartspectra/node-sdk needs native binaries, an API key and a face, so this copies the
// worker files into a temp dir next to stub modules (dotenv, jpeg-js, @smartspectra/node-sdk). The stub
// follows the 3.3.0 surface the worker relies on: on() keeps one listener per event; useCustomInput();
// start() is synchronous and throws an Error with .code (2 = key rejected); sendFrame(buf, w, h, stride,
// pixelFormat, timestampUs) needs strictly increasing µs; 'metrics' fires (buf, timestampUs);
// decodeMetrics() returns pulseRate arrays with Long timestamps; destroy() returns a Promise.
// Each stub metrics message repeats the last 3 samples (overlapping history), like a rolling window.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'presage-worker-test-'));
const SDK_LOG = path.join(TMP, 'sdk-frames.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

// --- temp layout -------------------------------------------------------------
const write = (rel, text) => {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
fs.mkdirSync(path.join(TMP, 'src'), { recursive: true });
for (const f of ['presage.js', 'presageWorker.js', 'presageSamples.js', 'config.js', 'checkPresage.js']) {
  fs.copyFileSync(path.join(SRC, f), path.join(TMP, 'src', f));
}
write('package.json', JSON.stringify({ type: 'module' }));
write('node_modules/dotenv/package.json', JSON.stringify({ name: 'dotenv', exports: { './config': './config.js' } }));
write('node_modules/dotenv/config.js', '');
write('node_modules/jpeg-js/package.json', JSON.stringify({ name: 'jpeg-js', main: 'index.js' }));
write(
  'node_modules/jpeg-js/index.js',
  `module.exports = { decode(buf, o) { if (buf[0] === 0x00) throw new Error('bad jpeg'); return { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) }; } };`,
);
write('node_modules/@smartspectra/node-sdk/package.json', JSON.stringify({ name: '@smartspectra/node-sdk', version: '3.3.0-stub', main: 'index.js' }));
write(
  'node_modules/@smartspectra/node-sdk/index.js',
  String.raw`'use strict';
const fs = require('fs');
const ProcessingStatus = { kUninitialized: 0, kIdle: 1, kStarting: 2, kRunning: 3, kStopping: 4, kError: 5 };
const ValidationCode = { kOk: 0, kNoFaceFound: 1 };
const PixelFormat = { kRGB: 0, kBGR: 1, kRGBA: 2, kBGRA: 3 };
const FrameTransform = { kNone: 0 };
const breathingMetrics = [0, 1, 2, 3, 4, 5, 6, 7];
const cardioMetrics = [15, 16, 17];
class Long { constructor(n) { this.low = n % 4294967296; this.high = Math.floor(n / 4294967296); this.unsigned = false; }
  toNumber() { return this.high * 4294967296 + this.low; } }
class SmartSpectraSDK {
  static get version() { return '3.3.0-stub'; }
  constructor(o = {}) { this._o = o; this._l = new Map(); this._src = null; this._run = false; this._last = -Infinity; this._ts = []; this._bad = 0; }
  on(e, cb) { this._l.set(e, cb); return this; }
  _emit(e, ...a) { const cb = this._l.get(e); if (!cb) return; try { cb(...a); } catch (err) { console.error('listener threw', err); } }
  useCustomInput(t = 0) { this._src = { kind: 'custom', t }; return this; }
  start() {
    if (!this._src) throw new Error('start(): no input source configured.');
    if (this._o.apiKey === 'bad') { const e = new Error('Authentication failed'); e.code = 2; e.retryable = false; throw e; }
    if (this._o.apiKey === 'reject') return Promise.reject(Object.assign(new Error('credits'), { code: 4 }));
    this._run = true;
    setImmediate(() => { this._emit('processingStatus', 2); this._emit('processingStatus', 3); this._emit('validationStatus', 1, 0, 'No face'); });
  }
  sendFrame(buf, w, h, stride, fmt, ts) {
    if (!this._run) throw new Error('sendFrame(): call useCustomInput() + start() first');
    if (typeof ts !== 'number' || !Number.isFinite(ts)) throw new TypeError('sendFrame: timestampUs must be a finite number or bigint (microseconds)');
    if (buf.length < stride * h || fmt !== PixelFormat.kRGBA || stride !== w * 4) { this._bad++; return false; }
    if (ts <= this._last) { this._bad++; setImmediate(() => this._emit('error', 10, 'non-monotonic timestamp', false)); return false; }
    this._last = ts; this._ts.push(ts);
    if (this._ts.length === 3) setImmediate(() => this._emit('validationStatus', 0, ts, ''));
    if (this._ts.length % 5 === 0) {
      const sampleTs = this._ts.filter((_, i) => (i + 1) % 5 === 0);
      const hist = sampleTs.slice(-3).map((t) => ({ value: 60 + sampleTs.indexOf(t), stable: true, confidence: 80, timestamp: t }));
      const payload = { cardio: { pulseRate: hist, hrv: [] }, breathing: { rate: [{ value: 14, stable: true, confidence: 70, timestamp: ts }] } };
      setImmediate(() => this._emit('metrics', Buffer.from(JSON.stringify(payload)), ts));
    }
    return true;
  }
  destroy() { this._run = false; if (process.env.STUB_SDK_LOG) fs.writeFileSync(process.env.STUB_SDK_LOG, JSON.stringify({ ts: this._ts, bad: this._bad })); return Promise.resolve(); }
}
function decodeMetrics(buf) {
  if (!buf.length) return { breathing: null, cardio: null };
  const m = JSON.parse(buf.toString());
  for (const arr of [m.cardio && m.cardio.pulseRate, m.breathing && m.breathing.rate]) for (const s of arr || []) s.timestamp = new Long(s.timestamp);
  return m;
}
const SmartSpectraErrorCode = { kOk: 0, kAuthenticationFailed: 2, kCreditExhausted: 4, kNonMonotonicTimestamp: 10 };
module.exports = { SmartSpectraSDK, ProcessingStatus, ValidationCode, SmartSpectraErrorCode, PixelFormat, FrameTransform, breathingMetrics, cardioMetrics, decodeMetrics };
`,
);

// Frame as the browser sends it: [float64 LE capture ms since epoch][JPEG bytes]
const frame = (captureMs) => {
  const b = Buffer.alloc(8 + 200, 0xff);
  b.writeDoubleLE(captureMs, 0);
  return b;
};

// --- 1. happy path ---------------------------------------------------------------
process.env.PRESAGE_API_KEY = 'good';
process.env.PRESAGE_MIN_CONFIDENCE = '0';
process.env.STUB_SDK_LOG = SDK_LOG;
const { createPresageSession } = await import(path.join(TMP, 'src', 'presage.js'));

const readings = [];
const statuses = [];
let s = createPresageSession({ onReading: (r) => readings.push(r), onStatus: (t) => statuses.push(t) });
check('worker starts and reports running', await waitFor(() => statuses.some((t) => /Reading your pulse/.test(t))), JSON.stringify(statuses));
check('validation hint mapped to plain English', statuses.includes('No face found. Look at the camera.'), JSON.stringify(statuses));

const SKEW_MS = -3_600_000; // browser clock one hour behind the server
const t0 = Date.now() + SKEW_MS;
const N = 60;
for (let i = 0; i < N; i++) {
  // a repeated and a backwards capture time in the middle, as a jittery browser clock might produce
  const cap = i === 30 ? t0 + 29 * 66.7 : i === 31 ? t0 + 20 * 66.7 : t0 + i * 66.7;
  s.sendFrame(frame(cap));
  await sleep(15);
}
check('readings arrive', await waitFor(() => readings.length >= 11), `got ${readings.length}`);
await sleep(200);
const receivedAt = Date.now();
await s.destroy();
await waitFor(() => fs.existsSync(SDK_LOG), 5000);

const log = fs.existsSync(SDK_LOG) ? JSON.parse(fs.readFileSync(SDK_LOG, 'utf8')) : { ts: [], bad: -1 };
check('every frame accepted by the SDK stub', log.ts.length === N && log.bad === 0, `accepted ${log.ts.length}, rejected ${log.bad}`);
check('frame timestamps strictly increasing µs integers', log.ts.every((v, i) => Number.isSafeInteger(v) && (i === 0 || v > log.ts[i - 1])));
check('frame timestamps follow capture clock (epoch µs)', Math.abs(log.ts[0] - Math.round(t0 * 1000)) < 2);

const expectedSamples = Math.floor(N / 5);
check(`each distinct sample emitted exactly once (${expectedSamples})`, readings.length === expectedSamples, `got ${readings.length}`);
check(
  'samples in order with no gaps or repeats',
  readings.every((r, i) => r.hr === 60 + i),
  readings.map((r) => r.hr).join(','),
);
const keys = ['hr', 'br', 'hrv', 'confidence', 'stable', 'ts'];
check('reading matches output contract', readings.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(keys)), JSON.stringify(readings[0]));
check('confidence normalised to 0..1, stable passed through', readings[0].confidence === 0.8 && readings[0].stable === true && readings[0].br === 14);
check('reading ts strictly increasing', readings.every((r, i) => i === 0 || r.ts > readings[i - 1].ts));
check(
  'reading ts on server clock despite 1 h browser skew',
  readings.every((r) => Math.abs(r.ts - receivedAt) < 15_000),
  `first ts ${readings[0]?.ts} vs now ${receivedAt}`,
);
const sampleSpacing = readings[1].ts - readings[0].ts;
check('reading ts spacing follows sample times (~5 frames = ~333 ms)', Math.abs(sampleSpacing - 5 * 66.7) < 2, String(sampleSpacing));

// --- 2. bad key: start() throws -> fatal, no restart loop ---------------------------------
async function fatalCase(key, expected) {
  process.env.PRESAGE_API_KEY = key;
  const st = [];
  const sess = createPresageSession({ onReading: () => {}, onStatus: (t) => st.push(t) });
  const got = await waitFor(() => st.includes(expected), 8000);
  await sleep(1500); // a restart would announce itself here
  check(`${key === 'bad' ? 'start() throws code 2' : 'start() returns a rejected Promise (code 4)'}: fatal "${expected}", no restart`, got && !st.some((t) => /restarted/.test(t)), JSON.stringify(st));
  await sess.destroy();
}
await fatalCase('bad', 'Presage API key rejected.');
await fatalCase('reject', 'Presage credits used up.');

// --- 3. checkPresage.js against the stub ------------------------------------------------
function runCheck(args, key) {
  const env = { ...process.env, PRESAGE_API_KEY: key };
  const r = spawnSync(process.execPath, ['src/checkPresage.js', ...args], { cwd: TMP, env, encoding: 'utf8', timeout: 40000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
let c = runCheck([], 'good');
check('check:presage prints SDK version and exports', c.code === 0 && /package 3\.3\.0-stub/.test(c.out) && /exports: .*SmartSpectraSDK/.test(c.out), c.out);
c = runCheck(['--live'], '');
check('check:presage --live without key: skipped with exit 1', c.code === 1 && /--live skipped/.test(c.out), c.out);
c = runCheck(['--live'], 'good');
check('check:presage --live: starts, frames accepted, passes', c.code === 0 && /start\(\) succeeded/.test(c.out) && /75 accepted, 0 rejected, 0 threw/.test(c.out), c.out);
c = runCheck(['--live'], 'bad');
check('check:presage --live bad key: start() threw code 2, exit 1', c.code === 1 && /start\(\) threw: .*code 2/.test(c.out), c.out);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
