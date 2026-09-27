// Pure helpers for the Presage SmartSpectra Node SDK (@smartspectra/node-sdk 3.3.0). No SDK, config or
// Node-only imports, so both the backend worker (presageWorker.js) and the laptop bridge
// (presage-bridge/presage.js) use this file, and it is unit-tested in backend/test/presage-decode.test.mjs.
//
// What the SDK gives us (verified against the 3.3.0 package, see presage-bridge/README.md "SDK contract"):
//   sdk.on('metrics', (buf, timestampUs) => ...)   buf = protobuf bytes, decodeMetrics(buf) -> Metrics
//   Metrics.cardio.pulseRate   : MeasurementWithConfidence[]  { value, stable, confidence, timestamp }
//   Metrics.cardio.hrv         : Hrv[]                        { rmssd, meanNn, sdnn, baevsky, timestamp, confidence, stable }
//   Metrics.breathing.rate     : MeasurementWithConfidence[]
//   timestamp: int64 microseconds "since Linux epoch" (protobufjs gives a Long object, not a number)
//   confidence: float percentage 0..100 (we report it as 0..1)
// The arrays are repeated fields (a series of samples), so one metrics message can hold several samples
// and we must not assume the newest one is the only new one, nor that a sample never repeats.

export const HR_MIN = 35;
export const HR_MAX = 220;
const BR_MAX_AGE_US = 30e6; // don't attach a breathing/HRV value older than 30 s to a pulse sample

