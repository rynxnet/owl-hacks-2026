// Runs in its own process (forked by presage.js), one per interview, so a Presage error or native crash
// can never take down the interview server. Receives JPEG frames, sends back readings and hints.
import { config } from './config.js';

const send = (msg) => process.connected && process.send(msg);
process.on('uncaughtException', (err) => send({ type: 'status', text: `Presage error: ${err.message}` }));
process.on('disconnect', () => process.exit(0));

let sdkMod;
let jpeg;
try {
  sdkMod = await import('@smartspectra/node-sdk');
  jpeg = (await import('jpeg-js')).default;
} catch (err) {
  send({ type: 'fatal', text: `Presage SDK failed to load: ${err.message}` });
  process.exit(1);
}

const HINTS = {
  NoFaceFound: 'No face found. Look at the camera.',
  MultipleFacesFound: 'More than one face in view.',
  FaceNotCentered: 'Center your face in the camera.',
  FaceSizeOutOfRange: 'Move closer to or farther from the camera.',
  FaceTooClose: 'Move back a little.',
  FaceTooFar: 'Move closer to the camera.',
  FaceTooHigh: 'Move down a little.',
  FaceTooLow: 'Move up a little.',
  FaceNotForward: 'Face the camera directly.',
  TooDark: 'Too dark. Add light in front of you.',
  TooBright: 'Too bright. Avoid a window behind you.',
  ExcessiveMotion: 'Hold still.',
  FrameRateTooLow: 'Video is choppy. Check your connection.',
  CameraTuning: 'Adjusting camera...',
};
const nameOf = (enumObj, code) =>
  (Object.entries(enumObj || {}).find(([, v]) => v === code)?.[0] || `code ${code}`).replace(/^k/, '');

// One Presage measurement per interview session.
// onReading({ hr, br, hrv }) and onStatus(text) are called as results arrive.
function createPresageSession({ onReading, onStatus }) {
  const { SmartSpectraSDK, ProcessingStatus, ValidationCode, PixelFormat, FrameTransform, breathingMetrics, cardioMetrics, decodeMetrics } =
    sdkMod;

  const sdk = new SmartSpectraSDK({
    apiKey: config.presageKey,
    requestedMetrics: [...breathingMetrics, ...cardioMetrics],
  });

  let lastHint = null;
  let lastBr = null;
  let t0 = null;
  let lastTsUs = -1;
  let destroyed = false;

  sdk.on('processingStatus', (status) => {
    const name = nameOf(ProcessingStatus, status);
    console.log(`[presage] ${name}`);
    if (status === ProcessingStatus.kRunning) onStatus('Reading your pulse. Hold still for a few seconds.');
  });

  sdk.on('validationStatus', (code) => {
    const hint = code === ValidationCode.kOk ? '' : HINTS[nameOf(ValidationCode, code)] || nameOf(ValidationCode, code);
    if (hint !== lastHint) {
      lastHint = hint;
      onStatus(hint);
    }
  });

  sdk.on('metrics', (buf) => {
    let m;
    try {
      m = decodeMetrics(buf);
    } catch {
      return;
    }
    if (!m || Buffer.isBuffer(m)) return;
    const br = m.breathing?.rate?.at(-1)?.value;
    if (br > 0) lastBr = br;
    const pulse = m.cardio?.pulseRate?.at(-1);
    if (!pulse || !(pulse.value > 0)) return;
    if (pulse.confidence != null && pulse.confidence < config.presageMinConfidence) return;
    if (pulse.value < 35 || pulse.value > 220) return;
    onReading({ hr: +pulse.value.toFixed(1), br: lastBr ? +lastBr.toFixed(1) : null, hrv: m.cardio?.hrv?.at(-1)?.rmssd ?? null });
  });

  sdk.on('error', (code, message) => {
    console.error(`[presage] error ${code}: ${message}`);
    onStatus({ 2: 'Presage API key rejected.', 4: 'Presage credits used up.', 5: 'Presage cannot reach its server.' }[code] || `Presage error: ${message}`);
  });

  sdk.useCustomInput(FrameTransform?.kNone ?? 0);
  sdk.start(); // may throw (bad key, no credits); caught by the caller

  return {
    // frame: Buffer = [8-byte float64 LE capture time in ms][JPEG bytes]
    sendFrame(frame) {
      if (destroyed || frame.length < 100) return;
      const captureMs = frame.readDoubleLE(0);
      let img;
      try {
        img = jpeg.decode(frame.subarray(8), { useTArray: true, formatAsRGBA: true });
      } catch {
        return;
      }
      if (t0 === null) t0 = captureMs;
      let tsUs = Math.round((captureMs - t0) * 1000);
      if (tsUs <= lastTsUs) tsUs = lastTsUs + 1; // SDK needs increasing timestamps
      lastTsUs = tsUs;
      try {
        sdk.sendFrame(img.data, img.width, img.height, img.width * 4, PixelFormat.kRGBA, tsUs);
      } catch {
        // not running yet / stopping: drop the frame
      }
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        await sdk.destroy();
      } catch {}
    },
  };
}

// --- process wiring ---------------------------------------------------------
let session;
try {
  session = createPresageSession({
    onReading: (r) => send({ type: 'reading', ...r }),
    onStatus: (text) => send({ type: 'status', text }),
  });
} catch (err) {
  const msg = /auth|key/i.test(err.message) ? 'Presage API key rejected.' : `Presage could not start: ${err.message}`;
  send({ type: 'fatal', text: msg });
  process.exit(1);
}

process.on('message', async (msg) => {
  if (msg?.type === 'frame') {
    session.sendFrame(Buffer.from(msg.frame.buffer, msg.frame.byteOffset, msg.frame.byteLength));
    send({ type: 'ack' });
  } else if (msg?.type === 'stop') {
    await session.destroy();
    process.exit(0);
  }
});
