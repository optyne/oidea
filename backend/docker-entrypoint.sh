#!/bin/sh
# Oidea backend 啟動前置：先把資料庫 migrate 到最新狀態再啟 Nest。
# prisma migrate deploy 是 idempotent 的，對已套用的 migration 會跳過。
set -e

echo "[entrypoint] running prisma migrate deploy..."
npx --yes prisma migrate deploy

echo "[entrypoint] starting Nest server..."
exec node dist/main
