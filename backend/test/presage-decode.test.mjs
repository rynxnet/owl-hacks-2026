// Unit tests for Presage sample extraction.  Run from backend/:   node test/presage-decode.test.mjs
//
// No dependencies. Fixtures mirror what @smartspectra/node-sdk 3.3.0's decodeMetrics() returns (protobufjs
// message from js/messages/generated.js): cardio.pulseRate / breathing.rate are arrays of
// MeasurementWithConfidence { value, stable, confidence (0..100), timestamp (int64 µs since epoch, as a
// protobufjs Long) }, cardio.hrv is an array of Hrv { rmssd, ..., timestamp }. Unset proto3 fields decode
// to their defaults (0 / false / Long 0), missing sub-messages to null.
import {
  extractNewSamples,
  nextFrameTimestampUs,
  anchorForFirstSample,
  normalizeConfidence,
  sdkUsToEpochMs,
  toNumber,
} from '../src/presageSamples.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Minimal stand-in for protobufjs' Long (what int64 fields decode to when the `long` package is present).
class Long {
  constructor(n) {
    const big = BigInt(n);
    this.low = Number(big & 0xffffffffn) | 0;
    this.high = Number((big >> 32n) & 0xffffffffn) | 0;
    this.unsigned = false;
  }
  toNumber() {
    return this.high * 4294967296 + (this.low >>> 0);
  }
  toString() {
    return String(this.toNumber());
  }
}
const L = (n) => new Long(n);

const T0 = 1_790_000_000_000_000; // epoch µs (2026-09)
const sec = (s) => T0 + Math.round(s * 1e6);
const pulse = (s, value, confidence = 80, stable = true) => ({ value, stable, confidence, timestamp: L(sec(s)) });
const breath = (s, value, confidence = 70) => ({ value, stable: true, confidence, timestamp: L(sec(s)) });
const hrvS = (s, rmssd) => ({ rmssd, meanNn: 800, sdnn: 50, baevsky: 100, timestamp: L(sec(s)), confidence: 60, stable: true });
const metrics = ({ pulses = [], breaths, hrvs = [] } = {}) => ({
  breathing: breaths === undefined ? null : { rate: breaths, upperTrace: [], lowerTrace: [], amplitude: [], apnea: [] },
  micromotion: null,
  eda: null,
  face: null,
  cardio: { pulseRate: pulses, arterialPressureTrace: [], hrv: hrvs },
});

// --- helpers -----------------------------------------------------------------
check('toNumber: Long', toNumber(L(T0)) === T0);
check('toNumber: bigint / string / number / null', toNumber(5n) === 5 && toNumber('7') === 7 && toNumber(3) === 3 && Number.isNaN(toNumber(null)));
check('normalizeConfidence: percent -> 0..1', normalizeConfidence(83.25) === 0.833 && normalizeConfidence(0) === 0 && normalizeConfidence(150) === 1);
check('normalizeConfidence: missing -> null', normalizeConfidence(undefined) === null && normalizeConfidence(NaN) === null);
check('sdkUsToEpochMs: no anchor = epoch µs', sdkUsToEpochMs(T0, null) === T0 / 1000);
check('sdkUsToEpochMs: anchor shifts timeline', sdkUsToEpochMs(2_500_000, { sdkUs: 500_000, epochMs: 1_000_000 }) === 1_002_000);

