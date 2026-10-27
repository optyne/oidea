# 員工系統＋管理後台＋Authentik 單一登入 — 設計規格

最後更新：2026-10-26（v3：依兩輪獨立審查修正）
基準：`origin/main` @ `1093144`（2026-08-09）
依據：盤點報告（讀碼，沒有執行測試；本機沒有 Node／Flutter／Docker）。現況都附 `檔案:行號`，實作前以當下程式為準。

這份規格是給 Claude Code 照著實作的。每個階段開一個分支、送一個 PR，驗收條件全部通過才算完成。遇到 §8「待決定」的問題要停下來問，不要猜。

路徑縮寫：`B/` = `backend/src/`，`A/` = `app/lib/`，`ERP/` = `app/lib/features/erp/presentation/pages/`。

---

## 1. 目標與範圍

**要做的**

1. **單一登入**：員工用公司 Mailcow 信箱的帳密登入 Oidea。路徑是 Mailcow（OAuth2）→ Authentik（OAuth Source）→ Oidea（標準 OIDC）。正式環境不再開放自行註冊。
2. **員工主檔**：員工編號、部門（樹狀）、職稱、直屬主管、到職日、離職日、雇用狀態。
3. **管理後台**：做在 Flutter app 裡的「後台」區塊（`/admin/*`），依角色顯示。功能包括員工名冊、部門、角色、審計日誌、全員出勤報表、假別與額度設定。
4. **補完三個 ERP 模組**：
   - 打卡：時區、補卡、報表畫面、匯出；
   - 請假：天數、假別額度、餘額、重疊檢查、主管簽核；
   - 報銷：收據上傳、依幣別統計。
5. **修補既有權限漏洞**（§3）。這是其他所有階段的前提。

**不做的（本規格範圍外）**

- 薪資計算、排班、加班費。之後若要做，參考 `optyne/careflow-public-erp` 的 `payroll-summaries`、`work-schedules`。
- 獨立的後台前端專案。後台就是 Flutter app 裡依權限顯示的頁面。
- 修改 Mailcow 本身。B 機（Mail）依 `oadpiz/STATE.md` 是「不動」的主機，只會在它的管理介面新增一個 OAuth2 App。
- 角色同步：不從 Authentik 群組同步角色。Authentik 只負責證明「你是誰」，角色在 Oidea 後台管。

## 2. 現況摘要

| 模組 | 判定 | 關鍵缺口 |
|---|---|---|
| 打卡 `B/attendance/` | 半成品 | `todayDate()` 依伺服器時區判斷日期，容器是 UTC，所以台北 08:00 前打卡會算成前一天（`attendance.service.ts:223-226`）。全員報表只有 API、沒有畫面（`A/core/network/api_client.dart:870` 沒有人呼叫）。沒有補卡，也沒有寫 audit。 |
| 請假（同一模組） | 半成品 | 不算天數、沒有額度與餘額、不檢查重疊（`attendance.service.ts:122` 只檢查 end ≥ start）。**沒有擋自我核准**（`:174-204`）。審批不是條件式更新。 |
| 報銷 `B/expenses/` | 半成品偏可用 | 收據端點接受客戶端自己報的 url，且用 inline type、沒有 DTO（`expenses.controller.ts:120-127`）。前端沒有上傳 UI。允許 0 元（`dto/create-expense.dto.ts:16-17`）。stats 把不同幣別直接加總。 |
| 前端三頁 `ERP/` | — | 核准、退回、付款按鈕不分角色都顯示（`leaves_page.dart:216-249`、`expenses_page.dart:407-468`）。 |
| 測試 | 無 | attendance、expenses、auth、workspaces 都沒有 spec；`app/test/` 沒有 ERP 測試。 |
| 員工主檔 | 無 | `User` 只有 email、username、displayName、passwordHash（非 null）、avatarUrl、status（這是在線狀態）、deletedAt（`schema.prisma:14-34`）。 |
| 後台畫面 | 無 | 只有 ERP 首頁的四個磚（`ERP/erp_home_page.dart:31-55`）。審計只有 API（`B/audit/audit.controller.ts:24-50`）。 |
| 登入 | 帳密＋自簽 JWT | 沒有任何 OAuth／OIDC 程式。`Account` 模型沒有人讀寫（`schema.prisma:67-80`）。`/auth/register` 任何人都能用，也不驗證 email。 |

## 3. 既有安全問題（H0 必修，要在 SSO 上線前修好）

以下都已讀碼確認：

1. **hr 與 finance 等同 admin**：`B/workspaces/workspaces.service.ts:196-202` 的 rank 表把 hr、finance 設為 2，跟 admin 一樣。邀請、移除、改角色都只要求 rank ≥ 2，所以 hr 或 finance 可以：
   - 移除 owner；
   - 把任何人（包括自己）升成 owner（`:149-171`；`validRoles` 含 `'owner'`，只擋「自己降成 member」）。
2. **所有 WebSocket gateway 都不驗身分**：
   - `B/messages/messages.gateway.ts:27-34` 與 `B/whiteboard/whiteboard.gateway.ts:25` 都直接信任 `handshake.auth.userId`；
   - 前端只送 userId（`A/core/network/socket_service.dart:14-26`）。
   - 只要知道別人的 userId，就能用他的身分收發訊息和改白板。
