import { Component, useState } from 'react';
import Setup from './components/Setup.jsx';
import Interview from './components/Interview.jsx';
import Replay from './components/Replay.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [replay, setReplay] = useState(null);
  const restart = () => {
    setReplay(null);
    setSession(null);
  };

  return (
    <main>
      {!session && <Setup onStart={setSession} />}
      {session && !replay && <Interview session={session} onDone={setReplay} />}
      {replay && (
        <ReplayBoundary replay={replay} onRestart={restart}>
          <Replay replay={replay} onRestart={restart} />
        </ReplayBoundary>
      )}
    </main>
  );
}

// If the replay view crashes on unexpected data, show the coaching as text instead of a blank page.
class ReplayBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('[replay] render failed:', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const { replay, onRestart } = this.props;
    return (
      <div className="replay">
        <div className="card">
          <h2>Your replay</h2>
          <p className="muted">The chart could not be drawn, but here is your coaching.</p>
          <p>{replay.feedback?.summary || 'No coaching was generated.'}</p>
          {replay.feedback?.strongerAnswer && <p className="quote">{replay.feedback.strongerAnswer}</p>}
        </div>
        <button className="primary" onClick={onRestart}>Practice again</button>
      </div>
    );
  }
}
