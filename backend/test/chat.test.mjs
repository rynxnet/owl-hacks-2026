// NOTE (AI interviewer agent): the interviewer no longer has a canned fallback, and each interview now
// makes a persona "briefing" Gemini call before its first turn. Checks here that expect canned
// questions (no key, Gemini error/empty/slow) are superseded: those cases now return HTTP 502 with
// code AI_INTERVIEWER_FAILED. The fake-Gemini harness this file needs was never committed. The
// current interviewer behavior is covered by test/interviewer-agent.test.mjs (no harness needed).
// Chat / interview-turn loop tests.  Run from backend/:   node test/chat.test.mjs
//
// Needs @google/genai + ws resolvable from backend/node_modules. Offline, symlink the harness:
//   ln -sfn /home/claude/harness/node_modules backend/node_modules
// The harness's fake Gemini is steered with MOCK_GEMINI=ok|fence|array|slow|error|empty|badjson|temp_sensitive.
// Uses PORT 3101 by default (TEST_PORT to override). Takes ~30 s (one real 12 s timeout test).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.TEST_PORT || 3101);
const BASE = `http://localhost:${PORT}`;
const MOCK_SAY = 'Tell me about a bug you were proud to fix.';
const ACTIONS = ['ask', 'escalate', 'breathe', 'end'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));

let passed = 0;
let failed = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
  console.log(results.at(-1));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function startServer(env = {}) {
  const log = path.join(TMP, `gemini-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: 'fake',
      ELEVENLABS_API_KEY: '',
      PRESAGE_API_KEY: '',
      DATABASE_URL: '',
      MOCK_GEMINI_LOG: log,
      BASELINE_MS: '3000',
      HOLD_MS: '1000',
      WINDOW_MS: '2000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const deadline = Date.now() + 10000;
  while (!/Pressure Test backend on/.test(out)) {
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`server did not start:\n${out}`);
    await sleep(50);
  }
  return {
    log,
    output: () => out,
    geminiRequests: () =>
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
    stop: () =>
      new Promise((r) => {
        proc.once('exit', r);
        proc.kill();
      }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function newSession(maxQuestions = 6) {
  return (await post('/api/sessions', { persona: 'cold', role: 'Backend Intern', maxQuestions })).body.id;
}

async function timedTurn(id, answer, turnId) {
  const t0 = Date.now();
  const r = await post(`/api/sessions/${id}/turn`, { answer, turnId });
  return { ...r, ms: Date.now() - t0 };
}

const count = (utts, speaker, text) => utts.filter((u) => u.speaker === speaker && u.text === text).length;

async function withServer(env, fn) {
  const srv = await startServer(env);
  try {
    await fn(srv);
  } catch (err) {
    check(`(no exception in ${JSON.stringify(env)})`, false, err.stack);
  } finally {
    await srv.stop();
  }
}

// ---------------------------------------------------------------------------
// 1. Model output shapes: every mode must yield a usable {say, action}
// ---------------------------------------------------------------------------
const MODES = [
  // mode, expect the model's line (true) or a canned fallback (false)
  ['ok', true],
  ['fence', true],
  ['array', true],
  ['badjson', true],
  ['temp_sensitive', true],
  ['empty', false],
  ['error', false],
];
for (const [mode, expectModel] of MODES) {
  await withServer({ MOCK_GEMINI: mode }, async (srv) => {
    const id = await newSession();
    const r = await timedTurn(id, '', 't1');
    const say = r.body?.say || '';
    check(`[${mode}] turn returns 200`, r.status === 200, `status ${r.status}`);
    check(`[${mode}] say is non-empty`, say.trim().length > 0, JSON.stringify(r.body));
    check(`[${mode}] action is valid`, ACTIONS.includes(r.body?.action), r.body?.action);
    if (expectModel) check(`[${mode}] uses the model's line`, say === MOCK_SAY, JSON.stringify(say));
    else check(`[${mode}] falls back to a canned question`, say !== MOCK_SAY && /\?|tell me/i.test(say), say);
    check(`[${mode}] no looping text`, !/(tell me ){3,}/i.test(say), say);
    check(`[${mode}] fast (<3 s)`, r.ms < 3000, `${r.ms} ms`);
  });
}

