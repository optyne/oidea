# 跨平台白板（雙格式 + Excalidraw 微前端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓白板頁在 web／Android／Windows 也能編輯：新增 `excalidraw` 頁格式（React 微前端，iframe/WebView 橋接），PencilKit 頁維持 iPad 專屬。

**Architecture:** 頁面雙格式（`format` 欄：`pencilkit` | `excalidraw`）。`canvas-web/` 是獨立 Vite+React 小 App，包 Excalidraw、自帶存檔閉環（鏡射 pencil 頁語意），由現有 web nginx 同源服務於 `/canvas/`；Flutter 各平台以 iframe（web）/ WebView（Android/iPad）/ 外部瀏覽器（桌面 v1）為宿主，token 走 postMessage 握手不進 URL。Task 1 是時間盒 2 天的 spike，GO/NO-GO 決定整個方案（NO-GO 退回 Flutter 自建引擎案，另立計畫）。

**Tech Stack:** Vite + React + TypeScript + `@excalidraw/excalidraw`（MIT，spike 時鎖版）+ vitest；NestJS/Prisma（format 欄）；Flutter `webview_flutter`（新增）+ `url_launcher`（既有）。

**Spec:** [docs/superpowers/specs/2026-08-09-crossplatform-whiteboard-design.md](../specs/2026-08-09-crossplatform-whiteboard-design.md)

## Global Constraints

- 分支：全計畫在 `feat/whiteboard-crossplatform`（基於 main），每任務一 commit，Task 8 開 PR。
- 基準：backend **179 tests / 15 suites** 全綠（Task 2 後 ≥183）、`npm run build` 乾淨；Flutter **30 tests**、`flutter analyze --no-fatal-infos` exit 0（0 warning）。
- canvas-web 的品質門檻：`npx tsc --noEmit` 乾淨 + `npx vitest run` 全綠。
- **Task 1 是閘門**：GO 才繼續 Task 2+；NO-GO → 停止並回報 BLOCKED（退路 = Flutter 自建引擎，另立計畫）。
- format 合法值恰為 `'pencilkit' | 'excalidraw'`；`POST pages` 缺省 `pencilkit`（舊 iPad App 相容）；非法值 400。
- token 絕不進 URL；橋協定：wrapper 送 `ready` → 宿主回 `init {token, boardId, pageId, apiBase}` → wrapper 自打 API；事件 `dirty|saved|error`。
- 存檔閉環語意（兩格式一致）：筆畫停 2s 自動存、關頁強制存、失敗指數退避 5→60s、dirty 不清、載入失敗絕不進編輯。
- UI 間距/圓角/字級一律 OideaSpace/OideaRadius/OideaType；文案繁中。
- Excalidraw scene v1 不含嵌入圖檔（`files` 不序列化）。
- 凍結區不得觸碰：`whiteboard.gateway.ts`、meetings WebRTC、C-15~18/P-14/P-15/D-02/04/07；**pencil 頁與 legacy 畫布本計畫零改動**。
- Commit 訊息照任務內文字，結尾空一行加 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`（spike 報告類提交亦同）。

## File Structure

```
canvas-web/                                新（獨立 npm 專案，不進 app/ 的 pub 管理）
├─ package.json / tsconfig.json / vite.config.ts / index.html
├─ src/main.tsx                            進入點
├─ src/api.ts                              fetch 包裝：getPage / savePage
├─ src/bridge.ts                           雙傳輸橋（iframe postMessage / WebView JS channel）
├─ src/save_loop.ts                        存檔閉環純邏輯（可注入 clock/save fn，vitest 可測）
├─ src/App.tsx                             Excalidraw 整合 + stylusOnly + 縮圖
├─ src/__tests__/save_loop.test.ts
├─ src/__tests__/bridge.test.ts
└─ SPIKE.md                                Task 1 產出：驗證結果與 GO/NO-GO

backend/prisma/schema.prisma               修改（WhiteboardPage + format）
backend/src/whiteboard/whiteboard-pages.service.ts     修改（format 讀寫）
backend/src/whiteboard/whiteboard-pages.controller.ts  修改（create body、驗證）
backend/src/whiteboard/whiteboard-pages.service.spec.ts 修改（+4 tests）

