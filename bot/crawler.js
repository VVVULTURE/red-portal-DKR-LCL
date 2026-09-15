'use strict';

/**
 * Red Portal — Game Asset Crawler
 * ================================
 * Two strategies, tried in order:
 *
 * 1. Playwright HAR capture (preferred)
 *    Launches a headless Chromium, navigates to the game, records every
 *    network request via HAR (identical to DevTools → Network → Export HAR),
 *    then extracts all responses into a local file map — the same output
 *    your manual HAR-extractor workflow produces.
 *    Requires: npm install playwright && npx playwright install chromium
 *
 * 2. Static HTML crawl (fallback)
 *    Regex-parses the HTML for src/href/url() references and downloads them.
 *    Misses dynamically loaded assets but requires no extra dependencies.
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const MAX_ASSETS      = 80;
const FETCH_TIMEOUT   = 15000;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
// Safety net for the Playwright/HAR crawl specifically (crawlGameStatic
// already enforces MAX_ASSETS as it goes; the HAR path extracts everything
// in one pass, so this caps it after the fact). A real bug hit in
// production: a truffled.lol page's related-games thumbnail carousel
// rendered ~700 blob: thumbnail images during the crawl's dwell time, all
// captured into the HAR and about to be written/synced to R2 as if they
// were part of the requested game. blob:/data: URLs are excluded outright
// below (they're ephemeral, page-session-local references, never real
// network assets worth self-hosting on ANY site) -- this cap is a second,
// independent line of defense against any other future capture-explosion
// cause we haven't seen yet.
const MAX_HAR_ASSETS  = 200;

const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'xml', 'webmanifest',
]);

/**
 * Defensively normalize every key in a crawled files map right before it's
 * used for GitHub/Vercel deployment. GitHub's Tree API rejects any path
 * starting with "/" (422 "tree.path cannot start with a slash"). Now that
 * the crawler navigates to multi-origin wrapper pages (e.g. truffled's
 * /unityframe.html, which embeds a nested iframe possibly from a different
 * origin/CDN), it's hard to guarantee every single captured request URL
 * produces a clean relative path upstream — so this is a final safety net
 * applied to the whole file map regardless of where each entry came from.
 */
function normalizeFileMapPaths(files) {
  const normalized = {};
  for (const [rawPath, data] of Object.entries(files)) {
    let p = rawPath.replace(/^\/+/, '').replace(/^\.\/+/, '');
    if (!p) p = 'index.html'; // guard against a path that normalizes to empty
    p = p.replace(/\/{2,}/g, '/'); // collapse any doubled slashes remaining mid-path
    normalized[p] = data;
  }
  return normalized;
}

function guessMime(localPath) {
  const ext = (localPath.split('.').pop() || '').toLowerCase();
  const map = {
    html: 'text/html', htm: 'text/html', css: 'text/css',
    js: 'application/javascript', mjs: 'application/javascript',
    json: 'application/json', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    wasm: 'application/wasm', data: 'application/octet-stream',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Convert a URL to a safe local file path.
 * Cross-origin assets are namespaced under their hostname so paths don't collide.
 */
// Characters illegal in Windows path segments (< > : " | ? * and control
// chars), plus trailing dots/spaces Windows also rejects. Real requests hit
// this: Cloudflare's cdn-cgi/challenge-platform script URLs embed a
// "<ray-id>:<timestamp>:<hash>" segment, which crashed mkdirSync on Windows
// (ENOENT) before this sanitization existed.
// Cap kept independent of MAX_ASSET_BYTES: this bounds a single PATH
// SEGMENT's length (Windows' ~260-char full-path limit), not file size.
// Some sites (Cloudflare Turnstile among them) embed a huge single-use
// token as the final URL segment; truncate with a short content hash
// suffix so different long segments don't collide once cut down.
const MAX_PATH_SEGMENT_LEN = 80;

function sanitizePathSegment(segment) {
  const cleaned = segment
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '') || '_';

  if (cleaned.length <= MAX_PATH_SEGMENT_LEN) return cleaned;
  const hash = crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 8);
  return `${cleaned.slice(0, MAX_PATH_SEGMENT_LEN - 9)}_${hash}`;
}

