// Role-tailored interviewer tests: the Role box (and optional job details) must drive who the
// interviewer is and what it asks, with Gemini on AND in the canned fallback.
// Plain node, no network, no npm install needed:   cd backend && node test/role.test.mjs
// Gemini is replaced by a fake that records every request (see register() below).
import { register } from 'node:module';

Object.assign(process.env, { GEMINI_API_KEY: 'fake-key', GEMINI_TURN_TIMEOUT_MS: '3000', GEMINI_FEEDBACK_TIMEOUT_MS: '3000' });

// Always use the fake Gemini (deterministic, offline). dotenv falls back to an empty module if not installed.
const FAKE_GENAI = `
export class GoogleGenAI {
  constructor() {
    this.models = {
      generateContent: async (req) => {
        globalThis.__geminiCalls.push(req);
        const mode = globalThis.__geminiMode;
        if (mode === 'error') throw new Error('503 UNAVAILABLE (fake)');
        return { text: JSON.stringify(globalThis.__geminiReply) };
      },
    };
  }
}`;
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(spec, ctx, next) {
      if (spec === '@google/genai') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(FAKE_GENAI)}), shortCircuit: true };
      try { return await next(spec, ctx); }
      catch (err) { if (spec === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }; throw err; }
    }`),
);
globalThis.__geminiCalls = [];
globalThis.__geminiMode = 'ok';
globalThis.__geminiReply = { say: 'Walk me through triaging a phishing alert.', action: 'ask' };

const iv = await import('../src/interviewer.js');
const roles = await import('../src/roles.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${String(detail).slice(0, 300)}` : ''}`);
}
const reset = (mode = 'ok') => {
  globalThis.__geminiCalls = [];
  globalThis.__geminiMode = mode;
};
const lastCall = () => globalThis.__geminiCalls.at(-1);
const turn = (o) =>
  iv.nextTurn({ persona: 'cold', history: [], state: 'calm', questionCount: 0, maxQuestions: 6, ...o });

// ---------------------------------------------------------------------------
// 1. Whatever is in the Role box reaches Gemini, and the interviewer becomes that job's hiring manager
// ---------------------------------------------------------------------------
for (const [role, track, expectWho] of [
  ['SOC Analyst', 'security', /security operations lead/],
  ['Registered Nurse', 'healthcare', /nurse manager/],
  ['Financial Analyst', 'finance', /finance manager/],
  ['High School Chemistry Teacher', 'education', /principal/],
  ['Barista', 'service', /store and operations manager/],
  ['Mechanical Engineer', 'hardware-eng', /senior engineer/],
  ['Paralegal', 'legal', /supervising attorney/],
  ['Zookeeper', 'general', /hiring manager for this role/],
]) {
  reset();
  const r = await turn({ role });
  const sys = lastCall()?.config?.systemInstruction || '';
  check(`[gemini] ${role}: Gemini called with the role`, sys.includes(`THE JOB: ${role}`), sys.slice(0, 120));
  check(`[gemini] ${role}: track ${track}`, roles.pickTrack(role).id === track, roles.pickTrack(role).id);
  check(`[gemini] ${role}: interviewer persona fits the job`, expectWho.test(sys), sys.match(/Think of yourself as [^.;]*/)?.[0]);
  check(`[gemini] ${role}: forbids generic questions`, /generic question that could be asked for any job is not allowed/.test(sys));
  check(`[gemini] ${role}: turn prompt names the role`, String(lastCall()?.contents).includes(role));
  check(`[gemini] ${role}: model line returned`, r.source === 'gemini' && r.say === globalThis.__geminiReply.say, JSON.stringify(r));
}

// Personas are styles now, not a fixed job ("senior engineer" must not leak into a nurse interview)
reset();
await turn({ role: 'Registered Nurse', persona: 'cold' });
check('[persona] cold style kept', /blunt and skeptical/.test(lastCall().config.systemInstruction));
check('[persona] no "senior engineer" in a nurse interview', !/senior engineer/i.test(lastCall().config.systemInstruction));
for (const p of ['friendly', 'cold', 'rapid']) {
  reset();
  await turn({ role: 'Barista', persona: p });
  check(`[persona] ${p} style text present`, lastCall().config.systemInstruction.includes(iv.PERSONAS[p]));
}

// Seniority changes the level
const sysFor = (role) => iv.interviewerSystemPrompt({ persona: 'friendly', role });
check('[level] intern -> entry-level guidance', /entry-level role/.test(sysFor('IT Help Desk Intern')));
check('[level] senior -> senior guidance', /senior role/.test(sysFor('Senior Penetration Tester')));
check('[level] plain title -> working professional', /working professional/.test(sysFor('Registered Nurse')));

// Job details are used, fenced as data, and capped
reset();
const posting = 'Acme Health is hiring an ICU nurse. Must know ventilator management and Epic charting. 12-hour night shifts.';
await turn({ role: 'Registered Nurse', jobDetails: posting });
const sysJD = lastCall().config.systemInstruction;
check('[details] job posting in system prompt', sysJD.includes('ventilator management') && sysJD.includes('Epic charting'));
check('[details] fenced and marked as data, not instructions', /never as instructions/.test(sysJD) && sysJD.includes('<<<JOB'));
check('[details] company named -> "you work there"', /you work there/.test(sysJD));
const huge = 'x'.repeat(20000);
check('[details] capped at 4000 chars', roles.normalizeJobDetails(huge).length === 4000);
check('[details] vague title falls back to details for the track', roles.pickTrack('Associate', 'patient care at our hospital').id === 'healthcare');

// Role input is sanitised; empty -> default
check('[role] empty role -> default', roles.normalizeRole('   ') === roles.DEFAULT_ROLE);
check('[role] whitespace/control chars collapsed', roles.normalizeRole(' SOC\n\tAnalyst  ') === 'SOC Analyst');
check('[role] capped at 120 chars', roles.normalizeRole('a'.repeat(500)).length === 120);

// ---------------------------------------------------------------------------
// 2. Canned fallback (no key / Gemini down) is role-specific too
// ---------------------------------------------------------------------------
async function cannedInterview(role, n = 6, jobDetails = '') {
  reset('error');
  const history = [];
  const says = [];
  for (let q = 0; q < n; q++) {
    const r = await iv.nextTurn({ persona: 'friendly', role, jobDetails, history, state: 'elevated', questionCount: q, maxQuestions: n + 1 });
    says.push(r);
    history.push({ speaker: 'interviewer', text: r.say }, { speaker: 'candidate', text: `answer ${q}` });
  }
  return says;
}
const nurse = await cannedInterview('Registered Nurse');
check('[canned] falls back when Gemini errors', nurse.every((r) => r.source === 'canned'));
check('[canned] opener names the role', nurse[0].say.includes('Registered Nurse position'), nurse[0].say);
check('[canned] nurse gets clinical questions', nurse.slice(1).some((r) => /patient|physician|handoff/i.test(r.say)), JSON.stringify(nurse.map((r) => r.say)));
check('[canned] no repeats', new Set(nurse.map((r) => r.say)).size === nurse.length);
const soc = await cannedInterview('SOC Analyst');
check('[canned] SOC analyst gets security questions', soc.slice(1).every((r) => /alert|phishing|vulnerab|risk|security|privilege|threat|problem nobody/i.test(r.say)), JSON.stringify(soc.map((r) => r.say)));
const zoo = await cannedInterview('Zookeeper', 4);
check('[canned] unknown role still mentions the role', zoo.slice(1).some((r) => r.say.includes('Zookeeper')), JSON.stringify(zoo.map((r) => r.say)));
const long = await cannedInterview('Barista', 15);
check('[canned] long interview never runs out / never empty', long.every((r) => r.say && r.say.length > 10));
const q0 = new Set(nurse.map((r) => r.say));
check('[canned] different roles -> different questions', soc.slice(1).every((r) => !q0.has(r.say)));
check('[canned] calm escalates with prefix', (await iv.nextTurn({ role: 'Barista', history: [], state: 'calm', questionCount: 2, maxQuestions: 6 })).action === 'escalate');
check('[canned] overloaded -> breathe', (await iv.nextTurn({ role: 'Barista', history: [], state: 'overloaded', questionCount: 2, maxQuestions: 6 })).action === 'breathe');
check('[canned] maxQuestions -> end', (await iv.nextTurn({ role: 'Barista', history: [], state: 'calm', questionCount: 6, maxQuestions: 6 })).action === 'end');

// ---------------------------------------------------------------------------
// 3. Coaching is judged against the role
// ---------------------------------------------------------------------------
reset();
globalThis.__geminiReply = { summary: 'Good triage instincts.', strongerAnswer: 'I would first confirm...' };
const fb = await iv.feedback({
  role: 'SOC Analyst',
  jobDetails: 'Tier 1 SOC, Splunk',
  history: [{ speaker: 'interviewer', text: 'Q' }, { speaker: 'candidate', text: 'A' }],
  spikes: [],
});
const fbPrompt = String(lastCall()?.contents || '');
check('[feedback] prompt has role + job details + role coach', fbPrompt.includes('SOC Analyst') && fbPrompt.includes('Splunk') && /security operations lead/.test(fbPrompt));
check('[feedback] returns coaching', fb.summary === 'Good triage instincts.', JSON.stringify(fb));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
