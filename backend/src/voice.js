import { config } from './config.js';

// Returns base64 MP3 audio for the interviewer's line, or null if ElevenLabs isn't configured
// (the frontend then falls back to the browser's built-in speech).
export async function speak(text, persona = 'friendly') {
  const voiceId = config.voices[persona] || config.voices.friendly;
  if (!config.elevenKey || !voiceId || !text) return null;

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: config.elevenModel }),
    });
    if (!res.ok) {
      console.error('[elevenlabs]', res.status, await res.text());
      return null;
    }
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch (err) {
    console.error('[elevenlabs] failed:', err.message);
    return null;
  }
}
