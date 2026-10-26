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
# 登入方式（H1）
AUTH_PASSWORD_LOGIN_ENABLED=false
BREAK_GLASS_OWNER_EMAILS=
COMPANY_TIMEZONE=Asia/Taipei
# 公司帳號單一登入（Authentik OIDC；OIDC 流程使用）
OIDC_ISSUER=https://<authentik>/application/o/oidea/
OIDC_CLIENT_ID=<Authentik provider 的 client id>
OIDC_CLIENT_SECRET=<Authentik provider 的 client secret>
OIDC_REDIRECT_URI=https://api.oidea.example.com/api/auth/oidc/callback
APP_WEB_CALLBACK_URL=https://app.oidea.example.com/auth/callback
APP_MOBILE_CALLBACK_URL=oidea://auth
```

要點：
- `DATABASE_URL` 的 host 用 Dokploy 內部網路名（**不是 localhost**），port 用 **5432**（容器內部通訊不經過 5433 映射）
- `JWT_SECRET` **絕對要換**，不然任何人都能偽造 token
- `JWT_EXPIRATION` 是 access token 的有效期（建議 15m）；`JWT_REFRESH_EXPIRATION` 是 refresh token 的有效期（不透明字串、存在 `refresh_tokens` 資料表，每次 refresh 換發並重新起算；格式 `7d`／`12h`／`30m`／秒數）
- **H1 上線注意**：H1 的 migration（`20261026120000_h1_employees_company`）最後一步會**撤銷所有 refresh token**（`UPDATE "refresh_tokens" SET "revokedAt" = ...`）。上線後每個人都要用公司帳號（SSO）重新登入一次；不在員工主檔的人（含以前自行註冊的帳號）就登不進來了。手上的 access token 最多再用 15 分鐘（`JWT_EXPIRATION`）。bot token 不受影響。這點要寫進 H1 的 PR 描述與上線公告。
- **H0 上線注意**：H0 改了 token 格式（access token 要有 `typ: "access"`，refresh token 改成不透明字串），上線後舊的 access／refresh token 全部失效，**所有人都要重新登入一次**。WebSocket 也改成要在握手帶 access token（`auth.token`），舊版 App 連不上即時訊息與白板，前後端要一起上線。
- `CORS_ORIGIN` 是逗號分隔的白名單，讓你的 Flutter Web / 其他前端可以打 API（SSO 的 `POST /api/auth/oidc/exchange` 也需要；Authentik 網域不用加）

### 登入方式、公司工作空間與緊急登入（H1）

- `AUTH_PASSWORD_LOGIN_ENABLED`：帳密登入／註冊開關。**不設時 fail closed：有設 `OIDC_ISSUER` 或 `NODE_ENV=production` 就是 false**，兩個都沒有（本機開發）才是 true。backend 的 Dockerfile 在 runtime stage 設了 `ENV NODE_ENV=production`，所以正式映像就算漏設變數也是關的。關閉時 `POST /api/auth/register`、`POST /api/auth/login` 回 404（下面的緊急登入例外）。接受 `true/false/1/0/yes/no/on/off`，無法辨識的值當 false。
- `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_REDIRECT_URI`、`APP_WEB_CALLBACK_URL`、`APP_MOBILE_CALLBACK_URL`：Authentik 單一登入（OIDC 流程使用）。`OIDC_CLIENT_SECRET` 只放後端。`OIDC_ISSUER` 有值時 `GET /api/auth/config` 回 `sso: true`。
- `GET /api/auth/config`（公開）回 `{ "sso": <OIDC_ISSUER 有設>, "passwordLogin": <帳密登入開著>, "breakGlass": <緊急登入開著：有設 BREAK_GLASS_OWNER_EMAILS 而且帳密登入關著>, "endSessionUrl": <Authentik 的 end-session URL 或 null> }`，Flutter 登入頁用它決定要顯示哪些按鈕（`breakGlass` 為 true 時顯示「管理者緊急登入」），Web 登出時導到 `endSessionUrl`。不含任何秘密值，也不透露緊急登入名單上是誰。
- `NODE_ENV=production` 時 `OIDC_REDIRECT_URI`、`APP_WEB_CALLBACK_URL` 必須是 `https://`，`APP_MOBILE_CALLBACK_URL` 必須是自訂 scheme（不能是 http(s)，因為行動版的 ticket 放在 query）。不符合時 SSO 回 503，log 寫出變數名稱。
- `COMPANY_TIMEZONE`：判斷「哪一天」用的時區，預設 `Asia/Taipei`（H4 起使用）。

