# ── Red Portal — Koyeb Docker Deployment ──────────────────────────
# Uses Node.js Alpine (small image, fast cold-start).
# Koyeb injects $PORT automatically; server.js already reads it.
# Default exposed port is 8000 (Koyeb's expected default).

FROM node:20-alpine

# Run as a non-root user for security
RUN addgroup -S redportal && adduser -S redportal -G redportal

WORKDIR /app

# Copy package files first for better layer caching
COPY --chown=redportal:redportal package.json ./

# Install dependencies (none right now, but future-proofed)
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || true

# Copy the rest of the project
COPY --chown=redportal:redportal . .

USER redportal

# Koyeb sets PORT at runtime; expose its default here for documentation
EXPOSE 8000

# Health check — Koyeb will poll /health every 30 s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8000}/health || exit 1

# server.js reads process.env.PORT — Koyeb supplies it automatically
CMD ["node", "server.js"]