app/Dockerfile                             修改（+canvas-web build stage）
app/nginx.conf                             修改（+/canvas/ location）
app/pubspec.yaml                           修改（+webview_flutter）
app/lib/core/network/api_client.dart       修改（createWhiteboardPage 帶 format、currentAccessToken()）
app/lib/features/whiteboard/presentation/pages/
├─ whiteboard_excalidraw_page.dart         新（宿主頁：按平台委派）
├─ excalidraw_host_web.dart                新（iframe + postMessage，web 專用）
├─ excalidraw_host_mobile.dart             新（webview_flutter，Android/iOS）
├─ excalidraw_host_desktop.dart            新（url_launcher 外開 + 說明頁）
├─ excalidraw_host_stub.dart               新（條件匯入替身）
├─ whiteboard_pages_page.dart              修改（format 分流、徽章、建頁選單）
app/lib/core/router/app_router.dart        修改（+1 路由）
app/test/whiteboard_pages_test.dart        修改（分流/徽章測試）
docs/REQUIREMENTS.md                       修改（Task 8）
```

---

### Task 1: Spike — Excalidraw 可行性驗證（時間盒 2 天，GO/NO-GO 閘門）

**Files:**
- Create: `canvas-web/package.json`、`canvas-web/tsconfig.json`、`canvas-web/vite.config.ts`、`canvas-web/index.html`、`canvas-web/src/main.tsx`、`canvas-web/src/App.tsx`（spike 精簡版）、`canvas-web/spike-host.html`（模擬宿主）、`canvas-web/SPIKE.md`

**Interfaces:**
- Produces: 鎖定的 `@excalidraw/excalidraw` 版本號；三個驗證結論（橋、縮圖、Android 筆）；GO/NO-GO。API 簽章若與本計畫 Task 4 的程式碼有出入，**在 SPIKE.md 列出修正對照表**（後續任務以對照表為準）。

- [ ] **Step 1: 建分支與 scaffold**

```bash
cd /Users/optyne/repository/oidea
git checkout main && git pull --ff-only
git checkout -b feat/whiteboard-crossplatform
mkdir -p canvas-web/src
```

`canvas-web/package.json`：

```json
{
  "name": "oidea-canvas-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@excalidraw/excalidraw": "latest",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

`npm install` 後把 `"latest"` 改成 lockfile 解析出的**確切版本**（`npm ls @excalidraw/excalidraw`），commit 進 package.json —— 鎖版是 spike 的交付物之一。

`canvas-web/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`canvas-web/vite.config.ts`：

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 部署路徑固定在 /canvas/（與 Flutter web 同源，由同一個 nginx 服務）
export default defineConfig({
  plugins: [react()],
  base: '/canvas/',
});
```

`canvas-web/index.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Oidea 畫布</title>
    <style>html, body, #root { margin: 0; height: 100%; }</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`canvas-web/src/main.tsx`：

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 2: spike 版 App.tsx（三個探針內建）**

```tsx
import React, { useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';

// ── Spike 探針版：驗證 (a) 橋握手+存讀 (b) exportToBlob (c) pointer 事件（筆壓/pointerType）──
// 正式版在 Task 4 重寫；此檔僅供 SPIKE.md 取證。

type InitMsg = { type: 'init'; token: string; boardId: string; pageId: string; apiBase: string };

export default function App() {
  const apiRef = useRef<any>(null);
  const initRef = useRef<InitMsg | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const say = (s: string) => setLog((l) => [...l.slice(-8), s]);

  React.useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (d?.type !== 'init') return;
      initRef.current = d;
      say(`init 收到 boardId=${d.boardId}`);
      const res = await fetch(`${d.apiBase}/whiteboard/${d.boardId}/pages/${d.pageId}`, {
        headers: { Authorization: `Bearer ${d.token}` },
      });
      say(`載入頁 HTTP ${res.status}`);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage(JSON.stringify({ type: 'ready' }), '*');
    (window as any).OideaBridge?.postMessage(JSON.stringify({ type: 'ready' }));
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 探針 (c)：記錄 pointerType 與 pressure —— Android 實機看這裡
  React.useEffect(() => {
    const probe = (e: PointerEvent) =>
      say(`pointer ${e.pointerType} p=${e.pressure.toFixed(2)}`);
    window.addEventListener('pointerdown', probe, { capture: true });
    return () => window.removeEventListener('pointerdown', probe, { capture: true });
  }, []);

  const saveProbe = async () => {
    const d = initRef.current;
    const api = apiRef.current;
    if (!d || !api) return say('尚未 init');
    const elements = api.getSceneElements();
    const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements });
    const drawing = btoa(unescape(encodeURIComponent(scene)));
    const blob = await exportToBlob({
      elements,
      appState: api.getAppState(),
      files: api.getFiles(),
      mimeType: 'image/png',
      maxWidthOrHeight: 512,
    });
    const thumb = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    const res = await fetch(`${d.apiBase}/whiteboard/${d.boardId}/pages/${d.pageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` },
      body: JSON.stringify({ drawing, thumbnail: thumb }),
    });
    say(`存檔+縮圖 HTTP ${res.status}`);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 4, fontSize: 12, background: '#eee' }}>
        <button onClick={saveProbe}>探針：存檔+縮圖</button> {log.join(' | ')}
      </div>
      <div style={{ flex: 1 }}>
        <Excalidraw excalidrawAPI={(api) => (apiRef.current = api)} />
      </div>
    </div>
  );
}
```

**若鎖定版本的 API 與上面不符**（`excalidrawAPI` prop、`exportToBlob` 參數名等），以官方文件修正並把差異寫進 SPIKE.md 的「API 對照表」。

- [ ] **Step 3: 模擬宿主頁 + 對本機後端驗證探針 (a)(b)**

`canvas-web/spike-host.html`（放專案根，`vite dev` 之外直接開檔）：

```html
<!doctype html>
<html><body>
<iframe id="c" src="http://localhost:5173/canvas/" style="width:90vw;height:80vh"></iframe>
<script>
const TOKEN = new URLSearchParams(location.search).get('t');
const BOARD = new URLSearchParams(location.search).get('b');
const PAGE  = new URLSearchParams(location.search).get('p');
window.addEventListener('message', (e) => {
  const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
  if (d?.type === 'ready') {
    document.getElementById('c').contentWindow.postMessage(JSON.stringify({
      type: 'init', token: TOKEN, boardId: BOARD, pageId: PAGE,
      apiBase: 'http://localhost:3001/api',
    }), '*');
  }
});
</script>
</body></html>
```

驗證流程（後端本機起：`cd backend && docker compose up -d && npm run start:dev`）：

```bash
cd canvas-web && npm install && npm run dev
```

另開終端機用 curl 註冊 spike 帳號 + 建 workspace/board/page（照 backend swagger），把 token/boardId/pageId 帶進 `spike-host.html?t=...&b=...&p=...` 開瀏覽器。驗收：畫幾筆 → 按探針 → 「存檔+縮圖 HTTP 200」→ 重整 iframe →「載入頁 HTTP 200」。把關鍵截圖/輸出記進 SPIKE.md。

- [ ] **Step 4: 探針 (c) —— Android 實機（需要使用者的 Android 平板）**

`npm run build` 後把 `canvas-web/dist` 用 `npx serve` 或任何方式暴露到區網，Android 平板 Chrome 開啟：觸控筆畫線看 log 是否出現 `pointer pen p=0.xx`（壓力值隨力道變動）、手指出現 `pointer touch`。**此步由使用者操作**——實作者把指令與判讀標準寫好後回報 `DONE_WITH_CONCERNS`（標注「探針 c 待使用者」），controller 安排使用者驗證。

- [ ] **Step 5: 寫 SPIKE.md + commit**

SPIKE.md 必含：鎖定版本、三探針結果（(c) 可標 pending-user）、API 對照表（若有）、GO/NO-GO 建議。

```bash
git add canvas-web
git commit -m "spike(canvas-web): Excalidraw feasibility probes — bridge, thumbnail, stylus

Time-boxed spike behind the cross-platform whiteboard plan. Pins the
Excalidraw version, proves the iframe handshake against the real pages
API, exercises exportToBlob thumbnails, and ships a pointer probe for
the Android stylus test. Verdict and any API deltas live in SPIKE.md."
```

---

### Task 2: 後端 `format` 欄（TDD）

**Files:**
- Modify: `backend/prisma/schema.prisma`、`backend/src/whiteboard/whiteboard-pages.service.ts`、`backend/src/whiteboard/whiteboard-pages.controller.ts`
- Test: `backend/src/whiteboard/whiteboard-pages.service.spec.ts`

**Interfaces:**
- Produces: `createPage(userId, whiteboardId, format?: string)`（預設 `'pencilkit'`，非法丟 `BadRequestException`）；`listPages`/`getPage` 回傳物件含 `format: string`；`POST /whiteboard/:boardId/pages` body `{format?: 'pencilkit'|'excalidraw'}`。Task 6/7 依賴這些名稱。

- [ ] **Step 1: schema + migration**

`WhiteboardPage` model 的 `position Int` 下一行加：

```prisma
  format       String    @default("pencilkit") // 'pencilkit' | 'excalidraw'（drawing bytes 的語意）
