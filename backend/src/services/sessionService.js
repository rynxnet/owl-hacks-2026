import crypto from 'node:crypto';
import { StressEngine } from '../stress.js';
import { normalizeRole, normalizeJobDetails } from '../roles.js';

export function createSessionService({ personas, destroySensor = () => {} }) {
  const sessions = new Map();
  const validPersonas = new Set(personas);
  let activeSessionId = null;

  function create(options = {}) {
    const requestedPersona = options.persona || 'friendly';
    const session = {
      id: crypto.randomUUID(),
      persona: validPersonas.has(requestedPersona) ? requestedPersona : 'friendly',
      // Whatever the candidate typed in the Role box (and an optional job posting) drives the interviewer.
      role: normalizeRole(options.role),
      jobDetails: normalizeJobDetails(options.jobDetails),
      maxQuestions: Math.min(Math.max(Number(options.maxQuestions) || 6, 1), 15),
      startedAt: Date.now(),
      engine: new StressEngine(),
      vitals: [],
      utterances: [],
      questionCount: 0,
      ended: false,
      feedback: null,
    };
    sessions.set(session.id, session);
    activeSessionId = session.id;
    return session;
  }

  function end(session, baseline) {
    if (session.ended) return false;
    session.ended = true;
    session.endedAt = Date.now();
    if (activeSessionId === session.id) activeSessionId = null;
    destroySensor(session);
    session.presage = null;
    return true;
  }

  return {
    create,
    get: (id) => sessions.get(id) || null,
    active: () => sessions.get(activeSessionId) || null,
    end,
  };
}