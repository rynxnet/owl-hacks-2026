import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const ai = config.geminiKey ? new GoogleGenAI({ apiKey: config.geminiKey }) : null;

// A turn must come back fast or the candidate stares at "Interviewer is thinking..." forever.
// On timeout we abort the request and use a canned question instead.
const TURN_TIMEOUT_MS = Number(process.env.GEMINI_TURN_TIMEOUT_MS || 12000);
const FEEDBACK_TIMEOUT_MS = Number(process.env.GEMINI_FEEDBACK_TIMEOUT_MS || 25000);
// Gemini 3 Flash thinks at "high" by default, which is slow for a one-line spoken reply.
// Values are the SDK's ThinkingLevel enum: MINIMAL | LOW | MEDIUM | HIGH.
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || 'LOW').toUpperCase();

export const PERSONAS = {
  friendly: 'a warm, encouraging recruiter who still asks real questions',
  cold: 'a blunt, skeptical senior engineer who interrupts vague answers and asks "why?"',
  rapid: 'a fast-paced panel interviewer who fires short, rapid follow-ups',
};

const MODEL_ACTIONS = ['ask', 'escalate', 'breathe'];

const STATE_RULES = `
How to adapt to the candidate's stress state (measured from their heart rate):
- "calm": raise the pressure. Ask a harder follow-up, challenge a vague claim, or throw a curveball.
- "elevated": keep the pressure steady. Ask a normal next question; do not add more pressure.
- "overloaded": stop and coach. Set action to "breathe" and say one short sentence inviting a slow breath before continuing.
Only use "breathe" when the state is "overloaded". Every other reply must end with exactly one question.
`;

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string', description: 'What the interviewer says out loud: 1-3 short spoken sentences.' },
    action: { type: 'string', enum: MODEL_ACTIONS },
  },
  required: ['say', 'action'],
};

const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '3-4 sentences: what went well, what rattled them, one habit to fix.' },
    strongerAnswer: { type: 'string', description: 'A rewritten, stronger version of their most stressed answer.' },
  },
  required: ['summary', 'strongerAnswer'],
};

