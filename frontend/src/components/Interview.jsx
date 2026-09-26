import { useEffect, useRef, useState } from 'react';
import { api, subscribe, endInterview } from '../lib/api.js';
import { playLine } from '../lib/audio.js';
import { createRecognizer } from '../lib/speech.js';
import { startCameraStream } from '../lib/cameraStream.js';
import VitalsChart, { STATE_COLORS } from './VitalsChart.jsx';

const BREATHE_SECONDS = 10;
const HIDDEN_BUT_PLAYING = { position: 'fixed', bottom: 0, right: 0, width: 2, height: 2, opacity: 0.01, overflow: 'hidden', pointerEvents: 'none', padding: 0, margin: 0, border: 0 };

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
  const [turnError, setTurnError] = useState(null); // { answer } when the backend didn't respond
  const [sensor, setSensor] = useState(''); // Presage hint, e.g. "No face found"
  const [serverPresage, setServerPresage] = useState(false); // backend reads heart rate from our camera
  const [endError, setEndError] = useState(null); // { message, notFound } when /end failed
  const ending = useRef(false); // finish() runs once even if End is clicked while the interviewer also ends
  const camActive = showCam || serverPresage;
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

  // Does the backend run Presage itself? Then we stream our webcam to it.
  useEffect(() => {
    api.health().then((h) => setServerPresage(Boolean(h.presageServer))).catch(() => {});
  }, []);

  // Webcam. Server-side Presage: frames go to the backend (preview can be hidden, camera stays on).
  // Laptop bridge: some systems only let one program use the camera, so if the preview fails, turn it off.
  useEffect(() => {
    if (!camActive) return;
    let stream;
    let stopStreaming;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const video = videoRef.current;
        if (video) video.srcObject = s;
        if (serverPresage && video) stopStreaming = startCameraStream(session.id, video);
      })
      .catch(() => {
        setShowCam(false);
        if (serverPresage) setSensor('Camera blocked. Allow camera access in the address bar to measure heart rate.');
      });
    return () => {
      cancelled = true;
      stopStreaming?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [camActive, serverPresage, session.id]);

  // No heart rate at all after 45 s (camera blocked, Presage down)? Start anyway instead of waiting forever.
  const gotVitals = useRef(false);
  useEffect(() => {
    if (vitals.length) gotVitals.current = true;
  }, [vitals.length]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!started.current && !gotVitals.current) {
        started.current = true;
        setSensor('No heart-rate data, so starting without it.');
        takeTurn('');
      }
    }, 45000);
    return () => clearTimeout(t);
  }, []);

  // Baseline done -> first question
  useEffect(() => {
    if (phase === 'baseline' && snap.baseline && !started.current) {
      started.current = true;
      takeTurn('');
    }
  }, [snap.baseline, phase]);

  async function takeTurn(answer) {
    setPhase('thinking');
    setTurnError(null);
    let turn;
    try {
      turn = await api.turn(session.id, answer);
    } catch (err) {
      console.error(err);
      setTurnError({ answer });
      setPhase('answering');
      return;
    }
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

  // Called by the End button ({ clicked: true }) and by the interviewer's closing line (no args).
  const pendingAnswer = useRef('');
  async function finish(opts) {
    if (ending.current) return;
    ending.current = true;
    setEndError(null);
    // End clicked mid-answer: send what was spoken or typed so far instead of dropping it.
    // (Only from the button: takeTurn's closure holds stale `typed`/`phase` values.)
    if (opts?.clicked && phase === 'answering') {
      let answer = typed.trim();
      if (recording && recognizer.current) {
        setRecording(false);
        const spoken = await Promise.race([recognizer.current.stop(), new Promise((r) => setTimeout(() => r(''), 1500))]);
        answer = [spoken, answer].filter(Boolean).join(' ');
        setPartial('');
      }
      setTyped('');
      pendingAnswer.current = answer;
    }
    const answer = pendingAnswer.current;
    setPhase('ending');

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const replay = await endInterview(session.id, { answer });
        pendingAnswer.current = '';
        return onDone(replay);
      } catch (err) {
        lastErr = err;
        console.error('[end]', err);
        if (err.status === 404) break; // backend restarted: retrying won't help
        if (err.status === 0 && /too long/.test(err.message)) break; // already waited 40 s
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    ending.current = false;
    setEndError({
      notFound: lastErr?.status === 404,
      message:
        lastErr?.status === 404
          ? 'The server restarted and lost this interview, so it cannot build the full replay or coaching.'
          : `Could not reach the server to build your replay (${lastErr?.message || 'unknown error'}).`,
    });
  }

  // Fallback when the server can't produce a replay: show what this page recorded itself.
  function showLocalReplay() {
    const firstTs = [vitals[0]?.ts, utterances[0]?.ts].filter(Boolean);
    onDone({
      id: session.id,
      role: session.role,
      startedAt: firstTs.length ? Math.min(...firstTs) : Date.now(),
      baseline: snap.baseline,
      vitals,
      utterances: pendingAnswer.current
        ? [...utterances, { ts: Date.now(), speaker: 'candidate', text: pendingAnswer.current, state: snap.state }]
        : utterances,
      spikes: [],
      feedback: null,
      feedbackError: endError?.notFound ? 'lost' : 'offline',
      local: true,
    });
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
          {!latest &&
            (serverPresage ? (
              <p className="muted">Presage is finding your pulse. Face the camera and hold still (about 15 seconds).</p>
            ) : (
              <p className="muted">Waiting for heart-rate data. Start the Presage bridge or run <code>npm run sim</code> in backend/.</p>
            ))}
        </div>

        {camActive && (
          // When hidden but still measuring, keep the video "on screen" but invisible:
          // Chrome may pause videos that are display:none or offscreen.
          <div className="card cam" style={showCam ? undefined : HIDDEN_BUT_PLAYING}>
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

            {turnError && (
              <p className="sensor-hint">
                The interviewer didn't respond (is the backend running?){' '}
                <button className="link" onClick={() => takeTurn(turnError.answer)}>Try again</button>
              </p>
            )}

            {endError && (
              <div className="sensor-hint">
                <p>{endError.message}</p>
                <button className="link" onClick={() => finish()}>Try again</button>{' '}
                <button className="link" onClick={showLocalReplay}>Show what this page recorded</button>
              </div>
            )}

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
              <span className="muted phase">{endError ? '' : phaseLabel(phase)}</span>
              <button className="link" onClick={() => finish({ clicked: true })} disabled={phase === 'ending'}>
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
