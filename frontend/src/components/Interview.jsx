import { useEffect, useRef, useState } from 'react';
import { api, subscribe, newTurnId, mergeUtterances, addPendingAnswer, endInterview } from '../lib/api.js';
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
  // Whole-interview totals (vitals above keeps only the last 300 readings for the chart).
  const [stats, setStats] = useState({ n: 0, sum: 0, peak: 0, calm: 0, elevated: 0, overloaded: 0 });
  const [turnError, setTurnError] = useState(null); // { answer, turnId } when the backend didn't respond
  const [sensor, setSensor] = useState(''); // Presage hint, e.g. "No face found"
  const [serverPresage, setServerPresage] = useState(false); // backend reads heart rate from our camera
  const [endError, setEndError] = useState(null); // { message, notFound } when /end failed
  const ending = useRef(false); // finish() runs once even if End is clicked while the interviewer also ends
  // No camera preview: in bridge mode (default) the Presage bridge owns the webcam. Only server-side
  // Presage needs the browser camera, and then it streams from a hidden <video>.
  const camActive = serverPresage;
  const started = useRef(false);
  const recognizer = useRef(null);
  const videoRef = useRef(null);
  const transcriptRef = useRef(null);
  const turnInFlight = useRef(false); // blocks double submits (Enter spam, mic + typing, retry spam)
  const mounted = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // False once unmounted or ending, so a late turn doesn't speak over the replay.
  const active = () => mounted.current && phaseRef.current !== 'ending';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Live updates from the backend. The transcript also comes back in every turn response,
  // so the chat stays correct even while this socket is down or reconnecting.
  useEffect(() => {
    return subscribe(session.id, (msg) => {
      if (msg.type === 'vitals') {
        setVitals((v) => [...v.slice(-300), msg]);
        setSnap({ state: msg.state, baseline: msg.baseline, baselineProgress: msg.baselineProgress });
        if (Number.isFinite(msg.hr) && msg.state !== 'baseline') {
          setStats((s) => ({ ...s, n: s.n + 1, sum: s.sum + msg.hr, peak: Math.max(s.peak, msg.hr), [msg.state]: (s[msg.state] || 0) + 1 }));
        }
      }
      if (msg.type === 'utterance') setUtterances((u) => mergeUtterances(u, [msg]));
      if (msg.type === 'transcript') setUtterances((u) => mergeUtterances(u, msg.utterances));
      if (msg.type === 'sensor') setSensor(msg.status);
    });
  }, [session.id]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
  }, [utterances, partial]);

  // Does the backend run Presage itself? Then we stream our webcam to it.
  useEffect(() => {
    api
      .health()
      .then((h) => {
        setServerPresage(Boolean(h.presageServer));
      })
      .catch(() => {});
  }, []);

  // Webcam, server-side Presage only: frames go to the backend from a hidden video.
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
        setSensor('Camera blocked. Allow camera access in the address bar to measure heart rate.');
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

  // turnId is reused by "Try again", so the server never stores the same answer twice.
  async function takeTurn(rawAnswer, turnId = newTurnId()) {
    if (turnInFlight.current || !active()) return;
    turnInFlight.current = true;
    const answer = String(rawAnswer || '').trim();
    setPhase('thinking');
    setTurnError(null);
    if (answer) setUtterances((u) => addPendingAnswer(u, answer, turnId));
    let turn;
    try {
      turn = await api.turn(session.id, answer, turnId);
    } catch (err) {
      console.error(err);
      turnInFlight.current = false;
      if (!active()) return;
      if (err.data?.utterances) setUtterances((u) => mergeUtterances(u, err.data.utterances));
      const aiMessage = err.data?.code === 'AI_INTERVIEWER_FAILED' ? err.data.error : '';
      setTurnError({ answer, turnId, busy: err.status === 409, message: aiMessage });
      setPhase('answering');
      return;
    }
    turnInFlight.current = false;
    if (!active()) return;
    setUtterances((u) => mergeUtterances(u, turn.utterances));
    setProgress({ q: turn.questionCount, max: turn.maxQuestions });
    if (turn.say) {
      setPhase('speaking');
      await playLine(turn.say, turn.audio, session.persona === 'rapid' ? 1.3 : 1.05);
      if (!active()) return;
    }

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
      if (text && !turnInFlight.current) takeTurn(text);
    }
  }

  function sendTyped(e) {
    e.preventDefault();
    if (!typed.trim() || phase !== 'answering' || turnInFlight.current) return;
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
  // Breathing and HRV arrive less often than pulse, so show the newest reading that has one.
  const lastWith = (key) => {
    for (let i = vitals.length - 1; i >= 0; i--) if (Number.isFinite(vitals[i][key])) return vitals[i][key];
    return null;
  };
  const br = lastWith('br');
  const hrv = lastWith('hrv');
  const conf = latest?.confidence;
  const vsBaseline = latest && snap.baseline ? Math.round(((latest.hr - snap.baseline) / snap.baseline) * 100) : null;
  const stateTotal = stats.calm + stats.elevated + stats.overloaded;

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
              {session.role && (
                <>
                  <br />
                  <span className="role-tag">{session.role}</span>
                </>
              )}
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

        <div className="card">
          <h4>More from Presage</h4>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Breathing</span>
              <span className="tile-value">{br != null ? Math.round(br) : '--'} <small>/min</small></span>
              <span className="tile-note">{breathNote(br)}</span>
            </div>
            <div className="tile">
              <span className="tile-label">HRV</span>
              <span className="tile-value">{hrv != null ? Math.round(hrv) : '--'} <small>ms</small></span>
              <span className="tile-note">{hrv != null ? 'Lower usually means more stress' : 'Needs ~30 s of steady signal'}</span>
            </div>
            <div className="tile">
              <span className="tile-label">vs. baseline</span>
              <span className="tile-value" style={{ color: vsBaseline != null ? color : undefined }}>
                {vsBaseline != null ? `${vsBaseline > 0 ? '+' : ''}${vsBaseline}%` : '--'}
              </span>
              <span className="tile-note">{snap.baseline ? `Resting ${Math.round(snap.baseline)} bpm` : 'Measuring'}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Signal</span>
              <span className="tile-value">{Number.isFinite(conf) ? `${Math.round(conf * 100)}%` : '--'}</span>
              <span className="tile-note">{signalNote(conf)}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="row between">
            <h4>This interview so far</h4>
            <span className="muted small-text">
              {stats.n ? `Avg ${Math.round(stats.sum / stats.n)} · Peak ${Math.round(stats.peak)} bpm` : 'Starts after baseline'}
            </span>
          </div>
          <div className="state-bar" aria-label="Share of time in each stress state">
            {['calm', 'elevated', 'overloaded'].map((s) =>
              stats[s] ? <div key={s} style={{ flexGrow: stats[s], background: STATE_COLORS[s] }} /> : null
            )}
          </div>
          <div className="state-legend">
            {['calm', 'elevated', 'overloaded'].map((s) => (
              <span key={s}>
                <i style={{ background: STATE_COLORS[s] }} />
                {s} {stateTotal ? Math.round((stats[s] / stateTotal) * 100) : 0}%
              </span>
            ))}
          </div>
        </div>

        {camActive && (
          // Server-side Presage only: keep the video "on screen" but invisible, since
          // Chrome may pause videos that are display:none or offscreen.
          <div style={HIDDEN_BUT_PLAYING}>
            <video ref={videoRef} autoPlay muted playsInline />
          </div>
        )}
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
            <div className="transcript" ref={transcriptRef}>
              {utterances.map((u) => (
                <div key={`${u.ts}|${u.speaker}|${u.text}${u.pending ? '|p' : ''}`} className={`bubble ${u.speaker}${u.pending ? ' partial' : ''}`}>
                  <span className="who">{u.speaker === 'interviewer' ? 'Interviewer' : 'You'}</span>
                  {u.text}
                </div>
              ))}
              {partial && <div className="bubble candidate partial">{partial}</div>}
            </div>

            {turnError && (
              <p className="sensor-hint">
                {turnError.busy
                  ? 'The interviewer is still answering your last message.'
                  : turnError.message || "The interviewer didn't respond (is the backend running?)"}{' '}
                <button className="link" onClick={() => takeTurn(turnError.answer, turnError.turnId)}>Try again</button>
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
                {recording ? '■ Stop and send' : '● Record'}
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
              <button className="link end-interview" onClick={() => finish({ clicked: true })} disabled={phase === 'ending'}>
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

function breathNote(br) {
  if (br == null) return 'Waiting for a reading';
  if (br < 10) return 'Slow and steady';
  if (br <= 20) return 'Normal range';
  return 'Fast, try a slow breath';
}

function signalNote(c) {
  if (!Number.isFinite(c)) return 'How sure Presage is';
  if (c >= 0.7) return 'Good lock on your pulse';
  if (c >= 0.4) return 'Fair, hold still';
  return 'Weak, check light and framing';
}
