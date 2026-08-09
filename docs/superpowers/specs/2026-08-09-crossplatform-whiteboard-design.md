# 跨平台白板編輯設計（雙格式：PencilKit + Excalidraw 微前端）

> 日期：2026-08-09
> 狀態：已與使用者逐節確認（資料格式／架構／能力縮圖／分流測試 + Excalidraw 修訂版皆核可）
> 前置：PR #45（GoodNotes 式筆記本，PencilKit）已合併上線
> 產出流程：superpowers:brainstorming（含一次方向重決 —— 使用者將優化目標定為
> **長期效益優先於出貨速度**，通用畫布因此由「Flutter 自建引擎」改為「Excalidraw 微前端」）

## 0. 背景與決策

PR #45 後的白板：筆記本→頁，頁 = PencilKit 墨水（iPad 專屬編輯，他處唯讀縮圖）。
使用者新需求：**網頁版、Android、Windows 也要能畫**。

釐清結果：

| 問題 | 答案 |
|---|---|
| 手感 vs 同一頁到處可編 | **雙格式混合** —— 兩者都要，接受頁的能力不對稱 |
| 非 iPad 的輸入裝置 | 滑鼠/觸控板、**Android 平板 + 觸控筆**、手機觸控（未選 Windows 筆）|
| 建頁格式策略 | 依裝置自動：非 iOS 一律通用格式；iPad 預設 PencilKit，長按「新增頁」可選通用 |
| 通用編輯器來源 | 評估 Flutter 自建（A）/ Excalidraw 微前端（B）/ 全面 React（C）後選 **B** |

**選 B 的理由（長期效益）**：畫布生態系在 JS（Excalidraw MIT、perfect-freehand 筆壓平滑內建、
開放 JSON 格式）；自建引擎是永久維護債，微前端只持有一座薄橋；若未來走 React web-first，
畫布已經是 React —— 以最小成本對沖方向風險。C（全面 React）不由白板單一功能觸發，
需另立產品層討論。

## 1. 資料模型與格式

- `WhiteboardPage` 新增欄位：`format String @default("pencilkit")`
  —— migration 以 default 回填，既有頁（全為 PencilKit）自動正確。
- `drawing` bytes 語意由 format 決定，server 一律不解析：
  - `pencilkit`：PKDrawing dataRepresentation（現狀）
  - `excalidraw`：UTF-8 JSON 的 Excalidraw scene（`elements` + 篩選後 `appState`；
    **v1 不含嵌入圖檔**，控制 bytes 大小）
- API 最小變化：
  - `GET /whiteboard/:id/pages` 與 `GET .../pages/:pid` 回傳加 `format`
  - `POST .../pages` body 可帶 `{format: 'pencilkit' | 'excalidraw'}`；
    缺省 `pencilkit`（與已安裝的舊版 iPad App 相容）；非法值 → 400
  - `PUT` savePage 不變（bytes 不解析、縮圖管線照舊）

## 2. 架構：Excalidraw 微前端 + 橋

### canvas-web/（新的獨立 React 小 App）

```
canvas-web/
├─ src/App.tsx     Excalidraw 元件 + 存檔邏輯：
│                  筆畫停 2s 自動存；關頁（pagehide/visibilitychange）強制存；
│                  失敗指數退避 5→60s；語意鏡射 pencil 頁的存檔閉環
├─ src/bridge.ts   與宿主的握手協定
└─ vite 建置 → 產物由現有 web nginx 同源服務於 /canvas/
```

技術棧：Vite + React + `@excalidraw/excalidraw`（MIT）。
建置整合：`app/Dockerfile` 加一個 node build stage，把 `canvas-web/dist`
拷進 nginx html 的 `/canvas/`。

### 橋協定（iframe 與 WebView 同一套）

1. wrapper 載入後送 `ready`
2. 宿主回 `init { token, boardId, pageId, apiBase }` —— **token 走 postMessage 握手，不進 URL**
3. 之後 wrapper 自己以 fetch 打 pages API（與宿主解耦）
4. wrapper 事件回報：`dirty` / `saved` / `error`（宿主顯示「未同步」狀態）

### 各平台宿主

