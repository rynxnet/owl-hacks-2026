import pg from 'pg';
import { config } from './config.js';

// Tiger Data is Postgres with time-series extensions, so the normal `pg` driver works.
// If DATABASE_URL is empty, every call is a no-op and the app runs purely in memory.
const pool = config.databaseUrl
  ? new pg.Pool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

export const dbEnabled = Boolean(pool);

async function q(text, params) {
  if (!pool) return null;
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('[db]', err.message);
    return null;
  }
}

export const db = {
  createSession: (s) =>
    q('INSERT INTO sessions (id, persona, role, started_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))', [
      s.id, s.persona, s.role, s.startedAt,
    ]),
  addVitals: (sessionId, v) =>
    q(
      'INSERT INTO vitals (time, session_id, hr, br, state) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5)',
      [v.ts, sessionId, v.hr, v.br ?? null, v.state],
    ),
  addUtterance: (sessionId, u) =>
    q(
      'INSERT INTO utterances (time, session_id, speaker, text, state) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5)',
      [u.ts, sessionId, u.speaker, u.text, u.state],
    ),
  endSession: (id, baseline) =>
    q('UPDATE sessions SET ended_at = now(), baseline_hr = $2 WHERE id = $1', [id, baseline]),
};