3. **refresh token 可以當 access token 用**：兩者用同一個 secret、同樣的 payload、沒有 type（`B/auth/auth.service.ts:82-93`），伺服端也無法撤銷。現有 `/auth/refresh` 是把 refresh token 當 Bearer、掛 `JwtAuthGuard`（`auth.controller.ts:27-33`）。
4. **token 不檢查使用者狀態**：`B/auth/strategies/jwt.strategy.ts:16-18` 不查 DB。被刪除或停用的人，token 在有效期內照樣能用。bot token 走另一條路（`B/auth/guards/jwt-auth.guard.ts` 對 `bot_` 前綴另外處理），也不受影響。
5. **請假可以自我核准**：`decideLeave` 沒有比對申請人與核准人是不是同一人。
6. **宣告式權限沒有接上**：`PermissionsGuard` 與 `@RequirePermission` 全專案零使用（`B/app.module.ts:73` 只註冊 ThrottlerGuard），各 service 自己手寫檢查。
7. **files 全部端點都沒有成員檢查**：`B/files/files.service.ts` 整支沒有查 workspaceMember。upload、findById、findByWorkspace、browse、listFolders、moveToFolder、delete 都一樣（controller 在 `files.controller.ts:14-89`）。
8. **使用者搜尋範圍過大**：`/users/search` 不帶 workspaceId 時會搜全系統使用者，email 和 bot 也搜得到（`B/users/users.service.ts:69-`）。
9. **還沒驗證的**：`main.ts` 沒有設 trust proxy，在 Traefik（以及可能的 Cloudflare）後面，限流和 audit 拿到的 IP 可能是代理的 IP。

## 4. 架構決策（標★的要使用者確認，見 §8）

### 4.1 「公司」是什麼 ★

**建議**：指定一個工作空間當「公司工作空間」。
- 新增 `Workspace.isCompany Boolean @default(false)`，用 partial unique index 保證全庫最多一個 true。
- 員工主檔、部門、假別、後台都綁在這個工作空間；它的 owner、admin、hr、finance 就是全公司的後台角色。
- 公司工作空間**不能刪除、不能封存**（後端擋）。

理由：改動最小，現有的 `WorkspaceMember.role` 可以沿用。其他工作空間照舊給專案協作用。

### 4.2 資料模型

員工主檔另開資料表，不塞進 `User`。原因是 `User` 也包含 bot（`B/bots/bots.service.ts:53`），而員工欄位之後會一直增加。

```prisma
model Department {
  id                String    @id @default(uuid())
  workspaceId       String                    // 公司工作空間
  name              String
  parentId          String?                   // 樹狀，→ Department
  managerProfileId  String?                   // 部門主管 → EmployeeProfile（不是 User：預建員工可能還沒有 User）
  sortOrder         Int       @default(0)
  archivedAt        DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  @@index([workspaceId, parentId])
}

model EmployeeProfile {
  id                String    @id @default(uuid())
  workspaceId       String                    // 公司工作空間
  userId            String?   @unique         // 首次 SSO 登入才綁定；預建時為 null
  email             String                    // 公司信箱，一律存小寫
  employeeNo        String
  fullName          String
  departmentId      String?
  jobTitle          String    @default("")
  managerProfileId  String?                   // 直屬主管 → EmployeeProfile；null 時用部門主管
  employmentType    String    @default("full_time")  // full_time / part_time / contractor / intern
  employmentStatus  String    @default("active")     // active / on_leave / terminated
  hireDate          DateTime  @db.Date
  terminationDate   DateTime? @db.Date
  phone             String    @default("")
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  @@unique([workspaceId, employeeNo])
  @@unique([workspaceId, email])
  @@index([workspaceId, departmentId])
  @@index([managerProfileId])
}

model RefreshToken {                          // H0 建立
  id          String    @id @default(uuid())
  userId      String
  familyId    String                          // 同一次登入（同一台裝置）換發出來的一串 token 共用
  tokenHash   String    @unique               // sha256，明文不落地
  expiresAt   DateTime
  revokedAt   DateTime?
  rotatedAt   DateTime?                       // 被換發的時間，用來判斷寬限期
  createdAt   DateTime  @default(now())
  @@index([userId])
  @@index([familyId])
}
```

上面是草稿，實作時要注意：
- 補上所有 `@relation`、反向 relation（User、Workspace），以及 `@@map`（照現有命名慣例）。
- `User` 新增兩個欄位：`disabledAt DateTime?`（H0，停用的唯一依據），以及 `passwordHash` 改為 nullable（H1）。
- **Prisma 表達不了、要在 migration.sql 手寫的索引**：
  - `Workspace` 的 `UNIQUE (("isCompany")) WHERE "isCompany"`；
  - `Department` 根節點同名：`UNIQUE ("workspaceId", lower(name)) WHERE "parentId" IS NULL`；
  - 非根節點：`UNIQUE ("workspaceId", "parentId", lower(name)) WHERE "parentId" IS NOT NULL`。
  - 原因是 Postgres 把 NULL 視為互不相等，Prisma 的 `@@unique` 擋不住根部門重名。
  - 還要驗證：之後再跑 `prisma migrate dev`，不會產生把這些索引 drop 掉的 diff。
