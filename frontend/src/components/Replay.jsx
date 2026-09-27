import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts';
import { STATE_COLORS } from './VitalsChart.jsx';
import { endInterview, fetchReplay } from '../lib/api.js';

const COACHING_ERRORS = {
  timeout: 'The coach is taking longer than usual.',
  unavailable: "Couldn't generate coaching this time.",
  server: "Couldn't generate coaching this time.",
  lost: 'Coaching is unavailable: the server restarted and lost this interview.',
  offline: 'Coaching is unavailable: the server could not be reached.',
};

// Heart rate over the whole interview, with a marker at every interviewer question.
// Must render something useful with any subset of data missing (no vitals, no coaching, ...).
export default function Replay({ replay: initial, onRestart }) {
  const [replay, setReplay] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    setReplay(initial);
  }, [initial]);

  const vitals = (replay.vitals || []).filter((v) => Number.isFinite(v?.hr) && Number.isFinite(v?.ts));
  const utterances = replay.utterances || [];
  const spikes = replay.spikes || [];
  const feedback = replay.feedback?.summary ? replay.feedback : null;
  const baseline = Number.isFinite(replay.baseline) ? replay.baseline : null;
  const t0 = replay.startedAt ?? vitals[0]?.ts ?? utterances[0]?.ts ?? 0;
  const sec = (ts) => Math.round((ts - t0) / 1000);

  const data = vitals.map((v) => ({ t: sec(v.ts), hr: Math.round(v.hr * 10) / 10 }));
  const hrs = data.map((d) => d.hr);
  const yLo = hrs.length ? Math.floor(Math.min(...hrs, baseline ?? Infinity) - 5) : 0;
  const yHi = hrs.length ? Math.ceil(Math.max(...hrs, baseline ?? -Infinity) + 5) : 1;
  const questions = utterances.filter((u) => u.speaker === 'interviewer' && u.action !== 'breathe' && u.action !== 'end');
  const top = spikes[0];

  // Coaching arrived after /end timed out? The server keeps it; pick it up.
  const waiting = !feedback && replay.feedbackPending && !replay.local;
  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const r = await fetchReplay(replay.id);
        if (r.feedback || !r.feedbackPending || tries >= 20) {
          clearInterval(timer);
          setReplay(r);
        }
      } catch {
        if (tries >= 20) clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting, replay.id]);

  async function retryCoaching() {
    setRetrying(true);
    try {
      setReplay(await endInterview(replay.id, { retryFeedback: true }));
    } catch (err) {
      setReplay((r) => ({ ...r, feedbackError: err.status === 404 ? 'lost' : 'offline' }));
    } finally {
      setRetrying(false);
    }
  }

  // 'lost' = the server forgot the session (restart), so asking again can't work.
  const canRetry = replay.id && replay.feedbackError !== 'lost';

  return (
    <div className="replay">
      <div className="card">
        <h2>Your replay</h2>
        <p className="muted">
          {replay.role || 'Interview'} · baseline{' '}
          {baseline ? `${replay.baselineEstimated ? '~' : ''}${Math.round(baseline)} bpm` : '--'}
          {top ? ` · biggest spike +${top.rise} bpm` : ''}
        </p>
        {data.length >= 2 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data} margin={{ top: 18, right: 16, bottom: 0, left: -10 }}>
              <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t) => `${t}s`} stroke="#8a8f98" />
              <YAxis domain={[yLo, yHi]} stroke="#8a8f98" allowDecimals={false} />
              <Tooltip formatter={(v) => [`${v} bpm`, 'Heart rate']} labelFormatter={(t) => `${t}s`} />
              {baseline && <ReferenceLine y={baseline} stroke={STATE_COLORS.calm} strokeDasharray="4 4" />}
              {questions.map((q, i) => (
                <ReferenceLine
                  key={q.ts}
                  x={sec(q.ts)}
                  stroke={top && q.ts === top.ts ? STATE_COLORS.overloaded : '#c3c7cf'}
                  // Too many markers to label legibly: label only the spike questions.
                  label={
                    questions.length <= 12 || spikes.some((s) => s.ts === q.ts)
                      ? { value: `Q${i + 1}`, position: 'top', fill: '#8a8f98', fontSize: 11 }
                      : undefined
                  }
                />
              ))}
              <Line type="monotone" dataKey="hr" stroke="#5b8def" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="muted" style={{ padding: '24px 0' }}>
            {vitals.length === 1
              ? 'Only one heart-rate reading was recorded, not enough to draw a chart.'
              : 'No heart-rate data was recorded for this interview (baseline skipped or the camera never locked on).'}
          </p>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h3>What rattled you</h3>
          {spikes.length === 0 && (
            <p className="muted">
              {replay.local
                ? 'Spike analysis needs the server, which could not finish this interview.'
                : vitals.length
                  ? 'Your heart rate never rose above your baseline during a question. Steady.'
                  : 'No heart-rate data, so no spikes to show.'}
            </p>
          )}
          {spikes.map((s) => (
            <div key={s.ts} className="spike">
              <strong>+{s.rise} bpm</strong> (peak {Math.round(s.peakHr)})
              <p>"{s.question}"</p>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Coaching</h3>
          {feedback ? (
            <>
              <p>{feedback.summary}</p>
              {feedback.strongerAnswer && (
                <>
                  <h4>A stronger answer</h4>
                  <p className="quote">{feedback.strongerAnswer}</p>
                </>
              )}
            </>
          ) : waiting && !retrying ? (
            <p className="muted">Still writing your coaching...</p>
          ) : (
            <>
              <p className="muted">
                {retrying ? 'Asking the coach again...' : COACHING_ERRORS[replay.feedbackError] || 'No coaching was generated.'}
              </p>
              {!retrying && canRetry && (
                <button className="link" onClick={retryCoaching}>Try again</button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Transcript</h3>
        {utterances.length === 0 && <p className="muted">Nothing was said in this interview.</p>}
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          {utterances.map((u, i) => (
            <p key={i} className={`replay-transcript-line ${u.speaker === 'interviewer' ? 'interviewer' : ''}`}>
              <span className="tag" style={{ background: STATE_COLORS[u.state] || '#8a8f98' }}>{u.state || 'n/a'}</span>{' '}
              <strong>{u.speaker === 'interviewer' ? 'Interviewer' : 'You'}:</strong> {u.text}
            </p>
          ))}
        </div>
      </div>

      <button className="primary" onClick={onRestart}>Practice again</button>
    </div>
  );
}