// --- first message -------------------------------------------------------------
let r = extractNewSamples(
  metrics({ pulses: [pulse(1, 72.04), pulse(2, 73.46), pulse(3, 74.95, 35, false)], breaths: [breath(1.5, 14.26)], hrvs: [hrvS(2.5, 41.27)] }),
  {},
);
check('first message: every sample emitted', r.readings.length === 3, JSON.stringify(r.readings));
check(
  'first message: exact output contract',
  eq(r.readings[0], { hr: 72, br: 14.3, hrv: 41.3, confidence: 0.8, stable: true, ts: sec(1) / 1000 }),
  JSON.stringify(r.readings[0]),
);
check('first message: hr rounded to 1 decimal', r.readings[1].hr === 73.5 && r.readings[2].hr === 75);
check('first message: br = newest breathing sample at/before pulse', r.readings[1].br === 14.3 && r.readings[2].br === 14.3);
check('first message: hrv = nearest sample (later one used when none earlier)', r.readings.every((x) => x.hrv === 41.3), JSON.stringify(r.readings));
check('first message: confidence and stable per sample', r.readings[2].confidence === 0.35 && r.readings[2].stable === false);
check('first message: ts is sample time in epoch ms, ascending', eq(r.readings.map((x) => x.ts), [sec(1), sec(2), sec(3)].map((u) => u / 1000)));
check('first message: state tracks last sample', r.state.lastSampleTs === sec(3));
let state = r.state;

// --- overlapping history ---------------------------------------------------------
r = extractNewSamples(metrics({ pulses: [pulse(2, 73.46), pulse(3, 74.95), pulse(4, 76), pulse(5, 77)], breaths: [] }), state);
check('overlapping history: only new samples, in order', eq(r.readings.map((x) => x.hr), [76, 77]), JSON.stringify(r.readings));
check('overlapping history: br carried from earlier message', r.readings[0].br === 14.3);
check('overlapping history: hrv carried from earlier message', r.readings[0].hrv === 41.3);
state = r.state;

r = extractNewSamples(metrics({ pulses: [pulse(4, 76), pulse(5, 77)] }), state);
check('identical repeat message: nothing re-sent', r.readings.length === 0 && r.state.lastSampleTs === state.lastSampleTs);

r = extractNewSamples(metrics({ pulses: [1, 2, 3, 4, 5, 6].map((s) => pulse(s, 70 + s)) }), state);
check('cumulative history: only the one new sample', eq(r.readings.map((x) => x.hr), [76]) && r.readings[0].ts === sec(6) / 1000);
state = r.state;

// --- bad values ------------------------------------------------------------------
r = extractNewSamples(
  metrics({ pulses: [pulse(7, 0), pulse(8, NaN), pulse(9, 30), pulse(10, 250), pulse(11, 81)], breaths: [breath(10, 0), breath(10.5, NaN)] }),
  state,
);
check('zero / NaN / out-of-range pulse skipped', eq(r.readings.map((x) => x.hr), [81]), JSON.stringify(r.readings));
check('skipped samples still advance lastSampleTs', r.state.lastSampleTs === sec(11));
check('zero / NaN breathing ignored (keeps last good br)', r.readings[0].br === 14.3);
state = r.state;

r = extractNewSamples(metrics({ pulses: [pulse(9, 80), pulse(10, 80)] }), state);
check('late samples older than lastSampleTs are not emitted', r.readings.length === 0);

// --- confidence filter ---------------------------------------------------------------
r = extractNewSamples(metrics({ pulses: [pulse(12, 70, 30), pulse(13, 71, 50), pulse(14, 72, 90)] }), state, { minConfidence: 0.5 });
check('minConfidence 0.5 drops confidence 30%, keeps 50% and 90%', eq(r.readings.map((x) => x.hr), [71, 72]), JSON.stringify(r.readings));
check('minConfidence 0 keeps low confidence', extractNewSamples(metrics({ pulses: [pulse(12, 70, 5)] }), state).readings.length === 1);
state = r.state;

// --- missing breathing / hrv ------------------------------------------------------------
r = extractNewSamples(metrics({ pulses: [pulse(1, 70), pulse(2, 71)] }), {});
check('no breathing message at all: br null', r.readings.every((x) => x.br === null && x.hrv === null));
r = extractNewSamples(metrics({ pulses: [pulse(100, 70)] }), { lastSampleTs: sec(99), lastBr: { value: 15, ts: sec(10) } });
check('breathing older than 30 s is not attached', r.readings[0].br === null);
r = extractNewSamples(metrics({ pulses: [pulse(1, 70)], breaths: [breath(1.2, 16)] }), {});
check('breathing only slightly after pulse is still used', r.readings[0].br === 16);

