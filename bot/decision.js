'use strict';

/**
 * Red Portal — Deterministic Decision Engine
 * =============================================
 * Fully script-based replacement for ai-client.js. No LLM of any kind is
 * involved anywhere in this pipeline anymore -- every judgment call below is
 * plain, testable logic. Keeps the exact same function names/signatures as
 * the old ai-client.js so pipeline.js needed only its `require(...)` line
 * changed.
 *
 * Why this is safe to do here (unlike a general "is this a real game"
 * question, which really does need world knowledge): the pipeline's true
 * source of truth was never the AI's opinion -- it was always whether a
 * candidate URL could be found, reached, and shown to actually render the
 * specific game (see verifyPageContent below, and crawler.js's deterministic
 * truffled checks it reuses). The AI step was doing three narrower things
 * that are all expressible as plain rules:
 *   1. Reject obvious spam/gibberish requests.
 *   2. Reject requests that explicitly self-describe as non-browser-playable
 *      (Flash/VR/native-only), unless the requester explicitly claims a web
 *      port exists.
 *   3. Score/rank candidate URLs by name-match + reachability instead of
 *      "vibes".
 * A real "does an HTML5 version of X exist" question is answered empirically
 * by actually finding, reaching, and rendering a page -- which is exactly
 * what search.js + this file + crawler.js do, not by asking anyone to guess.
 */

const { isPortalUrl, EMBEDDABLE_GAME_DOMAINS, looksLikeAggregatorLabel, probeUrls } = require('./search');
const { isTruffledWrapperUrl } = require('./crawler');
const { nameSimilarity } = require('./text-match');

// ─────────────────────────────────────────────────────────────
//  STEP 1: Duplicate detection
// ─────────────────────────────────────────────────────────────

// Below this, two names are considered different games. Chosen so real
// abbreviations/typos/punctuation variants clear it (see text-match.js's
// own test cases) while genuinely different titles that merely share a
// word or two ("Mario Kart" vs "Mario Party") stay below it.
const DUPLICATE_THRESHOLD = 0.8;

/**
 * @returns {{ duplicate: boolean, matchedName: string|null }}
 */
function checkDuplicate(requestedName, existingNames) {
  if (!existingNames || existingNames.length === 0) {
    return { duplicate: false, matchedName: null };
  }

  let best = null;
  let bestScore = 0;
  for (const existing of existingNames) {
    const score = nameSimilarity(requestedName, existing);
    if (score > bestScore) {
      bestScore = score;
      best = existing;
    }
  }

  if (best && bestScore >= DUPLICATE_THRESHOLD) {
    return { duplicate: true, matchedName: best };
  }
  return { duplicate: false, matchedName: null };
}

// ─────────────────────────────────────────────────────────────
//  STEP 2: Validate the request
// ─────────────────────────────────────────────────────────────

/** Anything that isn't a plausible game title: empty, absurdly long, mostly
 *  punctuation/symbols, or degenerate repeated-character spam. */
function looksLikeGibberish(name) {
  const trimmed = (name || '').trim();
  if (trimmed.length < 2 || trimmed.length > 100) return true;

  const alnum = trimmed.replace(/[^a-z0-9]/gi, '');
  if (alnum.length === 0) return true;
  if (alnum.length / trimmed.length < 0.4) return true; // mostly symbols/spaces

  if (/^(.)\1{5,}$/i.test(alnum)) return true; // e.g. "aaaaaaaaaa"
  return false;
}

// Literal, keyword-detectable signals the request/notes themselves assert --
// these don't require guessing at a specific title's general reputation,
// just reading what the requester actually wrote.
const HARD_INCOMPATIBLE_MARKERS = [
  'flash game', 'flash-only', '.swf', 'shockwave',
  'vr only', 'vr-only', 'oculus only', 'requires vr', 'vr headset required',
  'requires steam', 'steam only', 'steam-only', 'requires launcher',
  'requires installation', 'requires install', '.exe only',
  'console only', 'console-exclusive', 'ps5 exclusive', 'ps4 exclusive',
  'xbox exclusive', 'switch exclusive',
];

