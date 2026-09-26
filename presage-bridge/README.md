# Presage bridge

Heart rate comes from Presage's SmartSpectra SDK. The backend doesn't care where readings come from, as long as
they arrive on one WebSocket (or, for server-side Presage, from `backend/src/presageWorker.js`).

## The contract

Connect to `ws://<backend>:3001/ws/vitals` and send one JSON message per reading:

```json
{ "hr": 82.4, "br": 14.1, "hrv": 41.3, "confidence": 0.82, "stable": true, "ts": 1790000000000 }
```

- `hr`: heart rate in bpm, 1 decimal (required)
- `br`: breathing rate per minute, or `null`
- `hrv`: HRV RMSSD (ms), or `null`
- `confidence`: Presage's confidence for this pulse sample, 0..1 (the SDK reports 0..100; we divide by 100), or `null`
- `stable`: Presage's own "settled" flag for this sample, or `null`
- `ts`: time the sample was measured, epoch milliseconds (optional for other sources; the server uses "now" if missing)
- `sessionId` (optional): if left out, readings go to the newest running interview

The simulator (`backend/src/simulator.js`) sends `{ hr, br, ts }`, so anything that works with the simulator works with Presage.

## SDK contract (verified against `@smartspectra/node-sdk` 3.3.0)

Pinned to exactly `3.3.0` in `backend/package.json` and `presage-bridge/package.json`. Checked against the
package files (`js/index.d.ts`, `js/index.js`, `js/smartspectra.js`, `js/ffi.js`, `js/constants.js`,
`js/messages/index.js`, `js/messages/generated.d.ts`, `js/renderer/timestamp.js`) and the docs at
https://smartspectra.presagetech.com/docs/nodejs/api-reference/ and https://smartspectra.presagetech.com/docs/data-types/.

- `new SmartSpectraSDK({ apiKey, requestedMetrics, enableAccumulatedOutput, logLevel, enableTelemetry })`.
  `requestedMetrics` defaults to `breathingMetrics`, so pulse needs `[...breathingMetrics, ...cardioMetrics]`.
- Input: `sdk.useCustomInput(FrameTransform.kNone)` (or `useCamera({ deviceIndex, width, height, fps })`), then
  `sdk.start()`, then `sdk.sendFrame(buffer, width, height, strideBytes, pixelFormat, timestampUs)` → `boolean` (accepted).
  `timestampUs` is microseconds, must be strictly increasing (error 10 `kNonMonotonicTimestamp`; error 11 `kTimestampGap`
  for large gaps). The SDK's own camera/Electron sources stamp frames in epoch µs, and so do we.
  Pixel formats: `kRGB 0, kBGR 1, kRGBA 2, kBGRA 3, kNV12 4, kNV21 5, kYUYV 6`.
- `start()` is **synchronous** (`void`) and throws an `Error` with `.code` / `.retryable` (e.g. 2 = key rejected).
  `stop()` is sync; `stopAsync()` and `destroy()` return Promises.
- Events (`sdk.on(name, cb)`; one listener per event, a second `on()` replaces it; listener exceptions are caught and logged):
  `processingStatus(status)`, `validationStatus(code, timestampUs, hint)`, `metrics(buf, timestampUs)`,
  `accumulatedMetrics(buf, timestampUs)`, `error(code, message, retryable)`, `frameSentThrough(sent, timestampUs)`,
  `videoOutput(...)`, `insight(buf, requestId)`.
- `decodeMetrics(buf)` decodes with the bundled protobufjs `Metrics` class (registered by default):
  `cardio.pulseRate[]`, `breathing.rate[]` are `MeasurementWithConfidence { value, stable, confidence, timestamp }`,
  `cardio.hrv[]` is `Hrv { rmssd, meanNn, sdnn, baevsky, timestamp, confidence, stable }`.
  `timestamp` is int64 **microseconds since epoch** and arrives as a protobufjs `Long`; `confidence` is a
  **percentage 0..100**; `stable` means confidence ≥ 40 for pulse (≥ 45 for breathing).
  The fields are repeated (a series), so we never take only `.at(-1)`: `backend/src/presageSamples.js`
  emits every sample newer than the last one sent, once, in time order.
- Error codes: 1 invalid state, 2 auth failed, 3 config failed, 4 credits exhausted, 5 network, 6 server,
  7 input unavailable, 8 processing failed, 9 frame conversion failed, 10 non-monotonic timestamp, 11 timestamp gap.

## Easiest: let the backend run Presage (no bridge needed)

Put `PRESAGE_API_KEY=...` in **`backend/.env`**, run `npm install` and `npm run check:presage` in `backend/`, and restart it.
`npm run check:presage -- --live` also starts a real SDK session and feeds it 5 s of test frames.
The browser then streams its webcam to the backend (`/ws/camera`) and Presage runs there, whether that's a
Codespace, Vultr, or your laptop. Use the bridge below only if that doesn't work (for example, a slow network).

## Alternative: laptop bridge (`presage.js`)

Presage ships a Node.js SDK (`@smartspectra/node-sdk`) with prebuilt native code for Windows x64,
macOS Apple Silicon and Linux x64/arm64 (glibc 2.35+). No C++ build. Needs Node 20+. The bridge shares
`../backend/src/presageSamples.js`, so run it from a full checkout of the repo.

Run it **on the laptop with the webcam** (not in a Codespace: it has no camera).

```bash
cd presage-bridge
npm install          # downloads a few hundred MB of native runtime, once
cp .env.example .env # Windows: copy .env.example .env
# paste PRESAGE_API_KEY (https://physiology.presagetech.com) and set VITALS_URL
npm start
```

You should see `[presage] Running`, then lines like `[presage] hr=78.3 br=14.2 conf=0.82` after it locks on
(allow 10-20 seconds). Positioning hints such as "No face found" or "Too dark" show up in the app too.

**Backend in a Codespace?** In the Ports tab, set port 3001 to **Public**, then use
`VITALS_URL=wss://<codespace-name>-3001.app.github.dev/ws/vitals`. Private ports need a GitHub login, which the bridge can't do.

**Camera busy?** The bridge and the browser's camera preview may fight over the webcam. Start the bridge first;
if the preview then fails, the app hides it automatically. If the bridge reports "Camera unavailable", close other
camera apps (Teams, Zoom, the preview) and restart it.

**Wrong camera?** Set `CAMERA_INDEX=1` (or 2...) in `.env`.

## Fallbacks (C++ sample, mobile)

## Option A: pipe the Presage sample into the relay

1. Get an API key at the Presage sponsor table and install the SDK: https://github.com/Presage-Security/SmartSpectra (docs: https://smartspectra.presagetech.com/docs/)
2. Build and run their C++ sample until it prints heart rate in the terminal.
3. Pipe its output into the relay:

```bash
cd presage-bridge
npm install
<path-to-presage-sample> --your-flags | node relay.js
```

If the relay doesn't pick up readings, look at the sample's real output and set a matching pattern, e.g.:

```bash
HR_PATTERN='Pulse rate: ([0-9.]+)' node relay.js
```

## Option B: send from the C++ sample directly

In the sample's callback where it receives a new heart-rate value, open a WebSocket (or a plain HTTP POST
if that's easier; add an endpoint) and send the JSON above. Use this only if Option A is too laggy.

## Option C: Android or iOS sample

Run Presage's mobile sample on a phone and send the same JSON to the laptop's IP address
(`ws://<laptop-ip>:3001/ws/vitals`). Both devices need to be on the same network.

## Camera note

On some systems only one program can use the webcam at a time. If Presage runs on the same laptop as the
browser, turn off the camera preview in the app (there's a link under the chart).
