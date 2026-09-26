// Pipes Presage output into the backend.
//
//   <presage sample program> | node relay.js
//
// Reads lines from stdin, pulls out heart rate (and breathing rate if present),
// and sends {"hr": 82, "br": 14} to ws://localhost:3001/ws/vitals.
//
// It understands two kinds of lines:
//   1. JSON lines, e.g. {"pulse_rate": 82.1, "breathing_rate": 14.2}
//   2. Plain text, e.g. "Pulse: 82.1 BPM  Breathing: 14.2"
// If Presage's sample prints something different, change HR_PATTERN / BR_PATTERN below
// (or set them with env vars) after looking at its real output.
import WebSocket from 'ws';
import readline from 'node:readline';

const URL = process.env.VITALS_URL || 'ws://localhost:3001/ws/vitals';
const HR_PATTERN = new RegExp(process.env.HR_PATTERN || '(?:pulse|heart|hr|bpm)[^0-9]{0,20}([0-9]{2,3}(?:\\.[0-9]+)?)', 'i');
const BR_PATTERN = new RegExp(process.env.BR_PATTERN || '(?:breath|br|resp)[^0-9]{0,20}([0-9]{1,2}(?:\\.[0-9]+)?)', 'i');
const JSON_HR_KEYS = ['hr', 'pulse', 'pulse_rate', 'pulseRate', 'heart_rate', 'heartRate'];
const JSON_BR_KEYS = ['br', 'breathing', 'breathing_rate', 'breathingRate', 'respiration_rate'];

let ws;
function connect() {
  ws = new WebSocket(URL);
  ws.on('open', () => console.error(`[relay] connected to ${URL}`));
  ws.on('close', () => setTimeout(connect, 2000));
  ws.on('error', () => {});
}
connect();

function parse(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      const hr = pick(obj, JSON_HR_KEYS);
      if (hr) return { hr, br: pick(obj, JSON_BR_KEYS) };
    } catch {}
  }
  const hr = trimmed.match(HR_PATTERN)?.[1];
  if (!hr) return null;
  return { hr: Number(hr), br: Number(trimmed.match(BR_PATTERN)?.[1]) || null };
}

function pick(obj, keys) {
  for (const k of keys) if (obj[k] != null && Number(obj[k]) > 0) return Number(obj[k]);
  return null;
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const v = parse(line);
  if (!v || v.hr < 35 || v.hr > 220) return; // ignore junk readings
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ts: Date.now(), ...v, source: 'presage' }));
    console.error(`[relay] hr=${v.hr}${v.br ? ` br=${v.br}` : ''}`);
  }
});