const BROWSER_OVERRIDE_MARKERS = [
  'webport', 'web port', 'html5 version', 'html5 port', 'browser version',
  'browser port', 'fan port', 'web version', 'browser-playable',
];

/**
 * Explicit console/system mentions in the request name/notes -- deterministic
 * keyword detection ONLY, no guessing at what console an unlabeled title
 * "probably" is (that would need actual knowledge of the game, which a
 * text-matching check doesn't have -- see decision log: kept this pipeline
 * fully AI-free on purpose, so "Pokemon Red" with no console mentioned isn't
 * caught here and just falls through to the normal search-then-not-found
 * path like any other unrecognized title).
 *
 * Scoped to the systems Red Portal's own Emulation tab can actually run
 * (see ../../RedTesting/red-portal-DKR-LCL-main/assets/emulator/cores.json --
 * a separate deployable project, so this list is a hand-kept copy of those
 * same console names, not a shared import) -- a modern-platform mention
 * ("PS5 exclusive", "Xbox exclusive") is a DIFFERENT case already handled by
 * HARD_INCOMPATIBLE_MARKERS above (no realistic browser-emulation path
 * either way, ROM or not), not this one. Order matters: more specific
 * patterns are listed before the shorter ones they could otherwise be
 * masked by. Deliberately excludes very short/ambiguous abbreviations
 * ("GC" for GameCube, bare "arcade") that would false-positive too often
 * on ordinary game names/descriptions -- a miss here just falls through to
 * the existing "not found" path, same as an unlabeled request; a false
 * positive would incorrectly skip real search for a legitimate browser game,
 * which is the worse failure mode of the two.
 */
const CONSOLE_MARKERS = [
  { re: /\bnintendo entertainment system\b|\bfamicom\b|\bnes\b/i, console: 'NES' },
  { re: /\bsuper nintendo\b|\bsuper nes\b|\bsnes\b/i, console: 'SNES' },
  { re: /\bnintendo ?64\b|\bn64\b/i, console: 'N64' },
  { re: /\bgame ?boy advance\b|\bgba\b/i, console: 'GBA' },
  { re: /\bgame ?boy color\b|\bgbc\b/i, console: 'GBC' },
  { re: /\bgame ?boy\b/i, console: 'GB' },
  { re: /\bnintendo ds\b|\bnds\b/i, console: 'NDS' },
  { re: /\bplaystation ?1\b|\bps1\b|\bpsx\b/i, console: 'PSX' },
  { re: /\bplaystation portable\b|\bpsp\b/i, console: 'PSP' },
  { re: /\bsega genesis\b|\bmega ?drive\b/i, console: 'Genesis' },
  { re: /\bsega game ?gear\b|\bgame ?gear\b/i, console: 'GameGear' },
  { re: /\bsega ?cd\b/i, console: 'SegaCD' },
  { re: /\bsega ?32x\b|\b32x\b/i, console: 'Sega32X' },
  { re: /\bsega saturn\b/i, console: 'SegaSaturn' },
  { re: /\bsega master system\b/i, console: 'SegaMasterSystem' },
  { re: /\batari ?2600\b/i, console: 'Atari2600' },
  { re: /\batari ?5200\b/i, console: 'Atari5200' },
  { re: /\batari ?7800\b/i, console: 'Atari7800' },
  { re: /\batari jaguar\b/i, console: 'AtariJaguar' },
  { re: /\batari lynx\b/i, console: 'AtariLynx' },
  { re: /\bcolecovision\b/i, console: 'ColecoVision' },
  { re: /\bcommodore ?64\b|\bc64\b/i, console: 'Commodore64' },
  { re: /\bcommodore ?128\b|\bc128\b/i, console: 'Commodore128' },
  { re: /\bcommodore amiga\b|\bamiga\b/i, console: 'CommodoreAmiga' },
  { re: /\b3do\b/i, console: '3DO' },
  { re: /\bmame\b/i, console: 'MAME' },
  { re: /\bvirtual boy\b/i, console: 'VirtualBoy' },
  // Generic "this is a ROM/console game" mention with no specific system
  // named -- still worth flagging, just without a guessed console.
  { re: /\brom\b|\.rom\b|\bneeds an? emulator\b|\brequires an? emulator\b/i, console: null },
];

