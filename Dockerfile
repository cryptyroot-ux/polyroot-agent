# ─── Builder Stage ───
FROM node:26-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

# Copy package files
COPY package*.json ./
COPY turbo.json ./
COPY tsconfig.base.json ./
COPY tsconfig/ ./tsconfig/

# Copy workspace source (preserves src/pm/<pkg>/package.json hierarchy)
COPY src/ ./src/
COPY migrations/ ./migrations/

# Install dependencies
RUN npm ci

# Build all workspaces
RUN npm run build:all

# ─── Runtime Stage ───
FROM node:26-alpine AS runtime

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Install runtime dependencies only
RUN apk add --no-cache \
    postgresql-client \
    tini \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./
COPY turbo.json ./
COPY tsconfig.base.json ./
COPY tsconfig/ ./tsconfig/

# Copy built artifacts from builder (package-local dist + workspace layout)
COPY --from=builder --chown=nodejs:nodejs /app/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/migrations ./migrations

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# node:26-alpine vendors undici inside npm itself
# (/usr/local/lib/node_modules/npm/node_modules/undici). The image CI
# scanned ships 6.28.0, which is CVE-2026-109869 (DoS via an unhandled
# stream error). The agent does not depend on undici. Replace that
# copy when it is older than 6.29.1, and leave a newer vendored
# release in place.
RUN set +e; \
    undici_pkg=/usr/local/lib/node_modules/npm/node_modules/undici/package.json; \
    current="$(node -p "require('${undici_pkg}').version")"; \
    node -e "const [a,b,c]='${current}'.split('.').map(Number); if(a<6||(a===6&&(b<29||(b===29&&c<1)))) process.exit(10)"; \
    status=$?; \
    if [ "$status" -eq 10 ]; then \
      npm pack undici@6.29.1 --pack-destination /tmp && \
      rm -rf /usr/local/lib/node_modules/npm/node_modules/undici && \
      mkdir -p /usr/local/lib/node_modules/npm/node_modules/undici && \
      tar -xzf /tmp/undici-6.29.1.tgz -C /usr/local/lib/node_modules/npm/node_modules/undici --strip-components=1 && \
      rm -f /tmp/undici-6.29.1.tgz || exit 1; \
    elif [ "$status" -ne 0 ]; then \
      exit "$status"; \
    fi; \
    node -e "const v=require('${undici_pkg}').version.split('.').map(Number); if(v[0]<6||(v[0]===6&&(v[1]<29||(v[1]===29&&v[2]<1)))) { console.error('undici still below 6.29.1'); process.exit(1); }"

# Switch to non-root user
USER nodejs

# Health check against the agent's public /healthz endpoint.
# POLYROOT_METRICS_OWNER_KEY is optional; an unset key disables /metrics only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Use tini for proper signal handling
ENTRYPOINT ["tini", "--"]

# Default command runs the PolyRoot agent CLI (RUNTIME_MODE=LIVE).
CMD ["node", "src/pm/runtime/dist/cli.js"]