require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('./db');

const PORT = process.env.PORT || 3000;

// Any OpenAI-compatible Whisper endpoint works: hosted (Groq) or self-hosted (faster-whisper server).
const STT_BASE_URL = (process.env.STT_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const STT_API_KEY = process.env.STT_API_KEY || '';
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3';

// A Hinglish sample in the prompt nudges Whisper to write Hindi words in Roman script.
const HINGLISH_PROMPT =
  'Main kal office jaa raha hoon, meeting at 5 baje hai. Thoda time lagega, then I will call you.';
// Language modes the app accepts. 'auto' and 'hinglish' are special; the rest are Whisper language codes.
const LANGUAGES = ['auto', 'hinglish', 'hi', 'en', 'kn', 'ta', 'te', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur'];

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Create the table on first use. This works on serverless hosts (Vercel), where there is no
// long-running startup. A failed attempt is not cached, so the next request tries again.
let dbReady = null;
function ensureDb() {
  if (!dbReady) dbReady = db.init().catch((err) => { dbReady = null; throw err; });
  return dbReady;
}
app.use('/api', (_req, _res, next) => ensureDb().then(() => next(), next));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
  next();
});

app.get('/api/health', wrap(async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true });
}));

// ---------- Speech to text ----------
// The browser sends short audio segments; each one is transcribed and returned immediately.
app.post('/api/transcribe', upload.single('audio'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing audio file' });

  const language = LANGUAGES.includes(req.body.language) ? req.body.language : 'auto';
  const form = new FormData();
  form.append(
    'file',
    new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }),
    req.file.originalname || 'chunk.webm'
  );
  form.append('model', STT_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language === 'hinglish') form.append('prompt', HINGLISH_PROMPT);
  else if (language !== 'auto') form.append('language', language);   // fixed language code

  const upstream = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: STT_API_KEY ? { Authorization: `Bearer ${STT_API_KEY}` } : {},
    body: form,
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 300);
    console.error('STT error', upstream.status, detail);
    return res.status(502).json({ error: `Transcription service error (${upstream.status})` });
  }

  const data = await upstream.json();
  let text = data.text || '';
  // Drop segments Whisper itself marks as likely silence, which avoids "ghost" text.
  if (Array.isArray(data.segments) && data.segments.length) {
    text = data.segments
      .filter((s) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -1))
      .map((s) => s.text)
      .join('');
  }
  res.json({ text: text.trim(), language: data.language || null });
}));

// ---------- Transcription CRUD ----------
function parseBody(body) {
  const text = String(body.text ?? '').trim();
  const title = String(body.title ?? '').trim().slice(0, 200) || text.slice(0, 40);
  const language = LANGUAGES.includes(body.language) ? body.language : 'auto';
  const duration = Math.max(0, Math.min(86400, parseInt(body.duration_sec, 10) || 0));
  return { text, title, language, duration };
}

// List with optional search and paging
app.get('/api/transcriptions', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where = 'WHERE title ILIKE $1 OR text ILIKE $1';
  }
  const rows = await db.query(
    `SELECT * FROM transcriptions ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const count = await db.query(`SELECT COUNT(*)::int AS total FROM transcriptions ${where}`, params);
  res.json({ items: rows.rows, total: count.rows[0].total });
}));

app.get('/api/transcriptions/:id', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM transcriptions WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

app.post('/api/transcriptions', wrap(async (req, res) => {
  const { text, title, language, duration } = parseBody(req.body);
  if (!text) return res.status(400).json({ error: 'Text is required' });
  const { rows } = await db.query(
    'INSERT INTO transcriptions (title, text, language, duration_sec) VALUES ($1, $2, $3, $4) RETURNING *',
    [title, text, language, duration]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/transcriptions/:id', wrap(async (req, res) => {
  const { text, title, language } = parseBody(req.body);
  if (!text) return res.status(400).json({ error: 'Text is required' });
  const { rows } = await db.query(
    'UPDATE transcriptions SET title = $1, text = $2, language = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
    [title, text, language, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

app.delete('/api/transcriptions/:id', wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM transcriptions WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
}));

// ---------- Errors ----------
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Run locally with `npm start`. On Vercel the exported app is used instead (no listen needed).
if (require.main === module) {
  ensureDb()
    .then(() => app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`)))
    .catch((err) => {
      console.error('Database init failed:', err.message);
      process.exit(1);
    });
}

module.exports = app;