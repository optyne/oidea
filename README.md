# Oidea 協作平台

整合 **JANDI／Slack 風格通訊**、**專案管理（看板）**、**會議排程與視訊骨架**、**Affine 取向之白板編輯**、輕量 **ERP（費用報銷／打卡／請假／角色權限）**，以及 **Notion 風知識管理（Page + Block + Database，含記帳範本）** 的全端應用程式碼庫。

## 產品願景 vs 目前可執行範圍

| 模組 | 完整產品想像 | 本 repo 目前已具備 |
|------|----------------|-------------------------------|
| 通訊 | Thread、反應、@提及、搜尋、推播 | JWT、工作空間、頻道 REST 建立、訊息列表；**討論串頁**、**關鍵字搜尋**、**表情反應**、**正在輸入提示**；Socket 或 REST 發訊皆廣播 `newMessage`；**Markdown 渲染 + `@username` 高亮**、**`@提及` 自動建 Mention 並發通知**、**訊息置頂 API**、**檔案附件（MinIO）**、**全域通知徽章（輪詢）** |
| 專案 | 甘特圖、欄內排序、活動日誌 | 看板 API、新增欄位／任務、**長按跨欄拖曳**；**優先級色條 + 標籤 + 指派頭像 + 到期日**、**篩選（assignee／優先級）**、**新任務對話框含優先級／指派／截止日**、**活動日誌已在詳情呈現**、**任務附件上傳**、**被指派自動發通知** |
| 會議 | WebRTC 多人、螢幕分享、協作筆記 | 會議 CRUD、行事曆 UI、會議室頁面骨架；**邀請參與者自動發通知** |
| 白板 | Yjs CRDT、無限畫布、匯出 | 白板 CRUD、畫布繪圖 UI 骨架、Socket 事件名稱預留 |
| 平台 | 統一錯誤、權限、觀測 | **全域 `AllExceptionsFilter` 回傳 `{statusCode, error, message, path, timestamp}`**、所有 controller 均掛 `JwtAuthGuard`；**`ROLE_PERMISSIONS` + `@RequirePermission` + `PermissionsGuard`** |
| ERP | 報銷／考勤／請假／角色權限 | **Expense / ExpenseApproval / ExpenseReceipt / Attendance / LeaveRequest** 模型與 API；申請、審批、付款標記、狀態彙總；上下班打卡、月份查詢、HR 報表；請假申請／審批；`admin / hr / finance / member` 角色切換 UI；審批／付款自動通知申請人 |
| 筆記 | Notion 風 Page + Block + Database | **KnowledgePage / KnowledgeBlock / KnowledgeDatabase / DbProperty / DbRow** 模型；巢狀 Page 樹、10 種 Block 型別（含 todo/code/quote/divider）可相互轉換、800ms debounce 自動儲存；Database table view + row 編輯 dialog（select、date picker、currency 等）；**一鍵建立「💰 記帳」範本**（日期/類別/金額/帳戶/備註）與月份彙總（收入／支出／淨額／分類 breakdown） |

**結論：** 這是可持續擴充的 **MVP 架構與主要流程**，不是 Slack／Affine 的完整複製品。詳細功能項請見 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。

## 技術棧

- 前端: Flutter (Web/iOS/Android) + Riverpod
- 後端: NestJS + Prisma ORM
- 資料庫: PostgreSQL + Redis
- 檔案儲存: MinIO
- 即時通訊: Socket.IO + WebRTC（視訊為後續強化）
- 白板協作: Yjs（後端資料欄位預留，前端需再接 CRDT）
- 容器化: Docker Compose

## 快速開始

### 1. 啟動基礎服務

```bash
cd backend
docker compose up -d
```

### 2. 啟動後端

```bash
cd backend
docker compose up -d
cp .env.example .env   # 若已存在 .env，請確認 DATABASE_URL 埠號與下方一致
npm install
npx prisma migrate deploy
npm run start:dev
```