### Authentik 單一登入（H1）

**登入流程**（後端主導，client secret 只在後端）：

1. App → `GET /api/auth/oidc/start?client=web|mobile&app_challenge=<S256>` → 302 到 Authentik。
2. Authentik（上游 Mailcow 登入）→ 302 `GET /api/auth/oidc/callback?code&state` → 後端換 token、驗 id_token、對應員工 → 302 回 App：
   Web `APP_WEB_CALLBACK_URL#ticket=…`（或 `#error=<code>`），行動版 `APP_MOBILE_CALLBACK_URL?ticket=…`（或 `?error=<code>`）。
3. App → `POST /api/auth/oidc/exchange { ticket, app_verifier }` → `{ accessToken, refreshToken, user }`。ticket 60 秒內有效、只能用一次。

**Authentik 要這樣設**（Applications → Providers → Create → OAuth2/OpenID Provider；屬於正式環境設定，由管理者操作）：

| 欄位 | 值 |
|---|---|
| Client type | **Confidential** |
| Client ID／Client Secret | 填進 `OIDC_CLIENT_ID`／`OIDC_CLIENT_SECRET` |
| Redirect URIs | `https://<api 網域>/api/auth/oidc/callback`（strict；必須跟 `OIDC_REDIRECT_URI` **一字不差**） |
| Signing Key | **選一張 RS256 憑證**（例如 authentik Self-signed Certificate）。沒選的話 Authentik 會用 client secret 以 HS256 簽 id_token，後端一律拒絕（App 收到 `error=server_error`，後端 log 有 `unexpected JWT "alg" header parameter`） |
| Scopes | `openid`、`email`、`profile`（預設的 property mappings） |
| Subject mode | 用預設（Based on the User's hashed ID）。**上線後不要改**：sub 一變，所有已綁定的員工都會被擋（`profile_bound`），要 hr 逐一解除綁定 |
| PKCE | 後端一律送 `code_challenge_method=S256`，Authentik 會自動驗，不用另外設 |
| Application 的登入流程 | 只綁 Mailcow Source（見 spec §5 H1 基礎設施與下面的「Authentik 加固」） |

**Authentik 加固（必做；員工是用 email 對應的，email 能被改就能冒充別人）**：

1. **使用者不能自己改 email**：Flows & Stages → Stages → `default-user-settings`（使用者設定流程的 Prompt stage）→ 把 `email` 欄位（`default-user-settings-field-email`）從 Fields 移除；或把這個 prompt field 改成唯讀。改完用一般員工帳號登入 Authentik 的 User settings 確認看不到可編輯的 email。
2. **只有 Mailcow 來的帳號才宣告 `email_verified: true`**：Customization → Property Mappings → 建一個 Scope Mapping（scope name `email`），取代預設的 email mapping，掛到 Oidea 的 provider：
   ```python
   # 只有經 Mailcow source 登入過（有 source connection）的使用者，email 才算已驗證
   from authentik.core.models import UserSourceConnection
   verified = UserSourceConnection.objects.filter(user=request.user, source__slug="mailcow").exists()
   return {
       "email": request.user.email,
       "email_verified": verified,
   }
   ```
   `source__slug` 要換成實際的 Mailcow source slug。這段要在 staging 實測（Authentik 版本不同，可用的變數可能不同）：用一個 Authentik 本地帳號（不是從 Mailcow 來的）登入 Oidea，應該收到 `error=email_unverified`，後端 audit 有 `auth.sso_denied`（reason `email_unverified`）。**不要**寫成一律回 `True` 的 mapping。
3. **Oidea 這個 Application 不提供註冊與找回密碼**：Application 的 Authentication flow 只放 Mailcow source（Identification stage 的 Sources 只勾 Mailcow，不顯示帳密欄位）；該 flow 的 Identification stage 不設 Enrollment flow、Recovery flow；Brand 的 Enrollment／Recovery flow 也不要指向會建立本地帳號的流程。
4. **行動版重新驗證**：後端對 `client=mobile` 送 `prompt=login`，要求 Authentik 重新驗證，不沿用既有的 Authentik session（防止搶註冊 `oidea://` 的惡意 App 在使用者不知情下拿到 ticket）。上線前在 staging 確認 Authentik 有照 `prompt=login` 要求重新登入。注意 Mailcow 自己的 OAuth session 不在 Authentik 控制範圍，所以這只是緩解。**長期解法是 Android App Links**：把 `APP_MOBILE_CALLBACK_URL` 改成 `https://<app 網域>/auth/mobile-callback`，在該網域放 `/.well-known/assetlinks.json`、AndroidManifest 的 intent-filter 設 `android:autoVerify="true"`，這樣只有簽章相符的 App 能收到 callback（之後的工作，H1 還沒做）。

