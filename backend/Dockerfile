FROM node:24-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY shared/ /app/shared/
COPY scripts/backup-database.mjs scripts/verify-backup.mjs scripts/restore-database.mjs /app/scripts/
RUN npm run build
RUN npm prune --omit=dev

EXPOSE 3000
CMD ["node", "dist/main.js"]
