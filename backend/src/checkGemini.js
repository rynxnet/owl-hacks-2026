// Quick Gemini sanity check:  npm run check:gemini
// Tests every key (GEMINI_API_KEY + GEMINI_BACKUP_KEYS) against every model (GEMINI_MODEL +
// GEMINI_FALLBACK_MODELS) with one small call each, and lists the flash models your key can use, so you can
// pick fallbacks before a demo. 503 = Google is overloaded right now; 429 = that key/model is out of quota.
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const keys = config.geminiKeys;
if (!keys.length) {
  console.log('✗ GEMINI_API_KEY is empty. Make sure backend/.env exists and has GEMINI_API_KEY=yourkey (no quotes/spaces).');
  process.exit(1);
}
const label = (k, i) => `key ${i + 1} (...${k.slice(-4)})`;
console.log(`Keys:   ${keys.map(label).join(', ')}`);
console.log(`Models: ${config.geminiModels.join(', ')}  (main first, then GEMINI_FALLBACK_MODELS)\n`);

try {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keys[0]}&pageSize=200`);
  const body = await res.json();
  if (!res.ok) {
    console.log(`✗ ${label(keys[0], 0)} rejected (${res.status}): ${body.error?.message}`);
  } else {
    const names = body.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    const flash = names.filter((n) => n.includes('flash'));
    console.log(`Flash models available to key 1: ${flash.join(', ') || '(none)'}`);
    for (const m of config.geminiModels) if (!names.includes(m)) console.log(`✗ "${m}" is NOT available to key 1.`);
    const spare = flash.filter((n) => !config.geminiModels.includes(n) && !/tts|image|audio|live|embed/i.test(n));
    if (spare.length && !config.geminiFallbackModels.length)
      console.log(`Tip: add backups for busy moments, e.g.  GEMINI_FALLBACK_MODELS=${spare.slice(0, 2).join(',')}`);
    console.log('');
  }
} catch (err) {
  console.log('! Could not list models:', err.message);
}

let working = 0;
for (const [i, key] of keys.entries()) {
  const ai = new GoogleGenAI({ apiKey: key });
  for (const model of config.geminiModels) {
    const t0 = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: 'Reply ONLY with JSON: {"say": "one short interview question", "action": "ask"}',
        // Same thinking level the interviewer uses, so a model that rejects it shows up here.
        config: {
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: (process.env.GEMINI_THINKING_LEVEL || 'LOW').toUpperCase() },
        },
      });
      working++;
      console.log(`✓ ${model} with ${label(key, i)}: OK in ${Date.now() - t0} ms  ${String(res.text).slice(0, 80)}`);
    } catch (err) {
      const m = String(err.message);
      const why = /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(m)
        ? 'OUT OF QUOTA (429): wait, or use another key/model'
        : /\b503\b|UNAVAILABLE|overloaded/i.test(m)
          ? 'OVERLOADED (503): Google is busy, usually passes in a minute'
          : m.slice(0, 160);
      console.log(`✗ ${model} with ${label(key, i)}: ${why}`);
    }
  }
}

console.log(
  working
    ? `\n${working} of ${keys.length * config.geminiModels.length} key/model combinations work. The interviewer switches between them automatically. Restart the backend (Ctrl+C, npm run dev) after changing .env.`
    : '\nNothing works right now. Check the key, wait for quota to reset, or add GEMINI_BACKUP_KEYS / GEMINI_FALLBACK_MODELS.',
);
