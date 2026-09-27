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

## Backend boundaries

The backend keeps one process for simple local setup, with capability modules that communicate through
small injected functions. `server.js` wires HTTP and WebSocket transports; `sessionService.js` owns session
lifecycle; `interviewService.js` owns turn orchestration; `vitalsService.js` validates and publishes readings;
`replayService.js` calculates replay data; and `feedbackService.js` owns coaching retries and timeouts.
Gemini, voice, Presage, and database integrations remain adapters. This keeps the capabilities independently
testable without requiring a message broker or distributed deployment. The REST and WebSocket contracts remain
the boundary for a future split into separate processes.

Run the isolated backend service tests from `backend/` with `npm run test:unit`.

## Run it locally (about 2 minutes, no API keys needed)

Needs Node 20 or newer and Chrome (for speech recognition).

```bash
# terminal 1: backend
cd backend
cp .env.example .env      # add keys later; everything works without them
npm install
npm run dev

# terminal 2: fake heart rate (or real: see presage-bridge/README.md)
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
| `GEMINI_API_KEY` | **Required.** The AI interviewer and written coaching. Test with `npm run check:gemini` |
| `ELEVENLABS_API_KEY` (optional `VOICE_FRIENDLY` / `VOICE_COLD` / `VOICE_RAPID`) | Realistic interviewer voices, one per persona. Test with `npm run voices` |
| `PRESAGE_API_KEY` | Real heart rate: the browser streams its webcam to the backend and Presage reads your pulse there. Test with `npm run check:presage` |
| `DATABASE_URL` (Tiger Data) | Saves vitals and transcripts. Run `npm run db:init` once to create tables |

The setup screen shows which of these are on.

## AI interviewer (Gemini agent)

Every line the interviewer says is generated live by Gemini. There is no question bank and no canned fallback.
`backend/src/interviewer.js` runs one agent in three steps:

1. **Brief** (once per interview, started when the session is created): Gemini reads the **Role** and the pasted
   job posting and builds the interviewer: company, company context, team, a named fictional hiring manager and
   title, what the hire will do, must-haves, red flags, and a 5-8 step interview plan specific to that posting.
2. **Respond** (every turn): Gemini plays that interviewer. It names the detail it heard in the candidate's
   latest answer (`heard`), judges the answer (`answerRead`: strong, partial, vague, off topic, a question back...),
   reacts to that detail as this person at this company, then asks one question: a follow-up or the next plan
   area. The live stress state (calm / elevated / overloaded) sets how hard it pushes.
3. **Review**: each reply is checked for generic filler ("tell me more", "can you elaborate", "that's great",
   "tell me about yourself"...), for reacting to something the candidate didn't say, and for repeated questions.
   A failing draft goes back to Gemini once with the reasons.

If Gemini is missing or fails (no key, API error, timeout, or a generic reply twice), the turn fails and the chat
shows the reason with **Try again**. Retrying doesn't store the answer twice. The persona buttons
(friendly / cold / rapid) set the interviewing *style* only.
Tests: `node backend/test/interviewer-agent.test.mjs` and `node backend/test/role.test.mjs` (fake Gemini, no network).

## Stress logic

Readings pass through `backend/src/vitalsFilter.js` first: out-of-range, low-confidence, duplicate and one-off
glitch readings are dropped, and a median of the last 3 is fed to the stress engine. The app shows a
"lost your pulse" hint if readings stop for `FILTER_STALE_MS`.

`backend/src/stress.js`:

- Baseline = **median** heart rate over the first `BASELINE_MS`, starting once readings arrive steadily and
  needing at least `BASELINE_MIN_SAMPLES`
- Every reading, the last 10-second average is compared with baseline: under +15% calm, +15% to +30% elevated, over +30% overloaded
- A new state must hold for 6 seconds before it counts, so noise doesn't flip the interviewer

All thresholds are env vars (see `backend/.env.example`). For quick testing, set `BASELINE_MS=10000`.
Tests: `node backend/test/bpm.test.mjs`, `node backend/test/presage-decode.test.mjs`, `node backend/test/presage-worker.test.mjs`.

## API

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/health` | Which integrations are on, how many heart-rate sources are connected |
| POST | `/api/sessions` | Start an interview `{ role, jobDetails?, persona, maxQuestions }` |
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
