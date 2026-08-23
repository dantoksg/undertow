# Undertow — Node 22 + ws + better-sqlite3
FROM node:22-bookworm-slim AS base

# better-sqlite3 compiles a native addon; prebuilt binaries usually cover
# linux/amd64+arm64 for node 22, but keep build tools available as a fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
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

# Node-based health probe (no curl dependency); Coolify may override with its own.
HEALTHCHECK --interval=15s --timeout=5s --start-period=8s --retries=5 \
  CMD node -e "if((process.env.UNDERTOW_ROLE||'')==='keeper')process.exit(0);fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/launch.js"]
