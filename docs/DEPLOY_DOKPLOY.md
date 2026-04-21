# Dokploy 部署指南

在你自己的 VPS（或任何支援 Docker 的 Linux 主機）用 [Dokploy](https://dokploy.com/) 部署 Oidea 後端的完整步驟。

## 0. 前置準備

- 一台 Linux 主機（2 核 / 4GB RAM 起跳，Ubuntu 22.04+ / Debian 12+）
- 一個指向主機 IP 的網域（例如 `api.oidea.example.com`）
- 已安裝 Dokploy。尚未安裝請在主機上跑：
  ```bash
  curl -sSL https://dokploy.com/install.sh | sh
  ```
  安裝完開 `http://主機IP:3000` 建管理員帳號。

## 1. 建資料服務（Postgres / Redis / MinIO）

Dokploy 左側選 **Projects** → 建一個新 project（例如 `oidea`）。然後 **+ Create Service** 分別建三個 **Database** 資源：

### Postgres
| 欄位 | 值 |
|---|---|
| Type | PostgreSQL |
| Name | `oidea-postgres` |
| Image | `postgres:17-alpine` |
| DATABASE_NAME | `oidea` |
| DATABASE_USER | `oidea` |
| DATABASE_PASSWORD | （點右上「Generate」產個強密碼，記下來） |
| External Port | 不要勾（只內網存取） |

### Redis
| 欄位 | 值 |
|---|---|
| Type | Redis |
| Name | `oidea-redis` |
| Image | `redis:7-alpine` |
| External Port | 不勾 |

### MinIO
Dokploy 沒 MinIO 內建模板，用 **+ Create Service** → **Docker Compose**：
```yaml
services:
  minio:
    image: minio/minio:latest
    environment:
      MINIO_ROOT_USER: oidea_minio
      MINIO_ROOT_PASSWORD: <自己產一組強密碼>
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data
    ports:
      - "9000"
      - "9001"
volumes:
  minio_data:
```

部署後記下 Dokploy 給這個 compose 的內部 hostname（類似 `minio-xxxxx` 或你自己取的 service name）。

## 2. 建後端 Application

**+ Create Service** → **Application**：

| 欄位 | 值 |
|---|---|
| Name | `oidea-backend` |
| Source Type | **Git** |
| Repository | `https://github.com/optyne/oidea` |
| Branch | `main`（或你要部署的 branch） |
| Build Type | **Dockerfile** |
| Dockerfile | `backend/Dockerfile` |
| Context Path | `backend` |

### Environment Variables

在 Application 頁籤 **Environment** 填：

```env
DATABASE_URL=postgresql://oidea:<密碼>@oidea-postgres:5432/oidea?schema=public
REDIS_HOST=oidea-redis
REDIS_PORT=6379
MINIO_ENDPOINT=<上面 minio service 的 hostname>
MINIO_PORT=9000
MINIO_ACCESS_KEY=oidea_minio
MINIO_SECRET_KEY=<對應密碼>
MINIO_BUCKET=oidea-uploads
JWT_SECRET=<必換！openssl rand -hex 32>
JWT_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d
PORT=3001
CORS_ORIGIN=https://app.oidea.example.com,https://admin.oidea.example.com
NODE_ENV=production
```

要點：
- `DATABASE_URL` 的 host 用 Dokploy 內部網路名（**不是 localhost**），port 用 **5432**（容器內部通訊不經過 5433 映射）
- `JWT_SECRET` **絕對要換**，不然任何人都能偽造 token
- `CORS_ORIGIN` 是逗號分隔的白名單，讓你的 Flutter Web / 其他前端可以打 API

### 網域 + HTTPS

Application → **Domains** → **Add Domain**：
- Host: `api.oidea.example.com`
- Port: `3001`
- HTTPS: 勾（Dokploy 用 Traefik + Let's Encrypt 自動簽憑證）
- Certificate: Let's Encrypt

### 部署

點右上 **Deploy**。第一次會拉 image → 跑 `npm ci` → build → push 到 runtime layer。

Dockerfile 的 `docker-entrypoint.sh` 會在容器啟動時自動跑 `prisma migrate deploy`，所以**不需要手動下指令建 schema**。

部署完約 30 秒 healthcheck 會轉綠（Dockerfile 的 HEALTHCHECK 打 `/api/docs-json`，存在即健康）。

## 3. 驗證

```bash
curl https://api.oidea.example.com/api/docs-json | head -c 200
# 應該回傳 OpenAPI JSON

# 或瀏覽器開 Swagger：https://api.oidea.example.com/api/docs
```

第一次註冊：
```bash
curl -X POST https://api.oidea.example.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","username":"admin","displayName":"Admin","password":"changeMe123!"}'
```

## 4. 後續更新

兩種流程選一：

**A. 自動（推薦）**  
Dokploy Application → **Webhooks** 建一個 → 把 URL 加到 GitHub repo Settings → Webhooks。之後 push 到 `main` 就自動 redeploy。

**B. 手動**  
在 Dokploy UI 點 **Redeploy**。migration 會自動跑；已套用的會跳過。

## 5. Flutter App 連線

重建 APK 指向生產 API：

```bash
cd app
flutter build apk --release \
  --dart-define=API_URL=https://api.oidea.example.com/api \
  --dart-define=WS_URL=https://api.oidea.example.com
```

## 常見問題

| 症狀 | 解法 |
|---|---|
| 部署後 log 看到 `P1001: Can't reach database server` | `DATABASE_URL` 的 host 不對。在容器裡是 Postgres 服務的**內部 hostname**（Dokploy UI 上 Service 名），不是 localhost 也不是對外 IP |
| `CORS blocked` | `CORS_ORIGIN` 沒包含前端域名，或漏了 `https://` |
| 第一次打 `/auth/login` 一直 429 | Rate limit 5 次/分鐘生效。等 60 秒，或暫時在環境改更鬆的設定再 redeploy |
| `prisma migrate deploy` 卡住 | 通常是 DB 連不上。先在 Dokploy 內部 terminal 試 `psql $DATABASE_URL` |
| MinIO 上傳 403 | Bucket 還沒建。進 `minio:9001` console 登入後手動建一個 `oidea-uploads` bucket |
| 網域沒自動發憑證 | DNS A record 還沒生效。等 5 分鐘 DNS 傳播完，或 Dokploy 重跑 Let's Encrypt |
| 改 schema 後部署沒跑 migration | Dokploy 是否重 build 了 image？prisma 的 migrations 在 build 階段被拷到 image，entrypoint 才能讀到。沒 commit migration 只改 schema 是不會 apply 的 |

## 資源規劃

最小可用規格（< 10 人團隊）：
- **2 vCPU / 4GB RAM / 40GB SSD**
- 容器佔用約：postgres 200MB、redis 60MB、minio 150MB、backend 400MB

人數多 / 檔案多的話 Postgres 跟 MinIO 的 volume 要開大，或直接用託管服務（Supabase、Neon、Cloudflare R2）取代這兩個容器。
