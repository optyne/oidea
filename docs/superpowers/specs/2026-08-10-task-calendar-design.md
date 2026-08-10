# 任務日曆設計（個人統一日曆：任務 ＋ 會議）

> 日期：2026-08-10
> 狀態：已與使用者逐節確認（內容範圍／互動模型 二題皆核可）
> 產出流程：superpowers:brainstorming（探索現況 → 方向二選一 → 互動模型三選一 → 分節設計確認）
> 前置：跨平台白板（PR #46，待實機驗收）；Phase 0 還債、Phase 1 白板 GoodNotes 化皆已上線
> 定位：使用者個人的 iPad／桌機工作站，一人在用

## 0. 背景與決策

Phase 2「規劃強化」三個獨立方向（任務日曆／看板打磨／筆記資料庫視圖），本 spec 只處理第一個 ——
**任務日曆**。其餘兩個之後各自跑一輪 brainstorming。

釐清結果：

| 問題 | 答案 |
|---|---|
| 日曆裝什麼 | **個人統一日曆** —— 跨所有專案的任務（依 dueDate）＋ 既有會議，同一頁呈現 |
| 在日曆上能做什麼 | **拖曳改日期 ＋ 點空天建任務 ＋ 點任務開詳情**（非唯讀） |
| 任務日期欄位 | dueDate（任務只有日期、列為「全天」；無時刻排程） |
| 會議去哪 | 留在日曆上一起看；會議的建立/編輯/視訊房間不動 |

**為什麼改造而非新建**：`meeting_home_page.dart`（973 行）已有月/週/日 `TableCalendar` + 自訂時間格
（`_TimeGridView`/`_DayColumn`）+ `eventLoader`，整套 UI 與資料無關（吃一個 list）。擴資料來源
（會議 list → 任務＋會議）是最小改動；另開新頁會複製整套日曆 widget 並造成「兩處看會議」。

## 1. 導覽與路由

- 路由 `/meetings` → `/calendar`（側欄「會議」改名「行事曆」）。原頁 `MeetingHomePage` 改名
  `CalendarPage`，檔案 `meeting_home_page.dart` → `calendar_page.dart`。
- 會議視訊房間路由 `/meetings/room/:meetingId` 保持不動（WebRTC 仍凍結）。
- 點任務跳 `task_detail_page`（既有路由 `/projects/board/:projectId/task/:taskId`），不為日曆另開頁。

## 2. 資料模型與 API

### 既有不動

- `Task.dueDate DateTime?`（看板已用）、`Task.priority`、`Task.projectId`、`Task.assigneeId`、
  `Meeting.startTime/endTime`、`TaskActivity`（action 欄位為 enum 字串）。
- 會議端點 `GET /meetings/workspace/:workspaceId` 原樣使用。

### 新增

| 端點 | 用途 |
|---|---|
| `GET /tasks/calendar?from=<ISO>&to=<ISO>` | 當前使用者在工作區內、dueDate 落在 `[from,to]` 的任務（跨專案）。回傳精簡欄位：id、title、dueDate、priority、projectId、projectName、columnId、completed。 |
| `PUT /tasks/:id/reschedule` | body `{ dueDate: ISO \| null }`。改 `Task.dueDate`；寫一筆 `TaskActivity`（action `'rescheduled'`，details 記新舊日期）。null = 清除日期。 |

- `GET /tasks/calendar` 的可見範圍：呼叫者所屬工作區的專案中，**指派給呼叫者、或無指派人**
  的任務（solo 使用者＝該工作區唯一成員，即全部任務）。沿用既有 workspace ACL 模式鑑權。
- 點空天建任務：沿用 `POST /tasks`（既有 DTO 已接受 dueDate）。
- `reschedule` 的設計語意對齊看板 `PUT /tasks/:id/move`（專屬動詞 + activity 軌跡），
  不沿用通用 `PUT /tasks/:id`，以求軌跡清楚與前端呼叫明確。

## 3. 日曆呈現

`CalendarPage` 的 `eventLoader` 合併兩個來源：

- 任務：日期 = `dueDate`
- 會議：日期 = `startTime`

**視覺區分**：

| 類型 | 月視圖 | 週/日視圖 |
|---|---|---|
| 任務 | 格內依 priority 小色點（urgent 紅 / high 橘 / medium 藍 / low 灰） | 「全天區」置頂橫排 chip（同 priority 色，標題＋完成勾） |
| 會議 | 維持現有 marker | 維持現有：依 startTime/endTime 排在 day column |

- 已完成任務：灰顯 ＋ 刪除線。
- 月/週/日切換維持現有三段鈕（`_CalView { month, week, day }`）。

