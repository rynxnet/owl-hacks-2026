// `npm start` runs this. It runs presage.js and brings it back if Presage gets stuck or crashes,
// so one bad moment (error 8 "processing failed", a camera hiccup) doesn't end heart rate for the demo.
//
//   exit 0  -> you stopped it (Ctrl+C): stop
//   exit 78 -> setup problem (no key, key rejected, no credits): stop and say so
//   else    -> restart after a short pause (gives up after 8 restarts in 2 minutes)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXIT_SETUP = 78;
const WINDOW_MS = 120000;
const MAX_RESTARTS = 8;

let child = null;
let stopping = false;
let restarts = [];

function run() {
  child = spawn(process.execPath, [path.join(DIR, 'presage.js'), ...process.argv.slice(2)], { cwd: DIR, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || code === 0) return process.exit(0);
    if (code === EXIT_SETUP) {
      console.error('[bridge] Presage stopped because of a setup problem (see the message above). Fix it, then run npm start again.');
      return process.exit(1);
    }
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < WINDOW_MS);
    restarts.push(now);
    if (restarts.length > MAX_RESTARTS) {
      console.error(`[bridge] Presage restarted ${MAX_RESTARTS} times in 2 minutes; giving up. Check the camera (close other apps using it) and the lighting, then run npm start again.`);
      return process.exit(1);
    }
    const delay = Math.min(1000 * restarts.length, 5000);
    console.log(`[bridge] Presage exited (${signal || `code ${code}`}); restarting in ${delay / 1000}s...`);
    setTimeout(run, delay);
  });
}

function stop() {
  stopping = true;
  if (!child) return process.exit(0);
  child.kill('SIGINT');
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run();
