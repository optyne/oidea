# SPIKE — Excalidraw 可行性驗證

時間盒：2 天（本次執行約半天完成 (a)(b) 與 (c) 的準備）。
目的：在寫任何正式 Task 4 程式碼之前，驗證三個未知數：iframe 橋 + 真實 pages API
round-trip、`exportToBlob` 縮圖、Android 觸控筆 pointer 事件。

## 結論摘要

**GO**（(a)(b) 本機驗證通過，且沒有任何跡象顯示 (c) 不可行；(c) 待使用者用
Android 平板做最終確認——見下方「探針 (c)」章節的 `pending-user` 標記）。

理由與細節見下。

## 鎖定版本

```
@excalidraw/excalidraw@0.18.1
```

`npm install` 解析出的確切版本，已寫回 `canvas-web/package.json`
（`"@excalidraw/excalidraw": "0.18.1"`，非 `"latest"`）。搭配版本：

| 套件 | 版本 |
|---|---|
| react / react-dom | 18.3.1 |
| vite | 6.4.3 |
| @vitejs/plugin-react | 4.7.0 |
| typescript | 5.9.3（`devDependencies` 宣告 `^5.6.0`，實際解析到 5.9.3） |
| vitest | 2.1.9 |

`npx tsc --noEmit`：0 錯誤。`npm run build`（`tsc --noEmit && vite build`）：成功，
4.61s，輸出 `canvas-web/dist`（約 8.0MB，含 Excalidraw 內建的 mermaid-to-excalidraw
功能與其 40+ 語系 chunk——見下方「觀察與建議」）。

## 環境

- 後端：本機 `docker compose up -d`（postgres/redis/minio，皆 healthy）+
  `npm run start:dev`（NestJS，`localhost:3001`，`/api` 前綴，開發環境 CORS 允許任意
  origin）。179 個既有測試未重跑（spike 不改動 backend），僅透過真實 HTTP 呼叫驗證。
- 前端 spike app：`localhost:5173`（vite dev，`base: '/canvas/'`）。
- 探針帳號：`spike-canvas@example.com` / workspace `Spike Canvas WS`
  (`5746560a-6c4e-4980-b758-68b7ca7e8012`) / whiteboard `Spike Canvas Board`
  (`372aa2a2-e5fb-46c7-a84b-0208292fc039`) / page
  (`75859406-4c6d-4ac7-a0ff-2c4874c7444a`)，皆透過 curl 對 `POST /api/auth/register`
  → `POST /api/workspaces` → `POST /api/whiteboard` → `POST /api/whiteboard/:id/pages`
  建立。

## 探針 (a)：iframe 橋握手 + 真實 pages API round-trip — **PASS**

流程：`spike-host.html?t=<token>&b=<boardId>&p=<pageId>` 用瀏覽器開啟
→ iframe 載入 `localhost:5173/canvas/` → App 送出 `{type:'ready'}` →
host 回 `{type:'init', token, boardId, pageId, apiBase}` → App 收到後
立刻 `GET /api/whiteboard/:boardId/pages/:pageId`。

證據（瀏覽器截圖中 spike UI 上方的 log 列）：

```
init 收到 boardId=372aa2a2-e5fb-46c7-a84b-0208292fc039
載入頁 HTTP 200
```

存檔後重新整理 iframe（見探針 (b) 之後），再次觸發 init → 載入頁，log 同樣顯示
`載入頁 HTTP 200`，證實橋在「已有筆跡的頁」上也能正常握手 + 讀取，不只是空頁。

## 探針 (b)：`exportToBlob` 縮圖 — **PASS**

流程：用畫筆工具在畫布上畫一筆（freedraw 元素），點擊「探針：存檔+縮圖」→
`api.getSceneElements()` 取得元素 → base64 編碼存成 `drawing` → `exportToBlob(...)`
產生 PNG → base64 編碼存成 `thumbnail` → `PUT /api/whiteboard/:boardId/pages/:pageId`。

App 端 log：

```
存檔+縮圖 HTTP 200
```