```

```bash
cd backend && docker compose up -d && npx prisma migrate dev --name add_page_format && npx prisma generate
```

- [ ] **Step 2: 失敗測試（+4 條）**

在 `whiteboard-pages.service.spec.ts` 的 createPage 測試後加：

```typescript
  it('createPage: 未指定 format → 預設 pencilkit', async () => {
    prisma.whiteboardPage.aggregate.mockResolvedValue({ _max: { position: null } });
    prisma.whiteboardPage.create.mockResolvedValue({ id: 'p-1', position: 0, format: 'pencilkit' });
    await service.createPage('u-1', 'wb-1');
    expect(prisma.whiteboardPage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ format: 'pencilkit' }) }),
    );
  });

  it('createPage: format=excalidraw 被寫入', async () => {
    prisma.whiteboardPage.aggregate.mockResolvedValue({ _max: { position: null } });
    prisma.whiteboardPage.create.mockResolvedValue({ id: 'p-1', position: 0, format: 'excalidraw' });
    await service.createPage('u-1', 'wb-1', 'excalidraw');
    expect(prisma.whiteboardPage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ format: 'excalidraw' }) }),
    );
  });

  it('createPage: 非法 format → BadRequest', async () => {
    await expect(service.createPage('u-1', 'wb-1', 'tldraw')).rejects.toThrow(BadRequestException);
    expect(prisma.whiteboardPage.create).not.toHaveBeenCalled();
  });

  it('listPages / getPage: 回傳含 format', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([
      { id: 'p-1', position: 0, format: 'excalidraw', thumbnailId: null, updatedAt: new Date() },
    ]);
    const out = await service.listPages('u-1', 'wb-1');
    expect(out[0].format).toBe('excalidraw');

    prisma.whiteboardPage.findUnique.mockResolvedValue({
      id: 'p-1', whiteboardId: 'wb-1', position: 0, format: 'excalidraw',
      drawing: null, deletedAt: null,
    });
    const page = await service.getPage('u-1', 'wb-1', 'p-1');
    expect(page.format).toBe('excalidraw');
  });
```

spec 檔頂部 import 補 `BadRequestException`（自 `@nestjs/common`）。

Run: `npm test -- --testPathPattern=whiteboard-pages` → Expected: 新 4 條 FAIL（format 未實作）。

- [ ] **Step 3: 實作**

service（`BadRequestException` 加進既有 import）：

```typescript
const PAGE_FORMATS = new Set(['pencilkit', 'excalidraw']);
```

（放檔案頂部、class 外。）`createPage` 改為：

```typescript
  async createPage(userId: string, whiteboardId: string, format = 'pencilkit') {
    if (!PAGE_FORMATS.has(format)) {
      throw new BadRequestException(`format 必須是 ${[...PAGE_FORMATS].join(' | ')}`);
    }
    await this.assertAccess(userId, whiteboardId);
    const agg = await this.prisma.whiteboardPage.aggregate({
      where: { whiteboardId, deletedAt: null },
      _max: { position: true },
    });
    const position = (agg._max.position ?? -1) + 1;
    return this.prisma.whiteboardPage.create({
      data: { whiteboardId, position, format },
      select: { id: true, position: true, format: true },
    });
  }
```

`listPages` 的 select 加 `format: true`，回傳映射保留 `format`；`getPage` 回傳物件加 `format: page.format`。

controller `create` 改為：

```typescript
  @Post()
  @ApiOperation({ summary: '新增頁（接在最後；format 預設 pencilkit）' })
  create(
    @Req() req: any,
    @Param('boardId') boardId: string,
    @Body() body: { format?: string },
  ) {
    return this.pages.createPage(req.user.userId, boardId, body?.format ?? 'pencilkit');
  }
```

- [ ] **Step 4: 綠 + 全量 + commit**

```bash
npm test -- --testPathPattern=whiteboard-pages   # 15 passed
npm test && npm run build                        # 183 / 15 suites, build 乾淨
git add backend
git commit -m "feat(whiteboard): page format column — pencilkit | excalidraw

Pages now carry the semantic of their drawing bytes. Default stays
pencilkit so already-installed iPad builds keep working; invalid values
400 at the service boundary. List/get expose format for client routing."
```

---

### Task 3: canvas-web 純邏輯層 —— SaveLoop + bridge + api（vitest TDD）

**Files:**
- Create: `canvas-web/src/save_loop.ts`、`canvas-web/src/bridge.ts`、`canvas-web/src/api.ts`
- Test: `canvas-web/src/__tests__/save_loop.test.ts`、`canvas-web/src/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 鎖定的專案骨架。
- Produces（Task 4 依賴）:
  - `class SaveLoop { constructor(opts: {save: () => Promise<boolean>; debounceMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout}); markDirty(): void; flush(): Promise<boolean>; get dirty(): boolean; onState?: (s: 'dirty'|'saving'|'saved'|'error') => void; dispose(): void }`
  - `initBridge(onInit: (init: BridgeInit) => void): void` 與 `emit(event: 'dirty'|'saved'|'error'): void`；`type BridgeInit = { token: string; boardId: string; pageId: string; apiBase: string }`
  - `getPage(init: BridgeInit): Promise<{format: string; drawing: string | null}>`；`savePage(init: BridgeInit, drawingBase64: string, thumbnailBase64?: string): Promise<void>`（非 2xx 丟 Error）

- [ ] **Step 1: SaveLoop 失敗測試**

`canvas-web/src/__tests__/save_loop.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SaveLoop } from '../save_loop';

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe('SaveLoop（存檔閉環：debounce、單飛、世代、退避）', () => {
  it('markDirty 後 debounce 到期觸發一次 save', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(true);
    const loop = new SaveLoop({ save, debounceMs: 2000 });
    loop.markDirty();
    loop.markDirty(); // 連續筆畫只排一次
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(loop.dirty).toBe(false);
    vi.useRealTimers();
  });

  it('存檔進行中又 markDirty → 完成後自動補存（不遺失）', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (v: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => (resolveFirst = r)))
      .mockResolvedValue(true);
    const loop = new SaveLoop({ save, debounceMs: 10 });
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(10); // save #1 進行中
    loop.markDirty();                      // 存檔中落筆
    resolveFirst(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(2); // 自動補存
    expect(loop.dirty).toBe(false);
    vi.useRealTimers();
  });

  it('save 失敗 → dirty 保留、退避重試 5→10→20s、成功後歸零', async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const states: string[] = [];
    const loop = new SaveLoop({ save, debounceMs: 10 });
    loop.onState = (s) => states.push(s);
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(10);     // 失敗 #1 → 排 5s
    expect(loop.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);   // 失敗 #2 → 排 10s
    await vi.advanceTimersByTimeAsync(10000);  // 成功
    expect(save).toHaveBeenCalledTimes(3);
    expect(loop.dirty).toBe(false);
    expect(states).toContain('error');
    expect(states[states.length - 1]).toBe('saved');
    vi.useRealTimers();
  });

  it('flush：進行中等真結果；乾淨時回 true 不呼叫 save', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const loop = new SaveLoop({ save, debounceMs: 999999 });
    expect(await loop.flush()).toBe(true);
    expect(save).not.toHaveBeenCalled();
    loop.markDirty();
    expect(await loop.flush()).toBe(true); // flush 直接觸發，不等 debounce
    expect(save).toHaveBeenCalledTimes(1);
  });
});
```

Run: `cd canvas-web && npx vitest run` → Expected: FAIL（`save_loop` 不存在）。

- [ ] **Step 2: SaveLoop 實作**

`canvas-web/src/save_loop.ts`：

