# syntax=docker/dockerfile:1.7

# ───────────────── Builder：canvas-web（Excalidraw 微前端）─────────────────
FROM node:22-alpine AS canvas-builder
WORKDIR /canvas
COPY canvas-web/package.json canvas-web/package-lock.json ./
RUN npm ci
COPY canvas-web .
RUN npm run build

# ───────────────── Builder：Flutter Web ─────────────────
# 用官方 cirruslabs image（內含 Flutter SDK + Dart）；tag 跟本機一致
FROM ghcr.io/cirruslabs/flutter:3.41.6 AS builder

WORKDIR /app

# 先拷 pubspec 吃 layer cache
COPY app/pubspec.yaml app/pubspec.lock ./
COPY app/packages/pencil_canvas/pubspec.yaml packages/pencil_canvas/
RUN flutter pub get

COPY app/ .

# 透過 build arg 傳 API_URL；Dokploy UI 的 "Build Args" 填入
ARG API_URL=""
ARG WS_URL=""

RUN flutter build web --release \
    --dart-define=API_URL=${API_URL} \
    --dart-define=WS_URL=${WS_URL}

# ───────────────── Runtime：nginx alpine ─────────────────
FROM nginx:1.27-alpine AS production

# SPA 路由：所有路徑 fallback 到 /index.html
COPY app/nginx.conf /etc/nginx/conf.d/default.conf

# 只拷 build 產物
COPY --from=builder /app/build/web /usr/share/nginx/html
COPY --from=canvas-builder /canvas/dist /usr/share/nginx/html/canvas

# nginx:alpine 預設監聽 80
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
