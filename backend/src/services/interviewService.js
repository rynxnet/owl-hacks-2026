export function createInterviewService({ nextTurn, speak, addUtterance }) {
  // turnId: the client's id for this turn. If Gemini failed on it, the answer is already stored,
  // so "Try again" with the same turnId must not store it a second time.
  async function runTurn(session, answer, turnId = null) {
    if (session.ended || session.lastAction === 'end') {
      return { say: '', action: 'end', state: session.engine.state, audio: null };
    }

    const retryOfFailed = Boolean(turnId) && session.failedTurnId === turnId;
    if (answer && !retryOfFailed) addUtterance(session, 'candidate', answer);

    let state = session.engine.state === 'baseline' ? 'calm' : session.engine.state;
    if (state === 'overloaded' && session.lastAction === 'breathe') state = 'elevated';

    let turn;
    try {
      turn = await nextTurn({
        persona: session.persona,
        role: session.role,
        jobDetails: session.jobDetails,
        history: session.utterances,
        state,
        questionCount: session.questionCount,
        maxQuestions: session.maxQuestions,
      });
    } catch (err) {
      session.failedTurnId = turnId;
      throw err;
    }
    session.failedTurnId = null;

    if (session.ended) return { say: '', action: 'end', state, audio: null };
    if (turn.action === 'ask' || turn.action === 'escalate') session.questionCount += 1;
    session.lastAction = turn.action;

    addUtterance(session, 'interviewer', turn.say);
    const audio = await speak(turn.say, session.persona);
    return { say: turn.say, action: turn.action, source: turn.source, state, audio };
  }

  return { runTurn };
}