# 競品簡報：白板功能優先序（2026-08）

> 目的：為 Oidea 白板 Phase 2 排功能優先序。
> 範圍：手寫筆記賽道（GoodNotes 6 / Notability / Apple 備忘錄 / Freeform）＋
> 開源協作平台（AFFiNE / AppFlowy / Notion）。
> 前提：Phase 1（PencilKit 筆記本化）進行中 —— 筆壓/防手掌/套索/undo/顏色由系統提供。
> 研究方法：兩個獨立研究 agent、各 24+/20+ 條來源交叉驗證，完整筆記見文末。
> 時效：以 2025–2026 資訊為準；競品功能與價格變動快，本文件半年後需重驗。

## 一句話結論

**「協作平台不做手寫、手寫 App 不做協作資料」—— 兩個世界之間是空的，Oidea
正好站在交會點上；Phase 2 該做的是把手寫體驗補到「日用及格線」（紙張模板、
手寫搜尋），而不是追任何單一競品的全功能。**

## 競品總覽

| 產品 | 定位 | 價格（2026） | 評分 |
|---|---|---|---|
| GoodNotes 6 | 手寫筆記全能標竿 | Essential $11.99/年、Pro $35.99/年、另有買斷 | 4.7★（38.1 萬則） |
| Notability | 錄音同步差異化 | Lite $11.99/年、Plus $15.99/年、Pro $79.99/年 | 4.8★（43.4 萬則） |
| Apple 備忘錄 | 免費 + OS 級整合 | 免費 | — |
| Apple Freeform | 無限畫布協作 | 免費 | 手寫用途評價差 |
| AFFiNE | 開源 Notion+Miro | 自架免費 ≤10 人；後端 EE 授權 | — |
| AppFlowy | 開源 Notion 替代 | AGPL 自架免費 | — |
| Notion | 協作文件霸主 | Free / Plus $10/席/月起 | — |

## 關鍵發現

### 1. 協作平台全數缺席手寫（信心：高）

- **Notion**：沒有原生白板/畫布。Apple Pencil 官方定位＝指標裝置（點擊/捲動），
  無畫圖、無手寫。網路上「Notion 2024 推出 Whiteboard」是 SEO 內容農場假消息，
  研究過程已證偽。
- **AppFlowy**：白板功能不存在（官方自家比較表對 Whiteboard 欄打 ✗）。
- **AFFiNE**：三者中唯一有真無限畫布（Edgeless 模式），但 iPad Pencil 體驗未達標
  —— GitHub issue #13782「Proper iPad pencil support」（2025-10）至今 open，原文：
  "without proper palm rejection etc, it is very difficult to use"。官方部落格宣稱
  2026 已支援筆壓/防手掌，changelog 查無實據，與開放 issue 矛盾，判定為行銷話術。

**含義**：Oidea 選 PencilKit 原生路線，在「協作平台 × 手寫」這個交叉點上
目前沒有可用的競品。這條路線的差異化成立。

### 2. 手寫賽道的及格線與天花板（信心：高）

Freeform 是最有價值的反面教材：它有無限畫布、有 Apple 全家桶加持、完全免費，
仍被評測與使用者一致判定「不適合手寫筆記」。原因排序：

1. **無手寫辨識/搜尋** —— 寫進去的東西找不回來，筆記量一大就崩
2. **套索工具爛**（"見過最爛"）—— Oidea 由 PencilKit 原生解掉 ✅
3. **筆刷太少** —— PencilKit 提供筆/麥克筆/鉛筆 ✅（部分解掉）

**含義**：手寫筆記的及格線 = 畫得順（Phase 1 已解）＋**找得回來（OCR 搜尋）**
＋**紙張像紙（模板）**。天花板 = Notability 的錄音逐字同步（唯一難複製的護城河）。

### 3. 各產品強弱速覽

| 產品 | 使用者最稱讚 | 使用者最抱怨 |
|---|---|---|
| GoodNotes 6 | 筆記本組織（巢狀 10 層）、PDF 標注深度、範本庫 | 無錄音同步、iCloud 同步偶發失敗 |
| Notability | Note Replay 錄音逐字同步、AI 學習工具 | 2021 訂閱制轉型負評未消（BBB 投訴）、OCR 鎖付費 |
| Apple 備忘錄 | 免費、Smart Script 即時整形、免費 OCR | 無筆記本/範本系統、匯出品質不穩 |
| Freeform | 無限畫布、多媒體、免費 | 無 OCR、套索爛、筆刷少 → 手寫不堪用 |
| AFFiNE | Page↔Edgeless 雙態、frame 簡報、AI 心智圖 | Pencil 體驗粗糙（open issue）、後端 EE 授權 |

