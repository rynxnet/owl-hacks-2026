import { useEffect, useRef, useState } from 'react';
import { api, subscribe } from '../lib/api.js';
import { playLine } from '../lib/audio.js';
import { createRecognizer } from '../lib/speech.js';
import VitalsChart, { STATE_COLORS } from './VitalsChart.jsx';

const BREATHE_SECONDS = 10;

export default function Interview({ session, onDone }) {
  const [vitals, setVitals] = useState([]);
  const [snap, setSnap] = useState({ state: 'baseline', baseline: null, baselineProgress: 0 });
  const [utterances, setUtterances] = useState([]);
  const [phase, setPhase] = useState('baseline'); // baseline | speaking | answering | thinking | breathing | ending
  const [partial, setPartial] = useState('');
  const [typed, setTyped] = useState('');
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState({ q: 0, max: 0 });
  const [showCam, setShowCam] = useState(true);
  const [sensor, setSensor] = useState(''); // Presage hint, e.g. "No face found"
  const started = useRef(false);
  const recognizer = useRef(null);
  const videoRef = useRef(null);
  const transcriptEnd = useRef(null);

  // Live updates from the backend
  useEffect(() => {
    return subscribe(session.id, (msg) => {
      if (msg.type === 'vitals') {
        setVitals((v) => [...v.slice(-300), msg]);
        setSnap({ state: msg.state, baseline: msg.baseline, baselineProgress: msg.baselineProgress });
      }
      if (msg.type === 'utterance') setUtterances((u) => [...u, msg]);
      if (msg.type === 'sensor') setSensor(msg.status);
    });
  }, [session.id]);

  useEffect(() => transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' }), [utterances, partial]);

  // Webcam preview. Some systems only let one program use the camera at a time:
  // if Presage runs on this same laptop and the preview fails, turn the preview off.
  useEffect(() => {
    if (!showCam) return;
    let stream;
    navigator.mediaDevices
      ?.getUserMedia({ video: true })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => setShowCam(false));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [showCam]);

  // Baseline done -> first question
  useEffect(() => {
    if (phase === 'baseline' && snap.baseline && !started.current) {
      started.current = true;
      takeTurn('');
    }
  }, [snap.baseline, phase]);

  async function takeTurn(answer) {
    setPhase('thinking');
    const turn = await api.turn(session.id, answer);
    setProgress({ q: turn.questionCount, max: turn.maxQuestions });
    setPhase('speaking');
    await playLine(turn.say, turn.audio);

    if (turn.action === 'end') return finish();
    if (turn.action === 'breathe') {
      setPhase('breathing');
      await new Promise((r) => setTimeout(r, BREATHE_SECONDS * 1000));
      return takeTurn('');
    }
    setPhase('answering');
  }

  async function toggleMic() {
    if (!recognizer.current) recognizer.current = createRecognizer(setPartial);
    if (!recognizer.current) return alert('Speech recognition needs Chrome or Edge. Type your answer instead.');
    if (!recording) {
      setPartial('');
      recognizer.current.start();
      setRecording(true);
    } else {
      setRecording(false);
      const text = await recognizer.current.stop();
      setPartial('');
      if (text) takeTurn(text);
    }
  }

  function sendTyped(e) {
    e.preventDefault();
    if (!typed.trim()) return;
    const text = typed;
    setTyped('');
    takeTurn(text);
  }

  async function finish() {
    setPhase('ending');
    const replay = await api.end(session.id);
    onDone(replay);
  }

  const latest = vitals.at(-1);
  const color = STATE_COLORS[snap.state];

  return (
    <div className="interview">
      <div className="left">
        <div className="card">
          <div className="row between">
            <div>
              <div className="big" style={{ color }}>{latest ? Math.round(latest.hr) : '--'} <small>bpm</small></div>
              <div className="state" style={{ background: color }}>{snap.state}</div>
            </div>
            <div className="muted right-text">
              {snap.baseline ? `Baseline ${Math.round(snap.baseline)} bpm` : 'Measuring baseline'}
              <br />
              {progress.max ? `Question ${progress.q} of ${progress.max}` : ''}
            </div>
          </div>
          {sensor && <p className="sensor-hint">📷 {sensor}</p>}
          <VitalsChart vitals={vitals} baseline={snap.baseline} />
          {!latest && <p className="muted">Waiting for heart-rate data. Start the Presage bridge or run <code>npm run sim</code> in backend/.</p>}
        </div>

        {showCam && (
          <div className="card cam">
            <video ref={videoRef} autoPlay muted playsInline />
          </div>
        )}
        <button className="link" onClick={() => setShowCam((s) => !s)}>
          {showCam ? 'Hide camera preview' : 'Show camera preview'}
        </button>
      </div>

      <div className="right card">
        {phase === 'baseline' && (
          <div className="center">
            <h2>Get comfortable</h2>
            <p className="muted">Sit still facing the camera while we learn your resting heart rate.</p>
            <div className="bar"><div style={{ width: `${Math.round(snap.baselineProgress * 100)}%` }} /></div>
            <button
              className="link"
              onClick={() => {
                started.current = true;
                takeTurn('');
              }}
            >
              Skip baseline (no heart-rate data)
            </button>
          </div>
        )}

        {phase !== 'baseline' && (
          <>
            <div className="transcript">
              {utterances.map((u, i) => (
                <div key={i} className={`bubble ${u.speaker}`}>
                  <span className="who">{u.speaker === 'interviewer' ? 'Interviewer' : 'You'}</span>
                  {u.text}
                </div>
              ))}
              {partial && <div className="bubble candidate partial">{partial}</div>}
              <div ref={transcriptEnd} />
            </div>

            {phase === 'breathing' && (
              <div className="breathe">
                <div className="circle" />
                <p>Breathe in slowly... and out.</p>
              </div>
            )}

            <div className="controls">
              <button
                className={`mic ${recording ? 'on' : ''}`}
                onClick={toggleMic}
                disabled={phase !== 'answering'}
              >
                {recording ? '■ Stop and send' : '🎤 Answer'}
              </button>
              <form onSubmit={sendTyped} className="typed">
                <input
                  placeholder="...or type your answer"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  disabled={phase !== 'answering'}
                />
              </form>
              <span className="muted phase">{phaseLabel(phase)}</span>
              <button className="link" onClick={finish} disabled={phase === 'ending'}>
                End interview
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function phaseLabel(p) {
  return {
    thinking: 'Interviewer is thinking...',
    speaking: 'Interviewer is speaking...',
    answering: 'Your turn',
    breathing: 'Breathing pause',
    ending: 'Building your replay...',
  }[p] || '';
}
