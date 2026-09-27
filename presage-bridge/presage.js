// Presage SmartSpectra -> Pressure Test backend.
//
// Runs on the laptop with the webcam (Windows x64, macOS Apple Silicon, Linux x64 or arm64).
// Opens the camera through the SmartSpectra Node SDK (@smartspectra/node-sdk 3.3.0), reads pulse +
// breathing rate, and sends one JSON message per pulse sample to the backend's /ws/vitals socket:
//   { hr, br, hrv, confidence, stable, ts }   (ts = epoch ms of the sample, confidence 0..1)
//
//   cd presage-bridge
//   npm install
//   npm start      (runs start.js, which restarts this script if Presage gets stuck)
//
// The key comes from presage-bridge/.env, or else from backend/.env (so it works wherever you put it).
//
// Exit codes (read by start.js): 0 = stopped by you, 78 = setup problem (key, credits, config: don't
// restart), 75 = Presage stalled after an error (restart). Anything else is a crash (restart).
import 'dotenv/config';
import fs from 'node:fs';
import WebSocket from 'ws';
import {
  SmartSpectraSDK,
  ProcessingStatus,
  ValidationCode,
  breathingMetrics,
  cardioMetrics,
  decodeMetrics,
} from '@smartspectra/node-sdk';
// Shared, unit-tested sample extraction (plain JS, no backend dependencies).
import {
  extractNewSamples,
  anchorForFirstSample,
  toNumber,
  nameOf,
  HINTS as BASE_HINTS,
  ERROR_TEXT,
  FATAL_ERROR_CODES,
} from '../backend/src/presageSamples.js';

export const EXIT_SETUP = 78;
export const EXIT_RESTART = 75;

function keyFromBackendEnv() {
  try {
    const text = fs.readFileSync(new URL('../backend/.env', import.meta.url), 'utf8');
    const m = text.match(/^[ \t]*PRESAGE_API_KEY[ \t]*=[ \t]*["']?([^"'\r\n#]*)/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}
const OWN_KEY = (process.env.PRESAGE_API_KEY || '').trim();
const API_KEY = OWN_KEY || keyFromBackendEnv();
const VITALS_URL = process.env.VITALS_URL || 'ws://localhost:3001/ws/vitals';
const CAMERA_INDEX = Number(process.env.CAMERA_INDEX || 0);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0); // 0..1; raise (e.g. 0.4) if readings are jumpy

if (!API_KEY) {
  console.error('Set PRESAGE_API_KEY in presage-bridge/.env or backend/.env (get it at https://physiology.presagetech.com).');
  process.exit(EXIT_SETUP);
}
console.log(`[bridge] Presage key from ${OWN_KEY ? 'presage-bridge/.env' : 'backend/.env'} (ends in ...${API_KEY.slice(-4)})`);

// Plain-English versions of Presage's positioning hints, shown in the app (the camera is on this laptop).
const HINTS = {
  ...BASE_HINTS,
  FaceTooHigh: 'Lower the camera or move down.',
  FaceTooLow: 'Raise the camera or move up.',
  TooBright: 'Too bright. Avoid a window or light behind the camera.',
  FrameRateTooLow: 'Camera frame rate too low. Close other apps using the camera.',
};

// --- backend connection (auto-reconnects) ---------------------------------
let ws;
function connect() {
  ws = new WebSocket(VITALS_URL);
  ws.on('open', () => console.log(`[bridge] connected to ${VITALS_URL}`));
  ws.on('close', () => setTimeout(connect, 2000));
  ws.on('error', (err) => console.error(`[bridge] backend unreachable (${err.message}), retrying...`));
}
function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ source: 'presage', ...obj }));
}
connect();

// --- Presage ---------------------------------------------------------------
const sdk = new SmartSpectraSDK({
  apiKey: API_KEY,
  requestedMetrics: [...breathingMetrics, ...cardioMetrics],
});

let lastHint = '';
let anchor; // undefined until the first pulse sample; null = SDK time is already epoch µs
let samples = {}; // extractNewSamples state: lastSampleTs, lastBr, lastHrv

