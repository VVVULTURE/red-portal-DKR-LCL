'use strict';

/**
 * Red Portal — Deterministic Name/Text Matching Helpers
 * =======================================================
 * Pure string-similarity utilities with no external dependencies, used to
 * replace the LLM's fuzzy-matching judgment (duplicate detection, "does
 * this search result actually refer to the requested game") with something
 * deterministic and testable.
 */

/** Lowercase, collapse all non-alphanumeric runs to single spaces, trim. */
function normalizeWords(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Lowercase, strip every non-alphanumeric character entirely. */
function normalizeCompact(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First letter of each word, e.g. "Friday Night Funkin" -> "fnf". */
function initials(s) {
  return normalizeWords(s).split(' ').filter(Boolean).map(w => w[0]).join('');
}

/** Standalone numeric "words" (sequel/version indicators), e.g.
 *  "Dadish 4" -> ["4"], "Bloons TD 6" -> ["6"], "Slope" -> []. */
function numberTokens(s) {
  return normalizeWords(s).split(' ').filter(w => /^\d+$/.test(w));
}

function bigrams(s) {
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

/**
 * Sorensen-Dice coefficient over character bigrams of the normalized
 * (punctuation-stripped) strings. 1 = identical, 0 = nothing in common.
 * Good at catching typos/spelling variants without any dictionary.
 */
function diceCoefficient(a, b) {
  const A = normalizeCompact(a);
  const B = normalizeCompact(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return 0;

  const bgA = bigrams(A);
  const bgB = bigrams(B);
  const counts = new Map();
  for (const g of bgB) counts.set(g, (counts.get(g) || 0) + 1);

  let intersect = 0;
  for (const g of bgA) {
    const c = counts.get(g);
    if (c > 0) { intersect++; counts.set(g, c - 1); }
  }
  return (2 * intersect) / (bgA.length + bgB.length);
}

/**
 * Combined 0..1 confidence that `candidate` refers to the same game/title as
 * `name`. Tries, in order: exact match, acronym match (either direction),
 * substring match (guarded against tiny strings matching everything), then
 * falls back to bigram similarity for typos/spelling variants.
 */
function nameSimilarity(name, candidate) {
  const a = normalizeCompact(name);
  const b = normalizeCompact(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Sequel/installment veto: if the REQUESTED name explicitly carries a
  // number the candidate doesn't share, this is very likely a DIFFERENT
  // installment in the same franchise, not the requested one -- a real bug
  // hit in production: "Dadish 4" scored 0.85 against a catalog entry for
  // the plain original "Dadish" (word-subset substring match below) and
  // 0.83 against "Dadish 1"/"Dadish 2"/"Dadish 3" (bigram fallback), and got
  // silently self-hosted as if it were the requested sequel. Checked before
  // both the substring and bigram paths below since both independently
  // produced a false-high score for this case.
  // One-directional on purpose: a CANDIDATE carrying an extra number the
  // query didn't ask for (e.g. query "Slope" matching candidate "Slope 2
  // Multiplayer", an existing intentional case -- see the substring-match
  // comment below) stays allowed -- broadening an unqualified request is a
  // different, lower-risk failure mode than narrowing a specific one.
  const numsA = numberTokens(name);
  const numsB = numberTokens(candidate);
  if (numsA.length && (!numsB.length || !numsA.some(n => numsB.includes(n)))) {
    return 0.1;
  }

  // Acronym match: a short compact string equals the other side's initials
  // (e.g. "fnf" vs initials of "Friday Night Funkin" = "fnf").
  const aInit = initials(name).toLowerCase();
  const bInit = initials(candidate).toLowerCase();
  if (a.length >= 2 && a.length <= 6 && bInit && a === bInit) return 0.9;
  if (b.length >= 2 && b.length <= 6 && aInit && b === aInit) return 0.9;

  // Substring match, but at a WORD boundary in the space-separated form --
  // not a raw compact-string substring. Real bug hit in testing: comparing
  // against normalizeCompact() directly scored "Craftomation 1" as an 0.85
  // match for "RAFT", because the compact string "craftomation1" happens to
  // contain the letter run "raft" (from "cRAFTomation") with no word break.
  // Requiring the shorter side's whole word sequence to appear as a
  // contiguous, space-bounded run in the longer side still matches real
  // variants ("Slope 2 Multiplayer" contains "Slope") while rejecting
  // coincidental mid-word letter runs.
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 3) {
    const wordsA = normalizeWords(name).split(' ').filter(Boolean);
    const wordsB = normalizeWords(candidate).split(' ').filter(Boolean);
    const seqA = ` ${wordsA.join(' ')} `;
    const seqB = ` ${wordsB.join(' ')} `;
    if (wordsA.length && wordsB.length) {
      if (wordsA.length <= wordsB.length && seqB.includes(seqA)) return 0.85;
      if (wordsB.length <= wordsA.length && seqA.includes(seqB)) return 0.85;
    }
  }

  return diceCoefficient(a, b);
}

module.exports = { normalizeWords, normalizeCompact, initials, numberTokens, diceCoefficient, nameSimilarity };
