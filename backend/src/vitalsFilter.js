// Cleans heart-rate readings before they reach the stress engine. One instance per session.
//
// Webcam pulse is noisy: one bad frame can read 40 bpm high, Presage can resend readings it
// already sent, and the face can drop out for a few seconds. The interviewer should react to
// the candidate, not to the camera. Every reading goes through these checks, in order:
//
//   1. range       hr must be a finite number between FILTER_MIN_BPM and FILTER_MAX_BPM.
//   2. confidence  if the source reports confidence (0-1) it must be >= PRESAGE_MIN_CONFIDENCE.
//                  With FILTER_REQUIRE_STABLE=1, a reading flagged stable:false is dropped too.
//   3. duplicate   ts must be newer than every reading already seen (Presage can resend history).
//                  A reading without ts gets the arrival time.
//   4. jump        a reading more than FILTER_JUMP_BPM away from the median of the recent
//                  accepted readings is held back. If FILTER_JUMP_CONFIRM readings in a row agree
//                  on the new level it is real (a genuine spike) and is accepted; a lone glitch
//                  never is. After more than FILTER_JUMP_WINDOW_MS without an accepted reading
//                  there is nothing recent to compare against, so the next reading starts fresh.
//   5. smoothing   hrSmooth = median of the last FILTER_SMOOTH_N accepted values. The stress
//                  engine gets hrSmooth; the raw value is kept for the chart and replay.
//
// isStale(now) is true once no reading has been accepted for FILTER_STALE_MS (wall clock).
//
// Env vars (all optional; also listed in backend/.env.example):
//   FILTER_MIN_BPM=35            lowest plausible heart rate
//   FILTER_MAX_BPM=220           highest plausible heart rate
//   PRESAGE_MIN_CONFIDENCE=0     drop readings whose confidence is below this (0 = keep all)
//   FILTER_REQUIRE_STABLE=0      1 = drop readings the source flags as stable:false
//   FILTER_JUMP_BPM=25           max distance from the recent median before a reading is suspect
//   FILTER_JUMP_CONFIRM=3        consecutive agreeing readings that prove a jump is real
//   FILTER_JUMP_WINDOW_MS=5000   how far back "recent" reaches for the jump check
//   FILTER_HISTORY_N=5           how many recent accepted readings form the jump reference median
//   FILTER_SMOOTH_N=3            readings in the smoothing median (1 = no smoothing)
//   FILTER_STALE_MS=5000         no accepted reading for this long = pulse lost
//
// Readings are { hr, br?, hrv?, confidence?, stable?, ts? }. Only hr is required.

export const PULSE_LOST_HINT = 'Lost your pulse reading. Look at the camera.';

const env = (name, fallback) => {
  const n = Number(process.env[name]);
  return process.env[name] != null && process.env[name] !== '' && Number.isFinite(n) ? n : fallback;
};

// Read at construction time (not import time) so .env is always loaded and tests can override.
function defaults() {
  return {
    minBpm: env('FILTER_MIN_BPM', 35),
    maxBpm: env('FILTER_MAX_BPM', 220),
    minConfidence: env('PRESAGE_MIN_CONFIDENCE', 0),
    requireStable: env('FILTER_REQUIRE_STABLE', 0) === 1,
    jumpBpm: env('FILTER_JUMP_BPM', 25),
    jumpConfirm: Math.max(1, env('FILTER_JUMP_CONFIRM', 3)),
    jumpWindowMs: env('FILTER_JUMP_WINDOW_MS', 5000),
    historyN: Math.max(1, env('FILTER_HISTORY_N', 5)),
    smoothN: Math.max(1, env('FILTER_SMOOTH_N', 3)),
    staleMs: env('FILTER_STALE_MS', 5000),
  };
}

export class VitalsFilter {
  constructor(opts = {}) {
    this.opts = { ...defaults(), ...opts };
    this.lastSeenTs = null; // newest ts of any reading that passed range/confidence (dedupe)
    this.lastAcceptedAt = null; // wall-clock time of the last accepted reading (staleness)
    this.history = []; // recent accepted { ts, hr } for the jump reference
    this.pending = []; // consecutive held-back { ts, hr } that might be a real new level
    this.smoothBuf = []; // last smoothN accepted hr values
    this.stats = { accepted: 0, range: 0, confidence: 0, unstable: 0, duplicate: 0, jump: 0 };
  }

  // Returns { ok: true, ts, hr, hrSmooth, br, hrv, confidence, stable } for an accepted reading,
  // or { ok: false, reason } where reason is 'range' | 'confidence' | 'unstable' | 'duplicate' | 'jump'.
  push(reading, now = Date.now()) {
    const o = this.opts;
    const hr = Number(reading?.hr);
    if (!Number.isFinite(hr) || hr < o.minBpm || hr > o.maxBpm) return this.#reject('range');

    const confidence = num(reading.confidence);
    if (confidence != null && confidence < o.minConfidence) return this.#reject('confidence');
    const stable = typeof reading.stable === 'boolean' ? reading.stable : null;
    if (o.requireStable && stable === false) return this.#reject('unstable');

    let ts = num(reading.ts);
    if (ts == null || ts <= 0) {
      // No timestamp from the source: use arrival time, nudged so two readings in the same ms both count.
      ts = this.lastSeenTs != null ? Math.max(now, this.lastSeenTs + 1) : now;
    }
    if (this.lastSeenTs != null && ts <= this.lastSeenTs) return this.#reject('duplicate');
    this.lastSeenTs = ts;

    // Jump check against the median of recent accepted readings.
    this.history = this.history.filter((h) => ts - h.ts <= o.jumpWindowMs);
    if (this.history.length) {
      const ref = median(this.history.map((h) => h.hr));
      if (Math.abs(hr - ref) > o.jumpBpm) {
        // Hold it back. Keep a run of consecutive held-back readings that agree with each other.
        const run = this.pending.filter((p) => ts - p.ts <= o.jumpWindowMs);
        const agrees = run.length && Math.abs(hr - median(run.map((p) => p.hr))) <= o.jumpBpm;
        this.pending = agrees ? [...run, { ts, hr }] : [{ ts, hr }];
        if (this.pending.length < o.jumpConfirm) return this.#reject('jump');
        // The new level persisted: it's real. Restart the reference and smoothing from it.
        this.history = this.pending.slice(-o.historyN);
        this.smoothBuf = this.pending.map((p) => p.hr).slice(-o.smoothN);
        this.pending = [];
        return this.#accept(reading, ts, hr, confidence, stable, now, true);
      }
    }
    this.pending = []; // an in-range reading ends any run of suspect ones: they were glitches
    return this.#accept(reading, ts, hr, confidence, stable, now, false);
  }

  // True when readings were flowing but none has been accepted for staleMs.
  isStale(now = Date.now()) {
    return this.lastAcceptedAt != null && now - this.lastAcceptedAt > this.opts.staleMs;
  }

  #accept(reading, ts, hr, confidence, stable, now, restarted) {
    if (!restarted) {
      this.history.push({ ts, hr });
      if (this.history.length > this.opts.historyN) this.history.shift();
      this.smoothBuf.push(hr);
      if (this.smoothBuf.length > this.opts.smoothN) this.smoothBuf.shift();
    }
    this.lastAcceptedAt = now;
    this.stats.accepted++;
    return {
      ok: true,
      ts,
      hr,
      hrSmooth: Math.round(median(this.smoothBuf) * 10) / 10,
      br: num(reading.br),
      hrv: num(reading.hrv),
      confidence,
      stable,
    };
  }

  #reject(reason) {
    this.stats[reason]++;
    return { ok: false, reason };
  }
}

function num(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
