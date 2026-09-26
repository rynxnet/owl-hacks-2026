// End-of-interview feedback / replay tests. Plain node, no framework deps beyond `ws`:
//   node backend/test/feedback.test.mjs
// Uses the offline harness (fake Gemini) when the real SDK is absent: symlink
//   ln -sfn /home/claude/harness/node_modules backend/node_modules
// Fake Gemini env: MOCK_GEMINI (all calls), MOCK_GEMINI_FEEDBACK / MOCK_GEMINI_FEEDBACK_DELAY (feedback call only).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 3102);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(env = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: 'fake',
      ELEVENLABS_API_KEY: '',
      DATABASE_URL: '',
      PRESAGE_API_KEY: '',
      BASELINE_MS: '3000',
      WINDOW_MS: '2000',
      HOLD_MS: '1000',
      MOCK_GEMINI: 'ok',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const t0 = Date.now();
  while (!/backend on/.test(out)) {
    if (child.exitCode != null || Date.now() - t0 > 8000) throw new Error(`server did not start:\n${out}`);
    await sleep(50);
  }
  child.log = () => out;
  return child;
}
async function stopServer(child) {
  child.kill();
  await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
}

async function http(method, p, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, ms: Date.now() - t0 };
}

// Scripted heart-rate source: sends the current `hr` every 100 ms.
async function vitalsSource(sessionId) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/vitals`);
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  const src = { hr: 72 };
  const timer = setInterval(() => {
    const noise = (Math.random() - 0.5) * 1; // +-0.5 bpm
    ws.send(JSON.stringify({ sessionId, hr: +(src.hr + noise).toFixed(1) }));
  }, 100);
  src.close = () => (clearInterval(timer), ws.close());
  return src;
}

const newSession = async () => (await http('POST', '/api/sessions', { persona: 'cold', maxQuestions: 6 })).json.id;
const turn = (id, answer = '') => http('POST', `/api/sessions/${id}/turn`, { answer });
const end = (id, body) => http('POST', `/api/sessions/${id}/end`, body);
const questionsOf = (r) => r.utterances.filter((u) => u.speaker === 'interviewer');

function assertCoaching(r) {
  assert.ok(r.feedback, 'feedback present');
  assert.equal(typeof r.feedback.summary, 'string');
  assert.ok(r.feedback.summary.length > 10, 'summary not empty');
  assert.ok(!r.feedbackError, `no feedbackError (got ${r.feedbackError})`);
}

// ---------------------------------------------------------------------------
const tests = [];
const test = (name, env, fn) => tests.push({ name, env, fn });

test('normal flow: spike after Q2 is the top spike', {}, async () => {
  const id = await newSession();
  const hr = await vitalsSource(id);
  await sleep(3400); // baseline at ~72
  await turn(id); // Q1
  await sleep(1500);
  await turn(id, 'answer one'); // Q2
  hr.hr = 100; // big spike while answering Q2
  await sleep(1500);
  hr.hr = 72;
  await sleep(800);
  await turn(id, 'answer two'); // Q3
  await sleep(1500);
  await turn(id, 'answer three'); // Q4
  hr.hr = 82; // smaller spike after Q4
  await sleep(1500);
  hr.hr = 72;
  await sleep(500);
  hr.close();
  const r = (await end(id)).json;
  const q = questionsOf(r);
  assert.equal(q.length, 4);
  assert.ok(r.baseline > 70 && r.baseline < 74, `baseline ${r.baseline}`);
  assert.ok(r.spikes.length >= 2, `spikes: ${JSON.stringify(r.spikes)}`);
  assert.equal(r.spikes[0].ts, q[1].ts, 'top spike is Q2');
  assert.ok(Math.abs(r.spikes[0].rise - 28) <= 2, `Q2 rise ${r.spikes[0].rise}`);
  assert.equal(r.spikes[1].ts, q[3].ts, 'second spike is Q4');
  assert.ok(Math.abs(r.spikes[1].rise - 10) <= 2, `Q4 rise ${r.spikes[1].rise}`);
  for (const s of r.spikes) assert.ok(s.rise > 0, 'no zero/negative rises reported');
  assertCoaching(r);
  const again = await http('GET', `/api/sessions/${id}/replay`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.feedback, r.feedback);
});

test('no vitals at all (skipped baseline, no Presage)', {}, async () => {
  const id = await newSession();
  await turn(id);
  await turn(id, 'my answer');
  const res = await end(id);
  assert.equal(res.status, 200);
  const r = res.json;
  assert.deepEqual(r.vitals, []);
  assert.deepEqual(r.spikes, []);
  assert.equal(r.baseline, null);
  assertCoaching(r);
});

test('vitals but baseline never finished: fallback baseline still finds spikes', {}, async () => {
  const id = await newSession();
  const hr = await vitalsSource(id);
  await sleep(1000); // < BASELINE_MS, engine has no baseline
  await turn(id);
  hr.hr = 95;
  await sleep(1200);
  hr.close();
  const r = (await end(id)).json;
  assert.ok(r.vitals.length > 5);
  assert.ok(r.baseline > 70 && r.baseline < 75, `fallback baseline ${r.baseline}`);
  assert.equal(r.baselineEstimated, true);
  assert.equal(r.spikes.length, 1);
  assert.ok(r.spikes[0].rise >= 20, `rise ${r.spikes[0].rise}`);
});

test('double /end concurrently: both get the same non-null feedback', { MOCK_GEMINI_FEEDBACK: 'slow', MOCK_GEMINI_FEEDBACK_DELAY: '1500' }, async () => {
  const id = await newSession();
  await turn(id);
  await turn(id, 'an answer');
  const [a, b] = await Promise.all([end(id), end(id)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assertCoaching(a.json);
  assertCoaching(b.json);
  assert.deepEqual(a.json.feedback, b.json.feedback);
  const c = await end(id); // a late third call is instant and consistent
  assert.deepEqual(c.json.feedback, a.json.feedback);
  assert.ok(c.ms < 500);
});

test('slow Gemini: /end returns by the timeout with feedbackError, late result is kept', { MOCK_GEMINI_FEEDBACK: 'slow', MOCK_GEMINI_FEEDBACK_DELAY: '3500', FEEDBACK_TIMEOUT_MS: '1500' }, async () => {
  const id = await newSession();
  await turn(id);
  await turn(id, 'an answer');
  const res = await end(id);
  assert.equal(res.status, 200);
  assert.ok(res.ms < 2500, `took ${res.ms} ms`);
  assert.equal(res.json.feedbackError, 'timeout');
  assert.equal(res.json.utterances.length, 3);
  await sleep(2500); // Gemini answers late: replay picks it up
  const later = await http('GET', `/api/sessions/${id}/replay`);
  assertCoaching(later.json);
});

test('Gemini hangs: a retry call is also bounded by the timeout', { MOCK_GEMINI_FEEDBACK: 'slow', MOCK_GEMINI_FEEDBACK_DELAY: '60000', FEEDBACK_TIMEOUT_MS: '800' }, async () => {
  const id = await newSession();
  const a = await end(id);
  assert.equal(a.json.feedbackError, 'timeout');
  const b = await end(id, { retryFeedback: true });
  assert.equal(b.json.feedbackError, 'timeout');
  assert.ok(b.ms >= 700 && b.ms < 2000, `retry waited ${b.ms} ms`);
});

test('Gemini error: /end still returns the replay with feedbackError', { MOCK_GEMINI_FEEDBACK: 'error' }, async () => {
  const id = await newSession();
  await turn(id);
  await turn(id, 'an answer');
  const res = await end(id);
  assert.equal(res.status, 200);
  assert.ok(res.json.feedbackError, 'feedbackError set');
  assert.equal(res.json.utterances.length, 3);
});

test('Gemini returns a JSON array: coaching is unwrapped', { MOCK_GEMINI_FEEDBACK: 'array' }, async () => {
  const id = await newSession();
  await turn(id);
  const r = (await end(id)).json;
  assertCoaching(r);
});

for (const mode of ['badjson', 'fence', 'empty']) {
  test(`Gemini feedback "${mode}": replay still returned, never an empty coaching card`, { MOCK_GEMINI_FEEDBACK: mode }, async () => {
    const id = await newSession();
    await turn(id);
    const res = await end(id);
    assert.equal(res.status, 200);
    const r = res.json;
    // Either the coaching was recovered or the UI is told it failed; never feedback:null with no error.
    assert.ok((r.feedback && r.feedback.summary) || r.feedbackError, JSON.stringify(r.feedback));
  });
}

test('breathing prompt is not reported as a spike question (canned interviewer, no key)', { GEMINI_API_KEY: '' }, async () => {
  const id = await newSession();
  const hr = await vitalsSource(id);
  await sleep(3400);
  await turn(id); // Q1
  hr.hr = 110; // overloaded
  await sleep(3500);
  const b = await turn(id, 'panicking answer');
  assert.equal(b.json.action, 'breathe', `expected breathe, got ${JSON.stringify(b.json)}`);
  await sleep(1000);
  hr.hr = 72;
  await sleep(2500);
  await turn(id); // Q2
  await sleep(1000);
  hr.close();
  const r = (await end(id)).json;
  const q = questionsOf(r);
  assert.equal(q[1].action, 'breathe');
  assert.ok(r.spikes.every((s) => s.ts !== q[1].ts), 'breathing prompt excluded');
  assert.equal(r.spikes[0].ts, q[0].ts, 'Q1 owns the spike that triggered the pause');
  assert.ok(r.feedback?.summary, 'no-key feedback message still shown');
});

test('final answer sent with /end is kept in the transcript', {}, async () => {
  const id = await newSession();
  await turn(id);
  const r = (await end(id, { answer: 'my unfinished final answer' })).json;
  assert.equal(r.utterances.at(-1).speaker, 'candidate');
  assert.equal(r.utterances.at(-1).text, 'my unfinished final answer');
  const again = (await end(id, { answer: 'dup' })).json; // not added twice
  assert.equal(again.utterances.length, r.utterances.length);
});

test('unknown session id: 404 JSON on /end and /replay', {}, async () => {
  const a = await end('does-not-exist');
  assert.equal(a.status, 404);
  assert.equal(a.json.error, 'session not found');
  const b = await http('GET', '/api/sessions/does-not-exist/replay');
  assert.equal(b.status, 404);
});

// ---------------------------------------------------------------------------
const only = process.argv[2];
let failed = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  const server = await startServer(t.env);
  const t0 = Date.now();
  try {
    await t.fn();
    console.log(`PASS  ${t.name}  (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${err.stack.split('\n').slice(0, 3).join('\n      ')}`);
    if (process.env.VERBOSE) console.log(server.log());
  } finally {
    await stopServer(server);
  }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
