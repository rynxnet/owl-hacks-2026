// Presage SmartSpectra -> Pressure Test backend.
//
// Runs on the laptop with the webcam (Windows x64, macOS Apple Silicon, Linux x64 or arm64).
// Opens the camera through the SmartSpectra Node SDK (@smartspectra/node-sdk 3.3.0), reads pulse +
// breathing rate, and sends one JSON message per pulse sample to the backend's /ws/vitals socket:
//   { hr, br, hrv, confidence, stable, ts }   (ts = epoch ms of the sample, confidence 0..1)
//
//   cd presage-bridge
//   npm install
//   copy .env.example .env   (then paste PRESAGE_API_KEY and VITALS_URL)
//   npm start
import 'dotenv/config';
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

const API_KEY = process.env.PRESAGE_API_KEY || '';
const VITALS_URL = process.env.VITALS_URL || 'ws://localhost:3001/ws/vitals';
const CAMERA_INDEX = Number(process.env.CAMERA_INDEX || 0);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0); // 0..1; raise (e.g. 0.4) if readings are jumpy

if (!API_KEY) {
  console.error('Set PRESAGE_API_KEY in presage-bridge/.env (get it at https://physiology.presagetech.com).');
  process.exit(1);
}

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
  if (FATAL_ERROR_CODES.has(code)) shutdown(1); // bad key / config / no credits: retrying won't help
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
  shutdown(1);
}