伺服器端 read-back 證據（與 App 端 log 分開驗證，避免自驗）：

- `GET /api/whiteboard/:boardId/pages/:pageId` 回傳的 `drawing` 欄位 base64 解碼後：
  ```json
  {"type":"excalidraw","version":2,"elements":[{"id":"WsLNBZsP5Y-2F4iAOdlX6","type":"freedraw","x":800,"y":447.5,"width":320,"height":80,...
  ```
  長度 603 bytes，確實含剛畫的 freedraw 元素——不是空殼。
- `GET /api/whiteboard/:boardId/pages` 列表回傳的 `thumbnailUrl` 非 null：
  `localhost:9000/oidea-uploads/5746560a.../1786265124509-whiteboard-page-....png`。
- 直接對 MinIO 用 `mc stat` 確認物件存在：`Size: 4.5 KiB`。下載後用 PIL 解碼：
  `680 x 200, RGBA` 的合法 PNG（非空白/損毀檔案）。

**結論**：`exportToBlob` → base64 → `PUT` → MinIO 上傳整條鏈路在真實後端上全部走通，
沒有任何一步是模擬的。

## 探針 (c)：Android 實機 pointer 事件 — **pending-user，已備妥**

此步驟需要使用者的 Android 平板，本次執行者無法完成，狀態標記 `pending-user`。
已完成的準備工作：

1. **已驗證 build 產物正確**：`npm run build` 產出 `canvas-web/dist`，其
   `index.html` 內資源路徑為絕對路徑 `/canvas/assets/...`（因 `vite.config.ts` 設
   `base: '/canvas/'`）。**直接 `npx serve dist` 或 `python3 -m http.server` 在
   `dist` 目錄下起服務會 404**（`/canvas/assets/...` 在該目錄下不存在）——已用
   `python3 -m http.server`（僅 localhost，未對外）實測確認此問題，並驗證了修正法。

2. **正確的暴露方式**（修正法，已在本機 localhost-only 驗證 `/canvas/` 路徑
   回傳 200，含 HTML 與 JS asset）：

   ```bash
   cd canvas-web && npm run build
   mkdir -p /tmp/oidea-lan-serve
   ln -sf "$(pwd)/dist" /tmp/oidea-lan-serve/canvas
   cd /tmp/oidea-lan-serve && python3 -m http.server 5500 --bind 0.0.0.0
   ```

   （macOS 首次執行可能跳出「允許傳入連線」的防火牆提示，需允許。）

3. **取得本機區網 IP**（執行 spike 當下為 `192.168.0.25`，網路重連可能改變，
   使用者操作前請重新確認）：

   ```bash
   ipconfig getifaddr en0
   ```

4. **Android 平板操作**：Chrome 開啟 `http://<上一步的 IP>:5500/canvas/`
   （例：`http://192.168.0.25:5500/canvas/`）。不需要帶 `t`/`b`/`p` 參數——
   探針 (c) 的 pointer 監聽與 init 握手無關，畫布可直接使用。用觸控筆畫線，
   再用手指畫線，觀察畫面上方 log 列。

5. **判讀標準**：

   | 現象 | 判讀 |
   |---|---|
   | 觸控筆畫線時 log 出現 `pointer pen p=0.xx`，且 `p` 值隨下筆力道明顯變化（不是固定同一個數字） | **PASS** —— pointerType 與 pressure 皆可用，Task 4 可依此做壓感筆刷 |
   | 觸控筆畫線時 `pointerType` 顯示 `touch` 或 `mouse`（不是 `pen`），或 `p` 值固定不變（例如恆為 0.50 或 1.00） | **CONCERN** —— 該裝置/瀏覽器對 pen 的辨識或壓力回報有問題，需要記錄裝置型號、Chrome 版本，回報給 controller 判斷是否需要 fallback（例如退化為固定線寬） |
   | 手指畫線時 log 出現 `pointer touch p=...`（pressure 值意義不大，觸控通常回報 0 或 1） | **PASS**（區分手指與筆的能力正常，可用於「手指平移/筆繪畫」的手勢區隔） |
   | 頁面完全空白、Excalidraw 沒有渲染出來 | **NO-GO 證據**——但根據本次桌面瀏覽器驗證（見下方 CSS delta），這通常代表漏了 `@excalidraw/excalidraw/index.css` 的 import；目前 `App.tsx` 已包含此行，理論上不會發生，若仍發生請截圖回報 |

   探針 (c) 沒有自動化驗收條件（pointerType/pressure 是硬體與瀏覽器實作行為，
   無法在沒有實體筆的環境模擬），因此本次執行者只驗證了程式碼本身能正確捕捉
   `pointerdown` 事件（見下方「已驗證但非探針 (c) 本身」）。

