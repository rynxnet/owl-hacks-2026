import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { nextTurn, feedback, prepareInterviewer, PERSONAS } from './interviewer.js';
import { speak } from './voice.js';
import { presageAvailable, presageLoadError, createPresageSession } from './presage.js';
import { createSessionService } from './services/sessionService.js';
import { createInterviewService } from './services/interviewService.js';
import { createVitalsService } from './services/vitalsService.js';
import { buildReplay, effectiveBaseline, findSpikes } from './services/replayService.js';
import { createFeedbackService } from './services/feedbackService.js';
import { roleBrief } from './roles.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const sessionService = createSessionService({
  personas: Object.keys(PERSONAS),
  destroySensor: destroyPresageSensor,
});
const vitalsService = createVitalsService({ broadcast, isActive: (s) => sessionService.active() === s });
const feedbackService = createFeedbackService({
  generateFeedback: feedback,
  findSpikes,
  timeoutMs: Number(process.env.FEEDBACK_TIMEOUT_MS || 25000),
});

function getSession(req, res) {
  const s = sessionService.get(req.params.id);
  if (!s) res.status(404).json({ error: 'session not found' });
  return s;
}

function addUtterance(s, speaker, text) {
  const u = { ts: Date.now(), speaker, text, state: s.engine.state };
  if (speaker === 'interviewer' && s.lastAction) u.action = s.lastAction; // lets findSpikes skip breathing prompts
  s.utterances.push(u);
  broadcast(s.id, { type: 'utterance', ...u });
  return u;
}

const interviewService = createInterviewService({ nextTurn, speak, addUtterance });

function destroyPresageSensor(session) {
  try {
    session.presage?.destroy();
  } catch (error) {
    console.error('[presage] destroy failed:', error.message);
  }
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    gemini: Boolean(config.geminiKey),
    elevenlabs: Boolean(config.elevenKey),
    vitalsSources: vitalsSockets.size,
    sensorStatus: vitalsService.sensorStatus,
    presageServer: presageAvailable(),
    presageError: config.presageMode === 'server' && config.presageKey && !presageAvailable() ? presageLoadError() : undefined,
    presageMode: config.presageMode,
    personas: Object.keys(PERSONAS),
  });
});

app.post('/api/sessions', (req, res) => {
  const s = sessionService.create(req.body || {});
  const brief = roleBrief(s.role, s.jobDetails);
  // Gemini builds the interviewer (company, team, hiring manager, plan) while the baseline is measured.
  prepareInterviewer({ persona: s.persona, role: s.role, jobDetails: s.jobDetails });
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

  const promise = interviewService.runTurn(s, answer, turnId);
  s.inFlight = { turnId, promise };
  try {
    const result = await promise;
    if (turnId) s.lastTurn = { turnId, result };
    res.json(turnResponse(s, result));
  } catch (err) {
    if (err?.code === 'AI_INTERVIEWER_FAILED') {
      // Gemini couldn't produce a real reply. Say so instead of faking one.
      console.error('[turn] AI interviewer failed:', err.message);
      return res.status(502).json({ error: err.message, code: err.code, stage: err.stage, utterances: s.utterances });
    }
    console.error('[turn] failed:', err);
    res.status(500).json({ error: 'turn failed', utterances: s.utterances });
  } finally {
    s.inFlight = null;
  }
});

function turnResponse(s, result) {
  return { ...result, questionCount: s.questionCount, maxQuestions: s.maxQuestions, utterances: s.utterances };
}

// End the interview and build the replay. Safe to call more than once (End button + the
// interviewer's final 'end' action, double clicks, client retries): every caller awaits the
// same coaching request, and the response always arrives within FEEDBACK_TIMEOUT_MS.
app.post('/api/sessions/:id/end', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  try {
    if (!s.ended) {
      // An answer the candidate was still giving when they clicked End.
      const answer = String(req.body?.answer || '').trim();
      if (answer) addUtterance(s, 'candidate', answer);
      sessionService.end(s, effectiveBaseline(s).value);
    }
    const retry = Boolean(req.body?.retryFeedback) && s.feedbackError && !s.feedbackPending;
    if (!s.feedbackPending && (!s.feedbackStarted || retry)) feedbackService.start(s);
    await feedbackService.wait(s);
    res.json(buildReplay(s));
  } catch (err) {
    // Never leave the client hanging: send what we have.
    console.error('[end] failed:', err);
    s.feedbackError = s.feedbackError || 'server';
    if (!res.headersSent) res.json(buildReplay(s));
  }
});

app.get('/api/sessions/:id/replay', (req, res) => {
  const s = getSession(req, res);
  if (s) res.json(buildReplay(s));
});

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
    const s = msg.sessionId ? sessionService.get(msg.sessionId) : sessionService.active();
    // Sensor hints from Presage ("No face found", "Too dark"...): show them, don't store them.
    if (typeof msg.status === 'string') vitalsService.setSensorStatus(s, msg.status);
    if (msg.hr != null) vitalsService.ingest(s, msg);
  });
  ws.on('close', () => {
    vitalsSockets.delete(ws);
    console.log(`[vitals] source disconnected (${vitalsSockets.size} total)`);
  });
}

// Browser webcam frames -> server-side Presage. Binary messages: [float64 LE capture ms][JPEG].
function onCameraSocket(ws, sessionId) {
  const s = sessionService.get(sessionId);
  if (!s || s.ended || !presageAvailable()) return ws.close(1008, 'no session or Presage off');
  if (!s.presage) {
    try {
      s.presage = createPresageSession({
        onReading: (r) => vitalsService.ingest(s, r), // { hr, br, hrv, confidence, stable, ts } from presageSamples.js
        onStatus: (text) => vitalsService.setSensorStatus(s, text || 'ok'),
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
  const s = sessionService.get(sessionId);
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
    `  Gemini: ${config.geminiKey ? 'on' : 'OFF: interviewer will not work, set GEMINI_API_KEY'} | ElevenLabs: ${
      config.elevenKey ? 'on' : 'off (browser voice)'
    }`,
  );
  if (config.presageMode === 'server') {
    console.log(`  Heart rate: SERVER mode (browser streams the webcam here). Presage ${presageAvailable() ? 'ready' : `not ready: ${presageLoadError() || 'PRESAGE_API_KEY is empty'}`}. Do NOT also run the bridge.`);
  } else {
    console.log('  Heart rate: BRIDGE mode. Start it in another terminal: cd presage-bridge && npm start (or npm run sim here).');
    if (config.presageKey) console.log('  (PRESAGE_API_KEY in backend/.env is not used by the backend in bridge mode; the bridge can read it from here.)');
  }
});
