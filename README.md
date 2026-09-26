# Pressure Test

A mock interviewer that reads your heart rate through a webcam and adapts: it pushes harder when you're calm,
holds steady when you're stressed, and stops to coach a breath when you're overloaded. Afterward you get a
replay of your heart rate lined up with every question.

Built at OwlHacks 2026.

## How it fits together

```
webcam -> Presage SDK -> presage-bridge -> ws /ws/vitals -> backend -> stress engine -> Tiger Data
                                                              |
browser mic -> speech-to-text -> POST /api/sessions/:id/turn -> Gemini -> ElevenLabs -> interviewer voice
                                                              |
                                        ws /ws/client -> React app (live chart, transcript, replay)
```

| Folder | What's in it |
| --- | --- |
| `backend/` | Node + Express + WebSockets. Interview loop, stress logic, Gemini, ElevenLabs, Tiger Data, heart-rate simulator |
| `frontend/` | React (Vite). Setup screen, live interview, replay |
| `presage-bridge/` | Relay that pipes Presage output into the backend, plus setup notes |

## Run it locally (about 2 minutes, no API keys needed)

Needs Node 18 or newer and Chrome (for speech recognition).

```bash
# terminal 1: backend
cd backend
cp .env.example .env      # add keys later; everything works without them
npm install
npm run dev

# terminal 2: fake heart rate (until Presage works)
cd backend
npm run sim               # press u / d / s to push heart rate up, down, or spike

# terminal 3: frontend
cd frontend
npm install
npm run dev               # open http://localhost:5173
```

Without keys: questions come from a built-in list, the browser reads them aloud, and data stays in memory.
Add keys to `backend/.env` to switch on each sponsor tool:

| Key | Turns on |
| --- | --- |
| `GEMINI_API_KEY` | Adaptive interviewer and written coaching |
| `ELEVENLABS_API_KEY` (optional `VOICE_FRIENDLY` / `VOICE_COLD` / `VOICE_RAPID`) | Realistic interviewer voices, one per persona. Test with `npm run voices` |
| `DATABASE_URL` (Tiger Data) | Saves vitals and transcripts. Run `npm run db:init` once to create tables |

The setup screen shows which of these are on.

## Stress logic

Lives in `backend/src/stress.js`:

- Baseline = average heart rate over the first 30 seconds
- Every reading, the last 10-second average is compared with baseline: under +15% calm, +15% to +30% elevated, over +30% overloaded
- A new state must hold for 6 seconds before it counts, so noise doesn't flip the interviewer

All thresholds are env vars (`BASELINE_MS`, `WINDOW_MS`, `ELEVATED_PCT`, `OVERLOAD_PCT`, `HOLD_MS`). For quick
testing, set `BASELINE_MS=10000`.

## API

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/health` | Which integrations are on, how many heart-rate sources are connected |
| POST | `/api/sessions` | Start an interview `{ role, persona, maxQuestions }` |
| POST | `/api/sessions/:id/turn` | Send an answer `{ answer }`, get the next line `{ say, action, audio, state }` |
| POST | `/api/sessions/:id/end` | Finish, get replay and coaching |
| GET | `/api/sessions/:id/replay` | Replay data |
| WS | `/ws/vitals` | Heart-rate sources send `{ hr, br?, ts? }` |
| WS | `/ws/client?session=ID` | Browser receives `vitals` and `utterance` events |

## Deploy (Vultr)

One server runs everything: build the frontend and the backend serves it.

```bash
cd frontend && npm install && npm run build
cd ../backend && npm install && npm start     # serves the app on PORT (default 3001)
```

Browsers only allow microphone access on `https://` or `localhost`, so put the deployed server behind HTTPS
(for example Caddy with your domain). The Presage bridge still runs on the laptop with the camera and points
`VITALS_URL` at the deployed server (`wss://your-domain/ws/vitals`).

## Team

| Role | Owns |
| --- | --- |
| Sensing | `presage-bridge/` |
| Interviewer | `backend/src/interviewer.js`, `backend/src/voice.js` |
| Frontend | `frontend/` |
| Data and story | `backend/src/stress.js`, `backend/src/db.js`, `backend/schema.sql`, Devpost |
