import { config } from './config.js';

// Per-persona delivery. speed: 0.7-1.2, stability: higher = flatter / more controlled.
const DELIVERY = {
  friendly: { stability: 0.45, similarity_boost: 0.75, style: 0.3, speed: 1.0 },
  cold: { stability: 0.8, similarity_boost: 0.75, style: 0.05, speed: 0.95 },
  rapid: { stability: 0.4, similarity_boost: 0.75, style: 0.2, speed: 1.2 }, // 1.2 is ElevenLabs' max
};

let warned = false;

// Returns base64 MP3 audio for the interviewer's line, or null if ElevenLabs isn't configured or fails
// (the frontend then falls back to the browser's built-in speech, so the interview never stalls).
export async function speak(text, persona = 'friendly') {
  const voiceId = config.voices[persona] || config.voices.friendly;
  if (!config.elevenKey || !voiceId || !text) return null;

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
      {
        method: 'POST',
        headers: { 'xi-api-key': config.elevenKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: config.elevenModel,
          voice_settings: DELIVERY[persona] || DELIVERY.friendly,
        }),
        signal: AbortSignal.timeout(8000), // slow TTS -> fall back to browser voice instead of freezing
      },
    );
    if (!res.ok) {
      const body = await res.text();
      if (!warned || res.status !== 401) {
        const hint =
          res.status === 401 ? ' (bad API key or key missing text_to_speech permission)'
          : res.status === 402 || /quota/i.test(body) ? ' (out of credits)'
          : res.status === 404 ? ` (voice ${voiceId} not found; run npm run voices)`
          : '';
        console.error(`[elevenlabs] ${res.status}${hint}: ${body.slice(0, 200)}`);
        warned = true;
      }
      return null;
    }
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch (err) {
    console.error('[elevenlabs] failed, using browser voice:', err.message);
    return null;
  }
}