## Phase 2 白板功能優先序（本簡報的核心產出）

依「使用者價值 × 實作成本 × 與 PencilKit 架構的契合度」排序：

| 序 | 功能 | 抄誰 | 為什麼是這個順序 |
|---|---|---|---|
| **P2-1** | **紙張模板**（格線/點陣/橫線/康乃爾） | GoodNotes | 成本最低（PKCanvasView 背景層畫模板即可），完整度觀感提升最大；「紙不像紙」是筆記 App 的第一眼判準 |
| **P2-2** | **手寫 OCR 搜尋** | GoodNotes／備忘錄 | Freeform 缺此功能被判死刑的反向證據；Apple Vision framework 裝置端辨識 = 零伺服器成本、離線可用；先做「頁內找得到」再做跨筆記本 |
| **P2-3** | **筆記本封面與頁模板自訂** | GoodNotes | 低成本、組織體驗閉環（現有 Whiteboard model 已有 thumbnail/description 欄位可承載） |
| **P2-4** | **AI 手寫摘要／心智圖**（b300） | AFFiNE 的概念 | 唯一與自家 GPU 交會的畫布功能：OCR 文字餵 b300 → 摘要/心智圖。競品做 AI 都要付雲端 API 費，Oidea 邊際成本≈電費 —— 差異化敘事在白板上的落點 |
| 延後 | PDF 標注 | GoodNotes | 價值高但等於引入新文件型別（PDFKit 整合、頁面模型重構），是獨立的大專案 |
| 延後 | 錄音逐字同步 | Notability | 護城河級難度（音訊時間軸 × 筆畫時間戳），單人筆記情境價值待驗證 |
| 延後 | Frame 簡報模式 | AFFiNE | 「展示想法」目前用頁面縮圖與分享即可；等有真實展示需求再做 |
| 不做 | 即時多人畫布（CRDT） | Miro/AFFiNE | 已在凍結清單；單人筆記情境無此需求 |

## 威脅（誠實條款）

- **Apple 免費層持續上移**：Smart Script、免費 OCR 已把備忘錄推到「半個 GoodNotes」。
  對 Oidea 影響有限（Oidea 的價值在整合面：筆記＋看板＋資料庫＋自家 AI），
  但「純手寫體驗」永遠不該是 Oidea 的主戰場 —— 打不過 OS 廠商。
- **AFFiNE 若真把 Pencil 做好**：它會成為「開源 × 畫布 × 文件」最接近 Oidea 的存在。
  監測點：issue #13782 的關閉時間。
- **本簡報時效**：功能與價格資訊採集於 2026-08，半年後需重驗。

## 策略含義

1. **Phase 1 的方向被證實**：手寫及格線的三要素（畫得順/選得動/退得了）
   全由 PencilKit 原生解掉，等於用最低成本追平競品多年投入。
2. **Phase 2 順序**：P2-1 → P2-2 → P2-3 → P2-4（上表）。前三項把「能畫」
   變成「日用」，第四項接上差異化。
3. **不追天花板**：PDF 標注與錄音同步是 GoodNotes/Notability 的主場，
   單人筆記情境下投入產出比不成立，明確延後。
4. **AI 是白板與 b300 的交會點**：競品的 AI 都是成本中心，Oidea 的是資產
   利用 —— Phase 2 規劃 spec 時把 P2-4 與聊天 @ai 的基礎設施共用。

---

## 附錄：研究底稿

- 手寫賽道完整筆記（逐產品 12 維度表、評論原聲、24 條來源）：
  session scratchpad `competitive-handwriting.md`
- 協作平台完整筆記（維度表、授權/價格對照、證偽紀錄、20+ 條來源）：
  session scratchpad `competitive-collab-canvas.md`
- 底稿為 session 暫存檔；本簡報保留了所有決策相關結論，底稿佚失不影響使用。
