import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { StressEngine } from './stress.js';
import { VitalsFilter, PULSE_LOST_HINT } from './vitalsFilter.js';
import { nextTurn, feedback, PERSONAS } from './interviewer.js';
import { speak } from './voice.js';
import { normalizeRole, normalizeJobDetails, roleBrief } from './roles.js';
import { db, dbEnabled } from './db.js';
import { presageAvailable, presageLoadError, createPresageSession } from './presage.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// In-memory session store (Tiger Data gets a copy when DATABASE_URL is set)
// ---------------------------------------------------------------------------
const sessions = new Map();
let activeSessionId = null; // vitals without a sessionId go to the newest running session

function getSession(req, res) {
  const s = sessions.get(req.params.id);
  if (!s) res.status(404).json({ error: 'session not found' });
  return s;
}

function addUtterance(s, speaker, text) {
  const u = { ts: Date.now(), speaker, text, state: s.engine.state };
  if (speaker === 'interviewer' && s.lastAction) u.action = s.lastAction; // lets findSpikes skip breathing prompts
  s.utterances.push(u);
  db.addUtterance(s.id, u);
  broadcast(s.id, { type: 'utterance', ...u });
  return u;
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    gemini: Boolean(config.geminiKey),
    elevenlabs: Boolean(config.elevenKey),
    database: dbEnabled,
    vitalsSources: vitalsSockets.size,
    sensorStatus,
    presageServer: presageAvailable(),
    presageError: config.presageKey && !presageAvailable() ? presageLoadError() : undefined,
    personas: Object.keys(PERSONAS),
  });
});

app.post('/api/sessions', (req, res) => {
  const { persona = 'friendly', role, jobDetails, maxQuestions = 6 } = req.body || {};
  // Whatever the candidate typed in the Role box (and an optional job posting) drives the interviewer.
  const s = {
    id: crypto.randomUUID(),
    persona: PERSONAS[persona] ? persona : 'friendly',
    role: normalizeRole(role),
    jobDetails: normalizeJobDetails(jobDetails),
    maxQuestions: Math.min(Math.max(Number(maxQuestions) || 6, 1), 15),
    startedAt: Date.now(),
    engine: new StressEngine(),
    vitals: [],
    utterances: [],
    questionCount: 0,
    ended: false,
    feedback: null,
  };
  sessions.set(s.id, s);
  activeSessionId = s.id;
  db.createSession(s);
  const brief = roleBrief(s.role, s.jobDetails);
  console.log(`[session] ${s.id.slice(0, 8)} role="${s.role}" track=${brief.track} level=${brief.seniority}${s.jobDetails ? ` jobDetails=${s.jobDetails.length} chars` : ''}`);
  res.json({ id: s.id, persona: s.persona, role: s.role, track: brief.track, baselineMs: config.baselineMs });
});

// One interview turn: store the candidate's answer (if any), get the interviewer's next line.
// Body: { answer, turnId }. turnId (client-generated, reused on "Try again") makes the call idempotent:
// a retry or double submit of the same turn returns the same result instead of storing the answer twice.
// Only one turn runs per session at a time; a different turn sent meanwhile gets 409.
// The response includes the full transcript so the chat is correct even if the websocket is down.
app.post('/api/sessions/:id/turn', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const answer = String(req.body?.answer ?? '').trim();
  const turnId = req.body?.turnId ? String(req.body.turnId) : null;

  if (turnId && s.lastTurn?.turnId === turnId) return res.json(turnResponse(s, s.lastTurn.result));
  if (s.inFlight) {
    if (turnId && s.inFlight.turnId === turnId) {
      try {
        return res.json(turnResponse(s, await s.inFlight.promise));
      } catch {
        return res.status(500).json({ error: 'turn failed' });
      }
    }
    return res.status(409).json({ error: 'a turn is already in progress', utterances: s.utterances });
  }

  const promise = runTurn(s, answer);
  s.inFlight = { turnId, promise };
  try {
    const result = await promise;
    if (turnId) s.lastTurn = { turnId, result };
    res.json(turnResponse(s, result));
  } catch (err) {
    console.error('[turn] failed:', err);
    res.status(500).json({ error: 'turn failed', utterances: s.utterances });
  } finally {
    s.inFlight = null;
  }
});

