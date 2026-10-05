FROM node:24-slim AS builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY shared/ /app/shared/
RUN npm run build

FROM node:24-slim
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/frontend/dist ./dist
COPY frontend/server.mjs ./
EXPOSE 80
CMD ["node", "server.mjs"]