```typescript
/**
 * 存檔閉環純邏輯 —— 鏡射 Flutter pencil 頁的語意：
 * debounce、單飛（in-flight 期間 markDirty 完成後自動補存）、
 * 失敗指數退避 5→60s、dirty 直到「觸發時的世代」成功寫入才清。
 * 不碰 DOM/fetch：save callback 由呼叫端注入，vitest 可完整驗證。
 */
export type SaveState = 'dirty' | 'saving' | 'saved' | 'error';

export class SaveLoop {
  private generation = 0;
  private savedGeneration = 0;
  private inFlight: Promise<boolean> | null = null;
  private debounceId: ReturnType<typeof setTimeout> | null = null;
  private retryId: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 5000;
  private disposed = false;

  onState?: (s: SaveState) => void;

  constructor(
    private readonly opts: {
      save: () => Promise<boolean>;
      debounceMs?: number;
    },
  ) {}

  get dirty(): boolean {
    return this.generation !== this.savedGeneration;
  }

  markDirty(): void {
    if (this.disposed) return;
    this.generation++;
    this.onState?.('dirty');
    if (this.debounceId) clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => void this.run(), this.opts.debounceMs ?? 2000);
  }

  /** 立即存（關頁用）；回傳最終是否乾淨。 */
  flush(): Promise<boolean> {
    if (this.debounceId) clearTimeout(this.debounceId);
    if (!this.dirty && !this.inFlight) return Promise.resolve(true);
    return this.run();
  }

  private run(): Promise<boolean> {
    const existing = this.inFlight;
    if (existing) {
      return existing.then((ok) => (this.dirty && !this.disposed ? this.run() : ok));
    }
    const attempt = this.doSave().finally(() => (this.inFlight = null));
    this.inFlight = attempt;
    return attempt.then((ok) => (this.dirty && !this.disposed ? this.run() : ok));
  }

  private async doSave(): Promise<boolean> {
    if (!this.dirty) return true;
    const gen = this.generation;
    this.onState?.('saving');
    let ok = false;
    try {
      ok = await this.opts.save();
    } catch {
      ok = false;
    }
    if (this.disposed) return ok;
    if (ok) {
      this.savedGeneration = gen;
      this.retryMs = 5000;
      if (this.retryId) clearTimeout(this.retryId);
      this.onState?.(this.dirty ? 'dirty' : 'saved');
      return !this.dirty;
    }
    this.onState?.('error');
    if (this.retryId) clearTimeout(this.retryId);
    this.retryId = setTimeout(() => void this.run(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 60000);
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceId) clearTimeout(this.debounceId);
    if (this.retryId) clearTimeout(this.retryId);
  }
}
```

Run: `npx vitest run` → save_loop 4 passed。

- [ ] **Step 3: bridge 測試 + 實作**

`canvas-web/src/__tests__/bridge.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initBridge, emit } from '../bridge';

describe('bridge（iframe postMessage 傳輸）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as any).OideaBridge;
  });

  it('送出 ready；收到 init 後回呼一次（重複 init 忽略）', () => {
    const parentPost = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const onInit = vi.fn();
    initBridge(onInit);
    expect(parentPost).toHaveBeenCalledWith(JSON.stringify({ type: 'ready' }), '*');

    const init = { type: 'init', token: 't', boardId: 'b', pageId: 'p', apiBase: '/api' };
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(init) }));
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(init) }));
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onInit).toHaveBeenCalledWith({ token: 't', boardId: 'b', pageId: 'p', apiBase: '/api' });
  });

  it('emit 走 parent postMessage；有 OideaBridge 時也走 JS channel', () => {
    const parentPost = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const channel = { postMessage: vi.fn() };
    (window as any).OideaBridge = channel;
    emit('saved');
    expect(parentPost).toHaveBeenCalledWith(JSON.stringify({ type: 'saved' }), '*');
    expect(channel.postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'saved' }));
  });
});
```

`canvas-web/src/bridge.ts`：

```typescript
/**
 * 與宿主的橋。兩種傳輸同時支援：
 * - iframe（Flutter web）：window.parent.postMessage / window 'message' 事件
 * - WebView（Android/iPad）：window.OideaBridge JS channel（webview_flutter 注入）
 * token 只在 init 訊息內傳遞，不進 URL。
 */
export type BridgeInit = { token: string; boardId: string; pageId: string; apiBase: string };
export type BridgeEvent = 'dirty' | 'saved' | 'error';

declare global {
  interface Window {
    OideaBridge?: { postMessage(msg: string): void };
  }
}

export function initBridge(onInit: (init: BridgeInit) => void): void {
  let received = false;
  window.addEventListener('message', (e: MessageEvent) => {
    let d: any;
    try {
      d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (d?.type !== 'init' || received) return;
    received = true;
    onInit({ token: d.token, boardId: d.boardId, pageId: d.pageId, apiBase: d.apiBase });
  });
  const ready = JSON.stringify({ type: 'ready' });
  window.parent.postMessage(ready, '*');
  window.OideaBridge?.postMessage(ready);
}

export function emit(event: BridgeEvent): void {
  const msg = JSON.stringify({ type: event });
  window.parent.postMessage(msg, '*');
  window.OideaBridge?.postMessage(msg);
}
```

`canvas-web/src/api.ts`：

```typescript
import type { BridgeInit } from './bridge';

const headers = (init: BridgeInit) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${init.token}`,
});

export async function getPage(init: BridgeInit): Promise<{ format: string; drawing: string | null }> {
  const res = await fetch(`${init.apiBase}/whiteboard/${init.boardId}/pages/${init.pageId}`, {
    headers: headers(init),
  });
  if (!res.ok) throw new Error(`getPage ${res.status}`);
  return res.json();
}

export async function savePage(
  init: BridgeInit,
  drawingBase64: string,
  thumbnailBase64?: string,
): Promise<void> {
  const res = await fetch(`${init.apiBase}/whiteboard/${init.boardId}/pages/${init.pageId}`, {
    method: 'PUT',
    headers: headers(init),
    body: JSON.stringify({
      drawing: drawingBase64,
      ...(thumbnailBase64 ? { thumbnail: thumbnailBase64 } : {}),
    }),
  });
  if (!res.ok) throw new Error(`savePage ${res.status}`);
}
```

- [ ] **Step 4: 全綠 + commit**

```bash
cd canvas-web && npx tsc --noEmit && npx vitest run   # 6 passed
git add canvas-web/src
git commit -m "feat(canvas-web): save loop, bridge and api client with vitest coverage

