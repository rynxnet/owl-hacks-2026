// Checks the ElevenLabs setup:  npm run voices
// Lists the voices your key can use, then synthesizes one line per persona and saves voice-test-*.mp3.
import fs from 'node:fs';
import { config } from './config.js';
import { speak } from './voice.js';

if (!config.elevenKey) {
  console.error('Set ELEVENLABS_API_KEY in backend/.env first.');
  process.exit(1);
}

const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': config.elevenKey } });
if (res.ok) {
  const { voices } = await res.json();
  console.log('Voices on your account (put an ID in VOICE_FRIENDLY / VOICE_COLD / VOICE_RAPID to override):');
  for (const v of voices) console.log(`  ${v.voice_id}  ${v.name.padEnd(28)} ${v.category}`);
} else {
  console.log(`Could not list voices (${res.status}); key may lack voices_read permission. Testing speech anyway.\n`);
}

const LINES = {
  friendly: "Hi, thanks for coming in. Let's start simple: tell me about yourself.",
  cold: 'That was vague. Why did you make that choice?',
  rapid: 'Quick one. Biggest failure. Go.',
};
console.log('\nPersona test:');
for (const [persona, line] of Object.entries(LINES)) {
  const t = Date.now();
  const audio = await speak(line, persona);
  if (audio) {
    fs.writeFileSync(`voice-test-${persona}.mp3`, Buffer.from(audio, 'base64'));
    console.log(`  ${persona.padEnd(9)} OK  ${Date.now() - t} ms  -> voice-test-${persona}.mp3  (voice ${config.voices[persona]})`);
  } else {
    console.log(`  ${persona.padEnd(9)} FAILED (see error above)`);
  }
}
