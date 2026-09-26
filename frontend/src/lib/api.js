async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return res.json();
}

export const api = {
  health: () => call('GET', '/api/health'),
  startSession: (opts) => call('POST', '/api/sessions', opts),
  turn: (id, answer) => call('POST', `/api/sessions/${id}/turn`, { answer }),
  end: (id) => call('POST', `/api/sessions/${id}/end`),
};

// Live updates for one session: vitals, state changes, utterances.
export function subscribe(sessionId, onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/client?session=${sessionId}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  return () => ws.close();
}
