# ── Red Portal — Render Docker Deployment ──────────────────────────
# Uses Node.js Alpine (small image, fast cold-start).
# Render injects $PORT automatically; server.js already reads it.
# Default port is 3001 if $PORT isn't set (see server.js).
#
# ⚠  Create a  .dockerignore  alongside this file to keep the image lean:
#
#   node_modules
#   .git
#   .gitignore
#   *.md
#   Dockerfile
#   .dockerignore

FROM node:20-alpine

# Tell Node.js (and any future deps) we are in production:
#   • enables V8 optimisations
#   • npm skips devDependencies automatically
#   • many packages reduce logging / enable caches
ENV NODE_ENV=production

# Run as a non-root user for security
RUN addgroup -S redportal && adduser -S redportal -G redportal

WORKDIR /app

# ── Layer-cache trick: copy manifests before source so npm install
#    only re-runs when package.json/package-lock.json actually change.
#    package-lock.json is REQUIRED for `npm ci` -- without it, npm ci
#    fails immediately, which the `|| true` guard below used to mask
#    completely silently (harmless when there were zero dependencies,
#    but would otherwise leave node_modules empty at runtime). ────
COPY --chown=redportal:redportal package.json package-lock.json ./

# Install production dependencies.
# --omit=dev        : skip devDependencies (also implied by NODE_ENV=production)
# --ignore-scripts  : don't run arbitrary postinstall hooks (security)
# --prefer-offline  : use the npm cache when it's warm (faster rebuilds)
# Exit 0 is expected when there are no deps; the `true` guard prevents
# Docker marking a cache-miss as a build failure on empty projects.
RUN npm ci --omit=dev --ignore-scripts --prefer-offline || true

# Copy the rest of the project AFTER installing deps so edits to
# source files don't bust the npm cache layer.
COPY --chown=redportal:redportal . .

# Drop to the unprivileged user for the lifetime of the container
USER redportal

# Render sets PORT at runtime; expose the local default here.
EXPOSE 3001

# Health check — Render polls /health periodically.
# wget is built into BusyBox on Alpine — no extra package needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

# server.js reads process.env.PORT — Render supplies it at runtime.
CMD ["node", "server.js"]
