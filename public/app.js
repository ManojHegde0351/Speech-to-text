const $ = (id) => document.getElementById(id);
const SEGMENT_MS = 4000;      // each audio segment sent for transcription
const SILENCE_GATE = 0.05;    // skip segments quieter than this (avoids ghost text)

// ---------- API helper ----------
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---------- Tip notifications (toasts) ----------
// All tip wording lives here, so it is easy to edit. Each is [title, text].
const TIPS = {
  pickLang:   ['Choose your language first', 'Pick it from the dropdown above the mic. It gives the best accuracy and the right script.'],
  micAllow:   ['Allow microphone access', 'Your browser will ask for permission. Choose Allow.'],
  listening:  ['Listening…', 'Speak in full sentences. Text appears every few seconds.'],
  done:       ['Done! Review your text', 'Edit it if needed, then press Save to history. Use Speak back to hear it.'],
  nativeLang: ['Want text in your own script?', 'Choose the language itself (Kannada, Tamil, Telugu…) instead of Hinglish or Auto-detect.'],
  fixedLang:  ['Mixing languages?', 'With one language selected, English words may come out garbled. Use Auto-detect for mixed speech.'],
  sttError:   ['Could not transcribe', 'Check your internet connection and the speech API key, then try again.'],
  micBlocked: ['Microphone is blocked', 'Click the lock icon in the address bar, set Microphone to Allow, then reload the page.'],
};

const toastsSeen = new Set();

// Shows a toast. Pass an id to show that tip only once per page load (null = always show).
// Options: kind 'warn' for an error style, life = milliseconds before it disappears.
function toast(id, [title, text], { kind = 'info', life = 7000 } = {}) {
  if (id) { if (toastsSeen.has(id)) return null; toastsSeen.add(id); }
  const box = $('toasts');
  const live = [...box.children].filter((c) => !c.classList.contains('leaving'));
  while (live.length >= 3) dismissToast(live.shift());      // keep at most 3 on screen

  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
  el.setAttribute('role', kind === 'warn' ? 'alert' : 'status');
  el.style.setProperty('--life', life + 'ms');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = kind === 'warn' ? '!' : 'i';
  const body = document.createElement('div');
  const b = document.createElement('b'); b.textContent = title;
  const p = document.createElement('p'); p.textContent = text;
  body.append(b, p);
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');

  const timer = setTimeout(() => dismissToast(el), life);
  x.onclick = () => { clearTimeout(timer); dismissToast(el); };
  el.append(icon, body, x);
  box.appendChild(el);
  return el;
}

function dismissToast(el) {
  if (!el || !el.isConnected || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 250);
}

// ---------- Welcome screen ----------
const welcome = $('welcome');
const appMain = document.querySelector('main');
const WELCOME_WORDS = ['नमस्ते', 'ನಮಸ್ಕಾರ', 'வணக்கம்', 'నమస్కారం', 'നമസ്കാരം', 'Hello', 'নমস্কার', 'નમસ્તે', 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ', 'नमस्कार', 'السلام علیکم'];

WELCOME_WORDS.forEach((word, i) => {          // floating greetings in the background
  const s = document.createElement('span');
  s.textContent = word;
  s.style.setProperty('--x', 4 + ((i * 37) % 88) + '%');
  s.style.setProperty('--s', 18 + ((i * 7) % 16) + 'px');
  s.style.setProperty('--dur', 12 + ((i * 5) % 8) + 's');
  s.style.setProperty('--delay', -(i * 2.7) + 's');   // negative = already floating when the page opens
  $('floaters').appendChild(s);
});

function openWelcome() {
  welcome.hidden = false;
  welcome.classList.remove('leaving');
  appMain.inert = true;                       // keeps keyboard focus inside the welcome screen
  $('startBtn').focus();
}

function closeWelcome() {
  try { sessionStorage.setItem('stt-welcomed', '1'); } catch {}   // show it once per tab
  appMain.inert = false;
  welcome.classList.add('leaving');
  setTimeout(() => { welcome.hidden = true; welcome.classList.remove('leaving'); }, 500);
  appMain.classList.remove('in'); void appMain.offsetWidth; appMain.classList.add('in');   // replay fade-in
  $('recBtn').focus();
  setTimeout(() => toast('pick-lang', TIPS.pickLang), 700);
}

$('startBtn').onclick = closeWelcome;
$('guideBtn').onclick = openWelcome;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !welcome.hidden) closeWelcome(); });

let welcomed = false;
try { welcomed = sessionStorage.getItem('stt-welcomed') === '1'; } catch {}
if (welcomed) {
  welcome.hidden = true;
  setTimeout(() => toast('pick-lang', TIPS.pickLang), 600);
} else {
  appMain.inert = true;
  $('startBtn').focus();
}

