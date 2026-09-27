// AI interviewer agent tests: brief -> respond -> review, and no silent fallback.
// Plain node, no network, no npm install needed:   cd backend && node test/interviewer-agent.test.mjs
// Gemini is replaced by a fake whose replies each test scripts (globalThis.__turnReplies / __briefingReply).
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

Object.assign(process.env, {
  GEMINI_API_KEY: 'fake-key',
  GEMINI_TURN_TIMEOUT_MS: '4000',
  GEMINI_BRIEFING_TIMEOUT_MS: '4000',
  GEMINI_FEEDBACK_TIMEOUT_MS: '3000',
  ALLOW_CANNED_INTERVIEWER: '',
});

const FAKE_GENAI = `
export class GoogleGenAI {
  constructor() {
    this.models = {
      generateContent: async (req) => {
        const isBriefing = Boolean(req.config?.responseJsonSchema?.properties?.interviewerName);
        (isBriefing ? globalThis.__briefingCalls : globalThis.__turnCalls).push(req);
        if (isBriefing) {
          if (globalThis.__briefingMode === 'error') throw new Error('503 UNAVAILABLE (fake briefing)');
          return { text: JSON.stringify(globalThis.__briefingReply) };
        }
        if (globalThis.__turnMode === 'error') throw new Error('429 RESOURCE_EXHAUSTED (fake)');
        const next = globalThis.__turnReplies.length > 1 ? globalThis.__turnReplies.shift() : globalThis.__turnReplies[0];
        return { text: JSON.stringify(next) };
      },
    };
  }
}`;
const LOADER = `export async function resolve(spec, ctx, next) {
  if (spec === '@google/genai') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(FAKE_GENAI)}), shortCircuit: true };
  try { return await next(spec, ctx); }
  catch (err) { if (spec === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }; throw err; }
}`;

// --- child mode: no GEMINI_API_KEY (also with the removed ALLOW_CANNED_INTERVIEWER switch set) ---
if (process.argv[2] === '--nokey') {
  register('data:text/javascript,' + encodeURIComponent(LOADER));
  process.env.GEMINI_API_KEY = '';
  if (process.argv[3] === 'canned') process.env.ALLOW_CANNED_INTERVIEWER = '1';
  const iv = await import('../src/interviewer.js');
  try {
    const r = await iv.nextTurn({ persona: 'cold', role: 'SOC Analyst', history: [], state: 'calm', questionCount: 0, maxQuestions: 5 });
    console.log(JSON.stringify({ ok: true, source: r.source }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, code: err.code, stage: err.stage, message: err.message }));
  }
  process.exit(0);
}

register('data:text/javascript,' + encodeURIComponent(LOADER));

const POSTING = `CrowdStrike is hiring a Threat Hunter (Falcon OverWatch).
You will hunt adversaries across customer environments using the Falcon platform, write detections,
and escalate hands-on-keyboard intrusions. Requirements: EDR experience, MITRE ATT&CK, Windows internals,
threat intelligence on eCrime and nation-state actors, clear written reporting.`;

const BRIEFING = {
  company: 'CrowdStrike',
  companyContext: 'CrowdStrike makes the Falcon platform for endpoint detection and response and runs the OverWatch managed threat hunting team.',
  team: 'Falcon OverWatch',
  interviewerName: 'Maya Chen',
  interviewerTitle: 'Senior Manager, Threat Hunting',
  interviewerBackground: 'Maya has led OverWatch hunt shifts tracking eCrime and nation-state intrusions.',
  roleSummary: 'Hunt across Falcon telemetry, confirm hands-on-keyboard activity, escalate to customers and write detections.',
  mustHaves: ['EDR telemetry', 'MITRE ATT&CK', 'Windows internals', 'threat intel', 'written reporting'],
  strongSignals: 'Walks through a hunt hypothesis, names concrete telemetry, and knows when to escalate.',
  redFlags: ['only knows alerts, not hunting', 'cannot explain process trees'],
  interviewPlan: [
    { topic: 'Hunting hypothesis from ATT&CK', why: 'core of the job' },
    { topic: 'Reading a suspicious process tree in Falcon', why: 'daily work' },
    { topic: 'Credential dumping and LSASS access', why: 'common intrusion step' },
    { topic: 'Escalating to a customer mid-intrusion', why: 'communication under pressure' },
    { topic: 'Writing a detection from a hunt', why: 'turn findings into coverage' },
  ],
};

