'use strict';

/**
 * Red Portal — Search Module
 * ===========================
 * Searches multiple sources to find a browser-playable URL for a requested game.
 *
 * Sources (all run in parallel):
 *   1. truffled.lol   — direct gamefile slug probing (most reliable for hosted games)
 *   2. GitHub         — repo search filtered to remove aggregators (two passes —
 *                        see searchGitHub in github.js — since this is now the
 *                        main fallback source)
 *   3. DuckDuckGo     — web search across trusted game hosting domains
 *
 * gn-math.dev used to be a source here too, but it never actually had a
 * working search endpoint (confirmed live: gn-math.dev/search always 404s),
 * so that "tier" was silently just re-scraping gn-math's homepage link list
 * on every single request regardless of the game name — removed entirely
 * rather than keep pretending it searches anything. GitHub gets leaned on
 * harder to compensate (see github.js).
 */

const { searchGitHub } = require('./github');

/* ── HTTP helper ──────────────────────────────────────────────────────────── */

async function safeFetch(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, {
      signal:  AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/* ── truffled.lol ─────────────────────────────────────────────────────────── */

// truffled.lol's search box does an instant client-side lookup with no
// per-keystroke network calls, because the entire games catalog is fetched
// ONCE as a single JSON file (confirmed via HAR capture) and matched locally.
// We use that same authoritative catalog instead of guessing URL slugs or
// hoping a game happens to be indexed by a search engine — this is exactly
// the data source the site's own search feature reads from, so it will
// always be accurate for whatever games truffled actually has.
const TRUFFLED_GAMES_JSON_URL = 'https://truffled.lol/js/json/g.json';

let truffledGamesCache      = null;  // { games: [...] } once fetched
let truffledGamesCacheAtMs  = 0;
const TRUFFLED_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes — catalog rarely changes mid-session

/** Fetch (and cache) truffled's full games catalog. */
async function fetchTruffledCatalog() {
  const now = Date.now();
  if (truffledGamesCache && (now - truffledGamesCacheAtMs) < TRUFFLED_CACHE_TTL_MS) {
    return truffledGamesCache;
  }

  const raw = await safeFetch(TRUFFLED_GAMES_JSON_URL, 10000);
  if (!raw) {
    console.warn('[search]   Could not fetch truffled catalog (g.json) — truffled unavailable this run.');
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.games)) throw new Error('Unexpected g.json shape');
    truffledGamesCache     = parsed;
    truffledGamesCacheAtMs = now;
    console.log(`[search]   Truffled catalog loaded: ${parsed.games.length} games (cached ${TRUFFLED_CACHE_TTL_MS / 60000}min)`);
    return parsed;
  } catch (err) {
    console.warn(`[search]   Could not parse truffled catalog: ${err.message}`);
    return null;
  }
}

/** Normalize a name for loose matching: lowercase, strip punctuation/spacing. */
function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Search truffled's authoritative catalog for games matching gameName.
 * Matches against both `name` and `altNames`, using normalized substring
 * matching in both directions (handles "FNF" matching "Friday Night Funkin"
 * style abbreviations via altNames, and partial/extra-word queries).
 *
 * @returns {Array<{ name, url, matchedField }>} candidate games, best-ish first
 */
async function searchTruffledCatalog(gameName) {
  const catalog = await fetchTruffledCatalog();
  if (!catalog) return [];

  const query = normalizeForMatch(gameName);
  if (!query) return [];

  const matches = [];
  for (const game of catalog.games) {
    const candidates = [game.name, ...(game.altNames || [])];
    for (const candidate of candidates) {
      const norm = normalizeForMatch(candidate);
      if (!norm) continue;
      if (norm === query) {
        matches.push({ ...game, matchedField: candidate, exact: true });
        break;
      }
      // Substring containment, but ONLY when the shorter side is at least 3
      // chars -- otherwise a catalog entry literally named "1" or "-3"
      // (real truffled entries) "matches" via substring against ANY query
      // that happens to contain that single digit anywhere, e.g. a name
      // ending in a year or a numbered sequel. Real bug hit in testing:
      // "Zzxqplorp Nonexistent Game 12345" matched catalog entry "1" purely
      // because "12345" contains the digit "1".
      const shorterLen = Math.min(norm.length, query.length);
      if (shorterLen >= 3 && (norm.includes(query) || query.includes(norm))) {
        matches.push({ ...game, matchedField: candidate, exact: false });
        break;
      }
    }
  }

  // Exact matches first, then by name length (shorter = more likely the base
  // game rather than a specific mod/variant, e.g. prefer "FNF" over
  // "Friday Night Funkin Garcello" when the query is just "friday night funkin")
  matches.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return a.name.length - b.name.length;
  });

  return matches;
}

