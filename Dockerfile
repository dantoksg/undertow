# Undertow — Node 22 + ws + better-sqlite3
FROM node:22-bookworm-slim AS base

# better-sqlite3 compiles a native addon; prebuilt binaries usually cover
# linux/amd64+arm64 for node 22, but keep build tools available as a fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY server ./server
COPY public ./public

# Persistent world state lives here; mount a Coolify volume at /data.
ENV UNDERTOW_DATA_DIR=/data
ENV PORT=3000
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "server/server.js"]
