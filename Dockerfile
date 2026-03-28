# ===== Stage 1: Build Client =====
FROM node:18-alpine AS client-builder

WORKDIR /app/client

# Install client dependencies
COPY client/package.json client/package-lock.json ./
RUN npm ci

# Copy client source and build
COPY client/ ./
RUN npm run build

# ===== Stage 2: Production =====
FROM node:18-alpine AS production

WORKDIR /app

# Install system dependencies for bcrypt native module
RUN apk add --no-cache python3 make g++

# Install server dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Install tsx for TypeScript execution (needed at runtime)
RUN npm install tsx

# Copy server and shared source (runs via tsx, no compile step)
COPY server/ ./server/
COPY shared/ ./shared/
COPY migrations/ ./migrations/
COPY drizzle.config.ts ./
COPY tsconfig.json ./

# Copy built client from Stage 1
COPY --from=client-builder /app/client/dist ./client/dist

# Create uploads directory
RUN mkdir -p uploads

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Start the server
CMD ["npx", "tsx", "server/index.ts"]