const iv = await import('../src/interviewer.js');
const { createInterviewService } = await import('../src/services/interviewService.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${String(detail).slice(0, 400)}` : ''}`);
}
function reset({ turnReplies = [], turnMode = 'ok', briefingMode = 'ok' } = {}) {
  globalThis.__briefingCalls = [];
  globalThis.__turnCalls = [];
  globalThis.__turnReplies = turnReplies;
  globalThis.__turnMode = turnMode;
  globalThis.__briefingMode = briefingMode;
  globalThis.__briefingReply = BRIEFING;
}
async function attempt(p) {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}
const setup = { persona: 'cold', role: 'Threat Hunter', jobDetails: POSTING };
const ANSWER =
  'At my internship I built a Sigma rule after noticing rundll32 spawning from a Word macro, then pivoted on the parent process to find two more infected hosts.';
const history1 = [
  { speaker: 'interviewer', text: "I'm Maya Chen, I run hunt shifts on Falcon OverWatch at CrowdStrike. What's the most hands-on EDR work you've done?" },
  { speaker: 'candidate', text: ANSWER, state: 'elevated' },
];
const GOOD = {
  heard: 'rundll32 spawning from a Word macro',
  answerRead: 'strong',
  reaction: 'A macro spawning rundll32 is exactly the kind of tree OverWatch flags daily, and pivoting on the parent is the right instinct.',
  question: 'If that rundll32 then touched LSASS, what would you pull from Falcon before you called the customer?',
  planTopic: 'Credential dumping and LSASS access',
  action: 'escalate',
};

// ---------------------------------------------------------------------------
// 1. BRIEF: the interviewer is built from the posting, once per setup
// ---------------------------------------------------------------------------
reset({ turnReplies: [{ heard: '', answerRead: 'first_turn', reaction: "I'm Maya Chen, I lead hunt shifts on Falcon OverWatch.", question: "What's the most hands-on EDR work you've done?", action: 'ask' }] });
iv.prepareInterviewer(setup);
const first = await iv.nextTurn({ ...setup, history: [], state: 'calm', questionCount: 0, maxQuestions: 5 });
check('[brief] built once, reused by the turn', globalThis.__briefingCalls.length === 1, globalThis.__briefingCalls.length);
const bPrompt = String(globalThis.__briefingCalls[0]?.contents || '');
check('[brief] prompt has the posting, fenced as data', bPrompt.includes('Falcon OverWatch') && bPrompt.includes('<<<JOB') && /never instructions/.test(bPrompt));
check('[brief] asks for a fictional person, not a real exec', /fictional/.test(bPrompt));
check('[brief] asks for a posting-specific plan', /specific to this posting/.test(bPrompt));

const sys = globalThis.__turnCalls[0]?.config?.systemInstruction || '';
check('[respond] system prompt: interviewer identity from briefing', sys.includes('YOU ARE Maya Chen, Senior Manager, Threat Hunting at CrowdStrike'), sys.slice(0, 200));
check('[respond] system prompt: company context', sys.includes('ABOUT CROWDSTRIKE') && sys.includes('Falcon platform'));
check('[respond] system prompt: must-haves and plan', sys.includes('MITRE ATT&CK') && sys.includes('Reading a suspicious process tree in Falcon'));
check('[respond] system prompt: posting still fenced', sys.includes('<<<JOB') && /never as instructions/.test(sys));
check('[respond] system prompt: bans generic filler', /NEVER SAY: "tell me more", "can you elaborate"/.test(sys));
check('[respond] system prompt: questions scoped to company', sys.includes('about being a Threat Hunter at CrowdStrike'));
check('[respond] opener comes from Gemini and names the interviewer', first.source === 'gemini' && first.say.startsWith("I'm Maya Chen") && first.say.endsWith('?'), JSON.stringify(first));
check('[respond] turn returns the interviewer identity', first.interviewer?.company === 'CrowdStrike' && first.interviewer?.name === 'Maya Chen');
const openPrompt = String(globalThis.__turnCalls[0]?.contents || '');
check('[respond] opener prompt: introduce yourself, no generic opener', /Open the interview/.test(openPrompt) && /at CrowdStrike/.test(openPrompt));