/**
 * Build the final playable URL for a catalog game entry, replicating the
 * exact logic truffled's own frontend uses (getGameDestination in their
 * search.js) so the URL we produce is guaranteed to work the same way it
 * does for a real visitor clicking the search result.
 */
function buildTruffledGameUrl(game) {
  const path = game.url.startsWith('/') ? game.url : `/${game.url}`;
  // NOTE: we deliberately do NOT unwrap this to the raw file path — see
  // resolveTruffledEntry() in crawler.js for why the iframe wrapper is used
  // as the actual crawl entry point instead of the raw game file URL.
  const frameType = game.frameType === 'unity' ? '/unityframe.html' : '/iframe.html';
  return `https://truffled.lol${frameType}?url=${encodeURIComponent(path)}`;
}

async function searchTruffled(gameName) {
  const matches = await searchTruffledCatalog(gameName);

  if (matches.length === 0) {
    console.log(`[search]   Truffled: no catalog matches for "${gameName}"`);
    return [];
  }

  const top = matches.slice(0, 3);
  for (const m of top) {
    console.log(`[search]   Truffled catalog HIT: "${m.name}" (matched via "${m.matchedField}") → ${m.url}`);
  }

  // Return the matched catalog name alongside the URL (not just a bare URL
  // string) so callers can independently re-verify the match quality rather
  // than being forced to trust this function's own matching unconditionally.
  return top.map(m => ({ url: buildTruffledGameUrl(m), name: m.name, matchedField: m.matchedField, exact: m.exact }));
}

/* ── GitHub aggregator filter ─────────────────────────────────────────────── */

// Patterns that indicate a repo is a collection/aggregator rather than a
// specific game. Filtered out before a repo is ever considered as a candidate.
const AGGREGATOR_PATTERNS = [
  /^games?[-_ ]/,                  // starts with "game(s)-"
  /[-_ ]games?$/,                  // ends with "-game(s)"
  /[-_ ]games?[-_ ]/,              // "games" in the middle with separators
  /^awesome[-_ ]/,                 // curated lists ("awesome-*")
  /\bcollection\b/,
  /\bhub\b/,
  /\bportal\b/,                    // "portal" as a concept (not the game "Portal" itself)
  /\barcade\b/,                    // multi-game arcade sites
  /\bplatform\b/,
  /\blist\b/,
  /\bcatalog\b/,
  /\bshowcase\b/,
  /\bcompilation\b/,
  /\bmulti[-_ ]?game/,
  /\bhtml5[-_ ]?games\b/,
  /\bbrowser[-_ ]?games\b/,
  /\bweb[-_ ]?games\b/,
  /\bmini[-_ ]?games\b/,
];

/**
 * True if `label` (a repo name, URL path segment, hostname, etc.) reads like
 * a games-collection/hub/aggregator identifier rather than one specific game
 * title — UNLESS `label` (punctuation-insensitive) exactly equals `gameName`
 * itself, since a game genuinely titled e.g. "Portal" or "Arcade" must not
 * be rejected just because its own name happens to match one of these
 * generic words. This is deliberately generic (not GitHub-specific) so it
 * can also veto coincidental hub-word matches in plain web-search URLs,
 * which have no repo-style curation to rely on.
 */