SaveLoop is the pure-logic mirror of the pencil page's autosave —
generation tracking, single-flight with follow-up save, 5→60s backoff —
finally under unit test (the Flutter original could not be, per the
final review's blind-spot note). The bridge speaks both transports
(iframe postMessage and the OideaBridge WebView channel) and keeps
tokens out of URLs."
```

---

### Task 4: canvas-web 正式版 App（Excalidraw 整合）

**Files:**
- Modify: `canvas-web/src/App.tsx`（重寫 spike 版）
- Delete: `canvas-web/spike-host.html`（保留 SPIKE.md）

**Interfaces:**
- Consumes: Task 3 的 `SaveLoop`/`initBridge`/`emit`/`getPage`/`savePage`；Task 2 的 API 行為；SPIKE.md 的 API 對照表（若有，以其修正下方 Excalidraw 呼叫）。
- Produces: `/canvas/` 完整編輯器 —— 載入 scene、自動存檔、縮圖節流 30s、stylusOnly 開關、載入失敗擋編輯。

- [ ] **Step 1: 重寫 App.tsx**

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import { initBridge, emit, type BridgeInit } from './bridge';
import { getPage, savePage } from './api';
import { SaveLoop } from './save_loop';

// scene JSON（v1 不含 files/嵌圖）
const serializeScene = (api: any): string =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements: api.getSceneElements() });

const toBase64 = (s: string): string => btoa(unescape(encodeURIComponent(s)));
const fromBase64 = (b: string): string => decodeURIComponent(escape(atob(b)));

export default function App() {
  const apiRef = useRef<any>(null);
  const initRef = useRef<BridgeInit | null>(null);
  const loopRef = useRef<SaveLoop | null>(null);
  const lastThumbAtRef = useRef(0);
  const [phase, setPhase] = useState<'waiting' | 'loading' | 'ready' | 'loadFailed'>('waiting');
  const [initialData, setInitialData] = useState<any>(null);
  const [stylusOnly, setStylusOnly] = useState(false);
  const stylusOnlyRef = useRef(false);
  const [sync, setSync] = useState<'saved' | 'dirty' | 'error'>('saved');

  const load = async (init: BridgeInit) => {
    setPhase('loading');
    try {
      const page = await getPage(init);
      let scene: any = { elements: [] };
      if (page.drawing) scene = JSON.parse(fromBase64(page.drawing));
      setInitialData({ elements: scene.elements ?? [] });
      setPhase('ready');
    } catch {
      // 載入失敗絕不進編輯 —— 空白場景 + 自動存檔會覆寫伺服器內容
      setPhase('loadFailed');
    }
  };

  useEffect(() => {
    initBridge((init) => {
      initRef.current = init;
      loopRef.current = new SaveLoop({
        save: async () => {
          const api = apiRef.current;
          const at = initRef.current;
          if (!api || !at) return false;
          try {
            const drawing = toBase64(serializeScene(api));
            let thumbnail: string | undefined;
            if (Date.now() - lastThumbAtRef.current > 30000) {
              const blob = await exportToBlob({
                elements: api.getSceneElements(),
                appState: api.getAppState(),
                files: api.getFiles(),
                mimeType: 'image/png',
                maxWidthOrHeight: 512,
              });
              const buf = new Uint8Array(await blob.arrayBuffer());
              let bin = '';
              buf.forEach((b) => (bin += String.fromCharCode(b)));
              thumbnail = btoa(bin);
            }
            await savePage(at, drawing, thumbnail);
            if (thumbnail) lastThumbAtRef.current = Date.now();
            return true;
          } catch {
            return false;
          }
        },
      });
      loopRef.current.onState = (s) => {
        if (s === 'saved') { setSync('saved'); emit('saved'); }
        else if (s === 'error') { setSync('error'); emit('error'); }
        else if (s === 'dirty') { setSync('dirty'); emit('dirty'); }
      };
      void load(init);
    });

    const forceSave = () => void loopRef.current?.flush();
    window.addEventListener('pagehide', forceSave);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') forceSave();
    });
    return () => window.removeEventListener('pagehide', forceSave);
  }, []);

  // stylusOnly：capture 阶段擋掉非 pen 的「落墨」——手指仍可平移/縮放（Excalidraw 多指手勢不經此路徑）
  useEffect(() => {
    stylusOnlyRef.current = stylusOnly;
  }, [stylusOnly]);
  useEffect(() => {
    const guard = (e: PointerEvent) => {
      if (!stylusOnlyRef.current) return;
      if (e.pointerType === 'touch' && e.isPrimary) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const root = document.getElementById('root')!;
    root.addEventListener('pointerdown', guard, { capture: true });
    return () => root.removeEventListener('pointerdown', guard, { capture: true });
  }, []);

  if (phase === 'waiting' || phase === 'loading') {
    return <p style={{ padding: 16 }}>載入中…</p>;
  }
  if (phase === 'loadFailed') {
    return (
      <div style={{ padding: 16 }}>
        <p>頁面載入失敗</p>
        <button onClick={() => initRef.current && load(initRef.current)}>重試</button>
      </div>
    );
  }
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, padding: 4, fontSize: 12, alignItems: 'center' }}>
        <label>
          <input type="checkbox" checked={stylusOnly} onChange={(e) => setStylusOnly(e.target.checked)} />
          僅觸控筆（防手掌）
        </label>
        <span>{sync === 'saved' ? '已儲存' : sync === 'dirty' ? '編輯中…' : '⚠️ 未同步，重試中'}</span>
      </div>
      <div style={{ flex: 1 }}>
        <Excalidraw
          excalidrawAPI={(api) => (apiRef.current = api)}
          initialData={initialData}
          onChange={() => loopRef.current?.markDirty()}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 驗證 + commit**

```bash
cd canvas-web && npx tsc --noEmit && npx vitest run && npm run build
rm spike-host.html
git add -A canvas-web
git commit -m "feat(canvas-web): production wrapper — scene load, autosave, thumbnails, palm guard

Replaces the spike App with the real editor: bridge-gated load (a failed
load never enters editing), SaveLoop-driven autosave with 30s-throttled
exportToBlob thumbnails, pagehide/visibility force-save, and a
stylus-only toggle that blocks primary-touch inking at capture phase."
```

---

### Task 5: 建置整合（Dockerfile + nginx `/canvas/`）

**Files:**
- Modify: `app/Dockerfile`、`app/nginx.conf`

**Interfaces:**
- Produces: 部署後 `https://<web-domain>/canvas/` 服務 canvas-web 產物（同源）。

- [ ] **Step 1: Dockerfile 加 canvas-web stage**

在 `FROM ghcr.io/cirruslabs/flutter:3.41.6 AS builder` 之前加：

```dockerfile
# ───────────────── Builder：canvas-web（Excalidraw 微前端）─────────────────
FROM node:22-alpine AS canvas-builder
WORKDIR /canvas
COPY ../canvas-web/package.json ../canvas-web/package-lock.json ./
RUN npm ci
COPY ../canvas-web .
RUN npm run build
```

**注意**：Dokploy 對 web app 的 build context 是 `app/`，拿不到上層的 `canvas-web/`。因此把 context 改為 repo 根：本 Task 同步把 `app/Dockerfile` 內所有 `COPY` 路徑補 `app/` 前綴（`COPY app/pubspec.yaml app/pubspec.lock ./` 等，共四處：兩個 pubspec COPY、`COPY app/ .`、`COPY app/nginx.conf ...`），canvas stage 用 `COPY canvas-web/...`；Task 8 部署時把 Dokploy web app 的 `dockerContextPath` 從 `app` 改為 `.`、`dockerfile` 改為 `app/Dockerfile`。本機驗證用：

```bash
cd /Users/optyne/repository/oidea && docker build -f app/Dockerfile -t oidea-web-test . 2>&1 | tail -5
```

Expected: `✓ Built`（Flutter image 建置較久屬正常）。

runtime stage 補一行（`COPY --from=builder` 之後）：

```dockerfile
COPY --from=canvas-builder /canvas/dist /usr/share/nginx/html/canvas
```

- [ ] **Step 2: nginx `/canvas/` location**

`app/nginx.conf` 在 `location / {` 區塊**之前**加：

```nginx
    # Excalidraw 微前端（canvas-web 產物；vite base=/canvas/）
    location /canvas/ {
        try_files $uri $uri/ /canvas/index.html;
    }

    location = /canvas/index.html {
        expires 0;
        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }
```

（vite 產物檔名帶 hash，命中既有 `\.(js|…)$` 長快取規則；index.html 不快取。）

- [ ] **Step 3: 驗證 + commit**

```bash
docker run --rm -v "$PWD/app/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine nginx -t
git add app/Dockerfile app/nginx.conf
git commit -m "build(web): ship canvas-web at /canvas/ from the same nginx

New node build stage; docker context moves to the repo root so the web
image can see canvas-web/. Hashed assets ride the existing immutable
cache rule; /canvas/index.html is no-store like the Flutter shell."
```

---

### Task 6: Flutter 宿主（iframe / WebView / 桌面外開）

**Files:**
- Modify: `app/pubspec.yaml`（+`webview_flutter: ^4.10.0`）、`app/lib/core/network/api_client.dart`
- Create: `app/lib/features/whiteboard/presentation/pages/whiteboard_excalidraw_page.dart`、`excalidraw_host_web.dart`、`excalidraw_host_mobile.dart`、`excalidraw_host_desktop.dart`、`excalidraw_host_stub.dart`
- Test: `app/test/excalidraw_host_test.dart`

**Interfaces:**
- Consumes: Task 3 橋協定（`ready`/`init`/事件）；Task 5 的 `/canvas/` 路徑。
- Produces（Task 7 依賴）: `WhiteboardExcalidrawPage({required String boardId, required String pageId})`；`ApiClient.currentAccessToken(): Future<String?>`；canvas URL 常數 `kCanvasUrl`（dart-define `CANVAS_URL`，預設 `https://oidea.oadpiz.com/canvas/`）。

- [ ] **Step 1: api_client 補 token 讀取**

先定位 token 儲存鍵：`grep -n "accessToken\|access_token" app/lib/core/network/api_client.dart | head`。在 ApiClient class 內新增方法（用 grep 找到的**同一個 storage 實例與鍵名**——與攔截器讀的完全一致）：

```dart
  /// 給 Excalidraw 宿主的橋接握手用；回傳目前的 access token（未登入為 null）。
  Future<String?> currentAccessToken() => _storage.read(key: _accessTokenKey);
```

（若檔內是字面字串鍵而非常數，抽成 `static const _accessTokenKey = '<既有字串>'` 並讓原讀寫處共用 —— 不改鍵值本身。）

- [ ] **Step 2: 宿主頁與平台委派**

`whiteboard_excalidraw_page.dart`：

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'excalidraw_host_stub.dart'
    if (dart.library.js_interop) 'excalidraw_host_web.dart';
import 'excalidraw_host_desktop.dart';
import 'excalidraw_host_mobile.dart';

/// dart-define CANVAS_URL 覆寫；預設打正式站（iPad/Android 實機直接可用）。
const kCanvasUrl = String.fromEnvironment(
  'CANVAS_URL',
  defaultValue: 'https://oidea.oadpiz.com/canvas/',
);

/// excalidraw 格式頁的宿主：web=iframe、行動=WebView、桌面=外部瀏覽器。
class WhiteboardExcalidrawPage extends StatelessWidget {
  const WhiteboardExcalidrawPage({
    super.key,
    required this.boardId,
    required this.pageId,
  });

  final String boardId;
  final String pageId;

  @override
  Widget build(BuildContext context) {
    if (kIsWeb) {
      return ExcalidrawWebHost(boardId: boardId, pageId: pageId);
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
      case TargetPlatform.iOS:
        return ExcalidrawMobileHost(boardId: boardId, pageId: pageId);
      default:
        return ExcalidrawDesktopHost(boardId: boardId, pageId: pageId);
    }
  }
}
```

`excalidraw_host_stub.dart`（非 web 平台的替身，讓條件匯入可編譯）：

```dart
import 'package:flutter/material.dart';

class ExcalidrawWebHost extends StatelessWidget {
  const ExcalidrawWebHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  Widget build(BuildContext context) =>
      const Center(child: Text('僅 Web 平台'));
}
```

`excalidraw_host_web.dart`（web 專用；`dart:ui_web` + `package:web`）：

```dart
import 'dart:convert';
import 'dart:js_interop';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web/web.dart' as web;

import '../../../../core/network/api_client.dart';
import 'whiteboard_excalidraw_page.dart' show kCanvasUrl;

/// iframe 宿主：註冊 platform view、監聽 ready、回 init（token 不進 URL）。
class ExcalidrawWebHost extends ConsumerStatefulWidget {
  const ExcalidrawWebHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  ConsumerState<ExcalidrawWebHost> createState() => _ExcalidrawWebHostState();
}

class _ExcalidrawWebHostState extends ConsumerState<ExcalidrawWebHost> {
  static bool _registered = false;
  web.HTMLIFrameElement? _iframe;
  JSFunction? _listener;

  @override
  void initState() {
    super.initState();
    if (!_registered) {
      _registered = true;
      ui_web.platformViewRegistry.registerViewFactory('oidea-canvas-iframe', (int viewId) {
        final el = web.HTMLIFrameElement()
          ..src = kCanvasUrl
          ..style.border = 'none'
          ..style.width = '100%'
          ..style.height = '100%';
        _iframe = el;
        return el;
      });
    }
    _listener = ((web.MessageEvent e) {
      final raw = (e.data as JSString?)?.toDart;
      if (raw == null) return;
      Map<String, dynamic> msg;
      try {
        msg = jsonDecode(raw) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      if (msg['type'] == 'ready') _sendInit();
    }).toJS;
    web.window.addEventListener('message', _listener);
  }

  Future<void> _sendInit() async {
    final token = await ref.read(apiClientProvider).currentAccessToken();
    if (token == null || _iframe == null) return;
    final origin = web.window.location.origin;
    _iframe!.contentWindow?.postMessage(
      jsonEncode({
        'type': 'init',
        'token': token,
        'boardId': widget.boardId,
        'pageId': widget.pageId,
        'apiBase': '$origin/api'.toJS == null ? '$origin/api' : '$origin/api',
      }).toJS,
      '*'.toJS,
    );
  }

  @override
  void dispose() {
    if (_listener != null) web.window.removeEventListener('message', _listener);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('畫布頁')),
      body: const HtmlElementView(viewType: 'oidea-canvas-iframe'),
    );
  }
}
```

**實作提醒**：`apiBase` 應為 web 版實際 API 位址 —— 生產同源部署時 API 在另一網域（`api.oidea.oadpiz.com`），用 `nestApiBaseUrl` 的既有解析取得（`ref.read(apiClientProvider)` 的 dio baseUrl 去掉尾斜線），不要寫死 origin。上面 `_sendInit` 中把 `apiBase` 改為：

```dart
    final apiBase = ref.read(apiClientProvider).baseUrlForBridge; // 見下