// Returns { say, action, source } where action is "ask" | "escalate" | "breathe" | "end"
// and source is "gemini" or "canned". Never throws, never hangs past TURN_TIMEOUT_MS.
export async function nextTurn({ persona, role, history, state, questionCount, maxQuestions }) {
  if (questionCount >= maxQuestions) {
    return { say: 'That wraps up our interview. Thanks for your time.', action: 'end', source: 'canned' };
  }
  if (!ai) return cannedTurn({ state, questionCount, history });

  const system = `You are ${PERSONAS[persona] || PERSONAS.friendly}, interviewing a candidate for: ${role}.
Speak in 1-3 short spoken sentences. No lists, no markdown, no stage directions.
Do not repeat a question you already asked.
${STATE_RULES}
Reply ONLY with JSON: {"say": string, "action": "ask" | "escalate" | "breathe"}.`;

  const transcript = history
    .map((h) => `${h.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${h.text}`)
    .join('\n');

  const prompt = `Transcript so far:\n${transcript || '(interview is starting; greet briefly and ask the first question)'}\n\nCandidate stress state right now: "${state}". Question ${questionCount + 1} of ${maxQuestions}.`;

  try {
    const parsed = await generateJson({
      contents: prompt,
      systemInstruction: system,
      schema: TURN_SCHEMA,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    const turn = normalizeTurn(parsed, state);
    if (turn) return { ...turn, source: 'gemini' };
    console.error('[gemini] turn had no usable {say, action}, using canned question. Got:', JSON.stringify(parsed)?.slice(0, 200));
  } catch (err) {
    console.error('[gemini] turn failed, using canned question:', err.message);
  }
  return cannedTurn({ state, questionCount, history });
}

function normalizeTurn(parsed, state) {
  if (!parsed) return null;
  const say = String(parsed.say ?? parsed.text ?? parsed.response ?? '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!say) return null;
  let action = String(parsed.action || 'ask').trim().toLowerCase();
  if (!MODEL_ACTIONS.includes(action)) action = 'ask';
  // A breathing pause only makes sense when overloaded; otherwise the next turn would be another pause
  // (or the candidate is left "answering" a line with no question in it).
  if (action === 'breathe' && state !== 'overloaded') {
    if (!say.includes('?')) return null;
    action = 'ask';
  }
  return { say: say.slice(0, 600), action };
}

export async function feedback({ role, history, spikes }) {
  const answers = history.filter((h) => h.speaker === 'candidate' && String(h.text || '').trim());
  if (!answers.length) {
    return {
      summary:
        "You didn't answer any questions this time, so there is nothing to coach yet. Next run, answer at least one question out loud or by typing. Your heart-rate replay is still shown.",
      strongerAnswer: null,
    };
  }
  if (!ai) {
    return {
      summary: 'Add a GEMINI_API_KEY to get written feedback. Your heart-rate replay is still shown.',
      strongerAnswer: null,
    };
  }
  const transcript = history.map((h) => `${h.speaker}: ${h.text}`).join('\n');
  const prompt = `A candidate practiced an interview for: ${role}.
Transcript:\n${transcript}\n
Moments where their heart rate spiked (question text and bpm rise): ${JSON.stringify(spikes || [])}
Give coaching as JSON: {"summary": "3-4 sentences: what went well, what rattled them, one habit to fix",
"strongerAnswer": "a rewritten, stronger version of their answer to the question that stressed them most"}`;
  try {
    const parsed = await generateJson({ contents: prompt, schema: FEEDBACK_SCHEMA, timeoutMs: FEEDBACK_TIMEOUT_MS });
    const summary = String(parsed?.summary ?? '').trim();
    if (summary) {
      const stronger = typeof parsed.strongerAnswer === 'string' ? parsed.strongerAnswer.trim() : '';
      return { summary, strongerAnswer: stronger || null };
    }
    console.error('[gemini] feedback had no summary. Got:', JSON.stringify(parsed)?.slice(0, 200));
  } catch (err) {
    console.error('[gemini] feedback failed:', err.message);
  }
  return {
    summary: 'Written feedback is unavailable right now (the AI coach did not respond in time). Your heart-rate replay is still shown.',
    strongerAnswer: null,
  };
}

// ---------------------------------------------------------------------------
// One Gemini JSON call with a hard deadline. Returns a parsed object or null; throws on API errors.
// ---------------------------------------------------------------------------
let leanConfig = false; // flipped if the API rejects thinkingConfig / schema, so we stop sending them

async function generateJson({ contents, systemInstruction, schema, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  try {
    return await callOnce({ contents, systemInstruction, schema, timeoutMs, lean: leanConfig });
  } catch (err) {
    const remaining = deadline - Date.now();
    // 400 INVALID_ARGUMENT on the tuned config (e.g. a model without thinkingLevel): retry once with a bare one.
    if (!leanConfig && /\b400\b|INVALID_ARGUMENT/i.test(err.message) && remaining > 1500) {
      console.error('[gemini] request rejected, retrying without thinkingConfig/schema:', err.message);
      const parsed = await callOnce({ contents, systemInstruction, schema, timeoutMs: remaining, lean: true });
      leanConfig = true;
      return parsed;
    }
    throw err;
  }
}

async function callOnce({ contents, systemInstruction, schema, timeoutMs, lean }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  // Gemini 3: keep temperature at its default 1.0 (lower values can cause looping), so it is not set.
  const cfg = {
    responseMimeType: 'application/json',
    abortSignal: controller.signal,
    httpOptions: { timeout: timeoutMs },
  };
  if (systemInstruction) cfg.systemInstruction = systemInstruction;
  if (!lean) {
    cfg.responseJsonSchema = schema;
    cfg.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
  }
  try {
    const call = ai.models.generateContent({ model: config.geminiModel, contents, config: cfg });
    call.catch(() => {}); // the timeout may win the race; don't leave an unhandled rejection behind
    const res = await Promise.race([call, timeout]);
    return parseModelJson(responseText(res));
  } finally {
    clearTimeout(timer);
  }
}

// res.text is a getter that can be undefined (safety block, thoughts only) or warn/throw on odd responses.
function responseText(res) {
  try {
    if (typeof res?.text === 'string') return res.text;
  } catch {
    /* fall through */
  }
  const parts = res?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
}

// Tolerant JSON reader for model output: code fences, a one-element array, leading/trailing prose.
// Returns a plain object or null.
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  let value = tryParse(s);
  if (value === undefined) {
    for (let i = 0; i < s.length && value === undefined; i++) {
      if (s[i] === '{' || s[i] === '[') {
        const end = matchingBracket(s, i);
        if (end > i) value = tryParse(s.slice(i, end + 1));
      }
    }
  }
  if (Array.isArray(value)) value = value.find((v) => v && typeof v === 'object' && !Array.isArray(v));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Index of the bracket closing the one at `start`, skipping over strings. -1 if unbalanced.
function matchingBracket(s, start) {
  const stack = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Canned interview: works with no API key, and is the fallback when Gemini fails or is slow.
// ---------------------------------------------------------------------------
const OPENER = "Hi, thanks for coming in. Let's start simple: tell me about yourself.";
const CANNED = [
  'Tell me about a time you failed. What happened?',
  'Why should we hire you over the other candidates?',
  'Describe a conflict with a teammate and how you handled it.',
  "What's your biggest weakness? And don't say perfectionism.",
  'Walk me through a project you are proud of, in detail.',
  'Tell me about a time you had to learn something new very quickly. How did you do it?',
  'Describe a decision you made with incomplete information. How did it turn out?',
  'Tell me about a time you disagreed with your manager or professor. What did you do?',
  'What is the hardest technical problem you have solved? Walk me through it.',
  'Tell me about a time you missed a deadline. What would you do differently?',
  'How do you handle feedback you think is wrong?',
  'Why this role, and why now?',
  'Where do you see yourself in five years?',
  'Is there anything you want me to know about you that we have not covered?',
];
const CALM_PREFIX = 'Okay. Be specific this time. ';

function cannedTurn({ state, questionCount, history = [] }) {
  if (state === 'overloaded') {
    return {
      say: "Let's pause. Take one slow breath in, and out. Whenever you're ready, we'll continue.",
      action: 'breathe',
      source: 'canned',
    };
  }
  const asked = new Set(
    history.filter((h) => h.speaker === 'interviewer').map((h) => String(h.text).replace(CALM_PREFIX, '')),
  );
  let q;
  if (questionCount === 0 && !asked.has(OPENER)) q = OPENER;
  else q = CANNED.find((c) => !asked.has(c)) || CANNED[questionCount % CANNED.length];
  const escalate = state === 'calm' && questionCount > 0;
  return { say: escalate ? `${CALM_PREFIX}${q}` : q, action: escalate ? 'escalate' : 'ask', source: 'canned' };
}
