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

# Switch to non-root user
USER nodejs

# Health check against the agent's public /healthz endpoint.
# (Requires POLYROOT_METRICS_OWNER_KEY to be set so the metrics server runs.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Use tini for proper signal handling
ENTRYPOINT ["tini", "--"]

# Default command runs the PolyRoot agent CLI (PAPER by default; see RUNTIME_MODE).
CMD ["node", "src/pm/runtime/dist/cli.js"]