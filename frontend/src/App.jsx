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
      {!session && (
        <ErrorScreen key="setup" where="setup screen" onRestart={restart}>
          <Setup onStart={setSession} />
        </ErrorScreen>
      )}
      {session && !replay && (
        <ErrorScreen key={session.id} where="interview" onRestart={restart}>
          <Interview session={session} onDone={setReplay} />
        </ErrorScreen>
      )}
      {replay && (
        <ReplayBoundary replay={replay} onRestart={restart}>
          <Replay replay={replay} onRestart={restart} />
        </ReplayBoundary>
      )}
    </main>
  );
}

// Any crash while rendering a screen shows the error here instead of a blank white page.
// "Start over" goes back to setup (the key on each ErrorScreen resets it); "Copy error" is for bug reports.
class ErrorScreen extends Component {
  state = { error: null, stack: '' };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(`[${this.props.where}] crashed:`, error, info?.componentStack);
    this.setState({ stack: info?.componentStack || '' });
  }
  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const text = `${error?.name || 'Error'}: ${error?.message || String(error)}${error?.stack ? `\n\n${error.stack}` : ''}${stack ? `\n\nComponent stack:${stack}` : ''}`;
    return (
      <div className="card error-screen">
        <h2>Something broke on the {this.props.where}</h2>
        <p className="muted">The app hit an error. Your backend is still running. Start over to try again.</p>
        <pre className="error-text">{error?.message || String(error)}</pre>
        <details>
          <summary>Technical details</summary>
          <pre className="error-text">{text}</pre>
        </details>
        <div className="row">
          <button className="primary" onClick={this.props.onRestart}>Start over</button>{' '}
          <button onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}>Copy error</button>{' '}
          <button className="link" onClick={() => location.reload()}>Reload page</button>
        </div>
      </div>
    );
  }
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