**已驗證但非探針 (c) 本身**：在桌面瀏覽器用滑鼠觸發 `pointerdown`，log 正確顯示
`pointer mouse p=0.00`（`pointerType` 判讀正確、mouse 的 pressure 恆為 0 符合預期），
證實 pointer 事件監聽程式碼本身沒有邏輯錯誤——唯一未驗證的是 Android 裝置上
`pen`/`touch` 的實際回報值，這是探針 (c) 存在的真正原因，無法用滑鼠替代驗證。

## API 對照表（brief 程式碼 vs. 0.18.1 實測差異）

後續任務（尤其 Task 4）以本表為準：

| 項目 | brief 假設 | 0.18.1 實測 | 需要的修正 |
|---|---|---|---|
| `Excalidraw` / `exportToBlob` import 路徑與具名匯出 | `from '@excalidraw/excalidraw'` | 相同，`index.d.ts` 確認兩者皆為具名匯出 | 無需修正 |
| `excalidrawAPI` prop | `<Excalidraw excalidrawAPI={(api) => ...} />` | 型別簽章相同（`ExcalidrawProps['excalidrawAPI']`） | 無需修正 |
| `exportToBlob(opts)` 參數 | `{ elements, appState, files, mimeType, maxWidthOrHeight }` | 型別簽章相同（`ExportOpts & { mimeType?, quality?, exportPadding? }`） | 無需修正 |
| **CSS** | brief 程式碼未 import 任何 CSS | **0.18 起 CSS 已從 JS bundle 抽出**，套件另外匯出 `@excalidraw/excalidraw/index.css`。不 import 這行，Excalidraw 完全不套版——工具列、面板等全部退化成無樣式的原生 HTML（已截圖對照驗證：有無此行是「正常渲染」與「完全跑版看不出是繪圖工具」的差別） | **必加**：`import '@excalidraw/excalidraw/index.css';`（已加進本 spike 的 `App.tsx` 第 3 行，Task 4 正式程式碼務必保留） |
| `maxWidthOrHeight` 與縮圖實際像素尺寸 | 隱含假設「傳 512 就會得到 ≤512px 的圖」 | **只在「元素 bbox + padding」的縮放後尺寸超過 `maxWidthOrHeight` 時才會裁切**；未超過時，實際輸出像素 = 基礎尺寸 × `appState.exportScale`（若呼叫時傳入 `api.getAppState()`，`exportScale` 預設值可能等於裝置 `devicePixelRatio`）。本次在 DPR=2 的測試環境，一筆很小的線（bbox 約 320×80）產出的縮圖是 **680×200**，超過 512 的上限直覺——因為 `exportScale` 把「已經小於上限」的圖再放大了 2 倍，`maxWidthOrHeight` 沒有介入裁切 | Task 4 若對縮圖檔案大小/像素有硬性上限（例如 MinIO 儲存成本、行動網路頻寬），**不要直接傳整包 `api.getAppState()`**；改傳 `{ ...api.getAppState(), exportScale: 1 }` 或明確固定一個 `exportScale` 值，避免高 DPR 裝置（多數 Android/iPad）產出比預期大 2–3 倍的縮圖 |
| bundle 大小 | 未提及 | `npm run build` 產出約 8.0MB（`dist/`），含 Excalidraw 內建的「Mermaid 圖轉手繪」功能與其 40+ 語系 chunk（`mermaid-to-excalidraw` 相依），多個 chunk 超過 500KB 警告 | 非阻塞項，但 Task 4 若在意首次載入時間（micro-frontend 透過 iframe 載入，使用者等待感知明顯），可評估是否需要 `manualChunks` 或確認 Mermaid 功能是否真的需要（白板頁不太可能用到「貼 Mermaid 語法轉手繪圖」這個功能） |