```

並在 ApiClient 加：

```dart
  /// 橋接用：REST base（含 /api，無尾斜線）。
  String get baseUrlForBridge {
    final b = _dio.options.baseUrl;
    return b.endsWith('/') ? b.substring(0, b.length - 1) : b;
  }
```

（`_sendInit` 的 jsonEncode map 用這個 `apiBase` 值；上方範例中的 origin 推導整段刪除。）

`excalidraw_host_mobile.dart`：

```dart
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../../../core/network/api_client.dart';
import 'whiteboard_excalidraw_page.dart' show kCanvasUrl;

/// Android / iPad 的 WebView 宿主。橋走 OideaBridge JS channel。
class ExcalidrawMobileHost extends ConsumerStatefulWidget {
  const ExcalidrawMobileHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  ConsumerState<ExcalidrawMobileHost> createState() => _ExcalidrawMobileHostState();
}

class _ExcalidrawMobileHostState extends ConsumerState<ExcalidrawMobileHost> {
  late final WebViewController _controller;
  bool _outOfSync = false;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('OideaBridge', onMessageReceived: (msg) {
        Map<String, dynamic> m;
        try {
          m = jsonDecode(msg.message) as Map<String, dynamic>;
        } catch (_) {
          return;
        }
        if (m['type'] == 'ready') _sendInit();
        if (m['type'] == 'error' && mounted) setState(() => _outOfSync = true);
        if (m['type'] == 'saved' && mounted) setState(() => _outOfSync = false);
      })
      ..loadRequest(Uri.parse(kCanvasUrl));
  }

  Future<void> _sendInit() async {
    final api = ref.read(apiClientProvider);
    final token = await api.currentAccessToken();
    if (token == null) return;
    final init = jsonEncode({
      'type': 'init',
      'token': token,
      'boardId': widget.boardId,
      'pageId': widget.pageId,
      'apiBase': api.baseUrlForBridge,
    });
    // wrapper 的 bridge 監聽 window 'message'：以 dispatchEvent 餵入同協定訊息
    await _controller.runJavaScript(
      "window.dispatchEvent(new MessageEvent('message', {data: ${jsonEncode(init)}}));",
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('畫布頁'),
        actions: [
          if (_outOfSync)
            const Padding(
              padding: EdgeInsets.only(right: OideaSpace.space3),
              child: Icon(Icons.sync_problem),
            ),
        ],
      ),
      body: WebViewWidget(controller: _controller),
    );
  }
}
```

（檔頭補 `import '../../../../core/theme/app_theme.dart';`。）

`excalidraw_host_desktop.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/theme/app_theme.dart';
import 'whiteboard_excalidraw_page.dart' show kCanvasUrl;