/** @returns {{ needsEmulation: boolean, guessedConsole: string|null }} */
function detectConsoleRequest(name, notes) {
  const combined = `${name} ${notes || ''}`;
  for (const marker of CONSOLE_MARKERS) {
    if (marker.re.test(combined)) {
      return { needsEmulation: true, guessedConsole: marker.console };
    }
  }
  return { needsEmulation: false, guessedConsole: null };
}

/**
 * @returns {{
 *   valid: boolean, reason: string, browserCompatible: boolean,
 *   needsEmulation: boolean, guessedConsole: string|null,
 *   popularity: number, searchTerms: string[], suggestedSites: string[]
 * }}
 */
function validateRequest(name, type, notes) {
  if (looksLikeGibberish(name)) {
    return {
      valid: false,
      reason: 'Request name does not look like a real game title (empty, too long, mostly symbols, or repeated-character spam).',
      browserCompatible: false, needsEmulation: false, guessedConsole: null,
      popularity: 0, searchTerms: [name], suggestedSites: [],
    };
  }

  const { needsEmulation, guessedConsole } = detectConsoleRequest(name, notes);
  if (needsEmulation) {
    return {
      valid: true,
      reason: guessedConsole
        ? `Request/notes explicitly mention ${guessedConsole} -- this needs a real ROM, not something to search/crawl for.`
        : 'Request/notes explicitly mention needing a ROM/emulator -- this needs a real ROM, not something to search/crawl for.',
      browserCompatible: false, needsEmulation: true, guessedConsole,
      popularity: 5, searchTerms: [name], suggestedSites: [],
    };
  }

  const combined = `${name} ${notes || ''}`.toLowerCase();
  const hasOverrideSignal = BROWSER_OVERRIDE_MARKERS.some(m => combined.includes(m));
  const hasHardBlocker = !hasOverrideSignal && HARD_INCOMPATIBLE_MARKERS.some(m => combined.includes(m));

  if (hasHardBlocker) {
    return {
      valid: true,
      reason: 'Request/notes explicitly mention a requirement (Flash/VR/native client/console-exclusive) known to be incompatible with a browser embed.',
      browserCompatible: false, needsEmulation: false, guessedConsole: null,
      popularity: 5, searchTerms: [name], suggestedSites: [],
    };
  }

  return {
    valid: true,
    reason: hasOverrideSignal
      ? 'Notes explicitly claim a browser-playable version exists -- trusting that and deferring to search/verification to confirm.'
      : 'No blocking signal found in the request -- deferring to search + page-content verification, which empirically confirms a real, browser-playable version rather than guessing.',
    browserCompatible: true, needsEmulation: false, guessedConsole: null,
    popularity: 5, searchTerms: [name], suggestedSites: [],
  };
}

// ─────────────────────────────────────────────────────────────
//  STEP 3: Pick the best game URL from search results
// ─────────────────────────────────────────────────────────────

// Below this, a name-match is considered coincidental rather than the
// actual requested game (see text-match.js's own test cases for calibration:
// "Mario Kart" vs "Mario Party" scores ~0.71, deliberately still excluded
// only when combined with the aggregator-label veto below; genuine typos
// and abbreviations clear 0.55 comfortably).
const MIN_NAME_SIMILARITY = 0.55;
const PROBE_CAP = 5; // cap how many candidates get network-probed per tier

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || u.hostname;
    return decodeURIComponent(last).replace(/\.(html?|php)$/i, '');
  } catch {
    return '';
  }
}

