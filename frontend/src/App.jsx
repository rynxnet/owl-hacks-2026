import { useState } from 'react';
import Setup from './components/Setup.jsx';
import Interview from './components/Interview.jsx';
import Replay from './components/Replay.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [replay, setReplay] = useState(null);

  return (
    <main>
      {!session && <Setup onStart={setSession} />}
      {session && !replay && <Interview session={session} onDone={setReplay} />}
      {replay && (
        <Replay
          replay={replay}
          onRestart={() => {
            setReplay(null);
            setSession(null);
          }}
        />
      )}
    </main>
  );
}