function looksLikeAggregatorLabel(label, gameName) {
  const clean = (label || '').toLowerCase().replace(/[-_]/g, ' ');
  const gameNorm  = (gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const labelNorm = (label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (labelNorm && labelNorm === gameNorm) return false;

  return AGGREGATOR_PATTERNS.some(re => re.test(clean));
}

function filterGitHubResults(repos, gameName) {
  return repos.filter(r => {
    if (looksLikeAggregatorLabel(r.name, gameName) || looksLikeAggregatorLabel(r.description, gameName)) {
      console.log(`[search]   GitHub: filtered aggregator "${r.name}"`);
      return false;
    }
    return true;
  });
}

/* ── DuckDuckGo web search ────────────────────────────────────────────────── */

// Domains with clean, single-game pages that embed reliably via iframe —
// no surrounding portal navigation, and no history of blocking framing.
const EMBEDDABLE_GAME_DOMAINS = [
  'github.io',
  'itch.io',
  'newgrounds.com',
  'truffled.lol',
];

// Large multi-game portal/aggregator sites. Even when a specific game genuinely
// exists on one of these, the page is wrapped in the portal's own navigation,
// sidebars of unrelated games, ads, etc. — and many of them send
// X-Frame-Options/CSP headers that block embedding entirely, producing a
// blank/broken iframe. These are still useful as SEARCH signal that a game
// is real and popular, but should never be selected as the final embed target.
const PORTAL_DOMAINS = [
  'crazygames.com', 'poki.com', 'coolmathgames.com', 'miniclip.com',
  'html5games.com', 'silvergames.com', 'gamesflare.com', 'gamedistribution.com',
  'gameflare.com', 'y8.com', 'addictinggames.com', 'kizi.com', 'kongregate.com',
  'armorgames.com', 'snokido.com', 'twoplayergames.org', 'friv.com', 'agame.com',
  'lagged.com', 'crazygamesportal.com', 'gamepix.com',
];

// Union of both — anything in this combined list is worth surfacing as a
// search result at all; embeddability is decided separately downstream.
const TRUSTED_GAME_DOMAINS = [...EMBEDDABLE_GAME_DOMAINS, ...PORTAL_DOMAINS];

// Domains to skip even if DDG returns them
const REJECTED_DOMAINS = [
  'youtube.com', 'twitch.tv', 'reddit.com', 'twitter.com', 'x.com',
  'facebook.com', 'instagram.com', 'tiktok.com',
  'wikipedia.org', 'wikia.com', 'fandom.com',
  'amazon.com', 'ebay.com', 'etsy.com',
  'steampowered.com', 'store.steampowered.com',
  'microsoft.com', 'apple.com', 'google.com',
  'gamefaqs.gamespot.com', 'gamespot.com', 'ign.com', 'pcgamer.com',
  'play.google.com', 'apps.apple.com',
  'imdb.com',
];

async function searchDuckDuckGo(gameName) {
  const results = [];
  const seen    = new Set();

  // Search specifically for a browser-playable version
  const query = `"${gameName}" browser game play online free`;
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const html = await safeFetch(ddgUrl, 12000);
  if (!html) return results;

  // DDG HTML results encode result URLs as ?uddg=<percent-encoded-url>
  const re = /[?&]uddg=(https?[^&"]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 8) {
    let href;
    try {
      href = decodeURIComponent(m[1]);
      const domain = new URL(href).hostname.replace(/^www\./, '');

      if (REJECTED_DOMAINS.some(d => domain.includes(d))) continue;

      const isTrusted = TRUSTED_GAME_DOMAINS.some(d => domain.includes(d));
      if (!isTrusted) continue;

      if (!seen.has(href)) {
        seen.add(href);
        results.push(href);
      }
    } catch {}
  }

  if (results.length > 0) {
    console.log(`[search]   DuckDuckGo: ${results.length} result(s) from trusted game sites`);
  }

  return results.slice(0, 5);
}

/* ── Combined search ──────────────────────────────────────────────────────── */

async function searchAll(gameName) {
  console.log(`[search] Searching for "${gameName}"…`);

  const [githubRes, truffledRes, ddgRes] = await Promise.allSettled([
    searchGitHub(gameName),
    searchTruffled(gameName),
    searchDuckDuckGo(gameName),
  ]);

  const rawGithub   = githubRes.status   === 'fulfilled' ? githubRes.value   : [];
  const truffled    = truffledRes.status === 'fulfilled' ? truffledRes.value  : [];
  const webSearch   = ddgRes.status      === 'fulfilled' ? ddgRes.value       : [];

  // Filter GitHub results to remove obvious aggregator repos before scoring them.
  const github = filterGitHubResults(rawGithub, gameName);

  console.log(`[search]   GitHub:     ${github.length} results (${rawGithub.length} before filter)`);
  console.log(`[search]   Truffled:   ${truffled.length} results`);
  console.log(`[search]   Web search: ${webSearch.length} results`);

  return { github, truffled, webSearch };
}

/* ── URL probing ──────────────────────────────────────────────────────────── */

async function probeUrls(urls) {
  const probes = await Promise.allSettled(
    urls.map(async url => {
      try {
        const headRes = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        // Some static hosts (notably GitHub Pages on certain edge nodes, and
        // a handful of itch.io pages) reject HEAD outright (405/501) even
        // though the page is genuinely live via GET -- retry with GET rather
        // than wrongly reporting a working page as dead.
        if (headRes.ok || (headRes.status !== 405 && headRes.status !== 501)) {
          return { url, ok: headRes.ok, status: headRes.status };
        }
      } catch {
        // fall through to GET retry below
      }
      try {
        const getRes = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
        return { url, ok: getRes.ok, status: getRes.status };
      } catch {
        return { url, ok: false, status: 0 };
      }
    })
  );
  return probes.map(p => p.status === 'fulfilled' ? p.value : { url: '', ok: false, status: 0 });
}

/** Returns true if the given URL's hostname is a known multi-game portal. */
function isPortalUrl(url) {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, '');
    return PORTAL_DOMAINS.some(d => domain.includes(d));
  } catch {
    return false;
  }
}

module.exports = {
  searchAll, probeUrls, safeFetch, isPortalUrl, PORTAL_DOMAINS,
  EMBEDDABLE_GAME_DOMAINS, looksLikeAggregatorLabel,
};
