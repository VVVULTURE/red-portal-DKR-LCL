'use strict';

const { PROXY_URL } = require('./config');

/**
 * Build the Repo 1 HTML — a full-page proxy-iframe for the found game URL.
 * This is the "game content" repo that gets deployed first.
 *
 * @param {string} gameName   Display title (used in <title>).
 * @param {string} gameUrl    The external URL where the game is hosted.
 * @param {string} strategy   'proxy-iframe' (default) | 'iframe'
 */
/* Red Proxy takes the target in the PATH, not a ?url= parameter, and
   encodes it with a codec that keeps the slashes: only %, ? and # are
   escaped. encodeURIComponent would pack the whole target into one path
   segment, and every relative URL inside the proxied page would then
   resolve by replacing that segment. Must stay identical to codecEncode
   in redproxy/ssr.mjs. */
function proxyEncode(target) {
  return String(target).replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23');
}

function buildGameHtml(gameName, gameUrl, strategy = 'proxy-iframe') {
  const iframeSrc = strategy === 'proxy-iframe'
    ? `${PROXY_URL}${proxyEncode(gameUrl)}`
    : gameUrl;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(gameName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <iframe
    src="${escapeAttr(iframeSrc)}"
    allowfullscreen
    allow="fullscreen; autoplay; gamepad"
    loading="eager"
    title="${escapeAttr(gameName)}"
  ></iframe>
</body>
</html>`;
}

/**
 * Build a standalone iframe-wrapper index.html using the exact template
 * provided by the user, with the source game URL injected as the src.
 *
 * Used as the local fallback when a game can't be crawled/self-hosted:
 * this single file gets written straight into the local
 * Testing/<game>/ folder (instead of being deployed to a separate
 * GitHub repo + Vercel project like before).
 *
 * @param {string} srcUrl  The URL the iframe should load (the original
 *                         game URL, or a proxy-iframe URL through PROXY_URL).
 */
function buildIframeWrapperHtml(srcUrl) {
  // This is the exact iframe template the user provided, with the src replaced.
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Iframe Loader with Fullscreen</title>
    <style>
        body, html {
            height: 100%;
            margin: 0;
            overflow: hidden;
            background-color: #330000;
            color: #ffdddd;
            font-family: sans-serif;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100%;
        }

        #iframeContainer {
            flex-grow: 1;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }

        #loadedIframe {
            width: 100%;
            height: 100%;
            border: none;
        }

        /* Fullscreen styles removed */
    </style>
</head>
<body>
    <div class="container">
        <div id="iframeContainer">
            <iframe id="loadedIframe" src="${escapeAttr(srcUrl)}" frameborder="0" allowfullscreen></iframe>
        </div>
    </div>

    <script>
        const loadedIframe = document.getElementById('loadedIframe');
        const iframeContainer = document.getElementById('iframeContainer');
    </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

module.exports = { buildGameHtml, buildIframeWrapperHtml };
