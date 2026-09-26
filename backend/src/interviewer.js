import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const ai = config.geminiKey ? new GoogleGenAI({ apiKey: config.geminiKey }) : null;

export const PERSONAS = {
  friendly: 'a warm, encouraging recruiter who still asks real questions',
  cold: 'a blunt, skeptical senior engineer who interrupts vague answers and asks "why?"',
  rapid: 'a fast-paced panel interviewer who fires short, rapid follow-ups',
};

const STATE_RULES = `
How to adapt to the candidate's stress state (measured from their heart rate):
- "calm": raise the pressure. Ask a harder follow-up, challenge a vague claim, or throw a curveball.
- "elevated": keep the pressure steady. Ask a normal next question; do not add more pressure.
- "overloaded": stop and coach. Set action to "breathe" and say one short sentence inviting a slow breath before continuing.
`;

// Returns { say, action } where action is "ask" | "escalate" | "breathe" | "end".
export async function nextTurn({ persona, role, history, state, questionCount, maxQuestions }) {
  if (questionCount >= maxQuestions) {
    return { say: 'That wraps up our interview. Thanks for your time.', action: 'end' };
  }
  if (!ai) return cannedTurn({ state, questionCount });

  const system = `You are ${PERSONAS[persona] || PERSONAS.friendly}, interviewing a candidate for: ${role}.
Speak in 1-3 short spoken sentences. No lists, no markdown, no stage directions.
${STATE_RULES}
Reply ONLY with JSON: {"say": string, "action": "ask" | "escalate" | "breathe"}.`;

  const transcript = history
    .map((h) => `${h.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${h.text}`)
    .join('\n');

  const prompt = `Transcript so far:\n${transcript || '(interview is starting; greet briefly and ask the first question)'}\n\nCandidate stress state right now: "${state}". Question ${questionCount + 1} of ${maxQuestions}.`;

  try {
    const res = await ai.models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: { systemInstruction: system, responseMimeType: 'application/json', temperature: 0.8 },
    });
    const parsed = JSON.parse(res.text);
    return { say: String(parsed.say || '').trim(), action: parsed.action || 'ask' };
  } catch (err) {
    console.error('[gemini] turn failed, using canned question:', err.message);
    return cannedTurn({ state, questionCount });
  }
}

export async function feedback({ role, history, spikes }) {
  if (!ai) {
    return {
      summary: 'Add a GEMINI_API_KEY to get written feedback. Your heart-rate replay is still shown.',
      strongerAnswer: null,
    };
  }
  const transcript = history.map((h) => `${h.speaker}: ${h.text}`).join('\n');
  const prompt = `A candidate practiced an interview for: ${role}.
Transcript:\n${transcript}\n
Moments where their heart rate spiked (question text and bpm rise): ${JSON.stringify(spikes)}
Give coaching as JSON: {"summary": "3-4 sentences: what went well, what rattled them, one habit to fix",
"strongerAnswer": "a rewritten, stronger version of their answer to the question that stressed them most"}`;
  try {
    const res = await ai.models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    return JSON.parse(res.text);
  } catch (err) {
    console.error('[gemini] feedback failed:', err.message);
    return { summary: 'Feedback unavailable right now.', strongerAnswer: null };
  }
}

// Works with no API key so the team can build the rest of the app immediately.
const CANNED = [
  "Hi, thanks for coming in. Let's start simple: tell me about yourself.",
  'Tell me about a time you failed. What happened?',
  'Why should we hire you over the other candidates?',
  'Describe a conflict with a teammate and how you handled it.',
  "What's your biggest weakness? And don't say perfectionism.",
  'Walk me through a project you are proud of, in detail.',
  'Where do you see yourself in five years?',
];
function cannedTurn({ state, questionCount }) {
  if (state === 'overloaded') {
    return { say: "Let's pause. Take one slow breath in, and out. Whenever you're ready, we'll continue.", action: 'breathe' };
  }
  const q = CANNED[questionCount % CANNED.length];
  return { say: state === 'calm' && questionCount > 0 ? `Okay. Be specific this time. ${q}` : q, action: state === 'calm' ? 'escalate' : 'ask' };
}