function urlToLocalPath(absoluteUrl, baseUrl) {
  try {
    const a = new URL(absoluteUrl);
    let p = a.pathname.replace(/^\/+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';

    const parts = p.split('/').reduce((acc, part) => {
      if (part === '..') acc.pop();
      else if (part && part !== '.') acc.push(sanitizePathSegment(decodeURIComponent(part)));
      return acc;
    }, []);

    // Extensionless paths (e.g. Next.js routes like /games/portal) need an
    // explicit index.html appended, otherwise the deployed static host has
    // no way to know what content-type to serve the file as.
    if (parts.length) {
      const last = parts[parts.length - 1];
      if (last && !last.includes('.')) {
        parts.push('index.html');
      }
    }

    // Cross-origin: prefix with sanitised hostname to avoid path collisions
    if (baseUrl) {
      try {
        const base = new URL(baseUrl);
        if (a.hostname !== base.hostname) {
          parts.unshift(a.hostname.replace(/[^a-z0-9]/gi, '_'));
        }
      } catch {}
    }

    return parts.length ? parts.join('/') : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite root-absolute asset references (src="/x", href="/x", url(/x),
 * fetch("/x"), etc.) in every captured text file so they still resolve
 * once the whole folder is hosted under a subpath — e.g.
 * Testing/Eggy-Car/ on assets.redportal.dpdns.org — instead of at the
 * origin's root like they did on the source site.
 *
 * Without this, a game whose own source references e.g. src="/js/panic.js"
 * loads fine from https://original-site.com/js/panic.js, but once
 * self-hosted at .../Testing/Eggy-Car/index.html the browser resolves
 * that same "/js/panic.js" against the R2 bucket ROOT
 * (https://assets.redportal.dpdns.org/js/panic.js) instead of
 * .../Testing/Eggy-Car/js/panic.js, 404ing even though we did capture
 * the file.
 *
 * Only rewrites a reference when the target path (leading slash
 * stripped, query/hash removed) matches a file we actually captured —
 * this avoids mangling unrelated absolute strings (API endpoints,
 * external URLs, arbitrary JS string literals) that happen to start
 * with "/" but aren't one of our local assets.
 */
function rewriteAbsolutePaths(files) {
  const knownPaths = new Set(Object.keys(files));

  for (const [filePath, data] of Object.entries(files)) {
    if (!data.isText) continue;
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;

    const text = data.bytes.toString('utf-8');
    const depth  = filePath.split('/').length - 1; // dirs deep from folder root
    const prefix = depth > 0 ? '../'.repeat(depth) : './';

    let changed = false;
    // Matches a root-absolute reference right after a quote or "(" —
    // covers src="/x", href='/x', and CSS url(/x) — but not "//host/x"
    // (protocol-relative URLs, which are legitimately absolute).
    const rewritten = text.replace(/(["'(])\/(?!\/)([^"')\s>]+)/g, (match, lead, rest) => {
      const candidate = rest.split(/[?#]/)[0];
      if (!knownPaths.has(candidate)) return match; // not one of our files — leave as-is
      changed = true;
      const suffix = rest.slice(candidate.length); // preserve any ?query#hash
      return `${lead}${prefix}${candidate}${suffix}`;
    });

    if (changed) {
      data.bytes = Buffer.from(rewritten, 'utf-8');
      console.log(`[crawler]   Rewrote absolute path reference(s) in ${filePath}`);
    }
  }

  return files;
}

/**
 * Remove the element with the given id, correctly handling nested tags of
 * the same type via a depth-aware scan -- a naive non-greedy regex would
 * stop at the FIRST inner </div>, truncating the element instead of
 * removing it whole. Returns html unchanged if the id isn't found.
 */
function removeElementById(html, id) {
  const openTagRe = new RegExp(`<div\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const match = openTagRe.exec(html);
  if (!match) return html;

  const start = match.index;
  const tagRe = /<div\b[^>]*>|<\/div\s*>/gi;
  tagRe.lastIndex = start + match[0].length;
  let depth = 1;

  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].toLowerCase().startsWith('</div')) depth--;
    else depth++;
    if (depth === 0) {
      const end = m.index + m[0].length;
      return html.slice(0, start) + html.slice(end);
    }
  }
  return html; // unbalanced -- leave untouched rather than risk truncating
}

/**
 * Strip third-party ad-injection scaffolding and analytics boilerplate that
 * the "Ultimate Game Stash"-style templates (the shared file family used
 * across truffled.lol and similar sites -- confirmed by the "Ultimate Game
 * Stash" comment header these files carry) bundle alongside the actual
 * game. None of this is part of the game itself: statically decoding one of
 * these files' obfuscated inline script (pure string-table decoding, no
 * execution against any live site) showed its entire purpose is
 * `document.createElement('script')` for a THIRD-PARTY ad loader at
 * `cdn.r9x.in/ailogic_<site>_obf.js` (the site name is baked into the
 * filename per-source), appended to <body>. Left in place, a self-hosted
 * copy would either silently reference a script hardcoded to the ORIGINAL
 * site's own ad account, or -- worse -- successfully load unrelated
 * third-party ad/tracking code inside Red Portal's own embed. Either way
 * it has nothing to do with whether the game works, so it's removed rather
 * than left as dead weight or a stray third-party call.
 */
function stripAdInjectionScaffolding(files) {
  for (const [filePath, data] of Object.entries(files)) {
    if (!data.isText) continue;
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    if (ext !== 'html' && ext !== 'htm') continue;

    let html = data.bytes.toString('utf-8');
    const before = html;

    // Floating sidebar ad-slot containers from the shared template.
    for (const id of ['sidebarad1', 'sidebarad2']) {
      html = removeElementById(html, id);
    }

    // The ad-loader's own inline <script> block (no src attribute --
    // excluded via the negative lookahead so real script-tag references,
    // e.g. the Unity loader, are never touched), identified by the one
    // narrowly-specific signature confirmed via the static decode above.
    html = html.replace(
      /<script(?![^>]*\bsrc=)[^>]*>(?:(?!<\/script>)[\s\S])*?cdn\.r9x\.in(?:(?!<\/script>)[\s\S])*?<\/script>/gi,
      ''
    );

    // Google Tag Manager boilerplate: the async loader tag plus its
    // immediately-following inline init block. Pure analytics, reporting to
    // an ID that's meaningless once self-hosted on a different domain.
    html = html.replace(
      /<script[^>]*\bsrc=["']https:\/\/www\.googletagmanager\.com\/gtag\/js[^"']*["'][^>]*><\/script>\s*<script>(?:(?!<\/script>)[\s\S])*?gtag\(['"]config['"][\s\S]*?<\/script>/gi,
      ''
    );

    if (html !== before) {
      data.bytes = Buffer.from(html, 'utf-8');
      console.log(`[crawler]   Stripped ad-injection/analytics scaffolding from ${filePath}`);
    }
  }
  return files;
}

// ── Strategy 1: Playwright HAR capture ───────────────────────────────────────

/**
 * Launch headless Chromium, record a HAR of all network requests while the
 * game loads, then extract every response into a { localPath → fileData } map.
 *
 * This is the programmatic version of:
 *   1. Open DevTools → Network tab
 *   2. Navigate to the game URL
 *   3. Export HAR
 *   4. Run the HAR extractor
 */
/** Detect truffled.lol's iframe/unityframe wrapper pages. */
function isTruffledWrapperUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'truffled.lol' &&
      (u.pathname === '/iframe.html' || u.pathname === '/unityframe.html');
  } catch {
    return false;
  }
}

/**
 * Cheap, dependency-free resolution of a truffled.lol "iframe.html?url=…"
 * wrapper down to the actual game URL, by reading the wrapper's own ?url=
 * query parameter directly — no headless browser needed.
 *
 * This is ONLY used as a fallback when Playwright isn't available (see
 * resolveTruffledEntry's comment for why the Playwright path is preferred:
 * some games check window.top/referrer and only work when genuinely
 * embedded in truffled's own page, which a direct fetch of this resolved
 * URL doesn't replicate). But crawling *something* closer to the real
 * game is still far better than statically fetching the wrapper page
 * itself, which — without JS execution — just captures truffled's own
 * site chrome (nav bar, fullscreen/mute buttons) instead of the game.
 *
 * Doesn't apply to unityframe.html, whose target isn't reliably a simple
 * query param.
 *
 * @returns {string|null}
 */
function resolveTruffledInnerGameUrlFromQuery(wrapperUrl) {
  try {
    const u = new URL(wrapperUrl);
    if (u.hostname !== 'truffled.lol' || u.pathname !== '/iframe.html') return null;
    const inner = u.searchParams.get('url');
    if (!inner) return null;
    return new URL(inner, u.origin).href;
  } catch {
    return null;
  }
}

/**
 * Navigate to a truffled wrapper page and find the ACTUAL game URL the
 * nested iframe loads — e.g. resolving
 * "truffled.lol/unityframe.html?url=..." down to the real game host, which
 * is often a completely different origin (fan ports are frequently hosted
 * on the porter's own site, e.g. reeyuki.nekoweb.org / wasm.rip).
 *
 * Crawling the wrapper directly captures truffled's own site chrome/JS/CSS
 * mixed in with the actual game's files under one flat directory — this
 * resolves to the real origin first so the subsequent full crawl only
 * captures that game's own clean asset set, exactly like the manual
 * DevTools → capture HAR → extract workflow this replicates.
 *
 * @returns {string|null} The resolved inner game URL, or null if it
 *   couldn't be determined (caller should fall back to crawling the
 *   wrapper directly in that case).
 */
async function resolveTruffledInnerGameUrl(wrapperUrl) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    return null;
  }

  const tag = '[crawler/resolve]';
  let browser;
  try {
    console.log(`${tag} Resolving actual game URL behind wrapper…`);
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    // 'networkidle' never fires on truffled.lol — the site keeps background
    // connections open (ads/analytics) so the page never goes idle, which
    // was causing this to hard-timeout on every single request. DOM-ready
    // plus an explicit settle delay is enough for the nested iframe to mount.
    await page.goto(wrapperUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500); // let the nested iframe finish mounting

    const frames = page.frames();
    const child = frames.find(f => f !== page.mainFrame() && f.url() && f.url() !== 'about:blank');

    if (child) {
      console.log(`${tag} Resolved: ${child.url()}`);
      return child.url();
    }
    console.warn(`${tag} No nested game frame found — will crawl the wrapper page directly instead.`);
    return null;
  } catch (err) {
    console.warn(`${tag} Resolution failed: ${err.message} — will crawl the wrapper page directly instead.`);
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

async function crawlGameViaPlaywright(gameUrl) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.warn('[crawler] playwright not installed — falling back to static crawl.');
    console.warn('[crawler] To enable HAR capture: npm install playwright && npx playwright install chromium');
    return null;
  }

  // If this is a truffled wrapper, resolve to the actual game URL first so
  // the crawl below captures only that game's own files — not truffled's
  // site chrome mixed in with it.
  let entryUrl = gameUrl;
  if (isTruffledWrapperUrl(gameUrl)) {
    const resolved = await resolveTruffledInnerGameUrl(gameUrl);
    if (resolved) entryUrl = resolved;
  }

  const harPath = path.join(os.tmpdir(), `redportal-${Date.now()}.har`);
  const tag = '[crawler/playwright]';
  let browser;

  try {
    console.log(`${tag} Launching headless Chromium…`);
    browser = await playwright.chromium.launch({ headless: true });

    const context = await browser.newContext({
      recordHar: { path: harPath, urlFilter: /.+/ },
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    console.log(`${tag} Navigating to ${entryUrl}…`);
    // Same reasoning as resolveTruffledInnerGameUrl() above -- 'networkidle'
    // reliably times out on truffled.lol. domcontentloaded + the dwell time
    // below is enough for lazily-loaded game assets to show up in the HAR.
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Extra dwell time for deferred/lazy-loaded game assets
    await page.waitForTimeout(4000);

    await context.close(); // flushing the HAR file happens on context close

    console.log(`${tag} HAR captured — extracting files…`);
    const har = JSON.parse(fs.readFileSync(harPath, 'utf-8'));
    const files = {};

    for (const entry of har.log.entries) {
      const url    = entry.request.url;
      const res    = entry.response;

      if (!res || res.status < 200 || res.status >= 400) continue;
      if (!res.content || !res.content.text) continue;
      // Cloudflare bot-check scaffolding (injected on ANY site sitting behind
      // Cloudflare, regardless of hostname) — never part of the actual game,
      // and its Turnstile token URLs embed a huge single-use challenge
      // token as the final path segment (1000+ chars), which blows past
      // Windows' ~260-char path limit and crashes the local file write.
      if (url.includes('/cdn-cgi/challenge-platform') || url.includes('challenges.cloudflare.com')) continue;

      // blob:/data: URLs are ephemeral, page-session-local object references
      // (e.g. URL.createObjectURL() output for a canvas-rendered thumbnail)
      // -- never a real network resource, and re-fetching/self-hosting one
      // is meaningless even when it does belong to the actual requested
      // game. Also guards against urlToLocalPath mis-parsing a blob: URL's
      // opaque body as if it were a real hostname/path (see MAX_HAR_ASSETS
      // comment above for what that produced in practice).
      if (url.startsWith('blob:') || url.startsWith('data:')) continue;

      const localPath = urlToLocalPath(url, entryUrl);
      if (!localPath || files[localPath]) continue;

      const isBase64 = res.content.encoding === 'base64';
      const bytes    = isBase64
        ? Buffer.from(res.content.text, 'base64')
        : Buffer.from(res.content.text, 'utf-8');

      if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) continue;

      const ext     = (localPath.split('.').pop() || '').toLowerCase();
      const isText  = TEXT_EXTENSIONS.has(ext);
      const mimeType = (res.content.mimeType || guessMime(localPath)).split(';')[0];

      files[localPath] = { bytes, isText, mimeType };

      // Hard cap, independent of the blob:/data: exclusion above -- a real
      // game's own legitimate asset count should never realistically
      // approach this. Stop accumulating rather than silently writing/
      // syncing hundreds of files; the entry document + everything captured
      // so far is still kept, just nothing further.
      if (Object.keys(files).length >= MAX_HAR_ASSETS) {
        console.warn(`${tag} Hit MAX_HAR_ASSETS (${MAX_HAR_ASSETS}) — stopping extraction early. Remaining HAR entries were NOT captured.`);
        break;
      }
    }

    const entryLocalPath = urlToLocalPath(entryUrl, entryUrl) || 'index.html';

    // If the entry point isn't at index.html, add a root wrapper that frames it
    if (entryLocalPath !== 'index.html' && files[entryLocalPath]) {
      const wrapper = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Game</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="${entryLocalPath}" allowfullscreen allow="fullscreen; autoplay; gamepad"></iframe>
</body>
</html>`;
      files['index.html'] = { bytes: Buffer.from(wrapper, 'utf-8'), isText: true, mimeType: 'text/html' };
    }

    const count = Object.keys(files).length;
    console.log(`${tag} Done — ${count} file(s) extracted from HAR.`);

    const normalizedFiles = normalizeFileMapPaths(files);
    return count > 0 ? { files: normalizedFiles, entryLocalPath } : null;

  } catch (err) {
    console.error(`${tag} Failed: ${err.message}`);
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    try { fs.unlinkSync(harPath); } catch {}
  }
}

// ── Strategy 2: Static HTML crawl (fallback) ─────────────────────────────────

async function safeFetchBinary(url, timeoutMs = FETCH_TIMEOUT) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ASSET_BYTES) return null;
    return { ok: true, bytes: buf, contentType };
  } catch {
    return null;
  }
}

function resolveUrl(maybeRelative, base) {
  try { return new URL(maybeRelative, base).href; } catch { return null; }
}

// Same-origin only for the static crawl (we can't efficiently fetch CDN URLs)
function toLocalPathSameOrigin(assetUrl, entryUrl) {
  try {
    const a = new URL(assetUrl);
    const e = new URL(entryUrl);
    if (a.origin !== e.origin) return null;

    let p = a.pathname.replace(/^\/+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';

    const parts = p.split('/').reduce((acc, part) => {
      if (part === '..') acc.pop();
      else if (part && part !== '.') acc.push(sanitizePathSegment(part));
      return acc;
    }, []);

    if (parts.length) {
      const last = parts[parts.length - 1];
      if (last && !last.includes('.')) parts.push('index.html');
    }

    return parts.length ? parts.join('/') : null;
  } catch { return null; }
}

function extractUrls(content, baseUrl, originHostname) {
  const urls = new Set();
  const patterns = [
    /(?:src|data-src)\s*=\s*["']([^"']+)["']/gi,
    /href\s*=\s*["']([^"'#?]+\.(?:css|js|woff2?|ttf|eot|ico|svg|png|jpe?g|gif|webp|mp3|ogg|wav|mp4|webm))["']/gi,
    /url\s*\(\s*["']?([^"')]+?)["']?\s*\)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('javascript:')) continue;
      try {
        const abs = new URL(raw, baseUrl).href;
        if (new URL(abs).hostname === originHostname) urls.add(abs);
      } catch {}
    }
  }
  return [...urls];
}

async function crawlGameStatic(entryUrl) {
  const tag = '[crawler/static]';
  const origin = new URL(entryUrl).origin;
  const hostname = new URL(entryUrl).hostname;

  const entryRes = await safeFetchBinary(entryUrl);
  if (!entryRes) return null;

  const entryHtml = entryRes.bytes.toString('utf-8');

  // Truffled's /games/{slug} pages are legitimately rendered by Next.js, so
  // generic Next.js markers (__NEXT_DATA__, /_next/, etc.) appear on BOTH
  // real game pages and fallback pages — they can't be used to tell them
  // apart. Detect fallbacks by their actual copy instead (homepage marketing
  // text or the dedicated 404 "Page Not Found" page), matching search.js.
  const TRUFFLED_FALLBACK_TEXT = [
    'Welcome to Truffled', 'One secure place for all your learning',
    'Academic Subjects', 'Trusted by schools nationwide',
    'Page Not Found', 'page not found', "doesn't exist", 'does not exist',
    'could not be found',
  ];
  if (entryUrl.includes('truffled.lol') &&
      TRUFFLED_FALLBACK_TEXT.some(m => entryHtml.includes(m))) {
    console.warn(`${tag} Entry page is a truffled fallback/404 page — not a real game file.`);
    return null;
  }

  const entryLocalPath = toLocalPathSameOrigin(entryUrl, entryUrl) || 'index.html';
  const files = {};
  files[entryLocalPath] = {
    bytes: entryRes.bytes, isText: true,
    mimeType: (entryRes.contentType.split(';')[0]) || 'text/html',
  };

  const queued   = new Set([entryUrl]);
  const toFetch  = extractUrls(entryHtml, entryUrl, hostname);

  while (toFetch.length && Object.keys(files).length < MAX_ASSETS) {
    const url = toFetch.shift();
    if (!url || queued.has(url)) continue;
    queued.add(url);

    const localPath = toLocalPathSameOrigin(url, entryUrl);
    if (!localPath || files[localPath]) continue;

    const res = await safeFetchBinary(url);
    if (!res) continue;

    const ext    = (localPath.split('.').pop() || '').toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext);
    files[localPath] = {
      bytes: res.bytes, isText,
      mimeType: res.contentType.split(';')[0] || guessMime(localPath),
    };

    if (ext === 'css') {
      const subUrls = extractUrls(res.bytes.toString('utf-8'), url, hostname);
      subUrls.forEach(u => { if (!queued.has(u)) toFetch.push(u); });
    } else if (ext === 'js' || ext === 'mjs') {
      const re = /["'`]([./][^"'`\s]+\.(?:png|jpe?g|gif|webp|svg|mp3|ogg|wav|json|wasm|data|woff2?|ttf))["'`]/gi;
      let mm;
      while ((mm = re.exec(res.bytes.toString('utf-8'))) !== null) {
        const abs = resolveUrl(mm[1].trim(), url);
        if (abs && !queued.has(abs)) toFetch.push(abs);
      }
    }
  }

  // Add root index.html wrapper if entry point isn't already at root
  if (entryLocalPath !== 'index.html') {
    const wrapper = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Game</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="${entryLocalPath}" allowfullscreen allow="fullscreen; autoplay; gamepad"></iframe>
</body>
</html>`;
    files['index.html'] = { bytes: Buffer.from(wrapper, 'utf-8'), isText: true, mimeType: 'text/html' };
  }

  console.log(`${tag} Done — ${Object.keys(files).length} file(s).`);
  return { files: normalizeFileMapPaths(files), entryLocalPath };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Crawl a game URL and return all its files.
 * Tries Playwright HAR capture first, falls back to static HTML parsing.
 *
 * @param {string} gameUrl  Direct game page URL (not a wrapper/iframe URL).
 * @returns {Promise<{files: Object, entryLocalPath: string} | null>}
 */
/** Minimal fullscreen iframe wrapper -- no chrome, no buttons, just the game. */
function buildBareIframeWrapper(srcLocalPath) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Game</title>
  <style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#000}iframe{position:fixed;inset:0;width:100%;height:100%;border:none}</style>
</head>
<body>
  <iframe src="${srcLocalPath}" allowfullscreen allow="fullscreen; autoplay; gamepad"></iframe>
</body>
</html>`;
}

/** Local path a same-origin truffled.lol URL would be crawled to -- mirrors
    the plain (non-cross-origin) branch of urlToLocalPath/toLocalPathSameOrigin. */
function simpleSameOriginLocalPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/^\/+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    return p;
  } catch {
    return null;
  }
}

async function crawlGame(gameUrl) {
  console.log(`[crawler] Crawling: ${gameUrl}`);

  // Try HAR capture via Playwright (gets dynamic assets too, and is the
  // ONLY reliable way to capture a truffled.lol wrapper correctly — see
  // resolveTruffledEntry's comment for why).
  const playwrightResult = await crawlGameViaPlaywright(gameUrl);
  let result = playwrightResult;

  if (!result) {
    // Playwright unavailable/failed. Statically fetching a truffled.lol
    // iframe.html wrapper as-is (no JS execution) would just capture
    // truffled's own site chrome instead of the actual game -- so resolve
    // straight to the real game URL via the wrapper's own ?url= query
    // param first, if this is that kind of wrapper. Not as reliable as
    // the Playwright path for the handful of games that check
    // window.top/referrer, but far better than always capturing the
    // wrong content.
    const queryResolved = resolveTruffledInnerGameUrlFromQuery(gameUrl);
    const entryUrl = queryResolved || gameUrl;
    if (queryResolved) {
      console.log(`[crawler] Playwright unavailable — resolved wrapper via query param → ${queryResolved}`);
    }
    result = await crawlGameStatic(entryUrl);
  }

  if (result && result.files) {
    // Fix up any root-absolute asset references so the game still works
    // once hosted under Testing/<name>/ instead of at a domain root.
    result.files = rewriteAbsolutePaths(result.files);

    // Strip third-party ad-injection/analytics scaffolding bundled alongside
    // the actual game by the shared template these files come from.
    result.files = stripAdInjectionScaffolding(result.files);

    // truffled.lol's iframe.html is itself a wrapper with its own site chrome
    // (mute/music buttons, sidebar, fullscreen/share/download toolbar) around
    // a NESTED iframe that loads the real game. Playwright's HAR capture
    // records that inner navigation too, so the real game's own HTML file
    // (e.g. gamefile/eggycar.html) is very likely already sitting in
    // result.files right alongside truffled's wrapper markup -- we just
    // need to point the entry at THAT instead of at iframe.html itself, or
    // the self-hosted copy shows truffled's UI around the game (exactly
    // what a plain crawl of iframe.html captures, chrome and all). This
    // mirrors the manual workflow: pick the real game's HTML out of the
    // HAR, not whatever page was originally navigated to.
    if (isTruffledWrapperUrl(gameUrl)) {
      const wrapperLocalPath = simpleSameOriginLocalPath(gameUrl);
      const stillOnWrapper = result.entryLocalPath === wrapperLocalPath;
      if (stillOnWrapper) {
        const innerUrl = resolveTruffledInnerGameUrlFromQuery(gameUrl);
        const innerLocalPath = innerUrl && simpleSameOriginLocalPath(innerUrl);
        if (innerLocalPath && result.files[innerLocalPath]) {
          console.log(`[crawler]   Re-pointing entry to the real game file, not truffled's wrapper chrome: ${innerLocalPath}`);
          result.entryLocalPath = innerLocalPath;
          result.files['index.html'] = {
            bytes: Buffer.from(buildBareIframeWrapper(innerLocalPath), 'utf-8'),
            isText: true,
            mimeType: 'text/html',
          };
        } else if (innerLocalPath) {
          console.warn(`[crawler]   ⚠  Expected real game file "${innerLocalPath}" wasn't captured — keeping truffled's wrapper as the entry point (game may show truffled's UI around it).`);
        }
      }
    }

    // Safety net: both crawl strategies already add an index.html wrapper
    // whenever their own entryLocalPath isn't literally "index.html" --
    // but just in case something upstream ever changes that, guarantee an
    // entry point always exists so a game never needs a manual rename.
    if (!result.files['index.html'] && result.entryLocalPath && result.files[result.entryLocalPath]) {
      console.warn(`[crawler]   No index.html in the crawl output — adding one that iframes the actual entry point (${result.entryLocalPath}).`);
      result.files['index.html'] = {
        bytes: Buffer.from(buildBareIframeWrapper(result.entryLocalPath), 'utf-8'),
        isText: true,
        mimeType: 'text/html',
      };
    }
  }
  return result;
}

function needsSelfHost(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'truffled.lol' || host.endsWith('.truffled.lol');
  } catch { return false; }
}

function resolveTruffledEntry(url) {
  // Previously this unwrapped /iframe.html?url=X down to the raw X URL and
  // crawled that directly. Testing showed the raw direct URL often doesn't
  // load correctly on its own (truffled's games appear to require being
  // loaded inside the site's own iframe context — likely a referrer or
  // window.top check). The /iframe.html wrapper is truffled's own verified
  // real-world delivery mechanism, so we now crawl it as-is: Playwright's
  // HAR capture records all requests including the nested iframe's, so the
  // embedded game's assets still get captured correctly.
  return url;
}

module.exports = {
  crawlGame, needsSelfHost, resolveTruffledEntry,
  isTruffledWrapperUrl, resolveTruffledInnerGameUrlFromQuery,
  stripAdInjectionScaffolding,
};
