// Presage sanity check:  npm run check:presage            (install + key + SDK surface)
//                        npm run check:presage -- --live  (also starts a real SDK session, needs the key)
//
// --live pushes ~5 s of synthetic gray frames through the custom-input path the server uses and reports
// the SDK's status / validation / error events. There is no face, so no pulse comes out; the point is to
// prove that the key works, start() succeeds and sendFrame() accepts our frames and timestamps.
import { createRequire } from 'node:module';
import { config } from './config.js';
import { nextFrameTimestampUs, nameOf } from './presageSamples.js';

const LIVE = process.argv.includes('--live');
const LIVE_SECONDS = 5;
const FPS = 15;
const WIDTH = 640;
const HEIGHT = 480;

const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
console.log(`Node ${process.version} on ${process.platform}-${process.arch}${glibc ? `, glibc ${glibc}` : ''}`);
if (Number(process.versions.node.split('.')[0]) < 20) console.log('✗ The Presage SDK needs Node 20 or newer.');
if (glibc && glibc.startsWith('2.') && Number(glibc.split('.')[1]) < 35) {
  console.log(`✗ Presage needs glibc 2.35+. This machine has ${glibc}.`);
  console.log('  In a Codespace: pull the latest main, then Command Palette -> "Codespaces: Rebuild Container".');
}
if (!config.presageKey) console.log('✗ PRESAGE_API_KEY is empty in backend/.env');
else console.log(`✓ Key loaded (ends in ...${config.presageKey.slice(-4)})`);

const require = createRequire(import.meta.url);
let pkgVersion = 'unknown';
try {
  pkgVersion = require('@smartspectra/node-sdk/package.json').version;
} catch {}

let sdk;
try {
  sdk = await import('@smartspectra/node-sdk');
} catch (err) {
  console.log(`✗ SDK failed to load (package ${pkgVersion}):`, err.message);
  console.log('  Try: npm install   (it is an optional dependency, so a failed download is silent)');
  process.exit(1);
}
console.log(`✓ SDK loaded: package ${pkgVersion}, SmartSpectraSDK.version ${sdk.SmartSpectraSDK?.version ?? 'unknown'}`);
const names = Object.keys(sdk).filter((k) => k !== 'default').sort();
console.log(`  exports: ${names.join(', ')}`);
const needed = ['SmartSpectraSDK', 'decodeMetrics', 'PixelFormat', 'FrameTransform', 'ProcessingStatus', 'ValidationCode', 'cardioMetrics', 'breathingMetrics'];
const missing = needed.filter((n) => !(n in sdk));
if (missing.length) console.log(`✗ Missing exports this app uses: ${missing.join(', ')} (API changed?)`);
const proto = sdk.SmartSpectraSDK?.prototype || {};
const methods = ['useCustomInput', 'sendFrame', 'start', 'destroy', 'on'].filter((m) => typeof proto[m] !== 'function');
if (methods.length) console.log(`✗ Missing SmartSpectraSDK methods: ${methods.join(', ')} (API changed?)`);

// decodeMetrics must return a decoded message, not the raw Buffer (it does when a Metrics class is registered).
try {
  const empty = sdk.decodeMetrics(Buffer.alloc(0));
  if (Buffer.isBuffer(empty)) console.log('✗ decodeMetrics returned a raw Buffer: no protobuf Metrics class registered.');
  else console.log(`✓ decodeMetrics works (empty message has cardio=${JSON.stringify(empty?.cardio ?? null)})`);
} catch (err) {
  console.log('✗ decodeMetrics threw on an empty buffer:', err.message);
}

try {
  await import('jpeg-js');
  console.log('✓ jpeg-js loaded');
} catch {
  console.log('✗ jpeg-js missing: run npm install');
}

if (!LIVE) {
  console.log(
    config.presageKey
      ? config.presageMode === 'server'
        ? '\nReady. PRESAGE_MODE=server: restart the backend; the setup screen should show "Presage (webcam)".'
        : '\nKey and SDK OK. PRESAGE_MODE is bridge (default): heart rate comes from presage-bridge (cd presage-bridge && npm start).'
      : '',
  );
  console.log('Run with --live to start a real SDK session with synthetic frames.');
  process.exit(0);
}
if (!config.presageKey) {
  console.log('\n--live skipped: set PRESAGE_API_KEY in backend/.env first (the SDK has no offline mode).');
  process.exit(1);
}

// --- live custom-input session -------------------------------------------------
console.log(`\nLive check: ${LIVE_SECONDS}s of ${WIDTH}x${HEIGHT} gray RGBA frames at ${FPS} fps (no face, so no pulse expected)`);
const { SmartSpectraSDK, ProcessingStatus, ValidationCode, SmartSpectraErrorCode, PixelFormat, FrameTransform, breathingMetrics, cardioMetrics } =
  sdk;
const counts = { accepted: 0, rejected: 0, threw: 0, metrics: 0 };
const errors = [];
const live = new SmartSpectraSDK({ apiKey: config.presageKey, requestedMetrics: [...breathingMetrics, ...cardioMetrics] });
live.on('processingStatus', (s) => console.log(`  processingStatus: ${nameOf(ProcessingStatus, s)} (${s})`));
let lastValidation = null;
live.on('validationStatus', (code, tsUs, hint) => {
  if (code === lastValidation) return;
  lastValidation = code;
  console.log(`  validationStatus: ${nameOf(ValidationCode, code)} (${code}) at ${tsUs} µs${hint ? ` "${hint}"` : ''}`);
});
live.on('metrics', (buf, tsUs) => {
  counts.metrics += 1;
  if (counts.metrics <= 3) console.log(`  metrics: ${buf.length} bytes at ${tsUs} µs`);
});
live.on('error', (code, message, retryable) => {
  errors.push(code);
  console.log(`  error: ${nameOf(SmartSpectraErrorCode, code)} (${code})${retryable ? ' retryable' : ''}: ${message}`);
});
process.on('unhandledRejection', (err) => console.log('  unhandled rejection:', err?.message || err));

const watchdog = setTimeout(() => {
  console.log('✗ Live check hung (no exit after 30 s).');
  process.exit(1);
}, 30000);
watchdog.unref();

try {
  live.useCustomInput(FrameTransform.kNone);
  await live.start(); // synchronous in 3.3.0; throws Error with .code (e.g. 2 = key rejected)
  console.log('✓ start() succeeded');
} catch (err) {
  console.log(`✗ start() threw: ${err.message}${err.code != null ? ` (code ${err.code})` : ''}`);
  await live.destroy().catch(() => {});
  process.exit(1);
}

const frame = Buffer.alloc(WIDTH * HEIGHT * 4, 128);
let clock = null;
for (let i = 0; i < LIVE_SECONDS * FPS; i++) {
  clock = nextFrameTimestampUs(clock, Date.now());
  try {
    if (live.sendFrame(frame, WIDTH, HEIGHT, WIDTH * 4, PixelFormat.kRGBA, clock.us)) counts.accepted += 1;
    else counts.rejected += 1;
  } catch (err) {
    counts.threw += 1;
    if (counts.threw === 1) console.log(`  sendFrame threw: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1000 / FPS));
}
console.log(`  frames: ${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.threw} threw; metrics messages: ${counts.metrics}`);
await live.destroy();
const ok = counts.accepted > 0 && counts.threw === 0 && !errors.some((c) => [2, 3, 4, 10].includes(c));
console.log(ok ? '✓ Live check passed: the SDK starts and accepts frames and timestamps.' : '✗ Live check failed (see above).');
process.exit(ok ? 0 : 1);