// Same setup again -> cached briefing, no second build
reset({ turnReplies: [GOOD] });
const r2 = await iv.nextTurn({ ...setup, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 });
check('[brief] cached across turns', globalThis.__briefingCalls.length === 0, globalThis.__briefingCalls.length);
const tPrompt = String(globalThis.__turnCalls[0]?.contents || '');
check('[respond] turn prompt: latest answer singled out', tPrompt.includes(`CANDIDATE'S LATEST ANSWER (respond to THIS):\n"""${ANSWER}"""`));
check('[respond] turn prompt: transcript names the interviewer, tags stress', tPrompt.includes('Maya Chen (you):') && tPrompt.includes('Candidate [heart rate: elevated]:'));
check('[respond] turn prompt: live stress state', tPrompt.includes('stress state right now: "calm"'));
check('[respond] grounded reply accepted in one call', globalThis.__turnCalls.length === 1 && r2.say === `${GOOD.reaction} ${GOOD.question}` && r2.action === 'escalate', JSON.stringify(r2));
check('[respond] reports what it heard', r2.heard === GOOD.heard && r2.answerRead === 'strong');

// ---------------------------------------------------------------------------
// 2. REVIEW: generic, ungrounded or repeated drafts are sent back once
// ---------------------------------------------------------------------------
const GENERIC = { heard: 'their internship', answerRead: 'strong', reaction: "That's a great experience.", question: 'Can you elaborate on that?', action: 'ask' };
reset({ turnReplies: [GENERIC, GOOD] });
const fixed = await iv.nextTurn({ ...setup, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 });
check('[review] generic draft rejected, rewrite used', globalThis.__turnCalls.length === 2 && fixed.say.includes('LSASS'), JSON.stringify(fixed));
const retryPrompt = String(globalThis.__turnCalls[1]?.contents || '');
check('[review] rewrite request says why', /PREVIOUS DRAFT WAS REJECTED/.test(retryPrompt) && /empty praise/.test(retryPrompt) && /can you elaborate/.test(retryPrompt), retryPrompt.slice(-400));

reset({ turnReplies: [GENERIC] });
const twice = await attempt(iv.nextTurn({ ...setup, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 }));
check('[review] generic twice -> error, not a fake reply', twice.error?.code === 'AI_INTERVIEWER_FAILED' && /generic or unusable reply twice/.test(twice.error.message), twice.error?.message || JSON.stringify(twice.value));

const UNGROUNDED = { heard: 'cloud migration project', answerRead: 'strong', reaction: 'Cloud security is a big focus for us this year.', question: 'How would you secure an S3 bucket?', action: 'ask' };
reset({ turnReplies: [UNGROUNDED, GOOD] });
await iv.nextTurn({ ...setup, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 });
check('[review] reply not based on what the candidate said -> rewritten', globalThis.__turnCalls.length === 2 && /not something the candidate said/.test(String(globalThis.__turnCalls[1].contents)));

const REPEAT = { ...GOOD, question: "What's the most hands-on EDR work you've done?" };
reset({ turnReplies: [REPEAT, GOOD] });
await iv.nextTurn({ ...setup, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 });
check('[review] repeated question -> rewritten', globalThis.__turnCalls.length === 2 && /repeats an earlier question/.test(String(globalThis.__turnCalls[1].contents)));