- 敏感個資（緊急聯絡人、身分證、銀行帳戶）**本規格不放**，見 §8 第 8 點。
- **Decimal**：Prisma 的 Decimal 在 JSON 裡是字串（例如報銷的 amount、之後的 `days`）。API 照現狀回字串，Flutter 一律用 `num.parse`，並在 API 文件註明。

### 4.3 登入流程（後端主導的 OIDC）

```
Flutter ──(1) GET /api/auth/oidc/start?client=web|mobile&app_challenge=<S256> ──▶ 後端
後端    ──(2) 302 到 Authentik authorize（state、nonce、PKCE S256；state 對應的資料存 Redis 10 分鐘）
Authentik ──(上游) Mailcow /oauth/authorize 登入 ──▶ 回 Authentik
Authentik ──(3) 302 /api/auth/oidc/callback?code&state ──▶ 後端
後端：用 code 換 token；驗 id_token（RS256、JWKS、iss、aud、exp、nonce）；要求 email_verified=true；對應員工；建立 ticket
後端 ──(4) 302：web 到 /auth/callback#ticket=…（fragment）；mobile 到 oidea://auth?ticket=…
Flutter ──(5) POST /api/auth/oidc/exchange {ticket, app_verifier} ──▶ {accessToken, refreshToken}
```

**ticket**
- 隨機 32 bytes，只能用一次，60 秒內有效，存 Redis，並綁定第 (1) 步的 `app_challenge`。
- 取出與刪除要用原子操作 `GETDEL`。現有 `RedisService` 只有 get 和 del，需要補上。
- OIDC 流程用到 Redis 的地方（state、ticket）只要 Redis 出錯，就拒絕這次登入，不沿用「Redis 掛了不擋」的慣例。
- exchange 時必須送出相符的 `app_verifier`（S256）。這樣行動版的自訂 scheme 就算被別的 App 攔截，拿到 ticket 也換不到 token。
- Web 版的 ticket 放在 URL fragment，不會進 nginx access log 或 Referer。callback 頁要加 `Referrer-Policy: no-referrer`。

**token**
- client secret 只放在後端。Oidea 繼續簽自己的 JWT，bot token 與 interceptor 都沿用。
- access token：15 分鐘，payload 加 `typ: "access"`；`JwtStrategy` 只接受 `typ=access`。
- refresh token（H0）：
  - 不透明的隨機字串，存進 `RefreshToken.tokenHash`；
  - `POST /auth/refresh` 改成從 body 讀 token，**不掛** `JwtAuthGuard`；
  - 每次使用就換一組新的，新的那組沿用同一個 `familyId`；
  - **10 秒寬限期**：剛被換掉的 token（`rotatedAt` 在 10 秒內）再被使用時，在同一個 family 下**再簽發一組新的**，不算盜用。因為資料庫只存 hash，沒辦法回傳之前那組。
  - 超過 10 秒還被拿來用，就當成盜用，撤銷**整個 family**；同一使用者其他裝置的 family 不受影響。
  - H0 上線時，舊格式的 access token（沒有 `typ`）和舊的 refresh token 全部失效，所有人要重新登入一次。這點要寫在 H0 的 PR 描述與上線公告裡。
- Flutter 的 `AuthInterceptor`（`api_client.dart:66-100`）要改成 single-flight：同時有好幾個請求遇到 401，只送一次 refresh，其餘等它的結果。
- 新增 `POST /auth/logout`：撤銷這組 refresh token，寫 audit `auth.logout`。目前這個 action 型別存在，但沒有人呼叫。
- Web 登出時同時導向 Authentik 的 end-session，否則下次會不經詢問自動登入。Mailcow 本身的 session 不在本系統控制範圍。

**員工對應**（`auth.service.loginWithOidc`，依序判斷，整段包在同一個 DB 交易裡）

拒絕時一律寫 audit `auth.sso_denied`，workspaceId 設為公司工作空間，並在 metadata 記錄原因。

1. **先找出員工資料，在任何寫入之前判斷能不能登入**：
   - 先用 `Account(provider="authentik", providerId=sub)` 找到 User，再找出他的 `EmployeeProfile`；
   - 找不到，就用 email（小寫）找公司工作空間的 `EmployeeProfile`；
   - 兩邊都找不到 → 拒絕，顯示「此帳號尚未建立員工資料，請聯絡人資」★（§8 第 2 點）；
   - `employmentStatus = terminated`，或對應 User 的 `disabledAt` 有值 → 拒絕。
2. 是從 email 找到 profile 的，而且 profile 已經綁了另一個 User（例如 Authentik 重建帳號導致 sub 變了）→ **拒絕**，由 hr 在後台解除綁定後再登入。
3. 要綁定的 profile 還沒有 userId 時：
   - 已有同一個 email 的 `User`（**不分大小寫比對**，例如以前用帳密註冊的）：綁定這個 User，並同時做三件事——
     - 把 `passwordHash` 清成 null；
     - 撤銷他所有的 refresh token；
     - 撤銷他以前建立的所有 `BotAccount`，並刪除他其他 provider 的 Account。
     這是防止有人先用員工的 email 註冊、之後搶走帳號，或留下後門。
   - 沒有同 email 的 User：新建一個。username 取 email 的 @ 前面那段，轉小寫，只保留 `[a-z0-9._-]`；撞名就加 `-2`、`-3`……。
   - 建 `Account`，回填 `EmployeeProfile.userId`。
