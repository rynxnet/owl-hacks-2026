# Presage bridge

Presage's SmartSpectra SDK is C++, iOS or Android only, so heart rate reaches the app through a small bridge.
The backend doesn't care where readings come from, as long as they arrive on one WebSocket.

## The contract

Connect to `ws://<backend>:3001/ws/vitals` and send one JSON message per reading (about once a second):

```json
{ "hr": 82.4, "br": 14.1, "ts": 1790000000000 }
```

- `hr`: heart rate in bpm (required)
- `br`: breathing rate per minute (optional)
- `ts`: time in milliseconds (optional; the server uses "now" if missing)
- `sessionId` (optional): if left out, readings go to the newest running interview

The simulator (`backend/src/simulator.js`) sends exactly this, so anything that works with the simulator works with Presage.

## Option A: pipe the Presage sample into the relay (fastest)

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
