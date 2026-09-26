const SPIKE_WINDOW_MS = 60000;

export function effectiveBaseline(session) {
  if (session.engine.baseline) {
    return { value: Math.round(session.engine.baseline * 10) / 10, estimated: false };
  }
  if (!session.vitals.length) return { value: null, estimated: false };

  const firstQuestion = session.utterances.find((utterance) => utterance.speaker === 'interviewer');
  let earlyVitals = firstQuestion ? session.vitals.filter((vital) => vital.ts < firstQuestion.ts) : [];
  if (earlyVitals.length < 3) earlyVitals = session.vitals.slice(0, 20);

  const average = earlyVitals.reduce((total, vital) => total + vital.hr, 0) / earlyVitals.length;
  return { value: Math.round(average * 10) / 10, estimated: true };
}

export function findSpikes(session) {
  const baseline = effectiveBaseline(session).value;
  if (!baseline || !session.vitals.length) return [];

  const interviewerLines = session.utterances.filter((utterance) => utterance.speaker === 'interviewer');
  return interviewerLines
    .map((utterance, index) => {
      if (utterance.action === 'breathe' || utterance.action === 'end') return null;

      const nextQuestion = interviewerLines.slice(index + 1).find((line) => line.action !== 'breathe');
      const until = nextQuestion
        ? nextQuestion.ts
        : Math.min(utterance.ts + SPIKE_WINDOW_MS, session.endedAt ?? Infinity);
      const window = session.vitals.filter((vital) => vital.ts >= utterance.ts && vital.ts < until);
      if (!window.length) return null;

      const peak = Math.max(...smooth(window.map((vital) => vital.hr)));
      return {
        ts: utterance.ts,
        question: utterance.text,
        peakHr: Math.round(peak),
        rise: Math.round(peak - baseline),
      };
    })
    .filter((spike) => spike && spike.rise > 0)
    .sort((a, b) => b.rise - a.rise)
    .slice(0, 3);
}

export function buildReplay(session) {
  const baseline = effectiveBaseline(session);
  return {
    id: session.id,
    role: session.role,
    persona: session.persona,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    baseline: baseline.value,
    baselineEstimated: baseline.estimated,
    vitals: session.vitals,
    utterances: session.utterances,
    spikes: findSpikes(session),
    feedback: session.feedback,
    feedbackError: session.feedback ? null : session.feedbackError || null,
    feedbackPending: Boolean(session.feedbackPending),
  };
}

function smooth(values) {
  if (values.length < 3) return values;
  return values.map((value, index) => {
    const neighbors = [values[index - 1] ?? value, value, values[index + 1] ?? value];
    return neighbors.sort((a, b) => a - b)[1];
  });
}