const issues = iv.reviewTurn(iv.normalizeTurn({ heard: 'x', reaction: 'Interesting.', question: 'Tell me more.', action: 'ask' }, 'calm'), { history: [] });
check('[review] "tell me more" and a missing "?" are caught', issues.some((i) => /tell me more/.test(i)) && issues.some((i) => /no question/.test(i)), issues.join(' | '));
check(
  '[review] short "I don\'t know" answers are not forced to be quoted',
  iv.reviewTurn(iv.normalizeTurn({ heard: '', answerRead: 'no_answer', reaction: "Let's make it concrete: you see Word spawn PowerShell on a finance laptop.", question: 'What do you check first?', action: 'ask' }, 'elevated'), {
    history: [{ speaker: 'interviewer', text: 'Q?' }, { speaker: 'candidate', text: "I don't know" }],
  }).length === 0,
);
const breatheTurn = iv.normalizeTurn({ heard: '', answerRead: 'partial', reaction: 'Take a slow breath, then walk me back through that containment step.', question: '', action: 'breathe' }, 'overloaded');
check('[review] breathing pause needs no question', breatheTurn.action === 'breathe' && iv.reviewTurn(breatheTurn, { history: history1, state: 'overloaded' }).length === 0);
check('[review] breathe outside overload becomes a question turn', iv.normalizeTurn({ reaction: 'Breathe.', question: 'Which log first?', action: 'breathe' }, 'calm').action === 'ask');