// ---------------------------------------------------------------------------
// 2. Config sent to Gemini (proves temperature / thinking / schema / abort)
// ---------------------------------------------------------------------------
await withServer({ MOCK_GEMINI: 'ok' }, async (srv) => {
  const id = await newSession();
  await timedTurn(id, '', 'a');
  await timedTurn(id, 'I built a Raspberry Pi assistant.', 'b');
  const reqs = srv.geminiRequests();
  check('[config] Gemini was called for each turn', reqs.length === 2, `${reqs.length} requests`);
  const c = reqs[0]?.config || {};
  check('[config] model is the configured one', reqs[0]?.model === 'gemini-3.8-flash', reqs[0]?.model);
  check('[config] temperature not below 1.0 (Gemini 3 guidance)', c.temperature == null || c.temperature >= 1, c.temperature);
  check('[config] thinkingLevel set (not default HIGH)', ['MINIMAL', 'LOW'].includes(c.thinkingConfig?.thinkingLevel), JSON.stringify(c.thinkingConfig));
  check('[config] no thinkingBudget alongside thinkingLevel', c.thinkingConfig?.thinkingBudget == null);
  check('[config] JSON mime type', c.responseMimeType === 'application/json');
  check('[config] response schema has say/action', Boolean(c.responseJsonSchema?.properties?.say && c.responseJsonSchema?.properties?.action), JSON.stringify(c.responseJsonSchema));
  check('[config] abortSignal passed', 'abortSignal' in c);
  check('[config] httpOptions.timeout set', Number(c.httpOptions?.timeout) > 0, JSON.stringify(c.httpOptions));
  check('[config] systemInstruction present', typeof c.systemInstruction === 'string' && c.systemInstruction.length > 0);
  check('[config] candidate answer reached the prompt', /Raspberry Pi assistant/.test(reqs[1]?.contents || ''));
});

// ---------------------------------------------------------------------------
// 3. Slow Gemini: turn must come back within the timeout with a canned line
// ---------------------------------------------------------------------------
await withServer({ MOCK_GEMINI: 'slow', MOCK_GEMINI_DELAY: '60000' }, async () => {
  const id = await newSession();
  const r = await timedTurn(id, '', 's1');
  check('[slow] turn returns 200', r.status === 200, `status ${r.status}`);
  check('[slow] returns within ~12 s timeout', r.ms < 14000, `${r.ms} ms`);
  check('[slow] canned line is non-empty', (r.body?.say || '').length > 0, JSON.stringify(r.body));
});

// ---------------------------------------------------------------------------
// 3b. API rejects thinkingConfig/schema (400): retry once lean, then stay lean
// ---------------------------------------------------------------------------
await withServer({ MOCK_GEMINI: 'reject_thinking' }, async (srv) => {
  const id = await newSession();
  const r1 = await timedTurn(id, '', 'r1');
  const r2 = await timedTurn(id, 'an answer', 'r2');
  const reqs = srv.geminiRequests();
  check('[reject_thinking] still gets the model line', r1.body?.say === MOCK_SAY && r2.body?.say === MOCK_SAY, JSON.stringify([r1.body?.say, r2.body?.say]));
  check('[reject_thinking] retried without thinkingConfig, then stays lean', reqs.length === 3 && reqs[0].config.thinkingConfig && !reqs[1].config.thinkingConfig && !reqs[2].config.thinkingConfig, JSON.stringify(reqs.map((q) => Boolean(q.config.thinkingConfig))));
});

// ---------------------------------------------------------------------------
// 4. No API key: canned interview, full loop to "end", counters sane
// ---------------------------------------------------------------------------
await withServer({ GEMINI_API_KEY: '' }, async (srv) => {
  const id = await newSession(3);
  const says = [];
  let last;
  for (let i = 0; i < 5; i++) {
    last = await timedTurn(id, i ? `answer number ${i}` : '', `n${i}`);
    says.push(last.body?.say);
    if (last.body?.action === 'end') break;
  }
  check('[nokey] no Gemini requests', srv.geminiRequests().length === 0);
  check('[nokey] ends after maxQuestions', last.body?.action === 'end', JSON.stringify(says));
  check('[nokey] exactly 3 questions + closing line', says.length === 4, says.length);
  check('[nokey] questionCount never exceeds max', last.body?.questionCount <= last.body?.maxQuestions, `${last.body?.questionCount}/${last.body?.maxQuestions}`);
  const questions = says.slice(0, -1).map((s) => s.replace(/^Okay\. Be specific this time\. /, ''));
  check('[nokey] canned questions do not repeat', new Set(questions).size === questions.length, JSON.stringify(questions));
  const after = await timedTurn(id, 'late answer', 'n-late');
  check('[nokey] turn after end stays ended', after.body?.action === 'end', JSON.stringify(after.body));
});

