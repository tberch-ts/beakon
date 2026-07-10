# Beakon backend (Express + SQLite). Runs anywhere that runs a container:
# Fly.io, Render, Railway, a DigitalOcean droplet, etc.
FROM node:22-slim

# Build tools let the optional better-sqlite3 native module compile for best
# performance. If the build fails, the app falls back to Node's built-in SQLite,
# so the image still works either way.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --omit=optional --no-audit --no-fund

# App source.
COPY src ./src
COPY public ./public

# SQLite database lives on a mounted volume for persistence across restarts.
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/beakon.db
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "src/server.js"]
