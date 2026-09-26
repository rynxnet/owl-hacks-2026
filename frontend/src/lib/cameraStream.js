// Streams webcam frames from a <video> element to the backend, where Presage reads heart rate.
// Each message: [8-byte float64 capture time in ms][JPEG bytes].
// Returns a stop() function.
const WIDTH = 640;
const HEIGHT = 480;
const FPS = 15;
const QUALITY = 0.9; // pulse is read from tiny skin-color changes, so don't compress hard
const MAX_BUFFERED = 1_500_000; // bytes queued on the socket before we drop frames (slow network)

export function startCameraStream(sessionId, video, onState = () => {}) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/camera?session=${sessionId}`;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  let ws;
  let timer;
  let stopped = false;
  let busy = false;
  let sent = 0;

  function connect() {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => onState('streaming');
    ws.onclose = () => {
      if (stopped) return;
      onState('reconnecting');
      setTimeout(connect, 2000);
    };
  }

  function tick() {
    if (busy || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!video.videoWidth || video.readyState < 2) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return; // network can't keep up: skip this frame
    busy = true;
    const captureMs = performance.timeOrigin + performance.now();
    // Center-crop to 4:3 so the face keeps its proportions.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(WIDTH / vw, HEIGHT / vh);
    const sw = WIDTH / scale;
    const sh = HEIGHT / scale;
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, WIDTH, HEIGHT);
    canvas.toBlob(
      async (blob) => {
        busy = false;
        if (!blob || stopped || ws.readyState !== WebSocket.OPEN) return;
        const jpeg = new Uint8Array(await blob.arrayBuffer());
        const msg = new Uint8Array(8 + jpeg.length);
        new DataView(msg.buffer).setFloat64(0, captureMs, true);
        msg.set(jpeg, 8);
        ws.send(msg);
        sent += 1;
      },
      'image/jpeg',
      QUALITY,
    );
  }

  connect();
  timer = setInterval(tick, 1000 / FPS);

  return () => {
    stopped = true;
    clearInterval(timer);
    ws?.close();
    return sent;
  };
}