4. **每次 SSO 登入成功，都 upsert 公司工作空間的 WorkspaceMember**：沒有就加入，role=member；已經有就不動角色。這樣復職的員工再登入時，會自動回到公司工作空間。
5. 第一次上線時，公司工作空間由 CLI `npm run company:init -- --workspace <id>|--create <name> --owner-email <email>` 指定或建立（H1）：
   - 設定 `isCompany`；
   - 建立 owner 的 EmployeeProfile；
   - 把 `Workspace.ownerId` 設為那位 owner。如果他還沒有 User，就先在步驟 3 建立 User；如果是建立新的工作空間，ownerId 先指向執行者，等 owner 第一次 SSO 登入時再移交。
   - 這樣就不需要 `BOOTSTRAP_ADMIN_EMAILS`，這個環境變數拿掉。

**停用（離職）**
- H0 的停用依據是 `User.disabledAt`。H2 的離職流程會設這個欄位，並且做以下事情：
  - 撤銷全部 refresh token；
  - 撤銷他建立的所有 `BotAccount`（`createdById`）；
  - 斷開他所有的 Socket 連線；
  - 把他移出所有工作空間；
  - 資料保留，不刪除。
- `JwtStrategy.validate` 每次都檢查 `disabledAt`：
  - 快取的是「查 DB 得到的結果」（停用或沒停用都記），TTL 30 秒；
  - 快取沒有資料、或 Redis 出錯時，**一律回 DB 查**（用主鍵查），不能把「快取沒有」當成「沒停用」；
  - 停用時主動清掉該使用者的快取，讓停用立刻生效。
  - bot 那條路也要檢查「bot 的建立者有沒有被停用」，用同一套快取。
- 離職對象是公司工作空間的 owner，或是任何工作空間的 owner 時，必須先移交 owner，否則離職操作回 400。
- Mailcow 停用信箱，只能擋下「下一次 SSO 登入」，**不會**讓 Oidea 已經發出去的 token 失效。所以離職一定要在 Oidea 後台操作。

**Socket**（H0）
- `messages`、`whiteboard` 兩個 gateway 都改成在 `server.use()` middleware 驗 handshake 帶來的 access token（包括 `typ` 與停用檢查），不再讀 `auth.userId`。
- 前端 `socket_service.dart` 用 auth callback，每次（重新）連線時都取最新的 access token。實作前先確認現用的 `socket_io_client` 版本支援 auth callback，並實測一次。
- 後端在握手時記下 token 的 `exp`，到期就主動斷線；客戶端自動重連時，會帶新的 token 進來。離職時也要主動斷開該使用者的所有連線。

**開發與緊急登入（break-glass）**
- 帳密登入由 `AUTH_PASSWORD_LOGIN_ENABLED` 控制，正式環境預設 `false`。正式環境的 `/auth/register` 回 **404**。seed 帳號只用在開發環境。
- 緊急情況是指 Authentik 或 Mailcow 掛掉、沒有人能登入。處理方式：
  - 管理者在 Dokploy 設 `BREAK_GLASS_OWNER_EMAILS`（逗號分隔）並重新部署；
  - 這段期間，只有名單上、且是公司工作空間 owner 的帳號可以用帳密登入，其他人仍然只能走 SSO；
  - 每次登入寫 audit `auth.break_glass`；
  - 啟動時只要有設這個變數，就印 warning，並在每天的摘要裡提醒「緊急登入仍開啟」。
  - owner 的緊急密碼由 CLI `npm run auth:set-break-glass-password -- <email>` 設定，從 stdin 讀取，不寫進任何設定檔。

**邀請**
- `/invite/:token` 與 `inviteByIdentifier` 照舊可以用，但受邀者必須先用 SSO 登入（也就是要先是員工）。非員工的外部協作者見 §8 第 2 點。
- **公司工作空間的成員只由員工的生命週期決定**：SSO 登入時加入、離職時移出。對公司工作空間發邀請、或用 `inviteByIdentifier` 加人，一律回 403。

### 4.4 權限

- 把 rank 表拿掉。所有管理動作都改用 `B/common/permissions.ts` 的 permission key，並實際套上 `@RequirePermission`。
- 新增的 key：
  - `employee.read_all`、`employee.manage`、`department.manage`：hr、admin；
  - `leave.policy.manage`：hr；
  - `audit.read`：admin；
  - `member.role.manage`：admin；
  - `owner.transfer`：只有 owner。
- owner 規則：
  - 只有 owner 能指定或移交 owner；移交時一併更新 `Workspace.ownerId`；
  - owner 不能被移除或降級，除非先移交；
  - 永遠至少保留一位 owner。
- 自我核准一律禁止：請假、報銷、補卡都一樣。
- 「主管」不是角色，是一種關係：
  - 先看 `EmployeeProfile.managerProfileId`；
  - 沒有，就沿部門樹往上找第一位部門主管（跳過申請人自己）；
  - 整條都找不到，就交給 hr 角色。
  - 主管離職後，他的部屬自動改走這條找法。
  - 找到的主管還沒有 User（沒登入過），或已經停用，就跳過他，繼續往上找。
  - 主管可以看、可以核准**直屬部屬**的請假與補卡，不需要 hr 角色。