async function runTurn(s, answer) {
  // Interview already over (ended, or the closing line was said): don't store late answers or say more.
  if (s.ended || s.lastAction === 'end') return { say: '', action: 'end', state: s.engine.state, audio: null };
  if (answer) addUtterance(s, 'candidate', answer);

  let state = s.engine.state === 'baseline' ? 'calm' : s.engine.state;
  // Heart rate stays high for a while after a spike: one breathing pause, then keep interviewing.
  if (state === 'overloaded' && s.lastAction === 'breathe') state = 'elevated';
  const turn = await nextTurn({
    persona: s.persona,
    role: s.role,
    jobDetails: s.jobDetails,
    history: s.utterances,
    state,
    questionCount: s.questionCount,
    maxQuestions: s.maxQuestions,
  });
  if (s.ended) return { say: '', action: 'end', state, audio: null }; // "End interview" clicked meanwhile
  if (turn.action === 'ask' || turn.action === 'escalate') s.questionCount += 1;
  s.lastAction = turn.action;

  addUtterance(s, 'interviewer', turn.say);
  const audio = await speak(turn.say, s.persona);
  return { say: turn.say, action: turn.action, source: turn.source, state, audio };
}

function turnResponse(s, result) {
  return { ...result, questionCount: s.questionCount, maxQuestions: s.maxQuestions, utterances: s.utterances };
}

// End the interview and build the replay. Safe to call more than once (End button + the
// interviewer's final 'end' action, double clicks, client retries): every caller awaits the
// same coaching request, and the response always arrives within FEEDBACK_TIMEOUT_MS.
const FEEDBACK_TIMEOUT_MS = Number(process.env.FEEDBACK_TIMEOUT_MS || 25000);

app.post('/api/sessions/:id/end', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  try {
    if (!s.ended) {
      // An answer the candidate was still giving when they clicked End.
      const answer = String(req.body?.answer || '').trim();
      if (answer) addUtterance(s, 'candidate', answer);
      s.ended = true;
      s.endedAt = Date.now();
      if (activeSessionId === s.id) activeSessionId = null;
      try {
        s.presage?.destroy();
      } catch (err) {
        console.error('[presage] destroy failed:', err.message);
      }
      s.presage = null;
      db.endSession(s.id, effectiveBaseline(s).value);
    }
    const retry = Boolean(req.body?.retryFeedback) && s.feedbackError && !s.feedbackPending;
    if (!s.feedbackPending && (!s.feedbackStarted || retry)) startFeedback(s);
    await waitForFeedback(s);
    res.json(replay(s));
  } catch (err) {
    // Never leave the client hanging: send what we have.
    console.error('[end] failed:', err);
    s.feedbackError = s.feedbackError || 'server';
    if (!res.headersSent) res.json(replay(s));
  }
});

app.get('/api/sessions/:id/replay', (req, res) => {
  const s = getSession(req, res);
  if (s) res.json(replay(s));
});

// Starts the Gemini coaching call once per attempt. The promise is stored on the session so
// concurrent /end calls share it; a result that arrives after the timeout is still kept
// (GET /replay or a retry picks it up).
function startFeedback(s) {
  s.feedbackStarted = true;
  s.feedbackError = null;
  const attempt = (s.feedbackAttempt || 0) + 1;
  s.feedbackAttempt = attempt;
  s.feedbackPending = (async () => {
    try {
      const raw = await feedback({
        role: s.role,
        jobDetails: s.jobDetails,
        history: s.utterances,
        spikes: findSpikes(s),
      });
      const fb = normalizeFeedback(raw);
      if (attempt !== s.feedbackAttempt && s.feedback) return; // a newer attempt already won
      if (fb) {
        s.feedback = fb;
        s.feedbackError = null;
      } else {
        s.feedbackError = 'unavailable';
      }
    } catch (err) {
      console.error('[feedback] failed:', err.message);
      if (attempt === s.feedbackAttempt && !s.feedback) s.feedbackError = 'unavailable';
    } finally {
      if (attempt === s.feedbackAttempt) s.feedbackPending = null;
    }
  })();
}

