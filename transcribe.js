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
 *      response_format=vtt (Groq returns WebVTT directly).
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
function parseTs(str) { const p = str.trim().split(':'); let s = 0; for (const x of p) s = s * 60 + parseFloat(x); return s; }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    c.on('error', reject);
    c.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)));
  });
}

/** POST one audio chunk to Groq, asking for WebVTT back. Retries on rate limit. */
async function groqVtt(file) {
  const bytes = fs.readFileSync(file);
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), path.basename(file));
    form.append('model', GROQ_MODEL);
    form.append('response_format', 'vtt');
    form.append('language', 'en');
    form.append('temperature', '0');
    const res = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${GROQ_KEY}` }, body: form });
    if (res.ok) return res.text();
    if (res.status === 429 || res.status >= 500) {   // rate-limited / transient — back off
      const wait = Math.min(60000, 2000 * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error('Groq: gave up after retries (rate limit)');
}

/** Parse a chunk's VTT, offset every cue by `off` seconds, push into `cues`. */
function collectCues(vtt, off, cues) {
  for (const blk of String(vtt).split(/\r?\n\r?\n/)) {
    const m = blk.match(/([0-9:.]+)\s*-->\s*([0-9:.]+)([\s\S]*)/);
    if (!m) continue;
    const body = m[3].replace(/^\r?\n/, '').trim();
    if (body) cues.push(`${fmtTs(parseTs(m[1]) + off)} --> ${fmtTs(parseTs(m[2]) + off)}\n${body}`);
  }
}

const inProgress = new Set();
let queue = Promise.resolve();   // serialize: one movie at a time

/** Transcribe one Movies/<file> and upload Movies/<stem>.vtt. Safe/no-op if disabled. */
function queueMovie(fileName) {
  if (!ENABLED || !hasFfmpeg() || inProgress.has(fileName)) return;
  inProgress.add(fileName);
  queue = queue.then(() => transcribeOne(fileName)).catch(e => console.error(`  ✗  caption "${fileName}":`, e.message)).finally(() => inProgress.delete(fileName));
}

async function transcribeOne(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const url = `https://${R2_PUBLIC_DOMAIN}/Movies/${enc(fileName)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcap-'));
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
      const vtt = await groqVtt(path.join(tmp, chunks[i]));
      collectCues(vtt, i * CHUNK_SEC, cues);
    }
    if (!cues.length) { console.log(`  (no speech in "${fileName}", skipping)`); return; }
    const out = 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
    await s3().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: `Movies/${stem}.vtt`,
      Body: Buffer.from(out, 'utf-8'), ContentType: 'text/vtt; charset=utf-8' }));
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

module.exports = { ENABLED, hasFfmpeg, queueMissing, queueMovie, get inProgress() { return [...inProgress]; } };