- AuditAction 白名單（`B/audit/audit.service.ts:4-17`）要擴充：`auth.sso_denied`、`auth.logout`、`auth.break_glass`、`employee.*`、`department.*`、`leave.*`、`attendance.*`、`owner.transfer`。

### 4.5 時間與日期

- 所有「哪一天」的判斷都用 `COMPANY_TIMEZONE`（預設 `Asia/Taipei`），不依賴伺服器時區。
- 「現在」一律從可注入的時鐘取得，測試傳入假時鐘。
- 國定假日存在 `Holiday` 表，由 hr 在後台匯入或編輯，不自動抓外部資料。

## 5. 階段

順序固定：H0 → H1 → H2 → H3 → H4 → H5。H2 完成之後，H3、H4、H5 可以依優先序調整。

**migration 時間戳規則（所有階段都適用）**：新的 migration 時間戳必須晚於所有分支上最新的那個（目前是 `origin/feat/whiteboard-crossplatform` 的 `20260809090047_add_page_format`）。

### H0 安全修補與測試骨架

**做什麼**
1. 先寫特徵測試，固定住 attendance、expenses、workspaces、auth、files 目前的正常路徑行為，**然後才開始改**。
2. 修掉 §3 第 1–8 點。
3. 建立 `RefreshToken`，加上 `User.disabledAt`，並做好 §4.3 的 token、refresh、logout、Socket 改造（OIDC 本身留到 H1）。
4. `/users/search`：workspaceId 改成必填，並驗證呼叫者是該工作空間的成員；結果排除 bot。
5. `main.ts` 設 `trust proxy`。跳數要先在 staging 實測，確認是 Traefik 還是 Traefik 加 Cloudflare：比對 `req.ip` 與實際的客戶端 IP。

**驗收條件**
- [ ] hr、finance 不能改角色、不能移除成員、不能把任何人升成 owner；admin 不能動 owner；只剩一位 owner 時無法降級。每一條都有測試。
- [ ] `messages` 與 `whiteboard` 兩個 gateway，用以下方式連線都會被拒：不帶 token、只帶假的 userId、帶過期 token、帶 refresh token。每一條都有測試。
- [ ] refresh token 當 Bearer 打一般 API，回 401。
- [ ] 舊 refresh token 在 10 秒內重用，拿到一組可用的新 token；超過 10 秒重用回 401，而且整個 family 都被撤銷，但同一使用者另一個 family 的 token 仍然可用（用假時鐘測試）。
- [ ] 設定 `disabledAt` 之後，他手上還沒過期的 access token，下一個請求就回 401。以下兩種情況也一樣回 401（測試）：Redis 停掉；Redis 被清空（flush）。
- [ ] Socket 連線在 access token 到期時被後端斷開（假時鐘測試）。
- [ ] 申請人核准自己的請假回 403；兩個核准請求同時送出，只有一個成功。
- [ ] 用不屬於自己工作空間的 fileId 或 workspaceId 打 files 的每一個端點，都回 403（每個端點至少一條測試）。
- [ ] `/users/search` 不帶 workspaceId 回 400；結果不含 bot。
- [ ] 第 1 步的特徵測試在改造後全部仍通過。
- [ ] `npm test` 全綠，CI 綠燈。

### H1 Authentik 單一登入（含員工主檔資料表與匯入）

**基礎設施（屬於生產動作：由使用者執行，或經使用者同意後執行）**
1. 在 Dokploy 部署 Authentik。主機與網域見 §8 第 3 點。
2. 在 Mailcow 管理介面「System → Configuration → Access → OAuth2 Apps」新增一個 App，redirect URI 填 `https://<authentik>/source/oauth/callback/mailcow/`。
3. 照 Authentik 官方指南（docs.goauthentik.io/users-sources/sources/social-logins/mailcow/）建立 Mailcow OAuth Source：
   - email 對應到 Mailcow profile 的 `email`；
   - 不允許使用者自行修改 email；
   - 輸出 `email_verified=true`。
4. 在 Authentik 建立 Oidea 用的 OAuth2/OIDC Provider：
   - confidential client、PKCE；
   - redirect 設為 `https://<oidea-api>/api/auth/oidc/callback`；
   - **signing key 選 RS256 憑證**（沒選的話會改用 client secret 以 HS256 簽，JWKS 驗證會失敗，這點要實測確認）；
   - 這個 Application 的登入流程只綁 Mailcow Source。
5. 已知限制：Mailcow 的 OAuth 只對「信箱使用者」有效，Mailcow 的管理員帳號拿不到 profile。所以每位員工都要有信箱帳號。

