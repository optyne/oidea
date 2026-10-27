#!/bin/sh
# Oidea backend 啟動前置：先把資料庫 migrate 到最新狀態再啟 Nest。
# prisma migrate deploy 是 idempotent 的，對已套用的 migration 會跳過。
set -e

echo "[entrypoint] running prisma migrate deploy..."
# prisma 是 dependencies（不會被 npm prune --omit=dev 移除），--no-install 確保
# 用 package-lock 鎖定的版本，絕不在啟動時從 npm 下載最新版。
npx --no-install prisma migrate deploy

echo "[entrypoint] starting Nest server..."
exec node dist/main
