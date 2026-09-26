async function call(method, path, body, { timeoutMs } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`${method} ${path} failed: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// The backend caps Gemini at ~12 s and ElevenLabs at ~8 s, so a turn that takes longer than this is lost.
const TURN_TIMEOUT_MS = 35000;

export const api = {
  health: () => call('GET', '/api/health'),
  startSession: (opts) => call('POST', '/api/sessions', opts),
  // turnId makes retries safe: the server stores the answer once and returns the same reply.
  turn: (id, answer, turnId) => call('POST', `/api/sessions/${id}/turn`, { answer, turnId }, { timeoutMs: TURN_TIMEOUT_MS }),
  end: (id) => call('POST', `/api/sessions/${id}/end`),
};

export function newTurnId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Merge transcript entries from any source (turn response, websocket, reconnect snapshot) without duplicates.
// Server entries are keyed by ts + speaker + text. Local "pending" entries (an answer we just sent) are
// dropped once the server's copy of that answer arrives.
export function mergeUtterances(current, incoming) {
  if (!incoming?.length) return current;
  const key = (u) => `${u.ts}|${u.speaker}|${u.text}`;
  const byKey = new Map();
  for (const u of [...current, ...incoming]) if (!u.pending) byKey.set(key(u), u);
  const confirmed = [...byKey.values()].sort((a, b) => a.ts - b.ts);
  const pending = current.filter((u) => u.pending && answerCount(confirmed, u.text) <= u.baseCount);
  const merged = [...confirmed, ...pending];
  return merged.length === current.length && merged.every((u, i) => u === current[i]) ? current : merged;
}

// Show an answer right away while the turn is in flight. Replaces any earlier pending answer
// (a failed turn the user chose not to retry).
export function addPendingAnswer(current, text, turnId) {
  const confirmed = current.filter((u) => !u.pending);
  return [
    ...confirmed,
    { pending: true, turnId, speaker: 'candidate', text, ts: Date.now(), baseCount: answerCount(confirmed, text) },
  ];
}

function answerCount(list, text) {
  return list.filter((u) => !u.pending && u.speaker === 'candidate' && u.text === text).length;
}

// Live updates for one session: vitals, state changes, utterances.
// Reconnects with backoff (proxies and Codespaces drop idle sockets); on every (re)connect the server
// sends a {type: "transcript"} snapshot so nothing said while disconnected is lost.
export function subscribe(sessionId, onMessage, onStatus) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/client?session=${sessionId}`;
  let ws;
  let timer;
  let attempt = 0;
  let closed = false;

  const connect = () => {
    let openedAt = 0;
    ws = new WebSocket(url);
    ws.onopen = () => {
      openedAt = Date.now();
      onStatus?.('open');
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      onMessage(msg);
    };
    ws.onclose = () => {
      if (closed) return;
      if (openedAt && Date.now() - openedAt > 5000) attempt = 0; // only a socket that stayed up resets the backoff
      onStatus?.('reconnecting');
      timer = setTimeout(connect, Math.min(5000, 500 * 2 ** attempt++));
    };
    ws.onerror = () => {}; // onclose follows and schedules the reconnect
  };
  connect();

  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}