其他要確認的事：

- `OIDC_ISSUER` 必須跟 `https://<authentik>/application/o/<slug>/.well-known/openid-configuration` 裡的 `issuer` **完全相同，包含結尾的斜線**。不同的話 discovery 會失敗，`start` 會 302 回 App 並帶 `error=server_error`，log 有 `OIDC discovery failed`。
- id_token 裡必須有 `email` 與 **布林值** `email_verified: true`（字串 `"true"` 不算）。沒有的話 App 收到 `error=email_unverified`。email scope 的 property mapping 照上面「Authentik 加固」第 2 點寫：只對 Mailcow 來的帳號回 `true`，不要一律回 `true`。
- 後端容器要能用 HTTPS 連到 Authentik（discovery、JWKS、token endpoint；每個請求逾時 10 秒）。discovery 結果會快取；失敗後 30 秒內直接回錯，之後自動重試。沒設 `OIDC_ISSUER` 時 SSO 關閉（`/api/auth/oidc/*` 回 404），後端照常啟動。`OIDC_ISSUER` 有設但其他必要變數缺少或格式不對時，`start` 回 503，log 只寫缺少的變數名稱。
- **Redis 是 SSO 的必要條件**：state（10 分鐘）與 ticket（60 秒）存在 Redis。Redis 出錯時登入一律失敗（`server_error`／exchange 回 503），不會放行。
- `APP_MOBILE_CALLBACK_URL` 不設時預設 `oidea://auth`，必須跟 App 的 AndroidManifest／Info.plist 註冊的 scheme 一致。
- 速率限制：三個端點各自每 IP 每分鐘 60 次。沒設 `TRUST_PROXY` 時全公司共用代理的 IP，等於全公司每分鐘 60 次登入，所以上線前要照下面的步驟設好 `TRUST_PROXY`。
- **CORS**：`start` 與 `callback` 是整頁導向，不受 CORS 限制；`exchange` 是 Flutter Web 用 XHR 打的，所以 **Flutter Web 的網域必須在 `CORS_ORIGIN` 裡**。Authentik 的網域不用加進 `CORS_ORIGIN`。行動版不受 CORS 限制。
- callback 的回應帶 `Referrer-Policy: no-referrer` 與 `Cache-Control: no-store`；Web 的 ticket 放在 URL fragment，不會進 nginx access log 或 Referer。
- 登出：Web 登出時 App 會導到 `endSessionUrl`（Authentik 的 end-session），否則下次會不經詢問自動登入。Mailcow 本身的 session 不在本系統控制範圍。

**員工對應**（第一次 SSO 登入時）：只有員工主檔（`employee_profiles`，公司工作空間）裡的人能登入，email 不分大小寫。已有同 email 的帳密帳號時會綁定它，並清掉密碼、撤銷它的 refresh token 與它建立的 bot、刪除它其他的登入方式；綁定前發出的 access token 立刻失效（`users.sessionsValidAfter`），他當下的 Socket 連線也會被斷開。email 比對用 `lower(email) = lower(...)`（不是 `ILIKE`，`_`、`%` 不是萬用字元）；只差大小寫的帳號有兩個以上時拒絕。每次登入成功都確保他是公司工作空間成員（新加入為 member，已有角色不動）。

App 收到的錯誤碼：

| code | 意思 |
|---|---|
| `not_employee` | 不在員工主檔（或還沒執行 `company:init`） |
| `terminated` | 員工狀態是離職 |
| `disabled` | 帳號已停用或已刪除 |
| `profile_bound` | 這筆員工資料已綁定別的帳號（例如 Authentik 重建帳號導致 sub 改變）；hr 解除綁定後再登入 |
| `email_unverified` | id_token 沒有 `email_verified: true` |
| `invalid_state` | state 不存在、已用過或被竄改 |
| `expired` | 超過 10 分鐘才回來（state），或 ticket 超過 60 秒 |
| `server_error` | 其他錯誤（IdP、Redis、id_token 驗證失敗）；細節看後端 log（log 不含 code、token、ticket、client secret） |
| `invalid_ticket` | 只出現在 exchange：ticket 不存在、已用過，或 `app_verifier` 不符 |