// ---------------------------------------------------------------------------
// 3. NO SILENT FALLBACK: failures surface as InterviewerError with a clear reason
// ---------------------------------------------------------------------------
reset({ turnMode: 'error' });
const apiFail = await attempt(iv.nextTurn({ ...setup, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 }));
check('[error] Gemini API failure -> InterviewerError (no canned line)', apiFail.error?.code === 'AI_INTERVIEWER_FAILED' && /could not be generated: Gemini request failed \(429/.test(apiFail.error.message), apiFail.error?.message || JSON.stringify(apiFail.value));

const setup2 = { persona: 'friendly', role: 'Registered Nurse', jobDetails: 'Acme Health ICU nurse. Ventilator management.' };
reset({ briefingMode: 'error', turnReplies: [GOOD] });
const briefFail = await attempt(iv.nextTurn({ ...setup2, history: [], state: 'calm', questionCount: 0, maxQuestions: 5 }));
check('[error] briefing failure -> error explains it was the job-description step', briefFail.error?.stage === 'briefing' && /building the interviewer from the job description/.test(briefFail.error.message), briefFail.error?.message);
check('[error] no turn is attempted without a briefing', globalThis.__turnCalls.length === 0);
reset({ turnReplies: [{ heard: '', answerRead: 'first_turn', reaction: "I'm Maya Chen from the ICU.", question: 'How do you manage a patient on a ventilator overnight?', action: 'ask' }] });
const briefRetry = await attempt(iv.nextTurn({ ...setup2, history: [], state: 'calm', questionCount: 0, maxQuestions: 5 }));
check('[error] failed briefing is retried on the next turn', globalThis.__briefingCalls.length === 1 && briefRetry.value?.source === 'gemini', briefRetry.error?.message);

reset({ briefingMode: 'ok' });
globalThis.__briefingReply = { interviewerName: 'X' };
const incomplete = await attempt(iv.nextTurn({ persona: 'rapid', role: 'Barista', history: [], state: 'calm', questionCount: 0, maxQuestions: 5 }));
check('[error] incomplete briefing -> clear error', incomplete.error?.stage === 'briefing' && /incomplete interviewer profile/.test(incomplete.error.message), incomplete.error?.message);

// ---------------------------------------------------------------------------
// 4. Closing line is generated too, and ends the interview
// ---------------------------------------------------------------------------
reset({ turnReplies: [{ heard: 'pivoted on the parent process', answerRead: 'strong', reaction: 'Pivoting on the parent process is what stood out today; next step here is a live hunt exercise with two OverWatch leads. Thanks for your time.', question: '', action: 'ask' }] });
const close = await iv.nextTurn({ ...setup, history: history1, state: 'calm', questionCount: 5, maxQuestions: 5 });
check('[close] closing comes from Gemini and ends', close.source === 'gemini' && close.action === 'end' && /OverWatch/.test(close.say), JSON.stringify(close));
check('[close] closing prompt asks for the real next step at the company', /interview is over/.test(String(globalThis.__turnCalls[0]?.contents)) && /at CrowdStrike/.test(String(globalThis.__turnCalls[0]?.contents)));

// ---------------------------------------------------------------------------
// 5. Coaching uses the same interviewer
// ---------------------------------------------------------------------------
reset({ turnReplies: [{ summary: 'Strong process-tree instincts; slow down on escalation.', strongerAnswer: 'I would first...' }] });
const fb = await iv.feedback({ ...setup, history: history1, spikes: [] });
const fbPrompt = String(globalThis.__turnCalls[0]?.contents || '');
check('[feedback] coached as the same interviewer, against the must-haves', fbPrompt.includes('You are Maya Chen') && fbPrompt.includes('MITRE ATT&CK') && fbPrompt.includes('at CrowdStrike'));
check('[feedback] returns coaching', fb.summary.startsWith('Strong process-tree'));

// ---------------------------------------------------------------------------
// 6. Interview service: "Try again" after a failed turn doesn't store the answer twice
// ---------------------------------------------------------------------------
{
  let fail = true;
  const session = { persona: 'cold', role: 'Threat Hunter', jobDetails: POSTING, engine: { state: 'calm' }, questionCount: 1, maxQuestions: 5, utterances: [] };
  const service = createInterviewService({
    nextTurn: async () => {
      if (fail) throw new iv.InterviewerError('Gemini down');
      return { say: 'Which Falcon event would you pivot on?', action: 'ask', source: 'gemini' };
    },
    speak: async () => null,
    addUtterance: (s, speaker, text) => s.utterances.push({ speaker, text }),
  });
  const e = await attempt(service.runTurn(session, 'my answer', 'turn-1'));
  check('[service] failure propagates to the route', e.error?.code === 'AI_INTERVIEWER_FAILED');
  fail = false;
  await service.runTurn(session, 'my answer', 'turn-1');
  const answers = session.utterances.filter((u) => u.speaker === 'candidate');
  check('[service] retry with same turnId stores the answer once', answers.length === 1 && session.utterances.at(-1).speaker === 'interviewer', JSON.stringify(session.utterances));
  await service.runTurn(session, 'next answer', 'turn-2');
  check('[service] later turns store answers normally', session.utterances.filter((u) => u.speaker === 'candidate').length === 2);
}

// ---------------------------------------------------------------------------
// 6b. Styles: friendly / cold / rapid shape the briefing and every turn
// ---------------------------------------------------------------------------
{
  const RAPID_BRIEF = { ...BRIEFING, speakingStyle: 'Talks fast, never recaps, cuts to the next topic.' };
  const rapid = { persona: 'rapid', role: 'Threat Hunter', jobDetails: `${POSTING}\n(rapid test)` };
  const SHORT = { heard: 'rundll32 spawning from a Word macro', answerRead: 'strong', reaction: 'Macro to rundll32. Good.', question: 'First Falcon event you pivot on?', action: 'ask' };
  const LONG = {
    ...SHORT,
    reaction:
      'A macro spawning rundll32 is exactly the kind of tree our OverWatch team flags every day, and pivoting on the parent process is the right instinct because it shows you are thinking about how the intrusion actually started on that host.',
    question: 'If that rundll32 then touched LSASS, what would you pull from Falcon before you called the customer and why?',
  };

  reset({ turnReplies: [SHORT] });
  globalThis.__briefingReply = RAPID_BRIEF;
  const r1 = await iv.nextTurn({ ...rapid, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 });
  const rb = String(globalThis.__briefingCalls[0]?.contents || '');
  check('[style] rapid briefing asks for a fast, time-boxed interviewer', /time-boxed/.test(rb) && /rapid-fire/.test(rb), rb.slice(0, 300));
  check('[style] briefing schema asks for speakingStyle', Boolean(globalThis.__briefingCalls[0]?.config?.responseJsonSchema?.properties?.speakingStyle));
  const rc = globalThis.__turnCalls[0]?.config || {};
  check('[style] rapid turn uses MINIMAL thinking', rc.thinkingConfig?.thinkingLevel === 'MINIMAL', JSON.stringify(rc.thinkingConfig));
  check('[style] rapid system prompt has the pace rules', /under 30 words/.test(rc.systemInstruction) && /PACE BEATS EVERYTHING/.test(rc.systemInstruction) && /one follow-up max/.test(rc.systemInstruction));
  check('[style] rapid system prompt carries the briefed speaking style', rc.systemInstruction.includes('HOW YOU RUN INTERVIEWS: Talks fast'));
  check('[style] rapid schema asks for a clipped reaction', /clipped 2-8 word/.test(rc.responseJsonSchema?.properties?.reaction?.description || ''));
  check('[style] rapid short reply used in one call', r1.say === 'Macro to rundll32. Good. First Falcon event you pivot on?' && globalThis.__turnCalls.length === 1, JSON.stringify(r1));

  reset({ turnReplies: [LONG, SHORT] });
  globalThis.__briefingReply = RAPID_BRIEF;
  const r2 = await iv.nextTurn({ ...rapid, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 });
  const retryPrompt = String(globalThis.__turnCalls[1]?.contents || '');
  check('[style] rapid: too-long draft gets one rewrite', globalThis.__turnCalls.length === 2 && /too long for this style/.test(retryPrompt) && r2.say.startsWith('Macro to rundll32'), `${globalThis.__turnCalls.length} ${r2.say}`);

  const REPEAT = { ...SHORT, question: "What's the most hands-on EDR work you've done?" };
  reset({ turnReplies: [REPEAT, SHORT] });
  globalThis.__briefingReply = RAPID_BRIEF;
  await iv.nextTurn({ ...rapid, history: history1, state: 'calm', questionCount: 1, maxQuestions: 5 });
  check('[style] rapid: minor issue (near-repeat) skips the rewrite', globalThis.__turnCalls.length === 1, globalThis.__turnCalls.length);

  check('[style] review: long reply flagged only for rapid', iv.reviewTurn(iv.normalizeTurn(LONG, 'calm'), { history: history1, persona: 'rapid' }).some((i) => i.startsWith('too long')) && !iv.reviewTurn(iv.normalizeTurn(LONG, 'calm'), { history: history1, persona: 'cold' }).some((i) => i.startsWith('too long')));

  reset({ turnReplies: [GOOD] });
  await iv.nextTurn({ ...setup2, jobDetails: `${setup2.jobDetails} (style test)`, history: [], state: 'calm', questionCount: 0, maxQuestions: 5 });
  const fc = globalThis.__turnCalls[0]?.config || {};
  const fb = String(globalThis.__briefingCalls[0]?.contents || '');
  check('[style] friendly: warm briefing, normal thinking, no rapid pace rule', /approachable/.test(fb) && fc.thinkingConfig?.thinkingLevel === 'LOW' && !/PACE BEATS/.test(fc.systemInstruction) && /2-4 natural spoken sentences/.test(fc.systemInstruction));
  const fo = String(globalThis.__turnCalls[0]?.contents || '');
  check('[style] friendly opener introduces warmly with context', /Introduce yourself warmly/.test(fo));

  check('[style] PERSONAS still lists every style for the server', Object.keys(iv.PERSONAS).join() === 'friendly,cold,rapid');
}

// ---------------------------------------------------------------------------
// 7. No API key: a clear error, never canned questions
// ---------------------------------------------------------------------------
const self = fileURLToPath(import.meta.url);
const run = (mode) => JSON.parse(spawnSync(process.execPath, [self, '--nokey', mode], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1));
const strict = run('strict');
check('[nokey] no key -> clear config error', !strict.ok && strict.stage === 'config' && /GEMINI_API_KEY is not set/.test(strict.message), JSON.stringify(strict));
const canned = run('canned');
check('[nokey] no canned mode exists, even with the old ALLOW_CANNED_INTERVIEWER=1 switch', !canned.ok && canned.stage === 'config', JSON.stringify(canned));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
