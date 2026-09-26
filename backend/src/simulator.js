// Fake heart-rate source so the team can build without Presage.
// It connects to /ws/vitals exactly like the real Presage bridge.
//
//   npm run sim
//   Keys while running:  u = stress up   d = calm down   s = spike   q = quit
import WebSocket from 'ws';
import readline from 'node:readline';

const URL = process.env.VITALS_URL || 'ws://localhost:3001/ws/vitals';
const RESTING = Number(process.env.SIM_RESTING_HR || 74);

let target = RESTING;
let hr = RESTING;
let spikeUntil = 0;

function connect() {
  const ws = new WebSocket(URL);
  let timer;
  ws.on('open', () => {
    console.log(`[sim] sending vitals to ${URL}  (u = up, d = down, s = spike, q = quit)`);
    timer = setInterval(() => {
      const goal = Date.now() < spikeUntil ? target + 25 : target;
      hr += (goal - hr) * 0.15 + (Math.random() - 0.5) * 2.5; // drift toward goal + noise
      const br = 12 + (hr - RESTING) / 6 + (Math.random() - 0.5);
      ws.send(JSON.stringify({ ts: Date.now(), hr: +hr.toFixed(1), br: +br.toFixed(1), source: 'simulator' }));
    }, 1000);
  });
  ws.on('close', () => {
    clearInterval(timer);
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
