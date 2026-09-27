import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackService, normalizeFeedback } from '../src/services/feedbackService.js';
import { createInterviewService } from '../src/services/interviewService.js';
import { buildReplay } from '../src/services/replayService.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createVitalsService } from '../src/services/vitalsService.js';

test('session service owns creation, active lookup, and idempotent end', () => {
  const endedSensors = [];
  const sessions = createSessionService({
    personas: ['friendly', 'cold'],
    destroySensor: (session) => endedSensors.push(session.id),
  });

  const first = sessions.create({ persona: 'unknown', maxQuestions: 99 });
  assert.equal(first.persona, 'friendly');
  assert.equal(first.maxQuestions, 15);
  assert.equal(sessions.active(), first);

  const second = sessions.create({ persona: 'cold', maxQuestions: 0 });
  assert.equal(second.maxQuestions, 6);
  assert.equal(sessions.active(), second);
  assert.equal(sessions.end(second, 72.5), true);
  assert.equal(sessions.end(second, 72.5), false);
  assert.equal(sessions.active(), null);
  assert.equal(sessions.get(second.id), second);
  assert.deepEqual(endedSensors, [second.id]);
});

test('interview service owns turn state and delegates AI, transcript, and speech', async () => {
  let requestedTurn;
  const session = {
    persona: 'friendly',
    role: 'Engineer',
    engine: { state: 'overloaded' },
    lastAction: 'breathe',
    questionCount: 0,
    maxQuestions: 2,
    utterances: [],
  };
  const service = createInterviewService({
    nextTurn: async (turn) => {
      requestedTurn = turn;
      return { say: 'What did you learn?', action: 'ask', source: 'test' };
    },
    speak: async () => 'audio-data',
    addUtterance: (target, speaker, text) => target.utterances.push({ speaker, text }),
  });

  const result = await service.runTurn(session, 'I learned to test.');
  assert.equal(requestedTurn.state, 'elevated');
  assert.deepEqual(session.utterances.map(({ speaker }) => speaker), ['candidate', 'interviewer']);
  assert.equal(session.questionCount, 1);
  assert.equal(session.lastAction, 'ask');
  assert.deepEqual(result, {
    say: 'What did you learn?',
    action: 'ask',
    source: 'test',
    state: 'elevated',
    audio: 'audio-data',
  });
});

test('vitals service rejects invalid readings and publishes accepted readings', () => {
  const published = [];
  const session = {
    id: 'session-1',
    ended: false,
    vitals: [],
    engine: {
      add: () => ({ state: 'calm', baseline: 72, rollingHr: 73, baselineProgress: 1 }),
    },
  };
  const service = createVitalsService({
    broadcast: (id, message) => published.push([id, message]),
  });

  assert.equal(service.ingest(session, { hr: -1 }), null);
  const vital = service.ingest(session, { ts: 100, hr: 73, br: 15 });
  assert.deepEqual(vital, { ts: 100, hr: 73, hrSmooth: 73, br: 15, hrv: null, confidence: null, state: 'calm' });
  assert.deepEqual(session.vitals, [vital]);
  assert.equal(published[0][1].type, 'vitals');
  assert.equal(published[0][1].baseline, 72);
});

test('replay service estimates baseline and attributes spikes to interview questions', () => {
  const session = {
    id: 'session-1',
    role: 'Engineer',
    persona: 'friendly',
    startedAt: 0,
    endedAt: 40,
    engine: { baseline: null },
    vitals: [
      { ts: 1, hr: 70 },
      { ts: 2, hr: 70 },
      { ts: 3, hr: 70 },
      { ts: 11, hr: 75 },
      { ts: 15, hr: 100 },
      { ts: 18, hr: 100 },
      { ts: 31, hr: 71 },
    ],
    utterances: [
      { ts: 10, speaker: 'interviewer', text: 'Question one?', action: 'ask' },
      { ts: 20, speaker: 'interviewer', text: 'Take a breath.', action: 'breathe' },
      { ts: 30, speaker: 'interviewer', text: 'Question two?', action: 'ask' },
    ],
    feedback: null,
    feedbackError: 'timeout',
    feedbackPending: null,
  };

  const replay = buildReplay(session);
  assert.equal(replay.baseline, 70);
  assert.equal(replay.baselineEstimated, true);
  assert.equal(replay.spikes[0].ts, 10);
  assert.equal(replay.spikes[0].rise, 30);
  assert.equal(replay.feedbackError, 'timeout');
  assert.equal(replay.feedbackPending, false);
});

test('feedback service normalizes responses and stores generated coaching', async () => {
  assert.deepEqual(normalizeFeedback({ summary: ' Clear summary ', strongerAnswer: ' Better answer ' }), {
    summary: 'Clear summary',
    strongerAnswer: 'Better answer',
  });
  assert.deepEqual(normalizeFeedback([{ summary: 'Array summary' }]), {
    summary: 'Array summary',
    strongerAnswer: null,
  });
  assert.deepEqual(normalizeFeedback('```json\n{"summary":"JSON summary"}\n```'), {
    summary: 'JSON summary',
    strongerAnswer: null,
  });
  assert.equal(normalizeFeedback({ error: true, summary: 'unavailable' }), null);

  const service = createFeedbackService({
    generateFeedback: async () => ({ summary: 'Coaching summary' }),
    findSpikes: () => [],
  });
  const session = { role: 'Engineer', utterances: [] };
  service.start(session);
  await service.wait(session);
  assert.deepEqual(session.feedback, { summary: 'Coaching summary', strongerAnswer: null });
  assert.equal(session.feedbackStarted, true);
  assert.equal(session.feedbackPending, null);
});