audit：被拒寫 `auth.sso_denied`（metadata.reason；員工對應被拒，以及 `email_unverified`、`id_token_invalid`），綁定寫 `employee.sso_bind`，待移交的 owner 第一次登入寫 `owner.transfer`（原本的 owner 降為 admin），換到 token 寫 `auth.login`（metadata.method=`sso`）。exchange 時會再檢查一次帳號沒停用／刪除、員工沒離職。

**第一次上線：指定公司工作空間**（在後端容器的 Terminal 執行；映像裡已經 build 好）：

```bash
npm run company:init -- --workspace <既有工作空間 id> --owner-email <owner 公司信箱> --employee-no <編號> --full-name <姓名> --hire-date <YYYY-MM-DD>
npm run company:init -- --create <名稱> --owner-email <owner 公司信箱> --executor-email <暫時擔任 owner 的既有帳號> --employee-no <編號> --full-name <姓名> --hire-date <YYYY-MM-DD>
```

- 全庫只能有一個公司工作空間；已有別的就拒絕，對同一個重跑是冪等的。
- owner 的帳號**已經綁定 SSO**（登入過一次）時，`ownerId` 直接指向他，原本的 owner 降為 admin。其他情況（還沒有帳號，或只有以前用帳密註冊、還沒綁定 SSO 的帳號）一律記成「待移交」（`workspaces.pendingOwnerEmail`），等他第一次 SSO 登入、經過綁定的清理（清密碼、撤銷 token 與 bot）之後才成為 owner。這是為了防止有人先用老闆的 email 註冊帳號、搶到 owner。用 `--create` 時要用 `--executor-email` 指定另一位既有帳號暫時擔任 owner；移交時執行者降為 admin（執行者就是 owner 本人時不降）。
- email 比對：完全相同（小寫）優先，否則不分大小寫；只差大小寫的帳號有兩個以上時拒絕，要先整理重複帳號。
- `--workspace` 指向一個已有其他成員的工作空間（還不是公司工作空間）時會拒絕，並印出數量（成員總數、不在員工主檔的人數、owner/admin/hr/finance 的人數；不印 email）。這些人會直接變成公司成員，角色就是全公司的後台角色。確認要沿用請加 `--allow-existing-members`（會印同樣的數量當警告並寫進 audit），否則改用 `--create`。
- 匯入員工主檔：`npm run employees:import -- /path/員工.csv`（UTF-8，第一行檔頭 `employeeNo,email,fullName,hireDate,departmentName,jobTitle`；後兩欄可省略）。重新匯入時只寫檔頭有的欄位：省略 `departmentName`／`jobTitle` 欄就不會動到既有員工的部門與職稱；**有這一欄但留白會清掉**。已綁定帳號的員工不能用匯入改 email（該列失敗，要在 H2 後台處理）。有任何一列失敗時 exit code 非 0，會逐列印出行號與原因。
- 本機開發要先 `npm run build`，這三個指令跑的是 `dist/cli/*.js`。
- 公司工作空間不能刪除，也不能發邀請或手動加人（403）；成員由 SSO 登入（加入）與離職（移出）決定。

**緊急登入（break-glass）**：Authentik 或 Mailcow 掛掉、沒人能登入時使用。

1. 平時先替公司 owner 設好緊急密碼（至少 12 字元，從 stdin 讀，不會顯示也不會寫進 log）：
   ```bash
   npm run auth:set-break-glass-password -- owner@example.com
   ```
   只有公司工作空間的 owner 能設定。注意：帳號第一次 SSO 綁定時會清掉舊密碼，所以要在 owner 第一次 SSO 登入**之後**再設。
2. 緊急時在 Dokploy 設 `BREAK_GLASS_OWNER_EMAILS=owner@example.com`（逗號分隔）並重新部署。這段期間只有名單上、且是公司工作空間 owner 的帳號能用帳密登入，其他人仍回 404；每次登入寫 audit `auth.break_glass`。App 的登入頁會多一個「管理者緊急登入」的文字按鈕，點開就是帳密表單（`/auth/config` 的 `breakGlass` 為 true 時才顯示）；不在名單上的人一律顯示「帳號或密碼錯誤」。
   注意：company:init 的暫時執行者在 owner 第一次 SSO 登入後會降為 admin，就不再能用緊急登入。