// int64 fields arrive as protobufjs Long ({ low, high, unsigned, toNumber() }), or as number/bigint/string.
export function toNumber(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return v.trim() === '' ? NaN : Number(v);
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

const round = (x, digits) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

// SDK confidence is a percentage (0..100). Report 0..1 so PRESAGE_MIN_CONFIDENCE / MIN_CONFIDENCE (0..1) apply.
export function normalizeConfidence(c) {
  const n = toNumber(c);
  if (!Number.isFinite(n)) return null;
  return round(Math.min(1, Math.max(0, n / 100)), 3);
}

// SDK sample time (µs on the SDK timeline) -> epoch ms. With an anchor { sdkUs, epochMs } the SDK timeline is
// shifted so that sdkUs lands on epochMs; without one the SDK time is taken as epoch µs (what the SDK documents).
export function sdkUsToEpochMs(us, anchor) {
  if (anchor && Number.isFinite(anchor.sdkUs) && Number.isFinite(anchor.epochMs)) {
    return anchor.epochMs + (us - anchor.sdkUs) / 1000;
  }
  return us / 1000;
}

// Anchor for a timeline we did not produce (laptop bridge, SDK-owned camera). The SDK's native camera
// sources already offset frames to epoch µs; if the first sample looks like epoch time (within a day of
// now), keep it as is. Otherwise pin the first sample to "now".
export function anchorForFirstSample(firstSampleUs, nowMs = Date.now()) {
  if (Number.isFinite(firstSampleUs) && Math.abs(firstSampleUs / 1000 - nowMs) < 864e5) return null;
  return { sdkUs: firstSampleUs, epochMs: nowMs };
}

// Next strictly increasing frame timestamp (µs) for sdk.sendFrame(), following the browser's capture clock
// (captureMs = epoch ms from performance.timeOrigin + performance.now()). Real gaps are kept so the SDK
// timeline stays in step with wall time; a repeated or backwards capture time advances by 1 ms instead
// (the SDK rejects non-increasing timestamps with kNonMonotonicTimestamp).
export function nextFrameTimestampUs(prev, captureMs, nowMs = Date.now()) {
  const cap = Number.isFinite(captureMs) && captureMs > 0 ? captureMs : nowMs;
  if (!prev) return { us: Math.round(cap * 1000), captureMs: cap };
  const delta = Math.round((cap - prev.captureMs) * 1000);
  return { us: prev.us + (delta > 0 ? delta : 1000), captureMs: cap };
}

// Newest sample in `list` with a usable value and timestamp <= us (falls back to the earliest one after).
function pickNearest(list, us, valueOf) {
  let before = null;
  let after = null;
  for (const s of list) {
    if (!(s.ts <= us)) {
      if (!after || s.ts < after.ts) after = s;
    } else if (!before || s.ts > before.ts) before = s;
  }
  const hit = before || after;
  if (!hit || Math.abs(us - hit.ts) > BR_MAX_AGE_US) return null;
  return valueOf(hit);
}

function collect(arr, valueKey, carried) {
  const out = carried ? [carried] : [];
  for (const s of Array.isArray(arr) ? arr : arr ? [arr] : []) {
    const value = toNumber(s?.[valueKey]);
    const ts = toNumber(s?.timestamp);
    if (Number.isFinite(value) && value > 0 && Number.isFinite(ts) && ts > 0) out.push({ value, ts });
  }
  return out;
}
const newest = (list) => list.reduce((a, b) => (!a || b.ts > a.ts ? b : a), null);

/**
 * Pull every pulse sample from one decoded Metrics message that is newer than state.lastSampleTs.
 *
 * @param {object} metrics  decodeMetrics(buf) output (or a plain object with the same shape)
 * @param {object} state    { lastSampleTs, lastBr, lastHrv } carried between calls (all optional)
 * @param {object} opts     { anchor, minConfidence (0..1), eventTsUs (the 'metrics' event timestamp) }
 * @returns {{ readings: object[], state: object }} readings: { hr, br, hrv, confidence, stable, ts }
 */
export function extractNewSamples(metrics, state = {}, opts = {}) {
  const { anchor = null, minConfidence = 0, eventTsUs } = opts;
  let lastSampleTs = Number.isFinite(state.lastSampleTs) ? state.lastSampleTs : -Infinity;

  const brs = collect(metrics?.breathing?.rate, 'value', state.lastBr);
  const hrvs = collect(metrics?.cardio?.hrv, 'rmssd', state.lastHrv);
  const next = { lastSampleTs, lastBr: newest(brs), lastHrv: newest(hrvs) };

  const raw = metrics?.cardio?.pulseRate;
  const pulses = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const samples = [];
  pulses.forEach((p, i) => {
    let ts = toNumber(p?.timestamp);
    // proto3 leaves an unset int64 at 0. If the SDK ever omits sample times, date only the newest sample
    // with the message's own timestamp rather than guessing times for the rest.
    if (!(Number.isFinite(ts) && ts > 0)) {
      const ev = toNumber(eventTsUs);
      if (i !== pulses.length - 1 || !(Number.isFinite(ev) && ev > 0)) return;
      ts = ev;
    }
    samples.push({ p, ts });
  });
  samples.sort((a, b) => a.ts - b.ts);

  const readings = [];
  for (const { p, ts } of samples) {
    if (ts <= lastSampleTs) continue; // already seen (overlapping history) or a duplicate timestamp
    lastSampleTs = ts; // seen, whether or not it passes the filters below
    const hr = toNumber(p.value);
    if (!Number.isFinite(hr) || hr < HR_MIN || hr > HR_MAX) continue;
    const confidence = normalizeConfidence(p.confidence);
    if (minConfidence > 0 && (confidence == null || confidence < minConfidence)) continue;
    const br = pickNearest(brs, ts, (s) => round(s.value, 1));
    const hrv = pickNearest(hrvs, ts, (s) => round(s.value, 1));
    readings.push({
      hr: round(hr, 1),
      br,
      hrv,
      confidence,
      stable: typeof p.stable === 'boolean' ? p.stable : null,
      ts: Math.round(sdkUsToEpochMs(ts, anchor)),
    });
  }
  next.lastSampleTs = lastSampleTs;
  return { readings, state: next };
}

// --- plain-English SDK status -------------------------------------------------
// Keys are ValidationCode names without the leading "k" (see SDK js/constants.js).
export const HINTS = {
  NoFaceFound: 'No face found. Look at the camera.',
  MultipleFacesFound: 'More than one face in view.',
  FaceNotCentered: 'Center your face in the camera.',
  FaceSizeOutOfRange: 'Move closer to or farther from the camera.',
  FaceTooClose: 'Move back a little.',
  FaceTooFar: 'Move closer to the camera.',
  FaceTooHigh: 'Move down a little.',
  FaceTooLow: 'Move up a little.',
  FaceNotForward: 'Face the camera directly.',
  TooDark: 'Too dark. Add light in front of you.',
  TooBright: 'Too bright. Avoid a window behind you.',
  ChestNotVisible: 'Move back so your shoulders are visible.',
  ExcessiveMotion: 'Hold still.',
  FrameRateTooLow: 'Video is choppy. Check your connection.',
  CameraTuning: 'Adjusting camera...',
};

export const nameOf = (enumObj, code) =>
  (Object.entries(enumObj || {}).find(([, v]) => v === code)?.[0] || `code ${code}`).replace(/^k/, '');

// SmartSpectraErrorCode values (SDK js/constants.js). Auth/config/credit problems won't fix themselves.
export const FATAL_ERROR_CODES = new Set([2, 3, 4]);
export const ERROR_TEXT = {
  2: 'Presage API key rejected.',
  3: 'Presage configuration failed.',
  4: 'Presage credits used up.',
  5: 'Presage cannot reach its server.',
  6: 'Presage server error.',
  7: 'Camera unavailable. Close apps using it and restart.',
  10: 'Presage rejected a frame timestamp.',
  11: 'Video paused too long. Hold still while it catches up.',
};