## 4. 互動

| 動作 | 行為 |
|---|---|
| 點任務 | `context.go('/projects/board/$projectId/task/$taskId')` |
| 拖曳任務到別天 | 月：拖色點到格；週/日：拖 chip 到別天 column → `PUT /tasks/:id/reschedule { dueDate: 新日期 }`。**樂觀更新 ＋ 失敗回滾**（鏡射看板拖曳 `board_page.dart` 的 `_onTaskDropped` 模式） |
| 點空天／格內「＋」 | 建任務對話框：預填 dueDate、選專案、選欄位（預設該專案第一欄 position=0）→ `POST /tasks`（`projectId`+`columnId` 皆必填）；成功後 invalidate 日曆與看板 provider |
| 點會議 | 維持現有 join 預覽（`_JoinPreviewModal`），不動 |

### 過濾

- 兩個開關：顯示任務 / 顯示會議（預設都開）。
- v1 不做專案篩選（YAGNI；單人工作站「全部」就夠，之後要再加）。

## 5. 錯誤處理與測試

### 錯誤處理

| 情境 | 行為 |
|---|---|
| 日曆載入失敗 | 沿用 `AppErrorWidget` + 重試（既有 pattern） |
| 拖曳 reschedule 失敗 | 回滾任務到原日期 ＋ toast「改日期失敗，已還原」 |
| 建任務失敗 | 對話框保留輸入 ＋ 顯示錯誤，不清空 |
| dueDate 被 null（清除） | chip 從日曆消失（資料仍在看板可見） |

### 測試與驗收

- **後端（進 CI）**：
  - `reschedule`：改 dueDate、寫 activity、null 清除、跨工作區拒絕（ACL）。
  - `calendar` 查詢：區間過濾正確、跨專案回傳、只回指派自己或未指派、排除其他工作區。
  - 既有 183 後端測試全綠不動。
- **Flutter（進 CI）**：widget test
  - 任務出現在 dueDate 那天、會議出現在 startTime 那天。
  - 「顯示任務」關 → 任務消失。
  - 拖曳觸發 reschedule 呼叫（fake api 攔截）。
  - 既有 31 測試全綠不動。
- **實機驗收（使用者）**：
  1. 桌機/瀏覽器：月視圖看得到跨專案任務色點；拖到別天後看板 dueDate 也變。
  2. 點空天建任務 → 選專案 → 看板出現該任務且 dueDate 正確。
  3. 點任務 → 開詳情。
  4. 會議與任務同時顯示、開關各自隱藏。
  5. iPad 同樣操作（觸控拖曳）。

## 6. 範圍外（v1 明確不做）

- 任務時刻排程（09:00 之類）—— 任務只有日期、列為全天。
- 任務跨天區間（startDate→dueDate 橫跨多天）—— 使用者已選不做。
- 提醒（D-07）併入日曆 —— 提醒頁維持獨立。
- 會議的建立/編輯/視訊改動 —— 不動；WebRTC 持續凍結。
- 週期任務（P-14）在日曆展開 —— 無 UI、不做。
- 專案篩選 —— 之後再加。

## 7. 風險

| 風險 | 處置 |
|---|---|
| `table_calendar` 拖曳到格的支援度未知 | 週/日 column 拖曳先做（用既有 `Draggable`/`DragTarget`）；月視圖拖曳若套件不支援，月視圖改為「點格＝聚焦該日下方清單，拖曳只在週/日」—— 不阻塞核心價值 |
| `meeting_home_page.dart` 973 行重構改名引入迴歸 | 改名為純檔名/類別名調整＋資料來源抽換；不改日曆 widget 內部；既有會議功能以「資料來源只含會議」時行為不變為驗收基線 |
| `TaskActivity.action` 加新值 `rescheduled` | **已確認**：schema 中 `action String`（自由字串、非 DB enum），新增值免 schema 變更 |
| 跨專案任務量大導致月視圖色點過密 | 單格超過 N 個顯示「＋more」，點開展開（v1 先取 N=4，超出以數字標示） |

## 附帶：過時文件標籤清整（獨立小修，併入實作計畫）

REQUIREMENTS.md 下列項目實際已有 UI，狀態過時，順手翻正：

- `P-09` 清單檢視 `[ ]` → `[x]`（`board_page.dart` `_ListView` 已實作）
- `P-10` 甘特圖 `[ ]` → `[x]`（`board_page.dart` `_GanttView` 已實作）
- `M-02` 行事曆介面 `[~]` → `[x]`（`meeting_home_page.dart` 月/週/日已實作）
- `D-07` 提醒 `[~]` → `[x]`（`reminders_page.dart` 已實作並接後端）