async function waitForFeedback(s) {
  if (!s.feedbackPending) return;
  let timer;
  const timedOut = await Promise.race([
    s.feedbackPending.then(() => false),
    new Promise((r) => (timer = setTimeout(() => r(true), FEEDBACK_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
  if (timedOut && !s.feedback) {
    s.feedbackError = 'timeout';
    console.error(`[feedback] no answer from Gemini after ${FEEDBACK_TIMEOUT_MS} ms`);
  }
}

// Accept what Gemini actually sends: an object, a one-element array, or a JSON string
// (possibly in a ```json fence). Returns { summary, strongerAnswer } or null if unusable.
const FEEDBACK_FALLBACK = 'Feedback unavailable right now.'; // interviewer.feedback()'s error text
function normalizeFeedback(raw) {
  let fb = raw;
  if (typeof fb === 'string') {
    const m = fb.match(/\{[\s\S]*\}/);
    try {
      fb = m ? JSON.parse(m[0]) : { summary: fb };
    } catch {
      fb = { summary: fb };
    }
  }
  if (Array.isArray(fb)) fb = fb.find((x) => x && typeof x === 'object') || null;
  if (!fb || typeof fb !== 'object' || fb.error) return null;
  const summary = typeof fb.summary === 'string' ? fb.summary.trim() : '';
  if (!summary || summary === FEEDBACK_FALLBACK) return null;
  const stronger = typeof fb.strongerAnswer === 'string' ? fb.strongerAnswer.trim() : '';
  return { summary, strongerAnswer: stronger || null };
}

function replay(s) {
  const base = effectiveBaseline(s);
  return {
    id: s.id,
    role: s.role,
    jobDetails: s.jobDetails || null,
    persona: s.persona,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    baseline: base.value,
    baselineEstimated: base.estimated,
    vitals: s.vitals,
    utterances: s.utterances,
    spikes: findSpikes(s),
    feedback: s.feedback,
    feedbackError: s.feedback ? null : s.feedbackError || null,
    feedbackPending: Boolean(s.feedbackPending),
  };
}

// Resting heart rate: the stress engine's baseline, or (baseline skipped / cut short) the
// average of the readings before the first question, else of the first 20 readings.
function effectiveBaseline(s) {
  if (s.engine.baseline) return { value: Math.round(s.engine.baseline * 10) / 10, estimated: false };
  if (!s.vitals.length) return { value: null, estimated: false };
  const firstQ = s.utterances.find((u) => u.speaker === 'interviewer');
  let early = firstQ ? s.vitals.filter((v) => v.ts < firstQ.ts) : [];
  if (early.length < 3) early = s.vitals.slice(0, 20);
  const avg = early.reduce((a, v) => a + v.hr, 0) / early.length;
  return { value: Math.round(avg * 10) / 10, estimated: true };
}

// Top 3 questions by heart-rate rise. Each question owns the time from when it was asked until
// the next question (breathing pauses included, since that spike is what triggered the pause),
// capped at SPIKE_WINDOW_MS for the last one. Breathing prompts and the closing line are skipped.
const SPIKE_WINDOW_MS = 60000;
// 3-point median so one glitchy camera reading can't become the "biggest spike".
const smooth = (xs) =>
  xs.length < 3 ? xs : xs.map((_, i) => [xs[i - 1] ?? xs[i], xs[i], xs[i + 1] ?? xs[i]].sort((a, b) => a - b)[1]);
function findSpikes(s) {
  const base = effectiveBaseline(s).value;
  if (!base || !s.vitals.length) return [];
  const lines = s.utterances.filter((u) => u.speaker === 'interviewer');
  const isQuestion = (u) => u.action !== 'breathe' && u.action !== 'end';
  return lines
    .map((u, i) => {
      if (!isQuestion(u)) return null;
      const next = lines.slice(i + 1).find((x) => x.action !== 'breathe');
      const until = next ? next.ts : Math.min(u.ts + SPIKE_WINDOW_MS, s.endedAt ?? Infinity);
      const window = s.vitals.filter((v) => v.ts >= u.ts && v.ts < until);
      if (!window.length) return null;
      const peak = Math.max(...smooth(window.map((v) => v.hr)));
      return { ts: u.ts, question: u.text, peakHr: Math.round(peak), rise: Math.round(peak - base) };
    })
    .filter((x) => x && x.rise > 0)
    .sort((a, b) => b.rise - a.rise)
    .slice(0, 3);
}

// In production, serve the built frontend from the same server (one deploy on Vultr).
const dist = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------------------------------------------------------------------------
// WebSockets
//   /ws/vitals  <- Presage bridge or simulator sends {"hr": 82, "br": 14}
//   /ws/client  -> browser receives vitals, state changes and utterances
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const vitalsSockets = new Set();
let sensorStatus = ''; // latest Presage hint, '' when the face is locked on
const clientSockets = new Map(); // ws -> sessionId

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!['/ws/vitals', '/ws/client', '/ws/camera'].includes(url.pathname)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/ws/vitals') onVitalsSocket(ws);
    else if (url.pathname === '/ws/camera') onCameraSocket(ws, url.searchParams.get('session'));
    else onClientSocket(ws, url.searchParams.get('session'));
  });
});

function onVitalsSocket(ws) {
  vitalsSockets.add(ws);
  console.log(`[vitals] source connected (${vitalsSockets.size} total)`);
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const s = sessions.get(msg.sessionId || activeSessionId);
    // Sensor hints from Presage ("No face found", "Too dark"...): show them, don't store them.
    if (typeof msg.status === 'string') setSensorStatus(s, msg.status);
    if (msg.hr != null) ingestReading(s, msg);
  });
  ws.on('close', () => {
    vitalsSockets.delete(ws);
    console.log(`[vitals] source disconnected (${vitalsSockets.size} total)`);
  });
}