## 觀察與建議（給 Task 4）

1. **CSS import 是硬性必要項**，不是可有可無的美化——沒它 Excalidraw 是完全不能用
   的殘破畫面，務必在 Task 4 的正式元件保留。
2. **縮圖尺寸建議明確控制 `exportScale`**，否則不同裝置 DPR 會產出大小不一致的縮圖，
   影響 MinIO 儲存量體與頁面列表載入速度。
3. **CORS**：目前後端開發環境 `CORS_ORIGIN` 未設定時允許任意 origin（`main.ts`
   `corsOrigin ? ... : true`）。正式部署 canvas-web 到 `/canvas/`（與 Flutter Web
   同源）理論上不需要 CORS（同源請求），但若後續改為獨立網域或子網域，需要記得
   收斂 `CORS_ORIGIN` 白名單，不能依賴目前這個「開發環境允許全部」的預設值。
4. **thumbnail 上傳失敗不連坐筆跡存檔**（見
   `backend/src/whiteboard/whiteboard-pages.service.ts` 的既有設計）——這與
   PencilKit 頁面的既有行為一致，Task 4 的 Excalidraw 頁不需要改變這個容錯策略。
5. **iframe 橋協定本身沒有版本協商**：`{type:'ready'}` / `{type:'init'}` 是裸
   type 判斷，沒有 schema version 欄位。Task 4 若預期未來會迭代橋協定，建議现在就加
   一個 `version` 欄位，避免以後 Flutter WebView 端與 canvas-web 端版本不同步時
   互相看不懂訊息卻沒有任何錯誤訊號。

## 檔案清單

- `canvas-web/package.json`（鎖定 `@excalidraw/excalidraw@0.18.1`）
- `canvas-web/tsconfig.json`
- `canvas-web/vite.config.ts`
- `canvas-web/index.html`
- `canvas-web/src/main.tsx`
- `canvas-web/src/App.tsx`（探針版；比 brief 程式碼多一行 CSS import，見上方對照表）
- `canvas-web/spike-host.html`（模擬宿主，與 brief 逐字相同）
- `canvas-web/.gitignore`（`node_modules/`、`dist/`、`*.tsbuildinfo` 等，backend 同款）
- `canvas-web/SPIKE.md`（本檔）

## GO/NO-GO 建議

**GO**。理由：

- 探針 (a)(b) 在真實後端（非 mock）上完整走通，包含資料庫、MinIO 檔案儲存，
  且以伺服器端 read-back（非 App 自己宣稱）驗證了資料真的落地、縮圖真的是合法 PNG。
- 探針 (c) 沒有任何跡象顯示不可行——pointer 事件監聽程式碼邏輯本身已驗證正確
  （滑鼠情境下 pointerType/pressure 判讀無誤），Android Chrome 對 `PointerEvent`
  的 `pointerType`/`pressure` 支援是成熟穩定的瀏覽器標準能力（非實驗性 API）。
  唯一剩下的不確定性是特定裝置的硬體/驅動回報品質，這正是 (c) 需要使用者實機
  驗證的原因，不代表可行性有疑慮。
- 找到的兩個 API delta（CSS import、`exportScale` 放大縮圖）都是小範圍、
  有明確修法的問題，不影響架構可行性判斷。

**controller 待辦**：安排使用者用 Android 平板依上方「探針 (c)」章節的指令與
判讀標準完成最終確認，並將結果（PASS/CONCERN + 裝置型號）補回本檔或
task-1-report.md，才能把 GO 從「建議」轉為「定案」。
