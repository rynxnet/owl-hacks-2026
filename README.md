# Pressure Test

**An AI mock interviewer that reads your heart rate through your webcam and adapts in real time.**

Paste a job posting and Pressure Test builds the hiring manager for that exact role. It listens to what you
actually say, pushes harder when you're calm, holds steady when you're stressed, and pauses to coach a breath
when you're overloaded. When the interview ends, you get a replay of your heart rate lined up with every
question, the three moments that spiked you most, and coaching with a stronger version of your answer.

Built at **OwlHacks 2026** (Temple University) with Google Gemini, ElevenLabs, and Presage SmartSpectra.

> Pressure Test gives stress *feedback* for interview practice. It is not a medical device and does not
> diagnose anything.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [API keys](#api-keys)
- [Quick start](#quick-start)
- [Running without a camera](#running-without-a-camera)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Testing](#testing)
- [API reference](#api-reference)
- [Deployment](#deployment)
- [Team](#team)

## Features

- **An interviewer for any job.** Gemini reads the role and job posting and builds a specific interviewer:
  company, team, a named hiring manager, what the role needs, red flags, and a 5-8 step interview plan.
- **Live, grounded conversation.** Every line is generated live. The interviewer responds to details from
  your last answer; there is no question bank.
- **Stress-aware behavior.** Webcam heart rate is compared with your own baseline and sorted into *calm*,
  *elevated* or *overloaded*, which sets how hard the interviewer pushes.
- **Three interview styles.** Friendly, cold, or rapid-fire. Each changes the tone, pace and follow-up depth.
- **Realistic voices.** ElevenLabs gives each style its own voice; the browser's built-in voice is used when
  no key is set.
- **Replay and coaching.** A heart-rate chart synced to the transcript, your top three stress spikes, and
  coaching with a rewritten answer.

## How it works

```
webcam ──► Presage SmartSpectra (presage-bridge) ──► ws /ws/vitals ──► filter ──► stress engine
                                                                                   │ calm / elevated / overloaded
browser mic ──► speech-to-text ──► POST /api/sessions/:id/turn ──► Gemini agent ◄──┘
                                                                        │
                                                   ElevenLabs voice ◄───┘
                                                                        │
                              ws /ws/client ──► React app (live chart, transcript, replay)
```

The Gemini interviewer (`backend/src/interviewer.js`) works in three steps:

1. **Brief:** once per interview, while your baseline heart rate is measured, Gemini builds the interviewer
   persona and plan from the job posting.
2. **Respond:** each turn, Gemini gets the transcript (tagged with heart-rate readings), your latest answer
   and your current stress state. It reacts to what you said and asks one question.
3. **Review:** each reply is checked for generic filler, ungrounded reactions and repeated questions. A
   failing draft is sent back to Gemini once to be rewritten.

If Gemini can't produce a reply, the chat shows the reason and a **Try again** button. The app never falls
back to pre-written questions.

## Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js 20+** | For the backend and the Presage bridge |
| **Google Chrome** | The app uses Chrome's speech recognition for the microphone |
| **Webcam** | For real heart-rate readings (a simulator is available, see below) |
| **Gemini API key** | **Required** |
| ElevenLabs API key | Optional |
| Presage API key | Needed for real heart rate |

## API keys

The app **will not run an interview without a Gemini key**. The other keys add features.

| Key | Required? | Where to get it | Put it in |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | **Yes** | [Google AI Studio](https://aistudio.google.com/apikey) → *Create API key* | `backend/.env` |
| `PRESAGE_API_KEY` | For real heart rate | [Presage developer portal](https://physiology.presagetech.com) → log in and copy your key | `presage-bridge/.env` (or `backend/.env`; the bridge falls back to it) |
| `ELEVENLABS_API_KEY` | Optional | [ElevenLabs](https://elevenlabs.io) → *Developers* → *API keys* (enable Text to Speech and read access to Voices) | `backend/.env` |
| `DATABASE_URL` | Optional | Tiger Data (Tiger Cloud console) Postgres connection string. Without it, sessions stay in memory. | `backend/.env` |

Check that each key works before you start:

```bash
cd backend
npm run check:gemini      # tests the Gemini key and model, and suggests fallback models
npm run voices            # lists and test-plays your ElevenLabs voices
npm run check:presage     # checks the Presage key
```

> **Keep keys out of Git.** `.env` files are already in `.gitignore`. Never commit real keys or paste them into
> issues or pull requests.

**Optional Gemini backups:** set `GEMINI_BACKUP_KEYS` (keys from another Google project have their own quota)
and `GEMINI_FALLBACK_MODELS` in `backend/.env`. The app switches to them automatically when the main model is
overloaded (503) or out of quota (429).

## Quick start

### 1. Clone and create your `.env` files

```bash
git clone https://github.com/rynxnet/owl-hacks-2026.git
cd owl-hacks-2026
```

macOS / Linux:

```bash
cp backend/.env.example backend/.env
cp presage-bridge/.env.example presage-bridge/.env
```

Windows (PowerShell or Command Prompt):

```bat
copy backend\.env.example backend\.env
copy presage-bridge\.env.example presage-bridge\.env
```

Open `backend/.env` and set `GEMINI_API_KEY` (and `ELEVENLABS_API_KEY` if you have one). Open
`presage-bridge/.env` and set `PRESAGE_API_KEY`.

### 2. Start the three services, in this order

Use three terminals.

```bash
# Terminal 1: backend (http://localhost:3001)
cd backend
npm install
npm run dev
```

```bash
# Terminal 2: heart rate from the webcam
cd presage-bridge
npm install
npm start
# Wait for "[presage] Running" before opening the app.
```

```bash
# Terminal 3: frontend (http://localhost:5173)
cd frontend
npm install
npm run dev
```

### 3. Open the app

Open **Chrome** at <http://localhost:5173>, allow microphone access, enter a role, paste a job posting,
pick an interview style and start. The setup screen shows which integrations are connected.

> **Close other apps using the camera** (Teams, Zoom, the Windows Camera app) before starting the bridge. Only
> one program can use the webcam at a time.

## Running without a camera

If you have no webcam or no Presage key, use the heart-rate simulator instead of the bridge:

```bash
cd backend
npm run sim      # while it runs: u / d = heart rate up / down, s = spike
```

A Gemini key is still required.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Chat shows *"AI interviewer failed"* | Check `GEMINI_API_KEY` in `backend/.env` and run `npm run check:gemini`. If it mentions quota (429) or overload (503), wait a minute or add `GEMINI_BACKUP_KEYS`. |
| Setup screen says Gemini is off | The backend didn't find the key. Make sure the file is `backend/.env` (not `.env.example`) and restart `npm run dev`. |
| No heart rate / *"Lost your pulse"* | Make sure the bridge shows `[presage] Running`. Use steady, even lighting on your face and keep still. |
| *"SmartSpectra processing failed"* | Two programs are using the camera. Close other camera apps and leave `PRESAGE_MODE=bridge` (the default). |
| Bridge stops with a key or credit error | Check `PRESAGE_API_KEY` in `presage-bridge/.env`. |
| Microphone doesn't work | Use Chrome, and open the app on `localhost` or over `https://`. |
| The bridge opens the wrong camera | Set `CAMERA_INDEX=1` (or 2, 3...) in `presage-bridge/.env`. |

## Project structure

| Folder | Contents |
| --- | --- |
| `backend/` | Node.js, Express and WebSocket server. `src/interviewer.js` is the Gemini agent; `src/services/` holds sessions, turns, vitals, replay and feedback; `src/stress.js` and `src/vitalsFilter.js` hold the heart-rate logic; `test/` holds the tests. |
| `frontend/` | React 18 + Vite + Recharts: setup, live interview and replay screens |
| `presage-bridge/` | Reads the webcam with Presage SmartSpectra (SDK 3.3.0) and streams heart rate to the backend. It restarts Presage automatically if it stalls. See [`presage-bridge/README.md`](presage-bridge/README.md). |
| `.devcontainer/` | GitHub Codespaces configuration |

### Heart-rate pipeline

- `vitalsFilter.js` drops out-of-range, low-confidence, duplicate and one-off glitch readings, and passes a
  median of the last three readings to the stress engine.
- `stress.js` sets your baseline as the median heart rate over the first `BASELINE_MS`. After that, it
  compares the average of the last 10 seconds with the baseline:

  | Heart rate vs. baseline | State |
  | --- | --- |
  | under +15% | calm |
  | +15% to +30% | elevated |
  | over +30% | overloaded |

  A new state has to last 6 seconds before it counts.

All thresholds can be changed with environment variables; see `backend/.env.example`.

## Testing

The tests run offline against a fake Gemini, with no network access or API keys needed.

```bash
cd backend
node test/interviewer-agent.test.mjs   # the interviewer agent: brief, respond, review, styles
node test/gemini-routes.test.mjs       # retries, backup keys/models, unsupported thinking levels
node test/role.test.mjs                # matching roles to interview tracks
node test/bpm.test.mjs                 # heart-rate filter and stress engine
node test/presage-decode.test.mjs      # decoding Presage messages
node test/presage-worker.test.mjs      # the server-side Presage worker
npm run test:unit                      # service tests (run npm install first)
```

## API reference

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Which integrations are enabled, and how many heart-rate sources are connected |
| `POST` | `/api/sessions` | Start an interview. Body: `{ role, jobDetails?, persona, maxQuestions }` |
| `POST` | `/api/sessions/:id/turn` | Send an answer `{ answer }`. Returns `{ say, action, audio, state }` |
| `POST` | `/api/sessions/:id/end` | End the interview and get the replay and coaching |
| `GET` | `/api/sessions/:id/replay` | Replay data |
| `WS` | `/ws/vitals` | Heart-rate sources send `{ hr, br?, ts? }` |
| `WS` | `/ws/client?session=ID` | The browser receives `vitals` and `utterance` events |

## Deployment

The backend serves the built frontend, so one server runs the whole app:

```bash
cd frontend && npm install && npm run build
cd ../backend && npm install && npm start     # serves the app on PORT (default 3001)
```

- Browsers only allow the microphone on `https://` or `localhost`, so put the server behind HTTPS (for
  example, Caddy with your domain).
- The Presage bridge still runs on the computer with the webcam. Point it at the server by setting
  `VITALS_URL=wss://your-domain/ws/vitals` in `presage-bridge/.env`.
- `/ws/vitals` has no authentication, so keep deployments private to the demo.

## Team

Built by the OwlHacks 2026 team:

| Contributor | Focus |
| --- | --- |
| [@rynxnet](https://github.com/rynxnet) | AI interviewer agent, Presage integration, backend |
| [@LouGotCash](https://github.com/LouGotCash) | Frontend: interview and replay UI |
| [@JWS2028](https://github.com/JWS2028) | Frontend |
| [@VapeurCat](https://github.com/VapeurCat) | Backend service structure, branding |

Powered by [Google Gemini](https://ai.google.dev), [ElevenLabs](https://elevenlabs.io) and
[Presage SmartSpectra](https://github.com/Presage-Security/SmartSpectra).