// ---------------------------------------------------------------------------
// 5. Transcript without the websocket + idempotent retry + in-flight lock
// ---------------------------------------------------------------------------
await withServer({ MOCK_GEMINI: 'slow', MOCK_GEMINI_DELAY: '1500' }, async () => {
  const id = await newSession();
  const first = await timedTurn(id, '', 'x1');
  check('[transcript] turn response carries utterances', Array.isArray(first.body?.utterances), Object.keys(first.body || {}).join(','));
  check('[transcript] interviewer line present with ts', first.body?.utterances?.some((u) => u.speaker === 'interviewer' && u.ts && u.text === first.body.say));

  // Double submit of the same answer (Enter spam / retry while first is still running)
  const answer = 'I fixed a race condition in our job queue.';
  const [a, b] = await Promise.all([timedTurn(id, answer, 'x2'), timedTurn(id, answer, 'x2')]);
  check('[dedupe] concurrent same turnId both succeed', a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
  check('[dedupe] concurrent same turnId get the same line', a.body?.say === b.body?.say);
  const utts = b.body?.utterances || [];
  check('[dedupe] answer stored once after concurrent double submit', count(utts, 'candidate', answer) === 1, count(utts, 'candidate', answer));

  // Retry after the response was "lost" (Try again with the same turnId)
  const retry = await timedTurn(id, answer, 'x2');
  check('[retry] retry with same turnId returns 200', retry.status === 200, retry.status);
  check('[retry] retry does not store the answer again', count(retry.body?.utterances || [], 'candidate', answer) === 1);
  check('[retry] retry does not generate an extra interviewer line', (retry.body?.utterances || []).filter((u) => u.speaker === 'interviewer').length === 2);

  // A different turn while one is in flight is rejected, not interleaved
  const p1 = timedTurn(id, 'answer A', 'x3');
  await sleep(100);
  const p2 = await timedTurn(id, 'answer B', 'x4');
  const r1 = await p1;
  check('[lock] overlapping different turn gets 409', p2.status === 409, p2.status);
  check('[lock] first turn still succeeds', r1.status === 200, r1.status);
  check('[lock] rejected answer not stored', count(r1.body?.utterances || [], 'candidate', 'answer B') === 0);
  // After the lock clears, a new turn works
  const r3 = await timedTurn(id, 'answer C', 'x5');
  check('[lock] next turn after lock clears works', r3.status === 200 && count(r3.body.utterances, 'candidate', 'answer C') === 1);
  check('[transcript] strict speaker alternation (no doubles)', r3.body.utterances.every((u, i, arr) => i === 0 || u.speaker !== arr[i - 1].speaker), r3.body.utterances.map((u) => u.speaker[0]).join(''));

  // Legacy clients (no turnId) still work
  const legacy = await post(`/api/sessions/${id}/turn`, { answer: 'no id answer' });
  check('[compat] turn without turnId still works', legacy.status === 200 && legacy.body?.say);
  const missing = await post('/api/sessions/does-not-exist/turn', { answer: 'x' });
  check('[compat] unknown session is 404', missing.status === 404, missing.status);
});

// ---------------------------------------------------------------------------
// 6. Websocket: live utterances, late join snapshot
// ---------------------------------------------------------------------------
await withServer({ MOCK_GEMINI: 'ok' }, async () => {
  const id = await newSession();
  await timedTurn(id, '', 'w1');
  await timedTurn(id, 'answer before socket', 'w2');
  // Late client: should receive what it missed
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/client?session=${id}`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  await sleep(200);
  const snap = msgs.find((m) => m.type === 'transcript');
  check('[ws] late subscriber gets transcript snapshot', snap?.utterances?.length === 3, JSON.stringify(msgs.map((m) => m.type)));
  await timedTurn(id, 'answer with socket', 'w3');
  await sleep(200);
  const live = msgs.filter((m) => m.type === 'utterance');
  check('[ws] live utterances broadcast', live.some((m) => m.speaker === 'candidate' && m.text === 'answer with socket') && live.some((m) => m.speaker === 'interviewer'));
  ws.close();
});

// ---------------------------------------------------------------------------
// 7. Breathe handling: overloaded -> one breathe, then questions resume
// ---------------------------------------------------------------------------
await withServer({ GEMINI_API_KEY: '' }, async () => {
  const id = await newSession();
  const vs = new WebSocket(`ws://localhost:${PORT}/ws/vitals`);
  await new Promise((r) => vs.once('open', r));
  const t0 = Date.now();
  // 3 s baseline at 70 bpm, then 120 bpm long enough to hold "overloaded"
  for (let i = 0; i <= 30; i++) vs.send(JSON.stringify({ sessionId: id, ts: t0 + i * 100, hr: 70 }));
  for (let i = 31; i <= 80; i++) vs.send(JSON.stringify({ sessionId: id, ts: t0 + i * 100, hr: 120 }));
  await sleep(300);
  const t1 = await timedTurn(id, '', 'b1');
  const t2 = await timedTurn(id, '', 'b2');
  check('[breathe] overloaded -> breathe', t1.body?.action === 'breathe', JSON.stringify(t1.body?.action));
  check('[breathe] breathe does not count as a question', t1.body?.questionCount === 0, t1.body?.questionCount);
  check('[breathe] second turn resumes asking (no breathe loop)', t2.body?.action !== 'breathe', t2.body?.action);
  vs.close();
});

// ---------------------------------------------------------------------------
// 8. interviewer.js unit checks (feedback + parser), in-process with the fake
// ---------------------------------------------------------------------------
process.env.GEMINI_API_KEY = 'fake';
process.env.GEMINI_FEEDBACK_TIMEOUT_MS = '1500';
process.env.MOCK_GEMINI_LOG = path.join(TMP, 'unit.jsonl');
const iv = await import('../src/interviewer.js');

const history = [
  { speaker: 'interviewer', text: 'Tell me about yourself.' },
  { speaker: 'candidate', text: 'I study IT and run a small security consultancy.' },
];
for (const mode of ['ok', 'fence', 'array', 'badjson']) {
  process.env.MOCK_GEMINI = mode;
  const f = await iv.feedback({ role: 'Intern', history, spikes: [] });
  check(`[feedback ${mode}] summary parsed`, /STAR/.test(f.summary || ''), JSON.stringify(f));
}
for (const mode of ['empty', 'error']) {
  process.env.MOCK_GEMINI = mode;
  const f = await iv.feedback({ role: 'Intern', history, spikes: [] });
  check(`[feedback ${mode}] sane fallback`, typeof f.summary === 'string' && f.summary.length > 0 && 'strongerAnswer' in f, JSON.stringify(f));
}
process.env.MOCK_GEMINI = 'slow';
process.env.MOCK_GEMINI_DELAY = '60000';
let t0 = Date.now();
const fs1 = await iv.feedback({ role: 'Intern', history, spikes: [] });
check('[feedback slow] returns within its timeout', Date.now() - t0 < 3000 && typeof fs1.summary === 'string', `${Date.now() - t0} ms`);
process.env.MOCK_GEMINI = 'ok';
const before = fs.existsSync(process.env.MOCK_GEMINI_LOG) ? fs.readFileSync(process.env.MOCK_GEMINI_LOG, 'utf8').split('\n').length : 0;
const noAns = await iv.feedback({ role: 'Intern', history: [{ speaker: 'interviewer', text: 'Hi, tell me about yourself.' }], spikes: [] });
const after = fs.existsSync(process.env.MOCK_GEMINI_LOG) ? fs.readFileSync(process.env.MOCK_GEMINI_LOG, 'utf8').split('\n').length : 0;
check('[feedback no answers] no Gemini call, useful message', before === after && /answer/i.test(noAns.summary) && noAns.strongerAnswer === null, JSON.stringify(noAns));
const fbReq = fs.readFileSync(process.env.MOCK_GEMINI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0];
check('[feedback config] temperature not below 1.0', fbReq.config?.temperature == null || fbReq.config.temperature >= 1);
check('[feedback config] schema has summary/strongerAnswer', Boolean(fbReq.config?.responseJsonSchema?.properties?.summary));

if (iv.parseModelJson) {
  const p = iv.parseModelJson;
  check('[parse] plain', p('{"say":"hi"}')?.say === 'hi');
  check('[parse] fence', p('```json\n{"say":"hi"}\n```')?.say === 'hi');
  check('[parse] array', p('[{"say":"hi"}]')?.say === 'hi');
  check('[parse] prose around', p('Sure! {"say":"a {b} c"} hope this helps')?.say === 'a {b} c');
  check('[parse] empty -> null', p('') === null && p(undefined) === null);
  check('[parse] garbage -> null', p('no json here') === null && p('{"say": "Tell me tell me') === null);
} else {
  check('[parse] parseModelJson exported', false);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
