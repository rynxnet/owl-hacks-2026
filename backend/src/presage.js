// Server-side Presage: the browser streams webcam frames (JPEG) to /ws/camera,
// this module decodes them and feeds them to the SmartSpectra Node SDK.
// No install on the user's laptop, and it works the same in a Codespace or on Vultr.
//
// Optional: if PRESAGE_API_KEY is empty or the SDK isn't installed, presageAvailable() is false
// and the app falls back to the laptop bridge (presage-bridge/) or the simulator.
import { config } from './config.js';

let sdkMod = null;
let jpeg = null;
let loadError = '';

if (config.presageKey) {
  try {
    sdkMod = await import('@smartspectra/node-sdk');
    jpeg = (await import('jpeg-js')).default;
  } catch (err) {
    loadError = err.message;
    sdkMod = null;
    console.error('[presage] SDK not loaded, server-side heart rate is off:', err.message);
  }
}

export const presageAvailable = () => Boolean(sdkMod && jpeg);
export const presageLoadError = () => loadError;

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
export function createPresageSession({ onReading, onStatus }) {
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
  sdk.start();

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
      sdk.sendFrame(img.data, img.width, img.height, img.width * 4, PixelFormat.kRGBA, tsUs);
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
