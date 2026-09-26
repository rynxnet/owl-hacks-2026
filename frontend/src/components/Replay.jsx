import { LineChart, Line, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts';
import { STATE_COLORS } from './VitalsChart.jsx';

// Heart rate over the whole interview, with a marker at every interviewer question.
export default function Replay({ replay, onRestart }) {
  const t0 = replay.startedAt;
  const data = replay.vitals.map((v) => ({ t: Math.round((v.ts - t0) / 1000), hr: v.hr }));
  const questions = replay.utterances.filter((u) => u.speaker === 'interviewer');
  const top = replay.spikes[0];

  return (
    <div className="replay">
      <div className="card">
        <h2>Your replay</h2>
        <p className="muted">
          {replay.role} · baseline {replay.baseline ? Math.round(replay.baseline) : '--'} bpm
          {top ? ` · biggest spike +${top.rise} bpm` : ''}
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t) => `${t}s`} stroke="#8a8f98" />
            <YAxis domain={['dataMin - 5', 'dataMax + 5']} stroke="#8a8f98" />
            <Tooltip formatter={(v) => [`${v} bpm`, 'Heart rate']} labelFormatter={(t) => `${t}s`} />
            {replay.baseline && <ReferenceLine y={replay.baseline} stroke={STATE_COLORS.calm} strokeDasharray="4 4" />}
            {questions.map((q, i) => (
              <ReferenceLine
                key={i}
                x={Math.round((q.ts - t0) / 1000)}
                stroke={top && q.ts === top.ts ? STATE_COLORS.overloaded : '#c3c7cf'}
                label={{ value: `Q${i + 1}`, position: 'top', fill: '#8a8f98', fontSize: 11 }}
              />
            ))}
            <Line type="monotone" dataKey="hr" stroke="#5b8def" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>What rattled you</h3>
          {replay.spikes.length === 0 && <p className="muted">No heart-rate data recorded.</p>}
          {replay.spikes.map((s, i) => (
            <div key={i} className="spike">
              <strong>+{s.rise} bpm</strong> (peak {Math.round(s.peakHr)})
              <p>"{s.question}"</p>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Coaching</h3>
          <p>{replay.feedback?.summary}</p>
          {replay.feedback?.strongerAnswer && (
            <>
              <h4>A stronger answer</h4>
              <p className="quote">{replay.feedback.strongerAnswer}</p>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Transcript</h3>
        {replay.utterances.map((u, i) => (
          <p key={i}>
            <span className="tag" style={{ background: STATE_COLORS[u.state] || '#8a8f98' }}>{u.state}</span>{' '}
            <strong>{u.speaker === 'interviewer' ? 'Interviewer' : 'You'}:</strong> {u.text}
          </p>
        ))}
      </div>

      <button className="primary" onClick={onRestart}>Practice again</button>
    </div>
  );
}