| 平台 | 開啟方式 |
|---|---|
| Web（Flutter web） | `HtmlElementView` iframe（同源，postMessage 最穩） |
| Android / iPad | `webview_flutter`（官方套件）內嵌同一 wrapper，JS channel 走同協定 |
| Windows / macOS 桌面 | **v1 開外部瀏覽器**至 web 版同一頁（避免非官方 WebView 套件整合險） |

## 3. 能力、縮圖、技術驗證

| 能力 | 來源 |
|---|---|
| 筆壓 | Excalidraw 手繪基於 perfect-freehand，原生支援 pointer pressure |
| 平滑 | perfect-freehand 內建 |
| 防手掌 | wrapper 實作 `stylusOnly` 開關：capture 階段攔非 `pen` pointerType 的落墨、轉為平移。**技術驗證頭號題目** |
| 縮圖 | wrapper 以 `exportToBlob` 產 PNG → base64 → 現有 savePage thumbnail 參數 → 全平台真縮圖 |

### Spike 先行（1–2 天，任一失敗退回方案 A：Flutter 自建引擎）

1. Android WebView：筆壓有效 + stylusOnly 手掌過濾可用
2. iframe postMessage 橋：握手 → 載入頁 → 存檔 → 讀回，全鏈打通
3. `exportToBlob` 縮圖落 MinIO 並顯示於頁面格

## 4. 路由分流、平台矩陣、測試

- 頁面格點頁 → 依 `format` 分流：`excalidraw` → 微前端宿主頁（全平台可編）；
  `pencilkit` → 現行 pencil 頁（iPad 編輯、他處唯讀提示）
- 新增頁：非 iOS 一律 `excalidraw`；iPad 預設 `pencilkit`、長按「新增頁」選單可選 `excalidraw`
- 頁面格：`excalidraw` 頁標「到處可編」小徽章

| 平台 | pencilkit 頁 | excalidraw 頁 |
|---|---|---|
| iPad / iPhone | ✏️ 編輯（PencilKit） | ✏️ 編輯（WebView wrapper） |
| Web | 👁 唯讀縮圖 | ✏️ 編輯（iframe） |
| Android | 👁 唯讀縮圖 | ✏️ 編輯（WebView，筆壓+防手掌） |
| Windows / macOS 桌面 | 👁 唯讀縮圖 | ✏️ v1 導外部瀏覽器編輯 |

### 錯誤處理

- wrapper 存檔閉環語意同 pencil 頁：失敗退避重試、dirty 不清、`error` 事件讓宿主顯示未同步
- scene JSON 解析失敗 → wrapper 顯示載入失敗 + 重試，**不進編輯**（防「壞載入→空白→自動存檔覆寫」，與 pencil 頁同策略）
- WebView/iframe 載入失敗 → 宿主顯示重試頁

### 測試與驗收

- 後端：format 欄（預設/顯式/非法值 400、list 回傳）單元測試
- canvas-web：bridge 協定單元測試（vitest）；存檔閉環邏輯測試
- Flutter：分流路由 widget test；宿主頁載入失敗重試 test
- 既有 30 Flutter + 179 backend 測試全綠不動（pencil 頁與 legacy 畫布零觸碰）
- 實機驗收：① Android 平板筆壓+防手掌 ② web 滑鼠畫+真縮圖 ③ iPad 開 excalidraw 頁可編
  ④ pencilkit 頁在 web 唯讀 ⑤ 殺頁重開筆跡在（兩格式各驗）

## 範圍外（明確不做）

- 跨格式互轉（PencilKit 頁 ↔ Excalidraw 頁）
- 多人即時協作（Excalidraw 支援但不啟用；CRDT 仍在凍結清單）
- Excalidraw 嵌入圖檔（v1 禁用）
- 全面 React 前端遷移（另立討論）
- Windows/macOS 原生 WebView 內嵌（v1 外部瀏覽器）

## 風險

| 風險 | 處置 |
|---|---|
| Android WebView 手掌過濾不可行 | spike 第 1 題；失敗退方案 A |
| Flutter web iframe 與 HtmlElementView 的鍵盤/焦點怪癖 | spike 第 2 題涵蓋 |
| Excalidraw 升版 breaking changes | 鎖版本 + 開放 JSON 格式保底（資料不被綁架） |
| scene JSON 過大 | v1 禁嵌圖；沿用 20mb 上限與（合併後待辦的）413 處理 |
