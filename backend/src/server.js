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
import { nextTurn, feedback, PERSONAS } from './interviewer.js';
import { speak } from './voice.js';
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
  const { persona = 'friendly', role = 'Software Engineering Intern', maxQuestions = 6 } = req.body || {};
  const s = {
    id: crypto.randomUUID(),
    persona: PERSONAS[persona] ? persona : 'friendly',
    role,
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
  res.json({ id: s.id, persona: s.persona, baselineMs: config.baselineMs });
});

// One interview turn: store the candidate's answer (if any), get the interviewer's next line.
app.post('/api/sessions/:id/turn', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const answer = (req.body?.answer || '').trim();
  if (answer) addUtterance(s, 'candidate', answer);

  let state = s.engine.state === 'baseline' ? 'calm' : s.engine.state;
  // Heart rate stays high for a while after a spike: one breathing pause, then keep interviewing.
  if (state === 'overloaded' && s.lastAction === 'breathe') state = 'elevated';
  const turn = await nextTurn({
    persona: s.persona,
    role: s.role,
    history: s.utterances,
    state,
    questionCount: s.questionCount,
    maxQuestions: s.maxQuestions,
  });
  if (turn.action !== 'breathe') s.questionCount += 1;
  s.lastAction = turn.action;

  addUtterance(s, 'interviewer', turn.say);
  const audio = await speak(turn.say, s.persona);
  res.json({ ...turn, state, audio, questionCount: s.questionCount, maxQuestions: s.maxQuestions });
});

app.post('/api/sessions/:id/end', async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  if (!s.ended) {
    s.ended = true;
    if (activeSessionId === s.id) activeSessionId = null;
    s.presage?.destroy();
    s.presage = null;
    db.endSession(s.id, s.engine.baseline);
    s.feedback = await feedback({ role: s.role, history: s.utterances, spikes: findSpikes(s) });
  }
  res.json(replay(s));
});

app.get('/api/sessions/:id/replay', (req, res) => {
  const s = getSession(req, res);
  if (s) res.json(replay(s));
});

function replay(s) {
  return {
    id: s.id,
    role: s.role,
    persona: s.persona,
    startedAt: s.startedAt,
    baseline: s.engine.baseline,
    vitals: s.vitals,
    utterances: s.utterances,
    spikes: findSpikes(s),
    feedback: s.feedback,
  };
}

// Biggest heart-rate rise in the 25 seconds after each interviewer question.
function findSpikes(s) {
  const base = s.engine.baseline;
  if (!base) return [];
  return s.utterances
    .filter((u) => u.speaker === 'interviewer')
    .map((u) => {
      const window = s.vitals.filter((v) => v.ts >= u.ts && v.ts <= u.ts + 25000);
      const peak = window.reduce((m, v) => Math.max(m, v.hr), 0);
      return { ts: u.ts, question: u.text, peakHr: peak, rise: Math.round(peak - base) };
    })
    .filter((x) => x.peakHr > 0)
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
function ingestReading(s, msg) {
  if (!s || s.ended) return;
  const ts = Number(msg.ts) || Date.now();
  const hr = Number(msg.hr);
  if (!Number.isFinite(hr) || hr <= 0) return;
  const snap = s.engine.add(ts, hr);
  const v = { ts, hr, br: msg.br != null ? Number(msg.br) : null, state: snap.state };
  s.vitals.push(v);
  db.addVitals(s.id, v);
  broadcast(s.id, { type: 'vitals', ...v, ...snap });
}

// Browser webcam frames -> server-side Presage. Binary messages: [float64 LE capture ms][JPEG].
function onCameraSocket(ws, sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.ended || !presageAvailable()) return ws.close(1008, 'no session or Presage off');
  if (!s.presage) {
    try {
      s.presage = createPresageSession({
        onReading: (r) => ingestReading(s, { hr: r.hr, br: r.br, ts: Date.now() }),
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
  ws.on('close', () => clientSockets.delete(ws));
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
