# syntax=docker/dockerfile:1.7

# ─────────────── Builder ───────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# 把 devDependencies 剝掉，只留 runtime 用的
RUN npm prune --omit=dev

# ─────────────── Runtime ───────────────
FROM node:22-alpine AS production

# dumb-init 處理 PID 1 signal forwarding；wget 給 HEALTHCHECK 用
RUN apk add --no-cache dumb-init wget

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 用非 root 執行（node:alpine 內建 node 使用者，UID 1000）
RUN chown -R node:node /app
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