function firstPathSegment(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    return segs[0] || '';
  } catch {
    return '';
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** True if this URL is safe to even consider selecting as the final embed:
 *  not a known multi-game portal, and not structurally a hub/aggregator
 *  (checked against both the hostname and the first path segment, since
 *  plain web-search URLs have no repo-style curation to lean on the
 *  way GitHub results already do via filterGitHubResults). */
function isCandidateStructurallySafe(url, gameName) {
  if (isPortalUrl(url)) return false;
  if (looksLikeAggregatorLabel(hostnameOf(url), gameName)) return false;
  if (looksLikeAggregatorLabel(firstPathSegment(url), gameName)) return false;
  return true;
}

function isEmbeddableDomain(url) {
  const domain = hostnameOf(url).replace(/^www\./, '');
  if (!domain) return false;
  return EMBEDDABLE_GAME_DOMAINS.some(d => domain.includes(d));
}

async function firstLiveCandidate(urls) {
  if (!urls.length) return null;
  const probes = await probeUrls(urls.slice(0, PROBE_CAP));
  const live = probes.find(p => p.ok);
  return live ? live.url : null;
}

/**
 * @returns {{ found: boolean, url: string|null, confidence: number,
 *             strategy: 'iframe'|'none', reasoning: string }}
 */
async function findBestGameUrl(gameName, searchResults, extraProbes) {
  // Tier 1: truffled.lol catalog hits. search.js already matched these
  // against the site's own real catalog (not a web-search guess), but that
  // matching is still substring-based under the hood and can misfire on
  // short/numeric entries (a real bug hit in testing: a catalog game
  // literally named "1" matched a totally unrelated query that merely
  // contained the digit "1" somewhere). Re-score against the actual matched
  // catalog name -- not just trust "search.js found something" -- as
  // defense in depth on top of the length-guard fix in searchTruffledCatalog.
  const truffled = (searchResults.truffled || [])
    .filter(c => isCandidateStructurallySafe(c.url, gameName))
    .map(c => ({ ...c, score: nameSimilarity(gameName, c.name) }))
    .filter(c => c.score >= MIN_NAME_SIMILARITY)
    .sort((a, b) => b.score - a.score);

  if (truffled.length) {
    return {
      found: true, url: truffled[0].url, confidence: 95, strategy: 'iframe',
      reasoning: `Truffled.lol catalog match: "${truffled[0].name}" name-matches the requested game (authoritative site catalog lookup).`,
    };
  }

  // Tier 2: GitHub Pages. searchGitHub() always *constructs* the Pages URL
  // pattern (https://{owner}.github.io/{repo}/) regardless of whether Pages
  // was ever actually enabled/deployed for that repo -- so this must probe
  // it for real, not just trust the URL shape. filterGitHubResults() in
  // search.js already stripped obvious aggregator repos before this point.
  // This is the main fallback source now that gn-math.dev has been removed
  // (its "search" was a dead endpoint that always 404'd -- see search.js),
  // which is why searchGitHub() itself now tries a broader query too.
  const githubCandidates = (searchResults.github || [])
    .map(r => ({
      r,
      score: Math.max(
        nameSimilarity(gameName, (r.name || '').split('/').pop() || ''),
        nameSimilarity(gameName, r.description || ''),
      ),
    }))
    .filter(c => c.score >= MIN_NAME_SIMILARITY)
    .sort((a, b) => (b.score - a.score) || ((b.r.stars || 0) - (a.r.stars || 0)));

  if (githubCandidates.length) {
    const alive = await firstLiveCandidate(githubCandidates.map(c => c.r.pagesUrl));
    if (alive) {
      return {
        found: true, url: alive, confidence: 75, strategy: 'iframe',
        reasoning: 'GitHub Pages deployment name-matched to the requested game and verified live (not just constructed from the repo URL pattern).',
      };
    }
  }

  // Tier 3: web search (DDG), restricted to known clean single-game domains
  // (never a portal domain, even though search.js surfaces those too as
  // search signal) and name-matched against the URL's own slug.
  const webCandidates = (searchResults.webSearch || [])
    .filter(u => isCandidateStructurallySafe(u, gameName) && isEmbeddableDomain(u))
    .map(url => ({ url, score: nameSimilarity(gameName, slugFromUrl(url)) }))
    .filter(c => c.score >= MIN_NAME_SIMILARITY)
    .sort((a, b) => b.score - a.score);

  if (webCandidates.length) {
    const alive = await firstLiveCandidate(webCandidates.map(c => c.url));
    if (alive) {
      return {
        found: true, url: alive, confidence: 65, strategy: 'iframe',
        reasoning: 'Web search result on a known clean single-game domain, name-matched and verified live.',
      };
    }
  }

  // Tier 4: anything already probed externally. extraProbes is currently
  // always empty (nothing in the pipeline populates it) -- this stays as a
  // hook for a future manual/config-driven hint source, and costs nothing
  // to leave in place.
  const probedCandidates = (extraProbes || [])
    .filter(p => p.ok && isCandidateStructurallySafe(p.url, gameName))
    .map(p => ({ url: p.url, score: nameSimilarity(gameName, slugFromUrl(p.url)) }))
    .filter(c => c.score >= MIN_NAME_SIMILARITY)
    .sort((a, b) => b.score - a.score);

  if (probedCandidates.length) {
    return {
      found: true, url: probedCandidates[0].url, confidence: 60, strategy: 'iframe',
      reasoning: 'Externally probed URL, name-matched and already confirmed reachable.',
    };
  }

  return {
    found: false, url: null, confidence: 0, strategy: 'none',
    reasoning: 'No candidate across truffled.lol, GitHub Pages, or web search passed both the name-match and reachability checks.',
  };
}

// ─────────────────────────────────────────────────────────────
//  STEP 4: Verify the selected page's content is the real game
// ─────────────────────────────────────────────────────────────

/**
 * Render a URL with a real headless browser (JS execution) and return the
 * post-hydration HTML. Returns null if Playwright isn't installed or
 * rendering fails for any reason, so callers fall back gracefully.
 */
async function renderWithPlaywright(url) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    return null;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    // 'networkidle' never fires on truffled.lol (persistent background
    // connections keep the page from ever going idle) -- domcontentloaded
    // plus an explicit settle delay is what actually works here.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000); // extra settle time for lazy-mounted game iframes
    return await page.content();
  } catch (err) {
    console.warn(`[verify] Playwright render failed for ${url}: ${err.message}`);
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

// truffled's wrapper pages (iframe.html/unityframe.html) have a fixed,
// generic top-level document that never changes per-game -- the actual game
// loads inside a nested iframe, which never updates the parent document.
// These are the site's own copy for its homepage/marketing and 404 pages,
// used as deterministic negative markers (see crawler.js's copy of this
// same list, kept in sync).
const TRUFFLED_FALLBACK_TEXT = [
  'Welcome to Truffled', 'One secure place for all your learning',
  'Academic Subjects', 'Trusted by schools nationwide',
  'Page Not Found', 'page not found', "doesn't exist", 'does not exist',
  'could not be found',
];

function extractTruffledInnerPath(url) {
  try {
    return new URL(url).searchParams.get('url');
  } catch {
    return null;
  }
}

function stripTagsToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Multi-word phrases only (never a bare "404" or "not found" alone at full
// page scope) -- a single generic word/number can appear coincidentally in
// a real game's own bundled JS/text. The length-gated short-body check
// below is what makes the bare "404" case safe to include at all.
const ERROR_TITLE_MARKERS = [
  '404', 'page not found', 'not found', "doesn't exist", 'does not exist',
  'could not be found', 'oops! ', 'an error occurred',
];

function looksLikeErrorPage(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch ? titleMatch[1] : '').toLowerCase();
  if (title && ERROR_TITLE_MARKERS.some(m => title.includes(m))) return true;

  // Body-text markers are only trusted on SHORT pages -- dedicated error
  // pages are almost always brief; a long real game page innocently
  // containing "404" somewhere in its own text/JS must not be penalized.
  const text = stripTagsToText(html);
  if (text.length > 0 && text.length < 500) {
    const lower = text.toLowerCase();
    if (ERROR_TITLE_MARKERS.some(m => lower.includes(m))) return true;
  }
  return false;
}

/** A page listing many distinct /game(s)/ or /play/ links looks like a
 *  catalog/index rather than one dedicated game page. */
function looksLikeMultiGameIndex(html) {
  const hrefs = html.match(/href=["'][^"']*\/(?:games?|play)\/[^"']+["']/gi) || [];
  const unique = new Set(hrefs.map(h => h.toLowerCase()));
  return unique.size > 15;
}

/**
 * @returns {{ isRealGame: boolean, reason: string }}
 */
async function verifyPageContent(gameName, url, htmlSnippet) {
  // Hard rejection for known portal domains -- this URL should never have
  // reached this step given findBestGameUrl's own filtering, but reject
  // deterministically as a safety net regardless.
  if (isPortalUrl(url)) {
    return {
      isRealGame: false,
      reason: 'URL is on a known multi-game portal domain -- wraps games in navigation/ads and often blocks iframe embedding.',
    };
  }

  if (isTruffledWrapperUrl(url)) {
    console.log('[verify]   Truffled JS wrapper detected -- rendering with headless browser for accurate content check…');
    const rendered = await renderWithPlaywright(url);
    let effectiveHtml = rendered || htmlSnippet;
    if (!rendered) {
      console.warn('[verify]   Playwright render unavailable/failed -- falling back to plain-fetch snippet (pre-hydration shell, may be inconclusive).');
    }

    if (effectiveHtml) {
      const hasFallbackText = TRUFFLED_FALLBACK_TEXT.some(m => effectiveHtml.includes(m));
      if (hasFallbackText) {
        return { isRealGame: false, reason: 'Rendered truffled wrapper page shows fallback/not-found content.' };
      }

      const innerPath     = extractTruffledInnerPath(url);
      const hasInnerFrame = innerPath && effectiveHtml.includes(innerPath);
      if (hasInnerFrame) {
        console.log("[verify]   Deterministic truffled check passed (catalog match + inner game frame confirmed present).");
        return {
          isRealGame: true,
          reason: "Truffled catalog match confirmed: rendered wrapper page contains the specific game's inner frame, no fallback/404 markers present.",
        };
      }

      // No fallback markers, but couldn't confirm the inner frame either
      // (e.g. Playwright unavailable so we're stuck with the pre-hydration
      // snippet, which never contains the inner path). The catalog lookup
      // in search.js already matched this exact slug against truffled's own
      // authoritative games list -- that's real confirmation of identity,
      // just not of live page content. Trust it rather than blocking.
      return {
        isRealGame: true,
        reason: "Truffled catalog match already confirmed this slug maps to the requested game; no fallback/404 markers present (inner-frame confirmation unavailable this run).",
      };
    }

    return {
      isRealGame: true,
      reason: 'Truffled catalog match already confirmed identity; page content unavailable to double-check (transient fetch/render failure) -- proceeding on catalog authority.',
    };
  }

  if (!htmlSnippet || !htmlSnippet.trim()) {
    return { isRealGame: false, reason: 'Page returned empty content.' };
  }
  if (looksLikeErrorPage(htmlSnippet)) {
    return { isRealGame: false, reason: 'Page title/body matches a known not-found/error page pattern.' };
  }
  if (looksLikeMultiGameIndex(htmlSnippet)) {
    return { isRealGame: false, reason: 'Page looks like a multi-game listing/index rather than a dedicated single-game page.' };
  }

  return {
    isRealGame: true,
    reason: 'No error/fallback or multi-game-index markers detected; the URL already passed name-match, reachability, and non-portal checks upstream.',
  };
}

module.exports = { validateRequest, findBestGameUrl, verifyPageContent, checkDuplicate };
