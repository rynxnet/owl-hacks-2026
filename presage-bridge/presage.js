// Presage SmartSpectra -> Pressure Test backend.
//
// Runs on the laptop with the webcam (Windows x64, macOS Apple Silicon, or Linux x64).
// Opens the camera through the SmartSpectra Node SDK, reads pulse + breathing rate,
// and sends {"hr", "br"} to the backend's /ws/vitals socket, exactly like the simulator.
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

const API_KEY = process.env.PRESAGE_API_KEY || '';
const VITALS_URL = process.env.VITALS_URL || 'ws://localhost:3001/ws/vitals';
const CAMERA_INDEX = Number(process.env.CAMERA_INDEX || 0);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0); // raise (e.g. 0.5) if readings are jumpy

if (!API_KEY) {
  console.error('Set PRESAGE_API_KEY in presage-bridge/.env (get it at https://physiology.presagetech.com).');
  process.exit(1);
}

const nameOf = (enumObj, code) =>
  (Object.entries(enumObj || {}).find(([, v]) => v === code)?.[0] || `code ${code}`).replace(/^k/, '');

// Plain-English versions of Presage's positioning hints, shown in the app.
const HINTS = {
  NoFaceFound: 'No face found. Look at the camera.',
  MultipleFacesFound: 'More than one face in view.',
  FaceNotCentered: 'Center your face in the camera.',
  FaceSizeOutOfRange: 'Move closer to or farther from the camera.',
  FaceTooClose: 'Move back a little.',
  FaceTooFar: 'Move closer to the camera.',
  FaceTooHigh: 'Lower the camera or move down.',
  FaceTooLow: 'Raise the camera or move up.',
  FaceNotForward: 'Face the camera directly.',
  TooDark: 'Too dark. Add light in front of you.',
  TooBright: 'Too bright. Avoid a window or light behind the camera.',
  ExcessiveMotion: 'Hold still.',
  FrameRateTooLow: 'Camera frame rate too low. Close other apps using the camera.',
  CameraTuning: 'Adjusting camera...',
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
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ts: Date.now(), source: 'presage', ...obj }));
}
connect();

// --- Presage ---------------------------------------------------------------
const sdk = new SmartSpectraSDK({
  apiKey: API_KEY,
  requestedMetrics: [...breathingMetrics, ...cardioMetrics],
});

let lastHint = '';
let lastBr = null;

sdk.on('processingStatus', (status) => {
  console.log(`[presage] ${nameOf(ProcessingStatus, status)}`);
  if (status === ProcessingStatus?.kRunning) send({ status: 'Presage running. Hold still while it locks on.' });
});

sdk.on('validationStatus', (code) => {
  const name = nameOf(ValidationCode, code);
  const hint = code === ValidationCode?.kOk ? '' : HINTS[name] || name;
  if (hint !== lastHint) {
    lastHint = hint;
    console.log(`[presage] ${hint || 'face OK'}`);
    send({ status: hint || 'ok' });
  }
});

sdk.on('metrics', (buf) => {
  let m;
  try {
    m = decodeMetrics(buf);
  } catch (err) {
    return console.error('[presage] could not decode metrics:', err.message);
  }
  if (!m || Buffer.isBuffer(m)) return;

  const br = m.breathing?.rate?.at(-1)?.value;
  if (br > 0) lastBr = br;

  const pulse = m.cardio?.pulseRate?.at(-1);
  if (!pulse || !(pulse.value > 0)) return;
  if (pulse.confidence != null && pulse.confidence < MIN_CONFIDENCE) return;
  if (pulse.value < 35 || pulse.value > 220) return; // junk

  const hrv = m.cardio?.hrv?.at(-1)?.rmssd;
  send({ hr: +pulse.value.toFixed(1), br: lastBr ? +lastBr.toFixed(1) : null, hrv: hrv ?? null });
  console.log(`[presage] hr=${pulse.value.toFixed(1)}${lastBr ? ` br=${lastBr.toFixed(1)}` : ''}`);
});

sdk.on('error', (code, message, retryable) => {
  console.error(`[presage] error ${code}${retryable ? ' (retryable)' : ''}: ${message}`);
  const friendly = {
    2: 'Presage API key rejected.',
    4: 'Presage credits used up.',
    5: 'Presage cannot reach its server (network).',
    7: 'Camera unavailable. Close apps using it (or hide the camera preview) and restart the bridge.',
  }[code];
  send({ status: friendly || `Presage error: ${message}` });
});

sdk.useCamera({ deviceIndex: CAMERA_INDEX });
sdk.start();
console.log(`[presage] starting camera ${CAMERA_INDEX}... (Ctrl+C to stop)`);

async function shutdown() {
  console.log('\n[presage] stopping');
  try {
    await sdk.destroy();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
