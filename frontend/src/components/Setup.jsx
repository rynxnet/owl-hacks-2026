import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const PERSONAS = [
  { id: 'friendly', label: 'Friendly recruiter', blurb: 'Warm, but still asks real questions' },
  { id: 'cold', label: 'Cold tech lead', blurb: 'Blunt, skeptical, interrupts vague answers' },
  { id: 'rapid', label: 'Rapid-fire panel', blurb: 'Short, fast follow-ups' },
];

export default function Setup({ onStart }) {
  const [role, setRole] = useState('Software Engineering Intern');
  const [persona, setPersona] = useState('cold');
  const [questions, setQuestions] = useState(6);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => api.health().then(setHealth).catch(() => setHealth(null));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function start() {
    setError('');
    try {
      const s = await api.startSession({ role, persona, maxQuestions: questions });
      onStart(s);
    } catch (e) {
      setError('Could not reach the backend. Is it running on port 3001?');
    }
  }

  return (
    <div className="card setup">
      <h1>Pressure Test</h1>
      <p className="muted">A mock interviewer that reads your heart rate and adapts to it.</p>

      <label>
        Role you're interviewing for
        <input value={role} onChange={(e) => setRole(e.target.value)} />
      </label>

      <div className="label">Interviewer</div>
      <div className="personas">
        {PERSONAS.map((p) => (
          <button
            key={p.id}
            className={`persona ${persona === p.id ? 'selected' : ''}`}
            onClick={() => setPersona(p.id)}
          >
            <strong>{p.label}</strong>
            <span>{p.blurb}</span>
          </button>
        ))}
      </div>

      <label>
        Questions: {questions}
        <input type="range" min="3" max="10" value={questions} onChange={(e) => setQuestions(+e.target.value)} />
      </label>

      <div className="status">
        <Status ok={!!health} label="Backend" />
        <Status
          ok={health?.presageServer || health?.vitalsSources > 0}
          label={health?.presageServer ? 'Presage (webcam)' : 'Heart-rate source'}
          off={health?.presageError ? 'SDK failed to load' : undefined}
        />
        <Status ok={health?.gemini} label="Gemini" off="canned questions" />
        <Status ok={health?.elevenlabs} label="ElevenLabs" off="browser voice" />
        <Status ok={health?.database} label="Tiger Data" off="memory only" />
      </div>

      {health?.sensorStatus && <p className="sensor-hint">📷 {health.sensorStatus}</p>}

      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={start} disabled={!health}>
        Start interview
      </button>
    </div>
  );
}

function Status({ ok, label, off }) {
  return (
    <span className={`pill ${ok ? 'ok' : 'off'}`}>
      {ok ? '●' : '○'} {label}
      {!ok && off ? ` (${off})` : ''}
    </span>
  );
}