// ---------- Recording ----------
let stream, audioCtx, analyser, levelTimer, segTimer, tickTimer;
let currentRec, curSeg = { peak: 0 };
let running = false, startedAt = 0, elapsed = 0, queue = Promise.resolve(), pending = 0;

const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
const EXT = MIME.includes('mp4') ? 'mp4' : 'webm';

function setStatus(msg) { $('status').textContent = msg; }
function showLatest(text) {
  const el = $('latest');
  el.textContent = text;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');   // replay the slide-in animation
}

// Waveform bars (heights are driven by the live audio spectrum while recording)
const bars = [];
for (let i = 0; i < 28; i++) {
  const b = document.createElement('i');
  b.style.setProperty('--i', i);
  $('wave').appendChild(b);
  bars.push(b);
}

// ---------- Text to speech (browser built-in voices, no API key needed) ----------
const synth = window.speechSynthesis;
let voices = [], speakId = 0, speaking = false;
if (synth) { voices = synth.getVoices(); synth.onvoiceschanged = () => { voices = synth.getVoices(); }; }

function pickVoice(lang) {
  const base = lang.split('-')[0];
  return voices.find((v) => v.lang.replace('_', '-') === lang) || voices.find((v) => v.lang.startsWith(base)) || null;
}

function setSpeaking(on) {
  speaking = on;
  $('speakBtn').textContent = on ? '■ Stop' : '▶ Speak back';
}

// Which voice to use: decided PER PIECE of text by the script it is written in, so a
// sentence that mixes scripts (for example Kannada + English, or recorded words + words
// you typed while editing) is read in full, each piece by a matching voice.
// (Marathi shares Devanagari with Hindi, so the chosen mode breaks the tie.)
const SCRIPT_VOICES = [
  [/[ಀ-೿]/, 'kn-IN'],   // Kannada
  [/[஀-௿]/, 'ta-IN'],   // Tamil
  [/[ఀ-౿]/, 'te-IN'],   // Telugu
  [/[ഀ-ൿ]/, 'ml-IN'],   // Malayalam
  [/[ঀ-৿]/, 'bn-IN'],   // Bengali
  [/[઀-૿]/, 'gu-IN'],   // Gujarati
  [/[਀-੿]/, 'pa-IN'],   // Punjabi (Gurmukhi)
  [/[؀-ۿ]/, 'ur-IN'],   // Urdu
  [/[ऀ-ॿ]/, 'hi-IN'],   // Devanagari
  [/[A-Za-zÀ-ɏ]/, 'en-IN'],   // Roman script (English / Hinglish)
];

// Voice language of one character, or null for spaces, digits and punctuation.
function charLang(ch, mode) {
  const hit = SCRIPT_VOICES.find(([re]) => re.test(ch));
  if (!hit) return null;
  return hit[1] === 'hi-IN' && mode === 'mr' ? 'mr-IN' : hit[1];
}

// Cuts text into runs that each use one voice language, in reading order.
// Spaces, digits and punctuation stay with the run they sit in.
function splitByLanguage(text, mode) {
  const runs = [];
  let cur = null;
  for (const ch of text) {
    const l = charLang(ch, mode);
    if (!cur || (l && cur.lang && l !== cur.lang)) {
      cur = { lang: l, text: ch };
      runs.push(cur);
    } else {
      if (l && !cur.lang) cur.lang = l;
      cur.text += ch;
    }
  }
  return runs.filter((r) => r.text.trim()).map((r) => ({ lang: r.lang || 'en-IN', text: r.text }));
}

function speak(text, onEnd, mode) {
  if (!synth) { alert('Text-to-speech is not supported in this browser.'); return; }
  synth.cancel();
  setSpeaking(false);
  const id = ++speakId;                       // lets us ignore callbacks from a cancelled run

  // One utterance per sentence-sized piece, each with the voice for its own script.
  // Short pieces also stop Chrome from cutting off long utterances.
  const pieces = [];
  for (const run of splitByLanguage(text, mode)) {
    const sentences = (run.text.match(/[^.!?।]+[.!?।]*/g) || [run.text]).map((p) => p.trim()).filter(Boolean);
    sentences.forEach((s) => pieces.push({ lang: run.lang, text: s }));
  }
  if (!pieces.length) { if (onEnd) onEnd(); return; }

  const missing = new Set();
  pieces.forEach((piece, i) => {
    const u = new SpeechSynthesisUtterance(piece.text);
    u.lang = piece.lang;
    const voice = pickVoice(piece.lang);
    if (voice) u.voice = voice; else if (voices.length) missing.add(piece.lang);
    u.rate = 0.95;
    if (i === pieces.length - 1) u.onend = u.onerror = () => { if (id === speakId && onEnd) onEnd(); };
    synth.speak(u);
  });
  if (missing.size) setStatus(`No ${[...missing].join(', ')} voice on this device, so some words may be skipped.`);
}

