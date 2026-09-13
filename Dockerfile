# ─── Builder Stage ───
FROM node:26-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

# Copy package files
COPY package*.json ./
COPY turbo.json ./
COPY tsconfig.base.json ./

# Copy workspace packages
COPY src/pm/*/package.json ./src/pm/

# Install dependencies
RUN npm ci

# Copy source
COPY src/ ./src/
COPY migrations/ ./migrations/

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

# Copy built artifacts from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/src/pm/*/package.json ./src/pm/
COPY --from=builder --chown=nodejs:nodejs /app/migrations ./migrations

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Switch to non-root user
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Use tini for proper signal handling
ENTRYPOINT ["tini", "--"]

# Default command runs the executor (gateway runs separately in compose)
CMD ["node", "dist/pm/executor/index.js"]