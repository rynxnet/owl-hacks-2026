const FEEDBACK_FALLBACK = 'Feedback unavailable right now.';

export function createFeedbackService({ generateFeedback, findSpikes, timeoutMs = 25000 }) {
  function start(session) {
    session.feedbackStarted = true;
    session.feedbackError = null;
    const attempt = (session.feedbackAttempt || 0) + 1;
    session.feedbackAttempt = attempt;
    session.feedbackPending = (async () => {
      try {
        const raw = await generateFeedback({
          role: session.role,
          history: session.utterances,
          spikes: findSpikes(session),
        });
        const result = normalizeFeedback(raw);
        if (attempt !== session.feedbackAttempt && session.feedback) return;
        if (result) {
          session.feedback = result;
          session.feedbackError = null;
        } else {
          session.feedbackError = 'unavailable';
        }
      } catch (error) {
        console.error('[feedback] failed:', error.message);
        if (attempt === session.feedbackAttempt && !session.feedback) session.feedbackError = 'unavailable';
      } finally {
        if (attempt === session.feedbackAttempt) session.feedbackPending = null;
      }
    })();
  }

  async function wait(session) {
    if (!session.feedbackPending) return;
    let timer;
    const timedOut = await Promise.race([
      session.feedbackPending.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut && !session.feedback) {
      session.feedbackError = 'timeout';
      console.error(`[feedback] no answer from Gemini after ${timeoutMs} ms`);
    }
  }

  return { start, wait };
}

export function normalizeFeedback(raw) {
  let result = raw;
  if (typeof result === 'string') {
    const match = result.match(/\{[\s\S]*\}/);
    try {
      result = match ? JSON.parse(match[0]) : { summary: result };
    } catch {
      result = { summary: result };
    }
  }
  if (Array.isArray(result)) result = result.find((item) => item && typeof item === 'object') || null;
  if (!result || typeof result !== 'object' || result.error) return null;

  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  if (!summary || summary === FEEDBACK_FALLBACK) return null;
  const strongerAnswer = typeof result.strongerAnswer === 'string' ? result.strongerAnswer.trim() : '';
  return { summary, strongerAnswer: strongerAnswer || null };
}