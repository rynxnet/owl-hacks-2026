// Server-side Presage: the browser streams webcam frames (JPEG) to /ws/camera and the
// SmartSpectra SDK reads heart rate from them. The SDK runs in a separate child process
// (presageWorker.js) so an error or native crash only loses heart rate, never the interview.
//
// Optional: if PRESAGE_API_KEY is empty or the SDK isn't installed, presageAvailable() is false
// and the app falls back to the laptop bridge (presage-bridge/) or the simulator.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const require = createRequire(import.meta.url);
let loadError = '';
if (config.presageKey) {
  try {
    require.resolve('@smartspectra/node-sdk');
    require.resolve('jpeg-js');
  } catch (err) {
    loadError = 'SDK not installed (run npm install in backend/)';
    console.error('[presage] server-side heart rate is off:', loadError);
  }
}

export const presageAvailable = () => Boolean(config.presageKey) && !loadError;
export const presageLoadError = () => loadError;

const WORKER = fileURLToPath(new URL('./presageWorker.js', import.meta.url));
const MAX_IN_FLIGHT = 4; // frames sent but not yet processed; beyond this we drop (CPU can't keep up)

// onReading({ hr, br, hrv, confidence, stable, ts }) is called once per Presage pulse sample, in order;
// ts is the sample's own time in epoch ms (not the time it arrived). onStatus(text) gets positioning hints.
export function createPresageSession({ onReading, onStatus }) {
  let child = null;
  let inFlight = 0;
  let destroyed = false;
  let crashes = 0;

  function spawn() {
    inFlight = 0;
    child = fork(WORKER, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.on('message', (msg) => {
      if (msg.type === 'ack') inFlight = Math.max(0, inFlight - 1);
      else if (msg.type === 'reading') {
        // Full reading: { hr, br, hrv, confidence, stable, ts } with ts = epoch ms of the Presage sample.
        const { hr, br = null, hrv = null, confidence = null, stable = null, ts } = msg;
        onReading({ hr, br, hrv, confidence, stable, ts });
      }
      else if (msg.type === 'status') onStatus(msg.text);
      else if (msg.type === 'fatal') {
        console.error('[presage]', msg.text);
        onStatus(msg.text);
        crashes = 99; // config problem (bad key, missing SDK): don't keep restarting
      }
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (destroyed || crashes >= 99) return;
      crashes += 1;
      console.error(`[presage] worker exited (${signal || code}), crash ${crashes}/3`);
      if (crashes < 3) {
        onStatus('Heart-rate reader restarted. Hold still...');
        spawn();
      } else {
        onStatus('Heart-rate reader stopped. The interview continues without it.');
      }
    });
  }
  spawn();

  return {
    sendFrame(frame) {
      if (destroyed || !child?.connected || inFlight >= MAX_IN_FLIGHT) return;
      inFlight += 1;
      child.send({ type: 'frame', frame }, (err) => {
        if (err) inFlight = Math.max(0, inFlight - 1);
      });
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      const c = child;
      if (!c) return;
      if (c.connected) c.send({ type: 'stop' });
      setTimeout(() => c.exitCode === null && c.kill(), 3000);
    },
  };
}
