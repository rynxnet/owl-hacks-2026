import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const PERSONAS = [
  { id: 'friendly', label: 'Friendly recruiter', blurb: 'Warm, but still asks real questions' },
  { id: 'cold', label: 'Cold tech lead', blurb: 'Blunt, skeptical, interrupts vague answers' },
  { id: 'rapid', label: 'Rapid-fire panel', blurb: 'Short, fast follow-ups' },
];

const ROLE_IDEAS = [
  'Software Engineering Intern',
  'SOC Analyst',
  'IT Help Desk Technician',
  'Data Analyst',
  'Registered Nurse',
  'Financial Analyst',
  'Marketing Coordinator',
  'High School Teacher',
  'Mechanical Engineer',
  'Product Manager',
  'UX Designer',
  'Paralegal',
  'Barista',
];

export default function Setup({ onStart }) {
  const [role, setRole] = useState('Software Engineering Intern');
  const [jobDetails, setJobDetails] = useState('');
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
      const s = await api.startSession({ role: role.trim(), jobDetails: jobDetails.trim(), persona, maxQuestions: questions });
      onStart(s);
    } catch (e) {
      setError('Could not reach the backend. Is it running on port 3001?');
    }
  }

  return (
    <div className="card setup">
      <h1>Interview Pressure Test</h1>
      <p className="muted">A mock interviewer that reads your heart rate and adapts to it.</p>

      <label>
        Role you're interviewing for
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          list="role-ideas"
          maxLength={120}
          placeholder="Any job: SOC Analyst, Registered Nurse, Barista..."
        />
      </label>
      <datalist id="role-ideas">
        {ROLE_IDEAS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <p className="hint">The interviewer becomes the hiring manager for this job and asks questions only someone hiring for it would ask.</p>

      <label>
        Job posting or details <span className="optional">(optional)</span>
        <textarea
          value={jobDetails}
          onChange={(e) => setJobDetails(e.target.value)}
          maxLength={4000}
          rows={4}
          placeholder="Paste the job description, the company name, or what the job involves. The interviewer will ask about it."
        />
      </label>

      <div className="label">Interviewer</div>
      <div className="personas">
        {PERSONAS.map((p) => (
          <button
            key={p.id}
            className={`persona ${p.id} ${persona === p.id ? 'selected' : ''}`}
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
        <Status ok={health?.gemini} label="Gemini" off="required for the interviewer" />
        <Status ok={health?.elevenlabs} label="ElevenLabs" off="browser voice" />
        <Status ok={health?.database} label="Tiger Data" off="memory only" />
      </div>

      {health?.sensorStatus && <p className="sensor-hint">📷 {health.sensorStatus}</p>}

      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={start} disabled={!health || !role.trim()}>
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
