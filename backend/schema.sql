-- Tiger Data schema. Run with: npm run db:init  (needs DATABASE_URL in .env)

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  persona     TEXT NOT NULL,
  role        TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  baseline_hr REAL
);

CREATE TABLE IF NOT EXISTS vitals (
  time       TIMESTAMPTZ NOT NULL,
  session_id TEXT NOT NULL,
  hr         REAL,
  br         REAL,
  state      TEXT
);

CREATE TABLE IF NOT EXISTS utterances (
  time       TIMESTAMPTZ NOT NULL,
  session_id TEXT NOT NULL,
  speaker    TEXT NOT NULL,   -- 'interviewer' | 'candidate'
  text       TEXT NOT NULL,
  state      TEXT
);

-- Turn vitals into a time-series hypertable (Tiger Data / TimescaleDB).
SELECT create_hypertable('vitals', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS vitals_session_time ON vitals (session_id, time DESC);
CREATE INDEX IF NOT EXISTS utterances_session_time ON utterances (session_id, time);

-- Example replay query: average heart rate during each utterance.
-- SELECT u.time, u.speaker, u.text,
--        (SELECT avg(v.hr) FROM vitals v
--          WHERE v.session_id = u.session_id
--            AND v.time BETWEEN u.time AND u.time + interval '20 seconds') AS avg_hr
-- FROM utterances u WHERE u.session_id = $1 ORDER BY u.time;