function stopSpeaking() {
  speakId++;
  if (synth) synth.cancel();
  setSpeaking(false);
}

function speakLive() {
  const text = $('live').value.trim();
  if (!text) return;
  speak(text, () => setSpeaking(false), $('lang').value);
  setSpeaking(true);
}

$('speakBtn').onclick = () => (speaking ? stopSpeaking() : speakLive());

// Runs once the last audio segment of a session has been transcribed.
function onSessionDone() {
  if (running) return;                        // a new recording already started
  setStatus('Done. Review and save.');
  refreshSave();
  if ($('live').value.trim()) toast('done', TIPS.done);
  if ($('autoSpeak').checked && $('live').value.trim()) speakLive();
}
function fmt(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function refreshSave() {
  const empty = !$('live').value.trim();
  $('saveBtn').disabled = running || pending > 0 || empty;
  $('speakBtn').disabled = running || empty;
}

async function askMicTip() {
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    if (perm.state === 'prompt') return toast('mic-allow', TIPS.micAllow, { life: 15000 });
  } catch {}                                  // some browsers can't report mic permission
  return null;
}

async function startRecording() {
  stopSpeaking();                             // so the mic doesn't pick up our own voice
  if (!window.MediaRecorder) return setStatus('This browser does not support recording.');
  const permTip = askMicTip();                // tip is only shown if the browser is about to ask
  const clearPermTip = () => permTip.then((el) => dismissToast(el));
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    clearPermTip();
    toast(null, TIPS.micBlocked, { kind: 'warn', life: 12000 });
    return setStatus('Microphone access denied. Allow it and try again (HTTPS or localhost required).');
  }
  clearPermTip();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const freq = new Uint8Array(analyser.frequencyBinCount);
  levelTimer = setInterval(() => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
    curSeg.peak = Math.max(curSeg.peak, peak);
    analyser.getByteFrequencyData(freq);
    bars.forEach((bar, i) => {
      const v = freq[2 + i * 3] / 255;   // low-to-mid spectrum, where speech lives
      bar.style.height = 6 + Math.pow(v, 1.2) * 48 + 'px';
    });
  }, 80);

  running = true;
  startedAt = Date.now();
  tickTimer = setInterval(() => { $('timer').textContent = fmt(Math.floor((Date.now() - startedAt) / 1000)); }, 500);
  $('stage').classList.add('recording');
  $('recBtn').setAttribute('aria-label', 'Stop recording');
  setStatus('Listening…');
  refreshSave();
  startSegment();
  toast('listening', TIPS.listening);
}

function startSegment() {
  const rec = new MediaRecorder(stream, MIME ? { mimeType: MIME } : undefined);
  const seg = { peak: 0 };
  const chunks = [];
  curSeg = seg;
  currentRec = rec;
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    if (seg.peak > SILENCE_GATE && chunks.length) enqueue(new Blob(chunks, { type: rec.mimeType }));
    // Final segment of a stopped session: wait for every pending transcription, then finish up.
    if (!running && rec === currentRec) queue.then(onSessionDone);
  };
  rec.start();
  // Restarting the recorder makes every segment a standalone, valid audio file.
  segTimer = setTimeout(() => { rec.stop(); startSegment(); }, SEGMENT_MS);
}

function enqueue(blob) {
  pending++;
  $('stage').classList.add('busy');
  setStatus('Transcribing…');
  // Chain requests so text always arrives in speaking order.
  queue = queue.then(() => sendChunk(blob)).finally(() => {
    pending--;
    $('stage').classList.toggle('busy', pending > 0);
    if (running) setStatus('Listening…'); else if (!pending) setStatus('Done. Review and save.');
    refreshSave();
  });
}

async function sendChunk(blob) {
  const fd = new FormData();
  fd.append('audio', blob, `chunk.${EXT}`);
  fd.append('language', $('lang').value);
  try {
    const { text } = await api('/api/transcribe', { method: 'POST', body: fd });
    if (text) {
      const box = $('live');
      box.value += (box.value && !/\s$/.test(box.value) ? ' ' : '') + text;
      box.scrollTop = box.scrollHeight;
      showLatest(text);
    }
  } catch (e) {
    setStatus('Error: ' + e.message);
    toast('stt-error', TIPS.sttError, { kind: 'warn', life: 10000 });
  }
}

