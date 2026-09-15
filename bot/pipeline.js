'use strict';

/**
 * Red Portal — Game Request Pipeline
 * ====================================
 * Full end-to-end automation when a user submits a game request. Every
 * decision below is deterministic logic (decision.js/text-match.js) -- no
 * AI/LLM of any kind is involved anywhere in this pipeline.
 *
 * Steps:
 *  1.  Check duplicate (fuzzy name match against existing games + local Testing/ folders)
 *  2.  Validate request (gibberish/spam check, hard-incompatible keywords,
 *      and console/ROM detection -- see decision.js)
 *  2a. If it needs a real ROM (console explicitly mentioned, or a generic
 *      "needs an emulator" mention) → notify Discord and STOP. No search,
 *      no crawl -- there's no "browser version" of a console game to find,
 *      and this needs a legitimate ROM sourced by hand into Emulation/.
 *  3.  Search for the game (GitHub, truffled.lol, DuckDuckGo)
 *  4a. If not found → notify Discord "needs human worker"
 *  4b. If found:
 *        Crawl the game's assets/code (self-host) — or fall back to a
 *        single-file iframe wrapper if it can't be crawled.
 *        Write the files into Testing/<game name, spaces→"-">/ in the
 *        local red-portal-DKR-LCL checkout.
 *        Run sync_to_r2.py to push the repo (incl. the new folder) to R2.
 *        Notify Discord success
 */

const { searchAll, safeFetch } = require('./search');
const { validateRequest, findBestGameUrl, verifyPageContent, checkDuplicate } = require('./decision');
const { buildGameHtml } = require('./templates');
const { notifyNeedsHuman, notifyAdded, notifyInfo, notifyNeedsRom } = require('./discord');
const { crawlGame, needsSelfHost, resolveTruffledEntry, isTruffledWrapperUrl, resolveTruffledInnerGameUrlFromQuery } = require('./crawler');
const { writeGameFilesLocally, listLocalTestingFolders, listLocalGamesFolders, fetchRemoteManifestFolders, runR2Sync } = require('./local-deploy');

/**
 * Run the full automation pipeline for one game request.
 * This function is fire-and-forget — it logs progress and sends Discord messages.
 *
 * @param {{ name: string, type: string, notes: string|null, submitter: string|null }} request
 */
