'use strict';
/**
 * Turn whatever the user typed into a fully-qualified URL — either they
 * typed a real URL, typed a bare hostname, or typed a search query.
 * @param {string} input
 * @param {string} template  Search-engine URL template with a literal "%s".
 * @returns {string}
 */
function toTargetUrl(input, template) {
  try {
    // Already a valid, fully-qualified URL.
    return new URL(input).toString();
  } catch {}

  try {
    // Valid once a scheme is assumed — only trust this if the hostname
    // actually looks like a real host (has a dot), so "search terms with
    // spaces" don't accidentally parse as some garbage single-label host.
    const url = new URL(`https://${input}`);
    if (url.hostname.includes('.')) return url.toString();
  } catch {}

  // Treat as a search query.
  return template.replace('%s', encodeURIComponent(input));
}
