import { config } from './config.js';
import { median } from './vitalsFilter.js';

// Turns a stream of heart-rate samples into calm / elevated / overloaded.
// Samples should already be cleaned by VitalsFilter (vitalsFilter.js); this still ignores
// non-finite values and timestamps that don't move forward.
//
// 1. Baseline: the window only starts once readings arrive regularly (BASELINE_STEADY_N in a
//    row, each within BASELINE_MAX_GAP_MS of the last), so camera warm-up doesn't count.
//    It locks after BASELINE_MS of that AND at least BASELINE_MIN_SAMPLES readings, as the
//    MEDIAN of those readings (one bad reading can't drag it).
// 2. Every sample: average of the last WINDOW_MS compared with baseline:
//    under +ELEVATED_PCT calm, up to +OVERLOAD_PCT elevated, above that overloaded.
//    No samples in the window = no evidence, so the state stays where it is.
// 3. A new state must hold for HOLD_MS before it becomes official,
//    so the interviewer doesn't flip back and forth on noise.
//
// Extra env vars (the rest are in config.js):
//   BASELINE_MIN_SAMPLES=5      readings needed before the baseline can lock
//   BASELINE_MAX_GAP_MS=5000    readings further apart than this aren't "regular"
//   BASELINE_STEADY_N=2         regular readings in a row before the baseline window starts
const envNum = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);
const BASELINE_MIN_SAMPLES = envNum('BASELINE_MIN_SAMPLES', 5);
const BASELINE_MAX_GAP_MS = envNum('BASELINE_MAX_GAP_MS', 5000);
const BASELINE_STEADY_N = Math.max(1, envNum('BASELINE_STEADY_N', 2));

export class StressEngine {
  constructor() {
    this.startedAt = null; // when the baseline window started (readings became regular)
    this.samples = []; // { ts, hr }
    this.baseline = null;
    this.state = 'baseline';
    this.candidate = null;
    this.candidateSince = null;
    this.runStart = null; // first ts of the current run of regular readings
    this.runCount = 0;
  }

  add(ts, hr) {
    if (!Number.isFinite(ts) || !Number.isFinite(hr) || hr <= 0) return this.snapshot();
    const last = this.samples.at(-1);
    if (last && ts <= last.ts) return this.snapshot(); // duplicate or out of order
    this.samples.push({ ts, hr });
    // keep ~2 minutes of samples in memory for the rolling window
    const cutoff = ts - 120000;
    while (this.samples.length && this.samples[0].ts < cutoff) this.samples.shift();

    if (this.baseline === null) {
      if (last && ts - last.ts <= BASELINE_MAX_GAP_MS) this.runCount += 1;
      else {
        this.runStart = ts;
        this.runCount = 1;
      }
      if (this.startedAt === null && this.runCount >= BASELINE_STEADY_N) this.startedAt = this.runStart;
      if (this.startedAt !== null) {
        const window = this.#baselineSamples();
        if (ts - this.startedAt >= config.baselineMs && window.length >= BASELINE_MIN_SAMPLES) {
          this.baseline = median(window.map((s) => s.hr));
          this.state = 'calm';
        }
      }
      return this.snapshot();
    }
    return this.evaluate(ts);
  }

  // Re-check the state at time ts using the samples already in hand.
  evaluate(ts) {
    if (this.baseline === null) return this.snapshot();
    const recent = this.samples.filter((s) => s.ts >= ts - config.windowMs && s.ts <= ts);
    if (!recent.length) {
      // No readings in the window (signal lost): keep the current state, and drop any
      // half-held candidate so it has to be seen for a full HOLD_MS again.
      this.candidate = null;
      return this.snapshot();
    }
    const current = avg(recent.map((s) => s.hr));
    const next = classify(current, this.baseline);

    if (next === this.state) {
      this.candidate = null;
    } else if (next !== this.candidate) {
      this.candidate = next;
      this.candidateSince = ts;
    } else if (ts - this.candidateSince >= config.holdMs) {
      this.state = next;
      this.candidate = null;
    }
    return this.snapshot(current);
  }

  snapshot(current = null) {
    return {
      state: this.state,
      baseline: this.baseline ? round(this.baseline) : null,
      rollingHr: current ? round(current) : null,
      baselineProgress: this.baseline ? 1 : this.startedAt === null ? 0 : this.#baselineProgress(),
    };
  }

  #baselineSamples() {
    return this.samples.filter((s) => s.ts >= this.startedAt);
  }

  // Slower of time progress and sample-count progress, so the bar can't sit at 100% while waiting.
  #baselineProgress() {
    const lastTs = this.samples.at(-1)?.ts ?? this.startedAt;
    const byTime = config.baselineMs > 0 ? (lastTs - this.startedAt) / config.baselineMs : 1;
    const byCount = BASELINE_MIN_SAMPLES > 0 ? this.#baselineSamples().length / BASELINE_MIN_SAMPLES : 1;
    return Math.min(1, byTime, byCount);
  }
}

function classify(hr, baseline) {
  const rise = (hr - baseline) / baseline;
  if (rise >= config.overloadPct) return 'overloaded';
  if (rise >= config.elevatedPct) return 'elevated';
  return 'calm';
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x) => Math.round(x * 10) / 10;