async function stopRecording() {
  running = false;
  clearTimeout(segTimer);
  clearInterval(levelTimer);
  clearInterval(tickTimer);
  elapsed = Math.floor((Date.now() - startedAt) / 1000);
  if (currentRec && currentRec.state !== 'inactive') currentRec.stop();   // sends the final partial segment
  stream.getTracks().forEach((t) => t.stop());
  audioCtx.close();
  bars.forEach((b) => { b.style.height = ''; });
  $('stage').classList.remove('recording');
  $('recBtn').setAttribute('aria-label', 'Start recording');
  setStatus(pending ? 'Finishing transcription…' : 'Done. Review and save.');
  refreshSave();
}

$('recBtn').onclick = () => (running ? stopRecording() : startRecording());
$('live').oninput = refreshSave;

$('lang').onchange = () => {
  const mode = $('lang').value;
  if (mode === 'hinglish' || mode === 'auto') toast('native-lang', TIPS.nativeLang);
  else if (mode !== 'en' && mode !== 'hi') toast('fixed-lang', TIPS.fixedLang);
};

$('clearBtn').onclick = () => {
  $('live').value = ''; $('title').value = ''; $('timer').textContent = '0:00'; elapsed = 0;
  $('latest').textContent = '';
  setStatus('Tap the mic to start'); refreshSave();
};

$('saveBtn').onclick = async () => {
  try {
    await api('/api/transcriptions', jsonOpts('POST', {
      title: $('title').value, text: $('live').value, language: $('lang').value, duration_sec: elapsed,
    }));
    $('clearBtn').click();
    setStatus('Saved.');
    loadList();
  } catch (e) { setStatus('Save failed: ' + e.message); }
};

// ---------- Dashboard ----------
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); };

async function loadList() {
  try {
    const { items, total } = await api('/api/transcriptions?limit=100&q=' + encodeURIComponent($('search').value));
    $('count').textContent = `(${total})`;
    renderRows(items);
  } catch (e) { $('rows').innerHTML = ''; setStatus('Could not load history: ' + e.message); }
}

function cell(tr, content, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  if (content instanceof Node) td.appendChild(content); else td.textContent = content;
  tr.appendChild(td);
  return td;
}

function renderRows(items) {
  const tbody = $('rows');
  tbody.innerHTML = '';
  if (!items.length) {
    const tr = document.createElement('tr');
    const td = cell(tr, 'No transcriptions yet.', 'empty');
    td.colSpan = 5;
    tbody.appendChild(tr);
    return;
  }
  for (const it of items) {
    const tr = document.createElement('tr');
    cell(tr, it.title);
    cell(tr, it.text.length > 140 ? it.text.slice(0, 140) + '…' : it.text, 'text');
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = it.language;
    cell(tr, tag);
    cell(tr, new Date(it.created_at).toLocaleString());
    const actions = document.createElement('div');
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.onclick = () => openDialog(it);
    const del = document.createElement('button'); del.textContent = 'Delete'; del.className = 'danger';
    del.onclick = async () => {
      if (!confirm('Delete this transcription?')) return;
      try { await api(`/api/transcriptions/${it.id}`, { method: 'DELETE' }); loadList(); }
      catch (e) { alert(e.message); }
    };
    const say = document.createElement('button'); say.textContent = 'Speak'; say.onclick = () => speak(it.text, null, it.language);
    actions.append(say, ' ', edit, ' ', del);
    cell(tr, actions, 'actions');
    tbody.appendChild(tr);
  }
}

// ---------- Create / edit dialog ----------
$('dLang').innerHTML = $('lang').innerHTML;   // one language list for both dropdowns
let editingId = null;
function openDialog(item) {
  editingId = item ? item.id : null;
  $('dlgTitle').textContent = item ? 'Edit transcription' : 'New transcription';
  $('dTitle').value = item ? item.title : '';
  $('dLang').value = item ? item.language : 'hinglish';
  $('dText').value = item ? item.text : '';
  $('dlg').showModal();
}
$('newBtn').onclick = () => openDialog(null);
$('dCancel').onclick = () => $('dlg').close();
$('dlgForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = { title: $('dTitle').value, text: $('dText').value, language: $('dLang').value };
  try {
    if (editingId) await api(`/api/transcriptions/${editingId}`, jsonOpts('PUT', body));
    else await api('/api/transcriptions', jsonOpts('POST', body));
    $('dlg').close();
    loadList();
  } catch (err) { alert(err.message); }
};

loadList();