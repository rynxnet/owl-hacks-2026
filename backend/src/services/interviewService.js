export function createInterviewService({ nextTurn, speak, addUtterance }) {
  async function runTurn(session, answer) {
    if (session.ended || session.lastAction === 'end') {
      return { say: '', action: 'end', state: session.engine.state, audio: null };
    }

    if (answer) addUtterance(session, 'candidate', answer);

    let state = session.engine.state === 'baseline' ? 'calm' : session.engine.state;
    if (state === 'overloaded' && session.lastAction === 'breathe') state = 'elevated';

    const turn = await nextTurn({
      persona: session.persona,
      role: session.role,
      jobDetails: session.jobDetails,
      history: session.utterances,
      state,
      questionCount: session.questionCount,
      maxQuestions: session.maxQuestions,
    });

    if (session.ended) return { say: '', action: 'end', state, audio: null };
    if (turn.action === 'ask' || turn.action === 'escalate') session.questionCount += 1;
    session.lastAction = turn.action;

    addUtterance(session, 'interviewer', turn.say);
    const audio = await speak(turn.say, session.persona);
    return { say: turn.say, action: turn.action, source: turn.source, state, audio };
  }

  return { runTurn };
}