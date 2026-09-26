import { config } from './config.js';

// Turns a stream of heart-rate samples into calm / elevated / overloaded.
//
// 1. Baseline: average heart rate over the first BASELINE_MS of the session.
// 2. Every sample: average of the last WINDOW_MS compared with baseline.
// 3. A new state must hold for HOLD_MS before it becomes official,
//    so the interviewer doesn't flip back and forth on noise.
export class StressEngine {
  constructor() {
    this.startedAt = null;
    this.samples = []; // { ts, hr }
    this.baseline = null;
    this.state = 'baseline';
    this.candidate = null;
    this.candidateSince = null;
  }

  add(ts, hr) {
    if (!Number.isFinite(hr) || hr <= 0) return this.snapshot();
    if (this.startedAt === null) this.startedAt = ts;
    this.samples.push({ ts, hr });
    // keep ~2 minutes of samples in memory for the rolling window
    const cutoff = ts - 120000;
    while (this.samples.length && this.samples[0].ts < cutoff) this.samples.shift();

    if (this.baseline === null) {
      if (ts - this.startedAt >= config.baselineMs) {
        this.baseline = avg(this.samples.map((s) => s.hr));
        this.state = 'calm';
      }
      return this.snapshot();
    }

    const recent = this.samples.filter((s) => s.hr && s.ts >= ts - config.windowMs);
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
      baselineProgress: this.baseline
        ? 1
        : this.startedAt === null
          ? 0
          : Math.min(1, (this.samples.at(-1).ts - this.startedAt) / config.baselineMs),
    };
  }
}

function classify(hr, baseline) {
  const rise = (hr - baseline) / baseline;
  if (rise >= config.overloadPct) return 'overloaded';
  if (rise >= config.elevatedPct) return 'elevated';
  return 'calm';
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x) => Math.round(x * 10) / 10;
