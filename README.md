# Red Portal — Local Build

This is a self-hosted version of Red Portal that runs entirely on your machine.
The external Cloudflare Worker has been replaced by a built-in Node.js proxy server,
so **no Cloudflare account or external worker is needed**.

---

## Requirements

- [Node.js](https://nodejs.org/) v14 or later (no npm packages to install — uses only built-in modules)

---

## Quick Start

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

---

## Custom Port

```bash
PORT=8080 node server.js
```

If you change the port, also update the Proxy URL in the **Credits → Proxy Config** section
of the site (or in `index.html`: `const DEFAULT_WORKER = 'http://localhost:<PORT>/proxy';`).

---

## How it works

| Component | Original (Vercel) | This build |
|-----------|-------------------|------------|
| Static files | Vercel CDN | `server.js` static file handler |
| Proxy | External Cloudflare Worker | `/proxy?url=` route on `server.js` |
| CORS headers | `_headers` file (Vercel) | Added by `server.js` on **every** response |

The proxy endpoint (`/proxy?url=<encoded-url>`) behaves identically to the Cloudflare Worker:
- Forwards the request server-side (bypassing browser CORS restrictions)
- Strips `X-Frame-Options` and `Content-Security-Policy` headers so pages can be framed
- Adds `Access-Control-Allow-Origin: *` to all responses
- Follows redirects automatically (up to 10 hops)
- Supports GET, POST, HEAD, and OPTIONS

### Headers sent on every response (static files AND proxy)

| Header | Value | Purpose |
|--------|-------|---------|
| `Access-Control-Allow-Origin` | `*` | Allow any origin to fetch |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS, HEAD, PUT, PATCH, DELETE` | Full method support |
| `Access-Control-Allow-Headers` | `*` | Allow any request headers |
| `Access-Control-Expose-Headers` | `*` | Expose all response headers to JS |
| `Cross-Origin-Resource-Policy` | `cross-origin` | Allow cross-origin embedding |
| `Cross-Origin-Embedder-Policy` | `unsafe-none` | Don't block iframes |
| `Cross-Origin-Opener-Policy` | `unsafe-none` | Don't isolate window |
| `X-Frame-Options` | `ALLOWALL` | Allow framing |
| `Content-Security-Policy` | *(empty)* | No CSP blocking |
| `Vary` | `Origin` | Correct caching with CORS |

### Health check

`GET /health` or `GET /healthz` — returns `{"status":"ok","uptime":<seconds>}`.
Used by Koyeb's load balancer to confirm the container is alive.

---

## File Structure

```
Red-Portal/
├── server.js       ← local proxy + static file server (no dependencies)
├── package.json    ← run scripts
├── Dockerfile      ← Docker build for Koyeb
├── .dockerignore
├── _headers        ← Netlify/Vercel/CF Pages header rules (ignored by Node.js)
├── index.html      ← the full Red Portal frontend
├── assets/
│   └── logo.png
└── README.md
```

---

## Stopping the server

Press **Ctrl+C** in the terminal.