/// 桌面 v1：外開瀏覽器（web 版走完整 iframe 宿主），App 內留說明。
class ExcalidrawDesktopHost extends StatelessWidget {
  const ExcalidrawDesktopHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('畫布頁')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('此頁為通用畫布格式，桌面版請在瀏覽器中編輯。'),
            const SizedBox(height: OideaSpace.space3),
            FilledButton.icon(
              icon: const Icon(Icons.open_in_browser),
              label: const Text('在瀏覽器開啟'),
              onPressed: () => launchUrl(Uri.parse(
                  '${kCanvasUrl.replaceAll('/canvas/', '')}/#/whiteboard/excalidraw/$boardId/$pageId')),
            ),
          ],
        ),
      ),
    );
  }
}
```

- [ ] **Step 3: widget test**

`app/test/excalidraw_host_test.dart`：

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/whiteboard/presentation/pages/whiteboard_excalidraw_page.dart';

void main() {
  testWidgets('桌面平台渲染外開瀏覽器說明頁', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    await tester.pumpWidget(const MaterialApp(
      home: WhiteboardExcalidrawPage(boardId: 'b-1', pageId: 'p-1'),
    ));
    expect(find.text('在瀏覽器開啟'), findsOneWidget);
    debugDefaultTargetPlatformOverride = null;
  });
}
```

- [ ] **Step 4: 驗證 + commit**

```bash
cd app && flutter pub add webview_flutter web && flutter pub get
flutter analyze --no-fatal-infos && flutter test    # 31 passed
git add pubspec.yaml pubspec.lock lib test/excalidraw_host_test.dart
git commit -m "feat(whiteboard): excalidraw hosts — iframe, WebView, desktop hand-off

One page, three hosts: Flutter web registers an iframe platform view and
answers the wrapper's ready with a postMessage init; Android/iPad embed
the same wrapper via webview_flutter with an OideaBridge channel; desktop
v1 hands off to the browser. Tokens travel only inside the handshake."
```

---

### Task 7: 分流、建頁格式、徽章

**Files:**
- Modify: `app/lib/features/whiteboard/presentation/pages/whiteboard_pages_page.dart`、`app/lib/core/network/api_client.dart`、`app/lib/core/router/app_router.dart`
- Test: `app/test/whiteboard_pages_test.dart`

**Interfaces:**
- Consumes: Task 2 API（format）、Task 6 `WhiteboardExcalidrawPage`。
- Produces: 路由 `'/whiteboard/excalidraw/:boardId/:pageId'`；`ApiClient.createWhiteboardPage(String boardId, {String? format})`。

- [ ] **Step 1: api_client**

`createWhiteboardPage` 改為：

```dart
  Future<Map<String, dynamic>> createWhiteboardPage(String boardId, {String? format}) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'whiteboard/$boardId/pages',
      data: {if (format != null) 'format': format},
    );
    return res.data ?? {};
  }
```

- [ ] **Step 2: 路由**

`app_router.dart` 的 `/whiteboard` routes 內（`pencil/...` 之後）加，並 import 新頁：

```dart
              GoRoute(
                path: 'excalidraw/:boardId/:pageId',
                builder: (context, state) => WhiteboardExcalidrawPage(
                  boardId: state.pathParameters['boardId']!,
                  pageId: state.pathParameters['pageId']!,
                ),
              ),
```

- [ ] **Step 3: 頁面格分流 + 建頁 + 徽章**

`whiteboard_pages_page.dart` 三處修改：

(a) `_PageCard` 的 onTap 依 format 分流：

```dart
      onTap: () {
        final format = page['format'] as String? ?? 'pencilkit';
        final route = format == 'excalidraw' ? 'excalidraw' : 'pencil';
        context.go('/whiteboard/$route/$boardId/${page['id']}');
      },
```

(b) `_PageCard` 縮圖區右上角徽章（`ClipRRect` 外包 `Stack`，excalidraw 頁加）：

```dart
            if ((page['format'] as String? ?? 'pencilkit') == 'excalidraw')
              Positioned(
                top: OideaSpace.space1,
                right: OideaSpace.space1,
                child: Tooltip(
                  message: '所有裝置皆可編輯',
                  child: Icon(Icons.devices,
                      size: OideaSize.iconSm,
                      color: Theme.of(context).colorScheme.primary),
                ),
              ),
```

(c) FAB 建頁：非 iOS 一律 `format: 'excalidraw'`；iOS 預設 pencilkit、**長按**出選單。把現有 `FloatingActionButton.extended` 包進 `GestureDetector`：