function setSensorStatus(s, status) {
  sensorStatus = status === 'ok' ? '' : status;
  if (s && !s.ended) broadcast(s.id, { type: 'sensor', status: sensorStatus });
}

// One heart-rate reading from any source (simulator, laptop bridge, or server-side Presage).
// msg: { hr, br?, hrv?, confidence?, stable?, ts? }. VitalsFilter drops junk, duplicates and
// one-off glitches; rejected readings are neither stored nor broadcast. The stress engine gets
// the smoothed value; the chart and replay keep the raw accepted value in `hr`.
function ingestReading(s, msg) {
  if (!s || s.ended) return;
  s.filter ??= new VitalsFilter();
  const r = s.filter.push(msg);
  if (!r.ok) {
    if (process.env.FILTER_DEBUG === '1') console.log(`[vitals] dropped hr=${msg.hr} (${r.reason})`);
    return;
  }
  const snap = s.engine.add(r.ts, r.hrSmooth);
  const v = { ts: r.ts, hr: r.hr, hrSmooth: r.hrSmooth, br: r.br, confidence: r.confidence, state: snap.state };
  s.vitals.push(v);
  db.addVitals(s.id, v);
  broadcast(s.id, { type: 'vitals', ...v, ...snap });

  // Pulse back after being lost: clear our hint (but not a newer one from Presage).
  if (s.pulseLost) {
    s.pulseLost = false;
    if (sensorStatus === PULSE_LOST_HINT) setSensorStatus(s, 'ok');
  }
  // Watch for the pulse going quiet. The timer only runs while readings flow: it stops once it
  // has reported the loss (the next accepted reading restarts it) or when the session ends.
  if (!s.staleTimer) {
    s.staleTimer = setInterval(() => {
      const gone = s.ended || activeSessionId !== s.id; // ended or replaced by a newer session
      if (!gone && !s.filter.isStale(Date.now())) return;
      clearInterval(s.staleTimer);
      s.staleTimer = null;
      if (gone) return;
      s.pulseLost = true;
      setSensorStatus(s, PULSE_LOST_HINT);
    }, 1000);
    s.staleTimer.unref?.();
  }
}

// Browser webcam frames -> server-side Presage. Binary messages: [float64 LE capture ms][JPEG].
function onCameraSocket(ws, sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.ended || !presageAvailable()) return ws.close(1008, 'no session or Presage off');
  if (!s.presage) {
    try {
      s.presage = createPresageSession({
        onReading: (r) => ingestReading(s, r), // { hr, br, hrv, confidence, stable, ts } from presageSamples.js
        onStatus: (text) => setSensorStatus(s, text || 'ok'),
      });
      console.log(`[presage] measuring session ${s.id.slice(0, 8)} from browser camera`);
    } catch (err) {
      console.error('[presage] could not start:', err.message);
      return ws.close(1011, 'presage failed');
    }
  }
  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary && s.presage) s.presage.sendFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
    } catch (err) {
      console.error('[presage] frame dropped:', err.message);
    }
  });
  ws.on('close', () => {
    // Keep the SDK alive briefly in case the page reconnects; end-of-interview destroys it.
    setTimeout(() => {
      const stillStreaming = [...wss.clients].some((c) => c.cameraSession === s.id && c.readyState === c.OPEN);
      if (!stillStreaming && s.presage) {
        s.presage.destroy();
        s.presage = null;
      }
    }, 15000);
  });
  ws.cameraSession = s.id;
}

function onClientSocket(ws, sessionId) {
  clientSockets.set(ws, sessionId);
  // Ping so proxies (Codespaces, Vite, load balancers) don't drop the socket while nothing is being said.
  const keepAlive = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25000);
  ws.on('close', () => {
    clearInterval(keepAlive);
    clientSockets.delete(ws);
  });
  // (Re)connecting clients get the transcript so far, so nothing said while the socket was down is lost.
  const s = sessions.get(sessionId);
  if (s) ws.send(JSON.stringify({ type: 'transcript', utterances: s.utterances }));
}

function broadcast(sessionId, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, sid] of clientSockets) {
    if (sid === sessionId && ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Last-resort safety net: log and keep serving so one bad request or socket never ends a live demo.
process.on('uncaughtException', (err) => console.error('[server] uncaught error:', err));
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

server.listen(config.port, () => {
  console.log(`Pressure Test backend on http://localhost:${config.port}`);
  console.log(
    `  Gemini: ${config.geminiKey ? 'on' : 'off (canned questions)'} | ElevenLabs: ${
      config.elevenKey ? 'on' : 'off (browser voice)'
    } | Tiger Data: ${dbEnabled ? 'on' : 'off (memory only)'}`,
  );
});