// After a non-fatal Presage error (e.g. 8 "processing failed"), give the SDK a few seconds to keep going.
// If no new metrics arrive, exit with EXIT_RESTART and start.js brings up a fresh Presage process.
const STALL_MS = Number(process.env.STALL_MS || 6000);
let lastMetricsAt = 0;
let stallTimer = null;
function watchForStall(code) {
  if (stallTimer) return;
  const errorAt = Date.now();
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (lastMetricsAt > errorAt) return; // it recovered on its own
    console.error(`[presage] no data for ${STALL_MS / 1000}s after error ${code}; restarting Presage`);
    send({ status: 'Heart-rate reader hiccup, restarting it. Hold still...' });
    shutdown(EXIT_RESTART);
  }, STALL_MS);
}

sdk.on('processingStatus', (status) => {
  console.log(`[presage] ${nameOf(ProcessingStatus, status)}`);
  if (status === ProcessingStatus.kRunning) send({ status: 'Presage running. Hold still while it locks on.' });
});

sdk.on('validationStatus', (code, _tsUs, sdkHint) => {
  const name = nameOf(ValidationCode, code);
  const hint = code === ValidationCode.kOk ? '' : HINTS[name] || sdkHint || name;
  if (hint !== lastHint) {
    lastHint = hint;
    console.log(`[presage] ${hint || 'face OK'}`);
    send({ status: hint || 'ok' });
  }
});

sdk.on('metrics', (buf, eventTsUs) => {
  lastMetricsAt = Date.now();
  let m;
  try {
    m = decodeMetrics(buf); // the SDK registers its bundled protobufjs Metrics class by default
  } catch (err) {
    return console.error('[presage] could not decode metrics:', err.message);
  }
  if (!m || Buffer.isBuffer(m)) return;

  // Map the SDK timeline onto epoch ms once, at the first pulse sample. The SDK's camera sources already
  // stamp frames in epoch µs, so this is normally the identity; otherwise the first sample is pinned to now.
  if (anchor === undefined) {
    const first = (m.cardio?.pulseRate || []).map((p) => toNumber(p?.timestamp)).find((t) => t > 0);
    if (first === undefined) return;
    anchor = anchorForFirstSample(first, Date.now());
  }
  const out = extractNewSamples(m, samples, { anchor, minConfidence: MIN_CONFIDENCE, eventTsUs });
  samples = out.state;
  for (const r of out.readings) {
    send(r); // { hr, br, hrv, confidence, stable, ts }
    console.log(`[presage] hr=${r.hr}${r.br != null ? ` br=${r.br}` : ''}${r.confidence != null ? ` conf=${r.confidence}` : ''}`);
  }
});

sdk.on('error', (code, message, retryable) => {
  console.error(`[presage] error ${code}${retryable ? ' (retryable)' : ''}: ${message}`);
  send({ status: ERROR_TEXT[code] || `Presage error: ${message}` });
  if (FATAL_ERROR_CODES.has(code)) return shutdown(EXIT_SETUP); // bad key / config / no credits: retrying won't help
  watchForStall(code);
});

process.on('unhandledRejection', (err) => console.error('[presage] unhandled rejection:', err?.message || err));

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\n[presage] stopping');
  try {
    await sdk.destroy(); // returns a Promise in 3.3.0
  } catch {}
  setTimeout(() => process.exit(code), 200); // let the last status message reach the backend
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

sdk.useCamera({ deviceIndex: CAMERA_INDEX });
try {
  await sdk.start(); // synchronous in 3.3.0 (throws an Error with .code); await also covers a Promise
  console.log(`[presage] starting camera ${CAMERA_INDEX}... (Ctrl+C to stop)`);
} catch (err) {
  console.error(`[presage] could not start: ${err.message}`);
  send({ status: ERROR_TEXT[err.code] || `Presage could not start: ${err.message}` });
  shutdown(FATAL_ERROR_CODES.has(err.code) ? EXIT_SETUP : EXIT_RESTART);
}
