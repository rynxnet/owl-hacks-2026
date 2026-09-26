// Runs in its own process (forked by presage.js), one per interview, so a Presage error or native crash
// can never take down the interview server. Receives JPEG frames, sends back readings and hints.
//
// IPC out:  { type: 'reading', hr, br, hrv, confidence, stable, ts }   (ts = epoch ms of the SDK sample)
//           { type: 'status', text } | { type: 'fatal', text } | { type: 'ack' } (one per frame received)
// IPC in:   { type: 'frame', frame: Buffer [float64 LE capture ms since epoch][JPEG] } | { type: 'stop' }
//
// SDK API used here was verified against @smartspectra/node-sdk 3.3.0 (see presage-bridge/README.md).
import { config } from './config.js';
import {
  extractNewSamples,
  nextFrameTimestampUs,
  nameOf,
  HINTS,
  ERROR_TEXT,
  FATAL_ERROR_CODES,
} from './presageSamples.js';

const send = (msg) => process.connected && process.send(msg);
const report = (err) => send({ type: 'status', text: `Presage error: ${err?.message || err}` });
process.on('uncaughtException', report);
process.on('unhandledRejection', report); // e.g. a rejected destroy()/stopAsync() promise
process.on('disconnect', () => process.exit(0));

let session = null; // set once sdk.start() has succeeded
let stopping = false;

// Listen right away so frames that arrive while the SDK loads are acked (the parent caps frames in flight).
process.on('message', async (msg) => {
  if (msg?.type === 'frame') {
    if (session && msg.frame) session.sendFrame(Buffer.from(msg.frame.buffer, msg.frame.byteOffset, msg.frame.byteLength));
    send({ type: 'ack' });
  } else if (msg?.type === 'stop') {
    await shutdown(0);
  }
});

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  try {
    await session?.destroy();
  } catch {}
  process.exit(code);
}

function fatal(text) {
  send({ type: 'fatal', text });
  shutdown(1);
}

let sdkMod;
let jpeg;
try {
  sdkMod = await import('@smartspectra/node-sdk');
  jpeg = (await import('jpeg-js')).default;
} catch (err) {
  fatal(`Presage SDK failed to load: ${err.message}`);
}

// One Presage measurement per interview session.
async function createPresageSession({ onReading, onStatus }) {
  const { SmartSpectraSDK, ProcessingStatus, ValidationCode, PixelFormat, FrameTransform, breathingMetrics, cardioMetrics, decodeMetrics } =
    sdkMod;

  const sdk = new SmartSpectraSDK({
    apiKey: config.presageKey,
    requestedMetrics: [...breathingMetrics, ...cardioMetrics],
  });

  let lastHint = null;
  let frameClock = null; // { us, captureMs } of the last frame sent
  let anchor = null; // { sdkUs, epochMs }: first frame's SDK time -> server wall clock
  let samples = {}; // extractNewSamples state: lastSampleTs, lastBr, lastHrv
  let destroyed = false;

  // The SDK keeps one listener per event (a second on() replaces the first) and catches listener errors.
  sdk.on('processingStatus', (status) => {
    console.log(`[presage] ${nameOf(ProcessingStatus, status)}`);
    if (status === ProcessingStatus.kRunning) onStatus('Reading your pulse. Hold still for a few seconds.');
  });

  sdk.on('validationStatus', (code, _tsUs, sdkHint) => {
    const name = nameOf(ValidationCode, code);
    const hint = code === ValidationCode.kOk ? '' : HINTS[name] || sdkHint || name;
    if (hint !== lastHint) {
      lastHint = hint;
      onStatus(hint);
    }
  });

  sdk.on('metrics', (buf, eventTsUs) => {
    let m;
    try {
      m = decodeMetrics(buf); // SDK registers its bundled protobufjs Metrics class by default
    } catch (err) {
      return console.error('[presage] could not decode metrics:', err.message);
    }
    if (!m || Buffer.isBuffer(m)) return;
    const out = extractNewSamples(m, samples, { anchor, minConfidence: config.presageMinConfidence, eventTsUs });
    samples = out.state;
    for (const r of out.readings) onReading(r);
  });

  sdk.on('error', (code, message, retryable) => {
    console.error(`[presage] error ${code}${retryable ? ' (retryable)' : ''}: ${message}`);
    if (FATAL_ERROR_CODES.has(code)) return fatal(ERROR_TEXT[code]);
    onStatus(ERROR_TEXT[code] || `Presage error: ${message}`);
  });

  sdk.useCustomInput(FrameTransform?.kNone ?? 0);
  // start() is synchronous in 3.3.0 and throws an Error with .code on failure (bad key, no credits...).
  // Awaiting also covers a future version that returns a Promise.
  await sdk.start();

  return {
    // frame: Buffer = [8-byte float64 LE capture time in ms since epoch][JPEG bytes]
    sendFrame(frame) {
      if (destroyed || frame.length < 100) return;
      const captureMs = frame.readDoubleLE(0);
      let img;
      try {
        img = jpeg.decode(frame.subarray(8), { useTArray: true, formatAsRGBA: true });
      } catch {
        return;
      }
      // Frame times follow the browser's capture clock in epoch µs (what the SDK's own bindings feed it).
      // Readings are mapped back onto the server's clock, anchored at the first frame, so a skewed
      // browser clock can't push readings outside the stress engine's time windows.
      frameClock = nextFrameTimestampUs(frameClock, captureMs);
      if (!anchor) anchor = { sdkUs: frameClock.us, epochMs: Date.now() };
      try {
        sdk.sendFrame(img.data, img.width, img.height, img.width * 4, PixelFormat.kRGBA, frameClock.us);
      } catch {
        // not running yet / stopping: drop the frame
      }
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await sdk.destroy(); // Promise in 3.3.0; waits for native teardown
    },
  };
}

// --- process wiring ---------------------------------------------------------
if (sdkMod && jpeg) {
  try {
    session = await createPresageSession({
      onReading: (r) => send({ type: 'reading', ...r }),
      onStatus: (text) => send({ type: 'status', text }),
    });
    if (stopping) await session.destroy();
  } catch (err) {
    const text =
      ERROR_TEXT[err?.code] || (/auth|key/i.test(err?.message) ? ERROR_TEXT[2] : `Presage could not start: ${err?.message || err}`);
    fatal(text);
  }
}