3. 有設這個變數時，啟動與每天 09:00（`COMPANY_TIMEZONE`）都會在 log 印 warning。**緊急狀況解除後把變數拿掉並重新部署。**

### 反向代理與 `TRUST_PROXY`

後端在 Traefik（可能再加 Cloudflare）後面時，若不設 `TRUST_PROXY`，`req.ip`（登入限流、審計日誌用）拿到的會是代理的 IP，不是客戶端 IP。

- 不設（預設）：維持原本行為，不信任任何代理。
- 數字：信任的代理跳數。只有 Traefik 通常是 `1`；Cloudflare → Traefik 可能是 `2`。**這只是猜測，不要直接照抄。**
- 也接受 Express 的其他寫法（`loopback`、逗號分隔的子網段）。不要用 `true`，那會讓客戶端能偽造 `X-Forwarded-For`。

**正確的值必須先在 staging 實測**：
1. 先不設 `TRUST_PROXY` 部署到 staging，從一台已知對外 IP 的機器登入失敗一次（或打任何會寫 audit 的 API）。
2. 查 audit log 的 `ipAddress`，跟那台機器的實際對外 IP（例如 `curl https://ifconfig.me`）比對。
3. 設 `TRUST_PROXY=1` 重新部署再測一次；不對就試 `2`。取「剛好等於實際客戶端 IP」的最小值。
4. 再用偽造標頭測一次（`curl -H 'X-Forwarded-For: 1.2.3.4' ...`），確認記到的仍是真實 IP，不是 `1.2.3.4`。
5. 確認後才把同一個值設到正式環境。

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

帳號：H1 起正式環境沒有註冊（`POST /api/auth/register` 回 404），員工一律用公司帳號（SSO）登入，見上面「Authentik 單一登入（H1）」與 `company:init`。本機開發（沒設 `OIDC_ISSUER`、`NODE_ENV` 不是 production）才能用下面的註冊：
```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","username":"admin","displayName":"Admin","password":"changeMe123!"}'
```

## 4. 後續更新

兩種流程選一：

**A. 自動（推薦）**  
Dokploy Application → **Webhooks** 建一個 → 把 URL 加到 GitHub repo Settings → Webhooks。之後 push 到 `main` 就自動 redeploy。

**B. 手動**  
在 Dokploy UI 點 **Redeploy**。migration 會自動跑；已套用的會跳過。

## 5. 部署 Flutter Web（瀏覽器版）

同一個 repo 的 `app/Dockerfile` 會把 Flutter Web 編出來用 nginx serve，可以在 Dokploy 再開一個 Application：

### 建立
**+ Create Service** → **Application**：

| 欄位 | 填什麼 |
|---|---|
| Name | `oidea-web` |
| Source Type | **Git** |
| Repository | `https://github.com/optyne/oidea` |
| Branch | `main` |
| Build Type | **Dockerfile** |
| Dockerfile | `app/Dockerfile` |
| Build Context | `app` |

### Build Arguments（不是 Environment！）
Application → **Advanced** → **Build Arguments**：

```
API_URL=https://api.oidea.example.com
WS_URL=https://api.oidea.example.com
```

⚠️ **build-time 決定，之後不能在 runtime 改**。換 API 網域 → 得重 build。

### 網域
**Domains** → Add：
- Host: `app.oidea.example.com`（前端網域）
- Port: `80`
- HTTPS: 勾 → Let's Encrypt

### CORS 必須回頭設 backend
前端網域確定後，去 `oidea-backend` Application → **Environment** → 改 `CORS_ORIGIN`：

```env
CORS_ORIGIN=https://app.oidea.example.com
```

改完 backend 按 **Redeploy** 讓新 CORS 生效。**沒做這步瀏覽器打 API 會被擋。**

### 部署
右上 **Deploy**。第一次 build 需 3-5 分鐘（Flutter image 比較大，約 2GB）。完成後瀏覽器開 `https://app.oidea.example.com` 應該看到登入畫面。

---

## 6. 重建行動裝置 APK 指向生產 API

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
