// Fake heart-rate source so the team can build without Presage.
// It connects to /ws/vitals exactly like the real Presage bridge.
//
//   npm run sim
//   Keys while running:  u = stress up   d = calm down   s = spike   q = quit
//
// To exercise the backend's VitalsFilter it behaves like a webcam pulse reader: ~1 reading per
// second with a little timing jitter, beat-to-beat noise, the odd single-reading glitch
// (+/-40 bpm for one sample, which the filter should drop) and the odd dropout of a few seconds
// (face lost). Turn the glitches and dropouts off with SIM_GLITCHES=0.
//
// Env: VITALS_URL (default ws://localhost:3001/ws/vitals), SIM_RESTING_HR (74),
//      SIM_GLITCHES (1), SIM_GLITCH_RATE (0.03 per reading), SIM_DROPOUT_RATE (0.01 per reading)
import 'dotenv/config'; // so SIM_* in backend/.env apply
import WebSocket from 'ws';
import readline from 'node:readline';

const URL = process.env.VITALS_URL || 'ws://localhost:3001/ws/vitals';
const RESTING = Number(process.env.SIM_RESTING_HR || 74);
const GLITCHES = process.env.SIM_GLITCHES !== '0';
const GLITCH_RATE = Number(process.env.SIM_GLITCH_RATE || 0.03);
const DROPOUT_RATE = Number(process.env.SIM_DROPOUT_RATE || 0.01);

let target = RESTING;
let hr = RESTING;
let spikeUntil = 0;
let dropoutUntil = 0;

function connect() {
  const ws = new WebSocket(URL);
  let timer = null;
  let open = false;

  // ~1 Hz with +/-150 ms jitter (real readers don't tick perfectly).
  const schedule = () => {
    timer = setTimeout(tick, 1000 + (Math.random() - 0.5) * 300);
  };

  function tick() {
    if (!open) return;
    const now = Date.now();
    const goal = now < spikeUntil ? target + 25 : target;
    hr += (goal - hr) * 0.15 + (Math.random() - 0.5) * 2.5; // drift toward goal + noise

    if (GLITCHES && now >= dropoutUntil && Math.random() < DROPOUT_RATE) {
      dropoutUntil = now + 3000 + Math.random() * 4000; // face lost for 3-7 s
      console.log(`[sim] dropout for ${Math.round((dropoutUntil - now) / 1000)} s`);
    }
    if (now >= dropoutUntil) {
      let sent = hr;
      if (GLITCHES && Math.random() < GLITCH_RATE) {
        sent = hr + (Math.random() < 0.7 ? 40 : -40); // one bad camera frame
        console.log(`[sim] glitch: sending ${sent.toFixed(0)} instead of ${hr.toFixed(0)}`);
      }
      const br = 12 + (hr - RESTING) / 6 + (Math.random() - 0.5);
      const confidence = +(0.75 + Math.random() * 0.2).toFixed(2);
      ws.send(
        JSON.stringify({ ts: now, hr: +sent.toFixed(1), br: +br.toFixed(1), confidence, source: 'simulator' }),
      );
    }
    schedule();
  }

  ws.on('open', () => {
    open = true;
    console.log(
      `[sim] sending vitals to ${URL}  (u = up, d = down, s = spike, q = quit)${GLITCHES ? '' : '  [glitches off]'}`,
    );
    schedule();
  });
  ws.on('close', () => {
    open = false;
    clearTimeout(timer);
    console.log('[sim] disconnected, retrying in 2s');
    setTimeout(connect, 2000);
  });
  ws.on('error', () => {});
}

if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_s, key) => {
    if (!key) return;
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) process.exit(0);
    if (key.name === 'u') target += 8;
    if (key.name === 'd') target = Math.max(RESTING, target - 8);
    if (key.name === 's') spikeUntil = Date.now() + 8000;
    console.log(`[sim] target ${target} bpm${Date.now() < spikeUntil ? ' (spiking)' : ''}`);
  });
}

connect();