**程式**
- 資料表：建立 `Workspace.isCompany`、`Department`、`EmployeeProfile` 與 §4.2 列的手寫索引；`User.passwordHash` 改成 nullable。
- 預建員工的匯入：後台畫面要到 H2 才有，所以 H1 先做 CLI 指令 `npm run employees:import -- <csv>`，欄位為 employeeNo、email、fullName、hireDate、departmentName、jobTitle，用 upsert 方式匯入，並寫 audit。H2 的畫面也沿用同一個 service。
- 公司工作空間初始化：CLI `company:init`（§4.3「員工對應」第 5 點）。
- 緊急登入：`BREAK_GLASS_OWNER_EMAILS` 與 `auth:set-break-glass-password`（§4.3）。
- 公司工作空間的邀請限制（§4.3「邀請」）。
- 後端照 §4.3 實作 OIDC 與員工對應。新依賴：`openid-client`。
- Flutter：
  - 登入頁改成「使用公司帳號登入」；開發環境另外顯示帳密登入；
  - Web 用整頁導向，新增 `/auth/callback` 路由，從 fragment 讀 ticket；
  - 行動版用自訂 scheme `oidea://auth`，需要改 AndroidManifest 與 Info.plist。新依賴：`flutter_web_auth_2`；
  - 移除註冊頁的入口；
  - 確認 `app/nginx.conf` 的 `try_files` 有涵蓋 `/auth/callback`（目前 `location /` 會 fallback 到 index.html，需實測）。
- 新的環境變數：`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_REDIRECT_URI`、`APP_WEB_CALLBACK_URL`、`APP_MOBILE_CALLBACK_URL`、`AUTH_PASSWORD_LOGIN_ENABLED`、`BREAK_GLASS_OWNER_EMAILS`、`COMPANY_TIMEZONE`。寫進 `backend/.env.example` 與 `docs/DEPLOY_DOKPLOY.md`；CORS 也要涵蓋需要的來源。

**驗收條件**
- [ ] 在測試裡起一台假的 OIDC 伺服器（自帶 JWKS 與 RS256 金鑰），跑通 start → callback → exchange。
- [ ] 以下情況全部被拒，每一條都有測試：竄改 state、nonce 不符、`aud` 錯誤、HS256 簽的 id_token、id_token 過期、`email_verified=false`、ticket 重複使用、ticket 超過 60 秒、`app_verifier` 不符。
- [ ] 預建員工第一次 SSO 登入後：`EmployeeProfile.userId` 有回填、建立了 Account、加入公司工作空間（member），而且立刻能打 `/attendance/today`。這條要有測試。
- [ ] email 大小寫不同（`Foo@` 與 `foo@`）會對應到同一位員工（測試）。
- [ ] 已有帳密 User 的 email 第一次 SSO 登入：綁定後 `passwordHash` 是 null、舊的 refresh token 全部失效、他以前建的 bot 全部被撤銷（測試）。
- [ ] email 不在員工主檔、或狀態是 terminated：登入被拒，寫入 audit `auth.sso_denied`，而且資料庫完全沒有新增 User、Account、WorkspaceMember（測試）。
- [ ] profile 已經綁了另一個 User 時，用新的 sub 登入會被拒（測試）。
- [ ] 同一個 ticket 同時送出兩次 exchange，只有一次成功；Redis 停掉時，登入流程回錯誤（測試）。
- [ ] 對公司工作空間發邀請回 403（測試）。
- [ ] 緊急登入：沒有設 `BREAK_GLASS_OWNER_EMAILS` 時帳密登入回 404；有設時，只有名單上的 owner 能登入，非 owner 的人仍回 404，而且每次登入都有 audit（測試）。
- [ ] `company:init` 的兩種模式（指定既有工作空間、建立新的）都有測試；重複執行時不會產生第二個公司工作空間。
- [ ] 正式環境的設定下，`POST /auth/register` 和帳密登入都回 404（測試）。
- [ ] 錯誤訊息與 log 裡不含 client secret、code、id_token、ticket（測試用字串比對 log 輸出）。
- [ ] 人工驗證：在 staging 用一個真的 Mailcow 信箱，從 Web 和 Android 各登入一次、登出一次，附截圖；並確認 Socket 訊息與白板同步正常。

### H2 員工主檔後台

**API**（全部掛 `@RequirePermission`，每個寫入都寫 audit）
- 員工：
  - 列表：可依部門、狀態、關鍵字篩選，不含 bot；
  - 新增（預建）、編輯；
  - 離職：設 terminated 與 terminationDate，並執行 §4.3「停用」列的所有動作；
  - 離職的人如果是任何工作空間的 owner，必須先移交，否則回 400。
  - 復職：清除 `disabledAt`、把狀態改回 active。下一次 SSO 登入時會自動加回公司工作空間（§4.3「員工對應」第 4 點），但不會自動加回其他工作空間。
  - 解除綁定：hr 可以清空 profile 的 `userId`，並刪除對應的 authentik Account。用在 sub 改變的情況（§4.3「員工對應」第 2 點），要寫 audit。
- 部門：增刪改；移動時禁止形成循環；可指定主管；有成員的部門不能直接刪除，只能封存。
- 角色：沿用 H0 修正後的 `PUT /workspaces/:id/members/:userId/role`；新增 owner 移交端點。
- 審計：既有的 `GET /audit/workspaces/:id` 加上分頁與時間區間。

