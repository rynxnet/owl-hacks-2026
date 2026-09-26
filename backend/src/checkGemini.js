// Quick Gemini sanity check:  npm run check:gemini
// Tells you whether the key loaded, which models your key can use, and whether a real call works.
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const key = config.geminiKey;
if (!key) {
  console.log('✗ GEMINI_API_KEY is empty. Make sure backend/.env exists and has GEMINI_API_KEY=yourkey (no quotes/spaces).');
  process.exit(1);
}
console.log(`✓ Key loaded (${key.length} chars, ends in ...${key.slice(-4)})`);
console.log(`  Model configured: ${config.geminiModel}`);

try {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`);
  const body = await res.json();
  if (!res.ok) {
    console.log(`✗ Key rejected (${res.status}): ${body.error?.message}`);
    process.exit(1);
  }
  const names = body.models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));
  const flash = names.filter((n) => n.includes('flash'));
  console.log(`✓ Key works. Flash models available: ${flash.join(', ') || '(none)'}`);
  if (!names.includes(config.geminiModel)) {
    console.log(`✗ "${config.geminiModel}" is NOT available to your key. Set GEMINI_MODEL in .env to one of the above.`);
  }
} catch (err) {
  console.log('! Could not list models:', err.message);
}

try {
  const ai = new GoogleGenAI({ apiKey: key });
  const res = await ai.models.generateContent({
    model: config.geminiModel,
    contents: 'Reply ONLY with JSON: {"say": "one short interview question", "action": "ask"}',
    // Same thinking level the interviewer uses, so a model that rejects it shows up here.
    config: {
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: (process.env.GEMINI_THINKING_LEVEL || 'LOW').toUpperCase() },
    },
  });
  console.log('✓ Test call worked:', res.text);
  console.log('\nGemini is fine. Restart the backend (Ctrl+C, npm run dev) so it picks up the .env.');
} catch (err) {
  console.log('✗ Test call failed:', err.message);
}
