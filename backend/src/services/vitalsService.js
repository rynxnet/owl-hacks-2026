export function createVitalsService({ db, broadcast }) {
  let sensorStatus = '';

  function setSensorStatus(session, status) {
    sensorStatus = status === 'ok' ? '' : status;
    if (session && !session.ended) broadcast(session.id, { type: 'sensor', status: sensorStatus });
  }

  function ingest(session, message) {
    if (!session || session.ended) return null;

    const ts = Number(message.ts) || Date.now();
    const hr = Number(message.hr);
    if (!Number.isFinite(hr) || hr <= 0) return null;

    const snapshot = session.engine.add(ts, hr);
    const vital = {
      ts,
      hr,
      br: message.br != null ? Number(message.br) : null,
      state: snapshot.state,
    };
    session.vitals.push(vital);
    db.addVitals(session.id, vital);
    broadcast(session.id, { type: 'vitals', ...vital, ...snapshot });
    return vital;
  }

  return {
    ingest,
    setSensorStatus,
    get sensorStatus() {
      return sensorStatus;
    },
  };
}