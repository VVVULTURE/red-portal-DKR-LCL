'use strict';

/**
 * Red Portal — automatic movie captioning via Groq's Whisper API.
 * ================================================================
 * The Koyeb free instance can't run Whisper itself, so it hands the audio to
 * Groq's (free-tier) Whisper API and stores the result as Movies/<name>.vtt.
 *
 * Flow, per uncaptioned movie (queued one at a time to spare the 0.1 vCPU):
 *   1. ffmpeg reads the movie from its R2 URL and extracts 16 kHz mono audio,
 *      split into CHUNK_SEC-second .mp3 chunks (kept small: Groq caps upload
 *      size, and chunking bounds the work + eases rate limits).
 *   2. each chunk -> Groq POST /openai/v1/audio/transcriptions with
 *      response_format=verbose_json (Groq has no vtt/srt format — we build the
 *      WebVTT ourselves from the returned segment start/end/text).
 *   3. offset each chunk's timestamps and stitch into one .vtt.
 *   4. upload to R2 as Movies/<name>.vtt (write keys), then clean up.
 *
 * Entirely gated on GROQ_API_KEY + R2 write creds + ffmpeg being present; if any
 * is missing it's a no-op and nothing else is affected.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const GROQ_KEY   = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
const GROQ_URL   = 'https://api.groq.com/openai/v1/audio/transcriptions';
const CHUNK_SEC  = parseInt(process.env.CAPTION_CHUNK_SEC || '600', 10);   // 10-min chunks

const R2_ACCOUNT_ID   = process.env.R2_ACCOUNT_ID || '';
// Upload needs WRITE access. Prefer dedicated write keys; fall back to the
// site's R2_LIST_* keys in case that token already has write scope.
const R2_KEY    = process.env.R2_ACCESS_KEY_ID     || process.env.R2_LIST_ACCESS_KEY_ID     || '';
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_LIST_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'red-portal-assets';
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || 'assets.redportal.dpdns.org';

const ENABLED = !!(GROQ_KEY && R2_ACCOUNT_ID && R2_KEY && R2_SECRET);

let _ffmpeg = null;
function hasFfmpeg() {
  if (_ffmpeg === null) {
    try { _ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
    catch (_) { _ffmpeg = false; }
  }
  return _ffmpeg;
}

let _s3 = null;
function s3() {
  if (!_s3) _s3 = new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_KEY, secretAccessKey: R2_SECRET } });
  return _s3;
}

const enc = key => key.split('/').map(encodeURIComponent).join('/');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtTs(s) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60; return `${pad(h)}:${pad(m)}:${pad(Math.floor(sec))}.${pad(Math.round((sec - Math.floor(sec)) * 1000), 3)}`; }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    c.on('error', reject);
    c.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)));
  });
}

/**
 * POST one audio chunk to Groq and return its segment list. Retries on rate
 * limit. NOTE: Groq's transcription API supports only json | text |
 * verbose_json — NOT vtt/srt (that's OpenAI). So we ask for verbose_json and
 * build the WebVTT ourselves from the segment start/end/text (see collectCues).
 */
async function groqSegments(file) {
  const bytes = fs.readFileSync(file);
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), path.basename(file));
    form.append('model', GROQ_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('language', 'en');
    form.append('temperature', '0');
    const res = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${GROQ_KEY}` }, body: form });
    if (res.ok) { const j = await res.json(); return Array.isArray(j.segments) ? j.segments : []; }
    if (res.status === 429 || res.status >= 500) {   // rate-limited / transient — back off
      const wait = Math.min(60000, 2000 * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error('Groq: gave up after retries (rate limit)');
}

/** Offset each verbose_json segment by `off` seconds and push a cue into `cues`. */
function collectCues(segments, off, cues) {
  for (const s of segments || []) {
    const start = Number(s.start) + off, end = Number(s.end) + off;
    const body = String(s.text == null ? '' : s.text).trim();
    if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push(`${fmtTs(start)} --> ${fmtTs(end)}\n${body}`);
  }
}

const inProgress = new Set();
let queue = Promise.resolve();   // serialize: one movie at a time

// Last-run diagnostics, surfaced (no secrets) via /api/r2-status so a failure on
// the Koyeb instance is visible without shell/log access. `stage` is updated as
// transcribeOne progresses, so a thrown error tells us WHERE it died.
let _last = { file: null, stage: null, startedAt: null, doneAt: null, cues: null, error: null };
function _stage(file, stage) { _last = { ..._last, file, stage, error: null }; }

/** Transcribe one Movies/<file> and upload Movies/<stem>.vtt. Safe/no-op if disabled. */
function queueMovie(fileName) {
  if (!ENABLED || !hasFfmpeg() || inProgress.has(fileName)) return;
  inProgress.add(fileName);
  queue = queue.then(() => transcribeOne(fileName))
    .catch(e => { _last = { ..._last, file: fileName, error: e.message, doneAt: new Date().toISOString() }; console.error(`  ✗  caption "${fileName}":`, e.message); })
    .finally(() => inProgress.delete(fileName));
}

async function transcribeOne(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const url = `https://${R2_PUBLIC_DOMAIN}/Movies/${enc(fileName)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcap-'));
  _last = { file: fileName, stage: 'ffmpeg (extract audio)', startedAt: new Date().toISOString(), doneAt: null, cues: null, error: null };
  console.log(`  🎬  Auto-captioning "${fileName}" via Groq…`);
  try {
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
      '-i', url, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k',
      '-f', 'segment', '-segment_time', String(CHUNK_SEC), path.join(tmp, 'c%03d.mp3')]);
    const chunks = fs.readdirSync(tmp).filter(f => /^c\d+\.mp3$/.test(f)).sort();
    if (!chunks.length) throw new Error('no audio extracted');
    const cues = [];
    for (let i = 0; i < chunks.length; i++) {
      _stage(fileName, `groq chunk ${i + 1}/${chunks.length}`);
      const segments = await groqSegments(path.join(tmp, chunks[i]));
      collectCues(segments, i * CHUNK_SEC, cues);
    }
    if (!cues.length) { _last = { ..._last, stage: 'no speech', doneAt: new Date().toISOString(), cues: 0 }; console.log(`  (no speech in "${fileName}", skipping)`); return; }
    _stage(fileName, 'uploading .vtt to R2');
    const out = 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
    await s3().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: `Movies/${stem}.vtt`,
      Body: Buffer.from(out, 'utf-8'), ContentType: 'text/vtt; charset=utf-8' }));
    _last = { file: fileName, stage: 'done', startedAt: _last.startedAt, doneAt: new Date().toISOString(), cues: cues.length, error: null };
    console.log(`  ✓  Captioned "${fileName}" (${cues.length} cues) -> Movies/${stem}.vtt`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

/** Given the current movie + vtt filenames, queue any movie missing its caption. */
function queueMissing(movieFiles, vttFiles) {
  if (!ENABLED) return;
  const have = new Set((vttFiles || []).map(f => f.replace(/\.vtt$/i, '')));
  for (const m of (movieFiles || [])) {
    if (!have.has(m.replace(/\.[^.]+$/, ''))) queueMovie(m);
  }
}

module.exports = { ENABLED, hasFfmpeg, queueMissing, queueMovie, get inProgress() { return [...inProgress]; }, get last() { return _last; } };
