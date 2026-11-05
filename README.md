# Speech to Text (Hindi + English)

Web app that transcribes live speech, including Hindi and English mixed in one sentence, and stores every transcription in PostgreSQL. A dashboard shows the history with full CRUD.

**Stack:** Node.js, Express, PostgreSQL, vanilla JS frontend. Speech model: open-source **Whisper large-v3**.

## How it works

```
Browser mic ──(4s audio segments)──▶ POST /api/transcribe ──▶ Whisper (OpenAI-compatible API)
     ▲                                        │
     └──────────── text appended live ◀───────┘
Save ──▶ POST /api/transcriptions ──▶ PostgreSQL ◀── Dashboard (list / search / edit / delete)
```

- The browser records with `MediaRecorder`, cutting the audio every 4 seconds so each piece is a valid file, and sends them in order. Text shows up a few seconds after you speak.
- Segments that are silent are skipped in the browser, and segments Whisper flags as no-speech are dropped on the server. This stops "ghost" text.
- The speech service is just an OpenAI-compatible `/audio/transcriptions` endpoint, so you can switch between a hosted Whisper (Groq) and a self-hosted one by changing env vars only.
- **Language modes:** *Hinglish* (Hindi words in Roman script, the default), *Auto-detect*, *Hindi*, *English*.

## Run locally

Requirements: Node 18+, PostgreSQL, a Groq API key (free at https://console.groq.com) or a self-hosted Whisper server.

```bash
git clone <your-repo-url> && cd speech-to-text
npm install
cp .env.example .env          # then fill in DATABASE_URL and STT_API_KEY
createdb speech_to_text
npm start                     # http://localhost:3000
```

The `transcriptions` table is created automatically on first start.

With Docker instead: `STT_API_KEY=your_key docker compose up --build`

Browsers only allow microphone access on `localhost` or HTTPS.

## Self-hosting Whisper (no third-party API)

Run any OpenAI-compatible Whisper server (for example a faster-whisper server container) and point the app at it:

```
STT_BASE_URL=http://localhost:8000/v1
STT_API_KEY=
STT_MODEL=Systran/faster-whisper-small
```

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/transcribe` | multipart `audio` + `language`, returns `{ text }` |
| GET | `/api/transcriptions?q=&limit=&offset=` | list with search, returns `{ items, total }` |
| GET | `/api/transcriptions/:id` | read one |
| POST | `/api/transcriptions` | create `{ title?, text, language?, duration_sec? }` |
| PUT | `/api/transcriptions/:id` | update `{ title, text, language }` |
| DELETE | `/api/transcriptions/:id` | delete |
| GET | `/api/health` | health check (touches the DB) |

## Deploy (Render)

1. Push this repo to GitHub.
2. On Render: **New → Blueprint**, select the repo. `render.yaml` creates the web service and a PostgreSQL database and wires `DATABASE_URL`.
3. Set the `STT_API_KEY` env var when prompted.
4. Open the Render URL (HTTPS, so the mic works).

Any host that runs Node and Postgres works the same way (Railway, Fly.io, Azure, etc.). Set `DATABASE_SSL=true` for hosted databases that require SSL.

## Known limitations

- Near real-time, not word-by-word streaming: expect a delay of a few seconds. A word spoken exactly at a segment boundary can be split or missed. Overlapping segments or a streaming (WebSocket) pipeline would improve this.
- Whisper may write Hindi in Devanagari in Auto mode. Use *Hinglish* mode for Roman script.
- No user accounts: all history is shared. Add auth before using with real data.
