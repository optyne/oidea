# Oidea 收斂藍圖 + 白板 GoodNotes 化設計

> 日期：2026-08-09
> 狀態：已與使用者逐節確認（藍圖／架構／資料與 API／錯誤與測試 四節皆核可）
> 產出流程：superpowers:brainstorming（逐題釐清 → 方案比較 → 分節設計確認）

## 0. 背景與定位

Oidea 是 8 個子系統、107 個功能項（見 [REQUIREMENTS.md](../../REQUIREMENTS.md)）的協作平台。
2026-08-09 與使用者完整確認後，收斂出當前身分：

> **使用者個人的 iPad 筆記與規劃工作站。**

釐清出的關鍵事實：

| 問題 | 答案 |
|---|---|
| 實際使用狀況 | 只有使用者一人在用（個人工作站） |
| 最重視的模組 | 白板（畫畫做筆記）、規劃（看板＋行事曆＋筆記資料庫） |
| 畫畫裝置 | **iPad + Apple Pencil**（唯一） |
| 白板參照產品 | GoodNotes（筆記本→頁的結構、手寫手感） |
| 白板必要缺口 | 選取拖曳（W-07）、Undo/Redo（W-12）、顏色面板（W-09）、筆記本結構 |
| 白板不需要 | 匯出（未選）、CRDT 多人協作、跨表連動 |
| 規劃不需要 | 重複任務／到期提醒（P-14/D-07 後端凍結） |
| 其他模組 | 聊天／ERP／試算表／檔案庫保持可用，不主動投入 |
| AI | `feat/ai-tagging` 分支改接自家 b300 GPU 端點後合併 |

## 1. 整體藍圖

### Phase 0 — 還債（小、先做）

1. **合併 invite TOCTOU 修復**：`feat/invite-link` 分支上的 `invites.service.ts`
   條件式 `updateMany` 修復（單次使用保證），原樣合併。
2. **刪除 10 個死分支**（獨有 commit = 0，內容已全在 main）：
   `claude/organize-pricing-contracts-biTxB`、`fix/redis-auth-and-pr2-migration`、
   `feat/erp-knowledge-expansion`、`feat/invite-member-by-email`、
   `feat/audit-and-ratelimit`、`fix/backend-dist-path`、`chore/dokploy-deploy`、
   `feat/knowledge-acl`、`feat/all-in-one`、`fix/backend-minio-graceful`。
3. **AI 模組改造後合併**：`feat/ai-tagging` 的 `@ai` 聊天功能，
   把 `@anthropic-ai/sdk` 換成 OpenAI 相容 client 指向 b300 端點；
   env 改為 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`；
   訊息組裝與頻率限制邏輯不動。CI 綠後合併。

（`feat/bot-integration`、pricing docs、deploy docs 三個小分支未在本輪決策範圍，
實作 Phase 0 時再單獨徵詢。）

### Phase 1 — 白板 GoodNotes 化（本 spec 主體，§2–4）

### Phase 2 — 規劃強化（另立 spec）

任務行事曆視角（改造現有會議行事曆）、看板體驗打磨、筆記資料庫（K 模組）強化。
Phase 1 出貨後另跑一輪 brainstorming。

### 凍結清單（不刪不壞，不再投入）

- 會議 WebRTC 全系列：M-03～M-10
- 懸空後端（測試留著、不接 UI）：C-15～C-18、P-14、P-15、D-02、D-04、D-07
- CRDT 協作（W-08）、已讀狀態（C-09）、推播（C-14）

## 2. 白板架構（方案 A：PencilKit 混合）

**決策**：墨水引擎用 iPad 原生 PencilKit，結構與導覽留在 Flutter。
評估過的替代方案 B（純 Flutter 自建選取／undo／筆壓）被否決：
2–4 週工作量只能到「堪用」，手感結構性追不上使用者的參照產品 GoodNotes。

### 分層

```
Flutter 層（跨平台）
├─ 筆記本清單    現有 whiteboard_home_page 改造：封面格狀
├─ 頁面縮圖格    新：筆記本內頁面，可新增／排序／刪除
└─ 畫布頁
    ├─ iPad/iPhone  UiKitView 嵌 PencilCanvasView（原生）
    └─ 桌面/Web     顯示頁面縮圖（唯讀）
