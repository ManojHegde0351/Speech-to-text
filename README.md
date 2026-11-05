# Speech to Text (Hindi, English and Indian languages)

Web app that transcribes live speech, including Hindi and English mixed in one sentence, plus Kannada, Tamil, Telugu, Malayalam, Marathi, Bengali, Gujarati, Punjabi and Urdu. Every transcription can be saved to a PostgreSQL database and managed from a dashboard with full CRUD.

**Live demo:** <(https://speech-to-text-mu-flax.vercel.app/)>
**Code:** <paste your GitHub repo link here>



## Features

- **Near real-time transcription:** speak and text appears every few seconds.
- **Multilingual:** Hinglish mode (Hindi words in Roman script), Auto-detect for mixed languages, or pick a specific language to get text in its own script.
- **Dashboard (CRUD):** save transcriptions, search them, edit them, create new ones by hand, and delete them.
- **Speak back:** reads the text aloud in the right voice for each script, even when one text mixes scripts (for example Kannada plus English).
- **Welcome screen and tips:** animated first-visit guide and short instruction pop-ups. The "How it works" button reopens the guide.
- **Light and dark mode**, and reduced-motion support.

## Tech stack

| Part | Choice |
|---|---|
| Backend | Node.js, Express |
| Database | PostgreSQL (Neon in production) |
| Speech to text | Open-source Whisper large-v3 via an OpenAI-compatible API (Groq) |
| Text to speech | Browser built-in voices (Web Speech API) |
| Frontend | Plain HTML, CSS and JavaScript (`public/`) |
| Hosting | Vercel |

## How it works

```
Browser mic ──(4s audio segments)──▶ POST /api/transcribe ──▶ Whisper
     ▲                                        │
     └──────────── text appended live ◀───────┘
Save ──▶ POST /api/transcriptions ──▶ PostgreSQL ◀── Dashboard (list / search / edit / delete)
```

- The browser records with `MediaRecorder` and cuts the audio every 4 seconds, so each piece is a valid file. Pieces are sent in order, so the text stays in order.
- Silent segments are skipped in the browser, and segments Whisper marks as no-speech are dropped on the server. This avoids made-up text.
- The speech service is any OpenAI-compatible `/audio/transcriptions` endpoint. Switching between hosted Whisper (Groq) and a self-hosted Whisper server only needs environment variables.
- The `transcriptions` table is created automatically on the first request.

## Project structure

```
server.js          Express API and speech proxy
db.js              PostgreSQL connection and table setup
public/
  index.html       page structure
  style.css        all styling and animations (colors and sizes at the top)
  app.js           recording, speech, welcome screen, dashboard logic
render.yaml, Dockerfile, docker-compose.yml   optional deploy configs
```

## Run locally

Requirements: Node 18 or newer, PostgreSQL, and a free Groq API key from https://console.groq.com.

```bash
git clone <your-repo-url>
cd speech-to-text
npm install
cp .env.example .env          # Windows PowerShell: copy .env.example .env
createdb speech_to_text
npm start                     # http://localhost:3000
```

Edit `.env` with your own values. Browsers only allow microphone access on `localhost` or HTTPS.

With Docker instead: `STT_API_KEY=your_key docker compose up --build`

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL` | `true` for hosted databases such as Neon, `false` locally |
| `STT_API_KEY` | API key for the Whisper service (Groq) |
| `STT_BASE_URL` | Optional. Defaults to `https://api.groq.com/openai/v1` |
| `STT_MODEL` | Optional. Defaults to `whisper-large-v3` |
| `PORT` | Optional. Local port, defaults to 3000 |

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/transcribe` | multipart `audio` + `language`, returns `{ text }` |
| GET | `/api/transcriptions?q=&limit=&offset=` | list with search, returns `{ items, total }` |
| GET | `/api/transcriptions/:id` | read one |
| POST | `/api/transcriptions` | create `{ title?, text, language?, duration_sec? }` |
| PUT | `/api/transcriptions/:id` | update `{ title, text, language }` |
| DELETE | `/api/transcriptions/:id` | delete |
| GET | `/api/health` | health check (touches the database) |

## Deploy on Vercel

Vercel runs the app as a serverless function and serves `public/` from its CDN. It has no database of its own, so use a hosted PostgreSQL such as Neon.

1. Create a Neon project and copy the **pooled** connection string.
2. Push this repo to GitHub. Never commit `.env`.
3. On Vercel, import the repo and keep the default build settings.
4. Add the environment variables `DATABASE_URL`, `DATABASE_SSL=true` and `STT_API_KEY`.
5. Deploy. Changing a variable later needs a redeploy.

## Self-hosting the speech model

The app only needs an OpenAI-compatible Whisper endpoint. To avoid a third-party API, run your own Whisper server and point the app at it:

```
STT_BASE_URL=http://localhost:8000/v1
STT_API_KEY=
STT_MODEL=<model name your server expects>
```

The deployed demo uses Groq's hosted Whisper, because free hosting tiers cannot run the model.

## Known limitations

- **Not word-by-word streaming:** expect a delay of a few seconds. A word spoken exactly at a segment boundary can be split or missed. Overlapping segments or a WebSocket streaming pipeline would improve this.
- **Accuracy varies by language:** Whisper is strongest on English and Hindi, and weaker on Kannada, Tamil, Telugu and Malayalam. With one fixed language selected, English words in the middle of a sentence may come out garbled, so use Auto-detect for mixed speech.
- **Voices depend on the device:** speaking back uses voices installed on the device. If a language has no voice, the app shows a message and falls back to the default voice.
- **No user accounts:** all saved history is shared. Add authentication before using it with real data.

## License

MIT. See [LICENSE](LICENSE).
