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

// End the interview / fetch the replay, with a client-side timeout. The server answers within
// ~25 s even if Gemini hangs, so 40 s means the backend itself is gone. Errors carry .status
// (404 = the backend restarted and forgot the session, 0 = network error or timeout).
export async function endInterview(id, { answer, retryFeedback, timeoutMs = 40000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/sessions/${id}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: answer || undefined, retryFeedback: retryFeedback || undefined }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`End interview failed: ${res.status}`), { status: res.status });
    return await res.json();
  } catch (err) {
    if (err.status == null) err.status = 0;
    if (err.name === 'AbortError') err.message = 'The backend took too long to respond.';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchReplay(id) {
  const res = await fetch(`/api/sessions/${id}/replay`);
  if (!res.ok) throw Object.assign(new Error(`Replay failed: ${res.status}`), { status: res.status });
  return res.json();
}