iOS 原生層（Swift）
└─ PencilCanvasView = PKCanvasView + PKToolPicker
```

### MethodChannel 介面

| 方向 | 名稱 | 說明 |
|---|---|---|
| Flutter→原生 | `setDrawing(base64)` | 載入頁面筆跡 |
| Flutter→原生 | `getDrawing() → base64` | 取得目前筆跡（PKDrawing dataRepresentation） |
| Flutter→原生 | `undo()` / `redo()` | 接 PKCanvasView 的 UndoManager |
| Flutter→原生 | `renderThumbnail(maxWidth) → pngBase64` | 產生頁面縮圖 |
| 原生→Flutter | `onDrawingChanged`（防抖） | Flutter 標記 dirty、啟動自動存檔計時 |

- 筆壓、傾斜、防手掌誤觸、套索選取、顏色面板：PKToolPicker 原生內建，零實作。
- Undo/Redo 按鈕放 Flutter 頂欄（iPad 常規尺寸工具列不帶 undo 鈕）。
- PKToolPicker 需要 first-responder 掛載（已知固定模式）——列為第一個實作步驟的
  技術驗證點。

### 舊資料策略

現有 1,573 行 Flutter 畫布**保留**。舊白板（無 pages 的）繼續用它開啟；
不做資料遷移，新筆記從新結構開始。

## 3. 資料模型與 API

### Prisma（新增一個 model；`Whiteboard` 原樣作為「筆記本」）

```prisma
model WhiteboardPage {
  id           String    @id @default(uuid())
  whiteboardId String
  position     Int
  drawing      Bytes?    // PKDrawing dataRepresentation（bytea，不 base64 進 DB）
  thumbnailId  String?   // File id → MinIO PNG，桌面唯讀檢視用
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  deletedAt    DateTime?

  whiteboard Whiteboard @relation(fields: [whiteboardId], references: [id], onDelete: Cascade)

  @@map("whiteboard_pages")
}
```

### API（掛在現有 whiteboard controller，沿用 workspace ACL）

| 端點 | 用途 |
|---|---|
| `GET  /whiteboards/:id/pages` | 頁面清單：id、position、縮圖 URL、updatedAt（**不含筆跡**） |
| `GET  /whiteboards/:id/pages/:pid` | 單頁筆跡（base64 傳輸） |
| `POST /whiteboards/:id/pages` | 新增頁（position 預設接尾） |
| `PUT  /whiteboards/:id/pages/:pid` | 存筆跡＋縮圖（縮圖經 files module 進 MinIO） |
| `PATCH /whiteboards/:id/pages/reorder` | 以 orderedIds 全量重排 |
| `DELETE /whiteboards/:id/pages/:pid` | 軟刪除（沿用 deletedAt 慣例） |

### 存檔流

- 筆畫停 2 秒 → 自動存
- 離開頁面 → 強制存
- 縮圖節流：最多每 30 秒重產一次

## 4. 錯誤處理與測試

### 錯誤處理

| 情境 | 行為 |
|---|---|
| 存檔失敗 | 指數退避重試；dirty 不清除；頂部「未同步」橫幅 |
| 離開頁面未存成 | 擋可取消的存檔 spinner |
| 筆跡過大 | >10MB 警告（個人規模 bytea 可行；超標再議搬 MinIO） |
| 離線 | 照畫不擋，存檔排隊重試 |

### 測試與驗收

- **後端（進 CI）**：pages CRUD／reorder／workspace ACL 的 Jest spec，沿用現有模式。
- **Flutter（進 CI）**：筆記本格與頁面縮圖格的 widget test。
- **原生層（實機驗收清單，Phase 1 完成定義）**：
  1. Pencil 畫線有筆壓粗細變化
  2. 手掌貼螢幕不誤畫
  3. 套索選取後可移動物件
  4. Undo／Redo 正確
  5. 殺 App 重開，筆跡還在（存檔閉環）
  6. 桌面端能看到該頁縮圖（唯讀）

### 風險

| 風險 | 處置 |
|---|---|
| iPad 部署管道（Xcode 簽章實機安裝） | Phase 1 第一步先打通 |
| PKToolPicker first-responder 掛載 | 第一個實作步驟做技術驗證，1–2 天內確認；失敗則退方案 B |
| PKDrawing 為 Apple 私有格式 | 接受（僅 iPad 編輯）；縮圖 PNG 保底跨平台可讀 |

## 範圍外（明確不做）

- 白板匯出（W-10）、範本（W-11）、連線工具（W-06）、嵌入連結（W-13）
- 任何多人協作／CRDT
- 舊白板資料遷移到新頁面結構
- Phase 2 規劃強化的細節設計（另立 spec）
