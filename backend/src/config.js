import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3001),

  // Gemini (interviewer brain). Without a key the server uses canned questions.
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',

  // ElevenLabs (interviewer voice). Without a key the browser's built-in voice is used.
  elevenKey: process.env.ELEVENLABS_API_KEY || '',
  elevenModel: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
  // Defaults are ElevenLabs premade voices (usable on the free plan). Override with IDs from `npm run voices`.
  voices: {
    friendly: process.env.VOICE_FRIENDLY || 'cgSgspJ2msm6clMCkdW9', // Jessica: warm, conversational
    cold: process.env.VOICE_COLD || 'onwK4e9ZLuTAKqWW03F9', // Daniel: steady, authoritative
    rapid: process.env.VOICE_RAPID || 'TX3LPaxmHKxFdv7VOQHJ', // Liam: energetic
  },

  // Presage (heart rate from the webcam). With a key, the backend reads frames the browser streams to it.
  presageKey: process.env.PRESAGE_API_KEY || '',
  presageMinConfidence: Number(process.env.PRESAGE_MIN_CONFIDENCE || 0),

  // Tiger Data (Postgres + time-series). Without a URL everything stays in memory.
  databaseUrl: process.env.DATABASE_URL || '',

  // Stress logic tuning
  baselineMs: Number(process.env.BASELINE_MS || 30000),
  windowMs: Number(process.env.WINDOW_MS || 10000),
  elevatedPct: Number(process.env.ELEVATED_PCT || 0.15),
  overloadPct: Number(process.env.OVERLOAD_PCT || 0.30),
  holdMs: Number(process.env.HOLD_MS || 6000),
};