async function runPipeline(request) {
  const { name, type, notes, submitter } = request;
  const tag = `[pipeline:"${name}"]`;
  console.log(`\n${tag} ══ Starting pipeline ══`);
  console.log(`${tag}   Type: ${type} | Submitter: ${submitter || 'anonymous'}`);

  // ── STEP 1: Check for duplicates ──────────────────────────────
  // Remote manifest (R2, shared) is checked fresh on every request so a
  // game the OTHER bot copy just added shows up here right away — see
  // fetchRemoteManifestFolders() in local-deploy.js. Local folders are
  // still included too, in case something was written but not yet synced.
  console.log(`${tag} Step 1: Checking existing games…`);
  const { gamesFolders: remoteGames, testingFolders: remoteTesting } = await fetchRemoteManifestFolders();
  const localFolders = listLocalTestingFolders();
  const gamesFolders  = listLocalGamesFolders();
  console.log(`${tag}   Found ${remoteGames.length} remote Games/ + ${remoteTesting.length} remote Testing/ (R2 manifest), ${gamesFolders.length} local Games/ folders, ${localFolders.length} local Testing/ folders.`);

  const dupCheck = await checkDuplicate(name, [...remoteGames, ...remoteTesting, ...localFolders, ...gamesFolders]);
  if (dupCheck.duplicate) {
    console.log(`${tag}   DUPLICATE detected → "${dupCheck.matchedName}". Stopping.`);
    await notifyInfo(
      `Request for **${name}** skipped — it already exists on Red Portal as **${dupCheck.matchedName}**.`
    );
    return;
  }
  console.log(`${tag}   No duplicate found. Continuing.`);

  // ── STEP 2: Validate the request ──────────────────────────────
  console.log(`${tag} Step 2: Validating request…`);
  const validation = await validateRequest(name, type, notes);
  console.log(`${tag}   valid=${validation.valid} | browserCompatible=${validation.browserCompatible} | needsEmulation=${validation.needsEmulation} | popularity=${validation.popularity}`);
  console.log(`${tag}   reason: ${validation.reason}`);

  if (!validation.valid) {
    console.log(`${tag}   Request invalid → notifying Discord.`);
    await notifyNeedsHuman(name, validation.reason);
    return;
  }

  // A console/ROM game -- deliberately NOT the same path as "not browser
  // compatible" below. Searching/crawling for a "browser version" of an
  // actual console game would either find nothing (wasted work, same
  // outcome as just stopping here) or -- worse -- find and self-host some
  // sketchy unrelated page that happens to rank for the name. This needs a
  // real ROM the owner sources themselves, so stop immediately and say so.
  if (validation.needsEmulation) {
    console.log(`${tag}   Needs emulation (console=${validation.guessedConsole || 'unspecified'}) → notifying Discord, skipping search/crawl entirely.`);
    await notifyNeedsRom(name, validation.guessedConsole);
    return;
  }

  if (!validation.browserCompatible) {
    console.log(`${tag}   Not browser-compatible → notifying Discord.`);
    await notifyNeedsHuman(
      name,
      `This game/service does not appear to have a playable browser version. ${validation.reason}`
    );
    return;
  }

  // ── STEP 3: Search for the game ──────────────────────────────
  console.log(`${tag} Step 3: Searching for "${name}"…`);
  const searchResults = await searchAll(name);

  // ── STEP 4: Pick the best candidate URL ───────────────────────
  // extraProbes is a hook for a future manual/config-driven hint source --
  // nothing currently populates it, always passed empty. See findBestGameUrl
  // in decision.js for how candidates are scored and picked.
  console.log(`${tag} Step 4: Picking the best candidate URL…`);
  const gameDecision = await findBestGameUrl(name, searchResults, []);
  console.log(`${tag}   found=${gameDecision.found} | confidence=${gameDecision.confidence} | strategy=${gameDecision.strategy}`);
  console.log(`${tag}   url=${gameDecision.url}`);
  console.log(`${tag}   reasoning: ${gameDecision.reasoning}`);

  if (!gameDecision.found || !gameDecision.url) {
    console.log(`${tag}   No suitable game URL found → notifying Discord.`);
    await notifyNeedsHuman(
      name,
      `Could not locate a playable browser version across GitHub, truffled.lol, or the web. Manual research required.`
    );
    return;
  }

  const gameUrl     = gameDecision.url;
  const strategy    = gameDecision.strategy || 'proxy-iframe';

  // ── STEP 4.5: Read the actual page content to confirm it's a real game ──
  // HTTP 200 alone isn't proof of a real game page — many sites (truffled.lol
  // included) return 200 with a generic fallback/not-found/marketing page for
  // slugs that don't correspond to a real game. Fetch the page and run it
  // through verifyPageContent's checks (see decision.js) instead of just
  // trusting the HTTP status code.
  console.log(`${tag} Step 4.5: Verifying page content is a real game…`);
  const pageHtml = await safeFetch(gameUrl, 10000);
  if (!pageHtml) {
    console.log(`${tag}   Could not fetch page content → notifying Discord.`);
    await notifyNeedsHuman(
      name,
      `Found a candidate URL (${gameUrl}) but could not fetch its content to verify it. Manual check required.`
    );
    return;
  }

  const contentCheck = await verifyPageContent(name, gameUrl, pageHtml);
  console.log(`${tag}   isRealGame=${contentCheck.isRealGame} | reason: ${contentCheck.reason}`);

  if (!contentCheck.isRealGame) {
    console.log(`${tag}   Page content check failed → notifying Discord.`);
    await notifyNeedsHuman(
      name,
      `Found a candidate page (${gameUrl}) but it doesn't look like the actual game: "${contentCheck.reason}". Manual research required.`
    );
    return;
  }

  // ── STEP 5: Get the game's files (crawl self-host, or iframe fallback) ──
  console.log(`${tag} Step 5: Gathering game files…`);
  let files = null;

  // truffled.lol renders its game wrapper via client-side JS, so a plain
  // iframe to the search-result URL either shows a blank page or the wrong
  // content. For that source, crawl the actual game files (mirroring the
  // manual HAR-extractor workflow) and self-host a full copy instead of
  // just iframing the source.
  const selfHostCandidate = needsSelfHost(gameUrl) ? resolveTruffledEntry(gameUrl) : null;

  if (selfHostCandidate) {
    console.log(`${tag}   Source requires self-hosting → crawling ${selfHostCandidate}…`);
    try {
      const crawled = await crawlGame(selfHostCandidate);
      if (crawled && Object.keys(crawled.files).length >= 3) {
        console.log(`${tag}   Crawled ${Object.keys(crawled.files).length} file(s).`);
        files = crawled.files;
      } else {
        const count = crawled ? Object.keys(crawled.files).length : 0;
        console.warn(`${tag}   Crawl returned only ${count} file(s) — too few to self-host, falling back to iframe.`);
      }
    } catch (err) {
      console.error(`${tag}   Crawl failed:`, err.message, '— falling back to iframe.');
    }
  }

  // Fallback: single-file iframe wrapper pointing at the source
  // (used when the source doesn't need self-hosting, or self-hosting failed)
  if (!files) {
    // For a crawlable source (truffled.lol) force a direct iframe rather than
    // proxy-iframe. The proxy re-serves the source HTML but relative asset
    // paths inside it (e.g. /gamefile/game.js) would resolve to the proxy
    // domain instead of the original, breaking the game entirely.
    const fallbackStrategy = selfHostCandidate ? 'iframe' : strategy;

    // If this fell back to iframe because self-hosting a truffled wrapper
    // failed/came up too sparse, iframing gameUrl as-is would just embed
    // truffled.lol/iframe.html directly -- its own site chrome (mute/music
    // toggle, sidebar, fullscreen/share/download toolbar) around the real
    // game, exactly the bug this is fixing. Resolve to the real game file
    // via the wrapper's own ?url= query param and iframe that instead.
    let fallbackUrl = gameUrl;
    if (isTruffledWrapperUrl(gameUrl)) {
      const inner = resolveTruffledInnerGameUrlFromQuery(gameUrl);
      if (inner) {
        console.log(`${tag}   Fallback iframe: using resolved real game URL instead of truffled wrapper → ${inner}`);
        fallbackUrl = inner;
      }
    }

    const gameHtml = buildGameHtml(name, fallbackUrl, fallbackStrategy);
    files = { 'index.html': { bytes: Buffer.from(gameHtml, 'utf-8'), isText: true } };
    console.log(`${tag}   Using single-file iframe wrapper (strategy=${fallbackStrategy}).`);
  }

  // ── STEP 6: Write files into the local Testing/ folder ────────
  console.log(`${tag} Step 6: Writing files locally…`);
  let destDir, folderName;
  try {
    ({ destDir, folderName } = writeGameFilesLocally(name, files));
  } catch (err) {
    console.error(`${tag}   Local write failed:`, err.message);
    await notifyNeedsHuman(
      name,
      `Found game at ${gameUrl} but writing files to the local Testing/ folder failed: ${err.message}`
    );
    return;
  }

  // ── STEP 7: Sync to R2 ─────────────────────────────────────────
  console.log(`${tag} Step 7: Syncing to R2…`);
  try {
    await runR2Sync();
  } catch (err) {
    console.error(`${tag}   R2 sync failed:`, err.message);
    await notifyInfo(
      `⚠️ **Partial success for "${name}"**\n` +
      `Files were written to \`${destDir}\` but the R2 sync failed: ${err.message}\n` +
      `Please run \`sync_to_r2.py\` manually.`
    );
    return;
  }

  // ── STEP 8: Success notification ─────────────────────────────
  console.log(`${tag} ══ Pipeline complete ══`);
  console.log(`${tag}   Game URL:     ${gameUrl}`);
  console.log(`${tag}   Local folder: ${destDir}`);
  console.log(`${tag}   R2 sync:      ✓ complete`);

  await notifyAdded(name, folderName);
}

module.exports = { runPipeline };
