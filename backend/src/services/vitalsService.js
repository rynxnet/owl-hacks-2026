import { VitalsFilter, PULSE_LOST_HINT } from '../vitalsFilter.js';

// msg: { hr, br?, hrv?, confidence?, stable?, ts? } from any source (Presage, bridge, simulator).
// VitalsFilter drops junk, duplicates and one-off glitches; the stress engine gets a smoothed value.
// isActive(session) lets the lost-pulse watcher stop once a newer session takes over.
export function createVitalsService({ db, broadcast, isActive = () => true }) {
  let sensorStatus = '';

  function setSensorStatus(session, status) {
    sensorStatus = status === 'ok' ? '' : status;
    if (session && !session.ended) broadcast(session.id, { type: 'sensor', status: sensorStatus });
  }

  function ingest(session, message) {
    if (!session || session.ended) return null;

    session.filter ??= new VitalsFilter();
    const reading = session.filter.push(message);
    if (!reading.ok) {
      if (process.env.FILTER_DEBUG === '1') console.log(`[vitals] dropped hr=${message.hr} (${reading.reason})`);
      return null;
    }

    const snapshot = session.engine.add(reading.ts, reading.hrSmooth);
    const vital = {
      ts: reading.ts,
      hr: reading.hr, // raw accepted value (chart, replay, spikes)
      hrSmooth: reading.hrSmooth, // what the stress engine saw
      br: reading.br,
      confidence: reading.confidence,
      state: snapshot.state,
    };
    session.vitals.push(vital);
    db.addVitals(session.id, vital);
    broadcast(session.id, { type: 'vitals', ...vital, ...snapshot });
    watchForLostPulse(session);
    return vital;
  }

  // Pulse back after being lost: clear our hint (but not a newer one from Presage). Then watch for
  // readings going quiet. The timer only runs while readings flow: it stops once it has reported the
  // loss (the next accepted reading restarts it), or when the session ends or is replaced.
  function watchForLostPulse(session) {
    if (session.pulseLost) {
      session.pulseLost = false;
      if (sensorStatus === PULSE_LOST_HINT) setSensorStatus(session, 'ok');
    }
    if (session.staleTimer) return;
    session.staleTimer = setInterval(() => {
      const gone = session.ended || !isActive(session);
      if (!gone && !session.filter.isStale(Date.now())) return;
      clearInterval(session.staleTimer);
      session.staleTimer = null;
      if (gone) return;
      session.pulseLost = true;
      setSensorStatus(session, PULSE_LOST_HINT);
    }, 1000);
    session.staleTimer.unref?.();
  }

  return {
    ingest,
    setSensorStatus,
    get sensorStatus() {
      return sensorStatus;
    },
  };
}