- **PostgreSQL 埠號**：`docker-compose.yml` 將資料庫對外映射為 **`localhost:5433`**（內部仍為 5432），避免與本機或其他 Docker 容器（例如已佔用 5432 的 `postgres`）衝突。`.env` 內 `DATABASE_URL` 必須使用 `5433`。
- 若仍出現 **P1000 認證失敗**：代表連到的不是 Oidea 這顆資料庫（常見是 `.env` 仍寫 `5432` 而該埠為別套服務）。請執行 `docker compose up -d` 並確認 `docker ps` 中有 `oidea-postgres`，且 `DATABASE_URL` 帳密為 `oidea` / `oidea_secret_dev`、埠為 `5433`。
- **`npx prisma migrate dev` 停在「Enter a name for the new migration」**：直接輸入名稱（例如 `init`）後 Enter；若要免互動，改跑 `npx prisma migrate dev --name init`。本 repo 已含初始 migration，一般只需 **`npx prisma migrate deploy`**。
- **P1002 advisory lock 逾時**：多半是另一個終端機仍開著 `migrate dev` 在等待輸入。請在那個視窗 **Ctrl+C** 結束後，再執行 `migrate deploy`。
- **終端機 `zsh: parse error near ')'`**：常是把整段說明（含「`1)`」開頭的中文註解）一起貼進 zsh，`)` 會被當成語法。請**一次只貼一行指令**，或只貼純指令不要貼註解。若出現 `^[[200~` / `^[[201~` 之類亂碼，代表「括號貼上模式」把說明文字也貼進去了，請清掉該行後重打指令。
- **`EADDRINUSE: address already in use :::3001`**：已有程式佔用 **3001**（常見是先前開過的 `npm run start:dev` 仍在背景或其它專案）。請在另一個終端機關掉舊程序：`lsof -i :3001` 查看 PID，再 `kill <PID>`；或關掉跑著 Nest 的那個終端機視窗。亦可暫時在 `backend/.env` 設 `PORT=3002` 並讓 Flutter 的 `API_URL`／`WS_URL` 改連新埠。
- 開發時 REST **CORS** 預設為 `origin: true`（方便 Flutter Web 任意本機埠）。正式環境請設定環境變數 `CORS_ORIGIN`（逗號分隔網域）。
- WebSocket（訊息閘道）同樣允許本機開發連線；生產環境請改為白名單。

### 3. 啟動 Flutter 前端

```bash
cd app
flutter pub get
flutter run -d chrome
```

可選：以 `--dart-define=API_URL=http://localhost:3001/api` 與 `--dart-define=WS_URL=http://localhost:3001` 指向後端。**實體手機**請改用電腦區網 IP，例如 `--dart-define=BACKEND_HOST=192.168.x.x`（會自動組出 REST `/api` 與 Socket 位址；埠非 3001 時再加 `BACKEND_PORT`）。

### 4. 建議體驗流程

1. 註冊／登入  
2. 頂端列建立或切換**工作空間**  
3. **聊天**：建立頻道、傳送訊息；**Markdown 格式** `**粗體** *斜體* `code`` 即時渲染；**`@username` 會高亮並為對方產生通知**；**回覆／討論串**、**搜尋**、**表情反應**、**正在輸入**；**附件**（迴紋針 → 選檔 → 訊息顯示檔名或縮圖）  
4. **專案**：建立專案 → 進入看板 → 新增任務時可選**優先級／負責人／截止日** → 卡片以色條／chips／頭像呈現 → 右上角**篩選**按 assignee/priority 組合 → **長按卡片拖曳到其他欄**；任務詳情可**上傳附件**、查看**活動日誌**  
5. **通知**：AppBar 右上角鈴鐺顯示未讀數（15s 輪詢）；點擊進入列表，可單筆或全部標為已讀  
6. **會議／白板**：建立資源並開啟對應頁面（WebRTC／CRDT 仍待迭代）  
7. **筆記**（底部第 5 個 tab）：  
   - 左側 Page 樹，可新建「📄 頁面」、「💰 記帳（含預設欄位）」、「📊 空白資料庫」  
   - 頁面內：點任意 block 旁的 `+` 可插入 text/h1/h2/h3/todo/bullet/numbered/quote/code/divider；拖曳圖示可轉換型別或刪除；輸入 800ms 後自動儲存  
   - 資料庫：table 顯示 row、點 row 開啟編輯 dialog；**記帳表另外顯示當月收入／支出／淨額與分類小計**  
8. **ERP**（底部第 6 個 tab）：  
   - **打卡**：上下班一鍵打卡、工時自動計算、本月一覽  
   - **報銷**：新建單據（金額／類別／說明）→ 財務／管理員審批或退回（附原因）→ 標記付款；狀態彙總條  
   - **請假**：選類別／日期範圍送出 → HR／Admin 核准或退回  
   - **成員與權限**：將成員切換為 `admin / hr / finance / member`（`owner` 不可動）

## 資料庫 Migration

新增 ERP 與知識庫模組後，請在 `backend/` 依序執行：

```bash
npx prisma migrate dev --name add_erp_modules
npx prisma migrate dev --name add_knowledge_modules
```

ERP migration 建立 `expenses`、`expense_approvals`、`expense_receipts`、`attendances`、`leave_requests` 五個資料表。知識庫 migration 建立 `knowledge_pages`、`knowledge_blocks`、`knowledge_databases`、`db_properties`、`db_rows` 五個資料表。首次同時跑時，可以合併為單次 `npx prisma migrate dev --name add_erp_and_knowledge`。

## API 文件

http://localhost:3001/api/docs

## 授權

MIT License