**後台畫面**（`A/features/admin/`，路由 `/admin/*`）
- 側欄新增「後台」項目，只對有任一後台權限的人顯示。`A/shared/widgets/oidea_sidebar.dart` 與 `A/shared/pages/main_shell.dart` 的兩份清單都要改。
- 頁面：
  - 員工名冊：表格、篩選、新增與編輯表單、CSV 匯入；離職操作要先跳確認對話框並輸入離職日。
  - 部門：樹狀列表、移動、指定主管。
  - 成員與角色：從 ERP 首頁的磚移到這裡。
  - 審計日誌：時間、人、動作、對象，可篩選。
  - 員工自己的「我的資料」頁：唯讀，顯示部門、主管、到職日。

**驗收條件**
- [ ] 部門移動造成循環時回 400。測試涵蓋：把自己設成自己的上層、把孫節點設成上層。
- [ ] 根部門同名（大小寫不同也算）回 409（測試，證明手寫索引生效）。
- [ ] 離職的整合測試，依序驗證：
  - 他還沒過期的 access token，下一個請求回 401；
  - 他已連線的 Socket 被斷開；
  - 他建立的 bot 呼叫 API 回 401；
  - 再用 SSO 登入被拒；
  - 員工資料仍然查得到。
- [ ] 復職之後再用 SSO 登入，可以打 `/attendance/today`（測試）。
- [ ] 要讓 owner 離職、但還沒移交時回 400（測試）。
- [ ] 一般員工打任何 `/admin` 相關 API 都回 403；前端看不到「後台」項目（widget 測試）。
- [ ] 名冊不含 bot 使用者（測試）。
- [ ] 每個新的寫入動作都有對應的 audit 紀錄（測試）。

### H3 請假規則

- 新資料表：
  - `LeaveType`：代碼、名稱、是否帶薪、最小單位（0.5 天或 1 小時）、是否需要附件、每年預設額度；
  - `LeaveBalance`：員工、年度、假別、額度、已用、調整紀錄；
  - `Holiday`：日期、名稱、是否為補班日。
- 既有資料的 backfill：依 `LeaveRequest.type` 現有的值（sick／annual／personal／unpaid／other），在 migration 裡建立對應的 `LeaveType`，並把既有請假單接上去。
- 天數計算：扣掉週末與 `Holiday`，補班日要算上班日，支援半天。結果存在 `LeaveRequest.days Decimal(5,1)`。
- 申請時的檢查：
  - 不能跟自己其他 pending 或 approved 的請假重疊；
  - 餘額要夠（無薪假除外）；
  - 過去的日期只能在設定的天數內申請。
- 簽核：依 §4.4 找出核准人 ★（§8 第 4 點）。hr 可以檢視全部，必要時代為處理，但要寫 audit。
- 特休額度 ★：依勞基法第 38 條由到職日算出，hr 可以手動調整（§8 第 5 點）。
- 前端：
  - 申請時即時顯示天數與剩餘額度；
  - 主管有「待我核准」清單；
  - hr 後台可以設定假別、匯入假日、調整餘額。

**驗收條件**
- [ ] 天數計算的單元測試涵蓋：跨週末、跨國定假日、補班日、半天、跨年度。
- [ ] 以下情況都被拒（每一條都有測試）：日期重疊、餘額不足、自我核准、不是直屬主管卻去核准。
- [ ] 核准人的找法有測試：沒有直屬主管時找部門主管、整條都沒有主管時交給 hr、主管離職之後的情況。
- [ ] 核准後扣餘額、取消後退回餘額，都在同一個交易內完成（測試）。
- [ ] backfill 後，既有請假單全部都有 `leaveTypeId`（migration 測試）。
- [ ] 所有判斷都用注入的假時鐘測試。

### H4 打卡補完

- 「今天」改用 §4.5 的方式判斷。
- 補卡申請 `AttendanceCorrection`（日期、上班或下班時間、原因）→ 依 §4.4 找出的核准人核准 → 寫回 `Attendance`，並保留修改紀錄。
- 公司上下班時間設定（單一班別，例如 09:00–18:00、午休 60 分鐘），用來標示遲到、早退、缺卡。只做標示，不扣薪 ★（§8 第 6 點）。
- 已核准的請假在出勤報表上顯示為「請假」，不算缺卡。
- 後台出勤報表畫面：可依期間、部門篩選，可匯出 CSV。
- 打卡與補卡都要寫 audit。

**驗收條件**
- [ ] 台北時間 07:59 打卡算當天；UTC 跨日也不會出錯（假時鐘測試）。
- [ ] 同時送出兩次打卡，回友善的錯誤，不會回 500（測試）。
- [ ] 用固定 fixture 產生 CSV，跟版控中的黃金檔逐位元組比對（測試）。
- [ ] 遲到、早退、缺卡、請假四種標示各有一條測試。

### H5 報銷補完

- 收據：
  - 前端先走 `POST /files/upload`，再用 **fileId** 把收據掛到報銷單；
  - 後端驗證檔案屬於同一個工作空間、上傳者就是本人；
  - 不再接受客戶端自己報的 url；補上 DTO。
- 收據怎麼對外提供：用後端代理下載或簽名 URL，不暴露 MinIO 的內網位址 ★（§8 第 9 點）。
- 金額必須大於 0；統計依幣別分開加總。
- 前端的核准、退回、付款按鈕依權限顯示。
- 報銷要不要經直屬主管核准 ★（§8 第 4 點）。
- 後台匯出：可依期間、狀態篩選，輸出 CSV 給會計。