// --- message shapes ------------------------------------------------------------------
check('null cardio: no readings, state kept', extractNewSamples({ cardio: null, breathing: null }, { lastSampleTs: 5 }).state.lastSampleTs === 5);
check('empty object / null metrics: no crash', extractNewSamples({}, {}).readings.length === 0 && extractNewSamples(null, {}).readings.length === 0);
r = extractNewSamples(metrics({ pulses: [pulse(3, 73), pulse(1, 71), pulse(2, 72)] }), {});
check('unsorted history emitted in time order', eq(r.readings.map((x) => x.hr), [71, 72, 73]));
r = extractNewSamples(metrics({ pulses: [pulse(1, 71), pulse(1, 99)] }), {});
check('duplicate timestamp within a message emitted once', r.readings.length === 1 && r.readings[0].hr === 71);
r = extractNewSamples(
  { cardio: { pulseRate: [{ value: 70, confidence: 80, timestamp: BigInt(sec(1)) }, { value: 71, confidence: 80, timestamp: sec(2) }] } },
  {},
);
check('bigint / number timestamps accepted; missing stable -> null', r.readings.length === 2 && r.readings[0].stable === null);

// proto3 default: timestamp unset -> Long 0. Only the newest sample is dated, with the event timestamp.
const noTs = { cardio: { pulseRate: [{ value: 70, confidence: 80, stable: true, timestamp: L(0) }, { value: 72, confidence: 80, stable: true, timestamp: L(0) }] } };
r = extractNewSamples(noTs, {}, { eventTsUs: sec(20) });
check('missing sample timestamps: newest dated by event ts', r.readings.length === 1 && r.readings[0].hr === 72 && r.readings[0].ts === sec(20) / 1000);
check('missing sample timestamps and no event ts: nothing', extractNewSamples(noTs, {}).readings.length === 0);
check('missing timestamps: same event ts not re-sent', extractNewSamples(noTs, r.state, { eventTsUs: sec(20) }).readings.length === 0);

// --- anchoring a relative SDK timeline ---------------------------------------------------
const anchor = { sdkUs: 1_000_000, epochMs: 1_790_000_000_000 };
r = extractNewSamples({ cardio: { pulseRate: [{ value: 70, confidence: 90, stable: true, timestamp: L(3_500_000) }] } }, {}, { anchor });
check('anchor maps relative µs to epoch ms', r.readings[0].ts === 1_790_000_002_500, String(r.readings[0]?.ts));
check('anchorForFirstSample: epoch-like timeline kept as is', anchorForFirstSample(sec(0), T0 / 1000 + 5000) === null);
check('anchorForFirstSample: relative timeline pinned to now', eq(anchorForFirstSample(2_000_000, 1_790_000_000_000), { sdkUs: 2_000_000, epochMs: 1_790_000_000_000 }));

// --- frame timestamps for sendFrame -------------------------------------------------------
let c = nextFrameTimestampUs(null, 1_790_000_000_000.25);
check('first frame: capture ms -> epoch µs', c.us === 1_790_000_000_000_250);
const seq = [c.us];
for (const ms of [1_790_000_000_066.9, 1_790_000_000_066.9, 1_790_000_000_050, 1_790_000_000_133.5, 1_790_000_005_133.5]) {
  c = nextFrameTimestampUs(c, ms);
  seq.push(c.us);
}
check('frame timestamps strictly increasing (repeat and backwards capture)', seq.every((v, i) => i === 0 || v > seq[i - 1]), seq.join(','));
check('frame timestamps are integers', seq.every(Number.isSafeInteger));
check('real gap preserved (5 s)', seq[5] - seq[4] === 5_000_000, String(seq[5] - seq[4]));
check('bad capture time falls back to now', nextFrameTimestampUs(null, NaN, 1_790_000_000_000).us === 1_790_000_000_000_000);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