```dart
      floatingActionButton: GestureDetector(
        onLongPress: () async {
          if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return;
          final pick = await showModalBottomSheet<String>(
            context: context,
            builder: (context) => SafeArea(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                ListTile(
                    leading: const Icon(Icons.draw),
                    title: const Text('手寫頁（Apple Pencil）'),
                    onTap: () => Navigator.pop(context, 'pencilkit')),
                ListTile(
                    leading: const Icon(Icons.devices),
                    title: const Text('通用頁（所有裝置可編）'),
                    onTap: () => Navigator.pop(context, 'excalidraw')),
              ]),
            ),
          );
          if (pick != null && context.mounted) await _createPage(context, ref, pick);
        },
        child: FloatingActionButton.extended(
          icon: const Icon(Icons.add),
          label: const Text('新增頁'),
          onPressed: () => _createPage(
            context,
            ref,
            (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS)
                ? 'pencilkit'
                : 'excalidraw',
          ),
        ),
      ),
```

並把原 FAB 的建頁邏輯抽成頁面內的頂層函式：

```dart
Future<void> _createPage(BuildContext context, WidgetRef ref, String format) async {
  final boardId = context.mounted
      ? (context.findAncestorWidgetOfExactType<WhiteboardPagesPage>()!).boardId
      : '';
  final page = await ref
      .read(apiClientProvider)
      .createWhiteboardPage(boardId, format: format);
  ref.invalidate(whiteboardPagesProvider(boardId));
  if (context.mounted && page['id'] != null) {
    final route = format == 'excalidraw' ? 'excalidraw' : 'pencil';
    context.go('/whiteboard/$route/$boardId/${page['id']}');
  }
}
```

（實作時以檔案現況為準微調取 boardId 的方式 —— `WhiteboardPagesPage` 是 ConsumerWidget，直接把 `boardId` 作參數傳給 `_createPage` 最乾淨：`_createPage(context, ref, boardId, format)`，四參數版簽章以此為準。檔頭補 `import 'package:flutter/foundation.dart';`。）

- [ ] **Step 4: widget test 更新**

`whiteboard_pages_test.dart` 的 `_FakeApi.getWhiteboardPages` 回傳加 `'format': 'excalidraw'`（p-1）與 `'format': 'pencilkit'`（p-2），新增斷言：

```dart
    expect(find.byIcon(Icons.devices), findsOneWidget); // 只有 excalidraw 頁有徽章
```

`_FakeApi` 補 `createWhiteboardPage` 覆寫（新簽章）。

- [ ] **Step 5: 驗證 + commit**

```bash
cd app && flutter analyze --no-fatal-infos && flutter test   # 31+
git add lib test
git commit -m "feat(whiteboard): route pages by format — badge, per-device default, long-press picker

Tapping a page opens the editor its format demands; excalidraw pages
wear an all-devices badge. New pages default to excalidraw everywhere
except iOS, where PencilKit stays the default and a long-press on the
FAB offers the universal format."
```

---

### Task 8: 部署、實機驗收、文件、PR

**Files:**
- Modify: `docs/REQUIREMENTS.md`

**Interfaces:**
- Consumes: Tasks 1–7 全部。
- Produces: 合併到 main 的 `feat/whiteboard-crossplatform`。

- [ ] **Step 1: 全量建置驗證**

```bash
cd backend && npm test && npm run build
cd ../canvas-web && npx tsc --noEmit && npx vitest run && npm run build
cd ../app && flutter analyze --no-fatal-infos && flutter test && flutter build web --release
flutter build ios --no-codesign
docker build -f app/Dockerfile -t oidea-web-test .   # repo 根執行；驗證新 context 與 canvas stage
```

- [ ] **Step 2: 部署（controller 執行）**

推分支 → Dokploy web app 的 `dockerContextPath` 改 `.`、`dockerfile` 改 `app/Dockerfile`、分支切 `feat/whiteboard-crossplatform` → backend 分支同切 → 兩者 deploy → 驗證：`https://oidea.oadpiz.com/canvas/` 回 200 且非 Flutter shell；`POST pages {format:'excalidraw'}` 建頁走通。

- [ ] **Step 3: 實機驗收（使用者）**

1. [ ] Web（桌機瀏覽器）：建通用頁 → 滑鼠畫 → 「已儲存」→ 重整筆跡在 → 頁面格出現**真縮圖**
2. [ ] Android 平板（Chrome 或 App WebView）：觸控筆畫有筆壓粗細；開「僅觸控筆」後手掌貼上不落墨
3. [ ] iPad App：開同一通用頁可編輯；pencilkit 頁不受影響
4. [ ] Web 開 pencilkit 頁：唯讀提示 + 縮圖（不可編）
5. [ ] 兩格式各驗：關頁殺 App 重開，筆跡都在

任一失敗 → 停在該項修復。

- [ ] **Step 4: REQUIREMENTS + PR**

REQUIREMENTS.md 白板段註記塊補一行：

```markdown
> 2026-08-XX 起：頁面雙格式 —— `excalidraw` 頁（Excalidraw 微前端）全平台可編輯，
> `pencilkit` 頁維持 iPad 專屬。W-01 無限畫布於 excalidraw 頁達成 `[x]`。
```

（XX = 實際完成日；變更日誌表同步加列。）

```bash
git add docs/REQUIREMENTS.md
git commit -m "docs: record dual-format whiteboard pages"
git push -u origin feat/whiteboard-crossplatform
gh pr create --base main --title "feat(whiteboard): cross-platform pages — Excalidraw micro-frontend" --body "雙格式白板頁：excalidraw 頁全平台可編（web iframe / Android+iPad WebView / 桌面外開），pencilkit 頁維持 iPad 手感。spec: docs/superpowers/specs/2026-08-09-crossplatform-whiteboard-design.md"
```

CI 綠 + 使用者確認後合併；合併後 Dokploy 兩 app 切回 main。

---

## Self-Review 紀錄

- **Spec coverage**：§1 format 欄→Task 2；§2 canvas-web/橋/宿主→Tasks 3/4/6；nginx 同源→Task 5；§3 筆壓/平滑（Excalidraw 內建）/防手掌（Task 4 stylusOnly）/縮圖（Task 4 exportToBlob）/spike→Task 1；§4 分流/預設/徽章/矩陣→Task 7、驗收→Task 8；錯誤處理（載入失敗擋編輯、退避、事件）→Tasks 3/4/6。範圍外項目無任務觸碰。✅
- **Placeholder scan**：無 TBD/TODO；所有程式碼皆為實碼。兩處刻意的「以現況微調」（token 鍵名 grep、_createPage 取 boardId）均附明確判準與指定作法，非留白。✅
- **Type consistency**：`BridgeInit` 四欄位在 bridge.ts/api.ts/兩宿主 init 訊息一致；`currentAccessToken`/`baseUrlForBridge` 於 Task 6 定義、同 Task 使用；`createWhiteboardPage(boardId, {format})` Task 7 定義並更新測試 Fake；路由字串 `'/whiteboard/excalidraw/:boardId/:pageId'` 與分流/桌面外開連結一致。修正一處：excalidraw_host_web 的 apiBase 改用 `baseUrlForBridge`（已於 Task 6 Step 2 內以「實作提醒」明確覆寫範例中的 origin 推導）。✅