**驗收條件**
- [ ] 用別人或別的工作空間的 fileId 掛收據，回 403（測試）。
- [ ] 金額 0 或負數回 400；收據 body 欄位不合法回 400（測試，證明 DTO 生效）。
- [ ] 核准、退回、標記付款自己的報銷都回 403（測試，固定住現有的防護）。
- [ ] 不同幣別的統計各自加總（測試）。
- [ ] 一般員工看不到核准按鈕（widget 測試）。
- [ ] CSV 匯出用黃金檔比對（測試）。

## 6. 不可違反的原則

1. 每個狀態變更都寫 audit。audit 失敗不中斷主流程（沿用 `audit.service.ts` 的行為），但要記錯誤 log。
2. 權限檢查一律在後端做；前端隱藏按鈕只是為了使用體驗。
3. 憑證與 token 不寫進 log、錯誤訊息或 URL query。Web 的 ticket 放在 fragment。
4. 所有日期與時間的判斷，都透過可注入的時鐘取得「現在」。
5. 介面與錯誤訊息用繁體中文，跟現有程式一致（目前沒有 i18n 框架）。
6. 新增的第三方套件只限三個：後端 `openid-client`、Flutter `flutter_web_auth_2`、以及實作 H0 確實需要的 Redis 或 socket middleware 輔助套件（如果現有依賴不夠）。要加其他套件，先問。
7. 正式環境的動作（部署、改 Dokploy 設定、Authentik 與 Mailcow 的設定），由使用者執行，或經使用者同意後才執行。

## 7. 每個階段的完成定義

- `backend`：`npm test`、`npm run build` 都通過；新的 service 都有 spec。
- `app`：`flutter analyze`、`flutter test` 都通過；新頁面都有 widget 測試，包含依權限顯示。
- CI 綠燈（`.github/workflows/ci.yml`：Node 22、Flutter 3.41.2）。
- 新的環境變數寫進 `backend/.env.example` 與 `docs/DEPLOY_DOKPLOY.md`。
- `docs/REQUIREMENTS.md` 照實更新狀態：沒有 UI 或沒有測試的項目不標 `[x]`。順便更正 A-04、R-03 目前不符事實的標記。
- PR 描述逐條勾選驗收條件，人工驗證的項目附截圖。
- 開發環境：本機（Windows）目前沒有 Node、Flutter、Docker。要先裝好，或改在有環境的機器上做，才能跑上面的驗證。

## 8. 待決定（遇到時停下來問）

1. **公司工作空間**：同意 §4.1「指定單一工作空間」的做法嗎？還是要新增全域的組織層？員工自建其他工作空間的功能要不要保留？建議保留，因為只有員工能登入。
   - **已決定（2026-10-26）**：指定單一公司工作空間；員工可以自建其他工作空間。
2. **不在員工主檔的人**：建議拒絕登入。若要給客戶或外包使用，需要另外設計「訪客」身分。
   - **已決定（2026-10-26）**：拒絕登入。
3. **Authentik 部署在哪**：哪一台 Dokploy 主機、用什麼網域？staging 要不要另外一套？
4. **簽核層級**：請假、補卡、報銷，是「直屬主管一層」，還是「主管 → hr 或財務」兩層？報銷超過多少金額要多加一層？
5. **特休**：依勞基法第 38 條自動計算（週年制還是曆年制），還是由 hr 每年手動輸入？
6. **打卡規則**：固定班別還是彈性工時？要不要限制打卡的地點或 IP？
7. **既有資料**：Oidea 正式環境目前有沒有真實使用者與資料？有的話，要先到 Dokploy 的 Deployments 分頁確認正式環境跑的是哪個 commit，再規劃 migration 與帳號綁定。
8. **員工個資範圍**：電話以外的個資（緊急聯絡人、身分證、銀行帳戶）要不要放進系統？要放的話，另外寫加密與存取的規格。
9. **收據檔案怎麼對外提供**：`File.url` 目前沒有 scheme，而且用的是內網 hostname。要改成後端代理下載，還是 MinIO 簽名 URL？要先確認目前正式環境實際是怎麼提供的。

## 9. 參考

- Oidea：`README.md`、`docs/REQUIREMENTS.md`（P5 ERP）、`docs/DEPLOY_DOKPLOY.md`、`docs/BOT_INTEGRATION.md`
- 程式範本：`B/tasks/`（模組結構）、`B/invites/invites.service.spec.ts`（測試寫法，PrismaService 用 mock）
- Authentik 的 Mailcow Source：https://docs.goauthentik.io/users-sources/sources/social-logins/mailcow/
- Mailcow OAuth2 原始碼：github.com/mailcow/mailcow-dockerized 的 `data/web/oauth/`（沒有 PKCE、沒有 id_token；profile 欄位有 email、full_name、active）
- 薪資與排班之後的參考：`optyne/careflow-public-erp`（`app/api/payroll-summaries`、`work-schedules`）
- dev-platform（`github.com/oadpiz/dev-platform`）：之後也接同一個 Authentik，它的 SPEC §7 第 1 點就能定案。
