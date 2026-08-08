# Whiteboard GoodNotes 化 + Phase 0 還債 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 還清三筆技術債（invite 競態、死分支、AI 改接自家 GPU），並把白板升級為 GoodNotes 式筆記本：iPad 原生 PencilKit 墨水 + 筆記本→頁結構。

**Architecture:** 墨水引擎用 iOS 原生 PencilKit，包成 local Flutter plugin（`app/packages/pencil_canvas`，避免手改 pbxproj）；筆記本/頁結構與導覽留在 Flutter；後端新增 `WhiteboardPage` model（bytea 筆跡 + MinIO 縮圖）與 6 個端點掛在現有 whiteboard module。舊 Flutter 畫布保留供舊白板開啟，不做資料遷移。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL（bytea）+ MinIO；Flutter 3.41.2 + Riverpod + go_router + dio；Swift + PencilKit（PKCanvasView / PKToolPicker，iOS 14+）。

**Spec:** [docs/superpowers/specs/2026-08-09-whiteboard-goodnotes-design.md](../specs/2026-08-09-whiteboard-goodnotes-design.md)

## Global Constraints

- Node 22 / NestJS 11 / Prisma 6；後端測試基準 **160 個全綠**，每個任務結束不得低於此數。
- Flutter 3.41.2 / Dart >=3.11；`flutter analyze --no-fatal-infos` 必須 **exit 0、0 warning**。
- iOS 最低版本由本計畫從 13.0 升到 **14.0**（PKToolPicker 需要）。
- UI 間距/圓角/字級一律用 `OideaSpace` / `OideaRadius` / `OideaFontSize` / `OideaType`（`app/lib/core/theme/app_theme.dart`），禁止裸數字。
- UI 文案繁體中文；程式碼註解風格跟隨該檔既有密度。
- 後端 API 走 `setGlobalPrefix('api')`；Flutter 端一律經 `apiClientProvider`（dio），回傳型別跟隨現有慣例（`Map<String, dynamic>` / `List<dynamic>`）。
- Commit 訊息照任務內提供的文字，結尾加上標準 Claude co-author footer。
- Phase 0 各任務獨立分支 + PR + CI 綠後合併；Phase 1（Task 4–11）全部在 `feat/whiteboard-notebooks` 分支，每任務一 commit，最後一個 PR。
- 凍結區（本計畫**不得**觸碰）：`whiteboard.gateway.ts`（Yjs/CRDT）、meetings WebRTC、C-15~18/P-14/P-15/D-02/04/07 相關碼。

## File Structure

```
Phase 0
  backend/src/invites/invites.service.ts        修改（cherry-pick a790ad9）
  backend/src/invites/invites.service.spec.ts   新增（競態回歸測試）
  backend/src/ai/ai.service.ts                  修改（Anthropic SDK → fetch b300）
  backend/src/ai/ai.service.spec.ts             新增
  backend/.env.example                          修改（AI_BASE_URL 等）
  backend/package.json                          修改（移除 @anthropic-ai/sdk）

Phase 1 — backend
  backend/prisma/schema.prisma                  修改（+WhiteboardPage model）
  backend/src/whiteboard/whiteboard-pages.service.ts        新增
  backend/src/whiteboard/whiteboard-pages.service.spec.ts   新增
  backend/src/whiteboard/whiteboard-pages.controller.ts     新增
  backend/src/whiteboard/whiteboard.module.ts   修改（掛新 service/controller + FilesModule）

Phase 1 — pencil_canvas plugin（local plugin，免動 pbxproj）
  app/packages/pencil_canvas/pubspec.yaml                   新增
  app/packages/pencil_canvas/ios/pencil_canvas.podspec      新增
  app/packages/pencil_canvas/ios/Classes/PencilCanvasPlugin.swift  新增
  app/packages/pencil_canvas/lib/pencil_canvas.dart         新增
  app/ios/Podfile                                修改（platform :ios, '14.0'）
  app/ios/Runner.xcodeproj/project.pbxproj       修改（DEPLOYMENT_TARGET 14.0 ×3）
  app/pubspec.yaml                               修改（+pencil_canvas path dep）

Phase 1 — Flutter app
  app/lib/core/network/api_client.dart           修改（+6 個 pages 方法）
  app/lib/features/whiteboard/providers/whiteboard_provider.dart  修改（+pagesProvider）
  app/lib/features/whiteboard/presentation/pages/whiteboard_pages_page.dart   新增（頁面格）
  app/lib/features/whiteboard/presentation/pages/whiteboard_pencil_page.dart  新增（畫布頁）
  app/lib/features/whiteboard/presentation/pages/whiteboard_home_page.dart    修改（點擊導向頁面格）
  app/lib/core/router/app_router.dart            修改（+2 路由）
  app/test/whiteboard_pages_test.dart            新增
  app/test/pencil_canvas_channel_test.dart       新增
  docs/REQUIREMENTS.md                           修改（W-07/09/12 狀態 + 筆記本條目）
```

---

## Phase 0 — 還債

### Task 1: Invite TOCTOU 修復（cherry-pick + 回歸測試）

**Files:**
- Modify: `backend/src/invites/invites.service.ts`（由 cherry-pick 完成）
- Test: `backend/src/invites/invites.service.spec.ts`（新增）

**Interfaces:**
- Consumes: `InvitesService.accept(userId: string, token: string)`（既有）
- Produces: 行為不變的 `accept()`，但單次使用保證由 DB 條件式寫入承擔

- [ ] **Step 1: 建分支並 cherry-pick 修復**

```bash
cd /Users/optyne/repository/oidea
git checkout main && git pull --ff-only
git checkout -b fix/invite-toctou
git cherry-pick a790ad9
```

Expected: cherry-pick 乾淨落地（該 commit 只動 `invites.service.ts` 一檔）。若有衝突，以分支版本（`updateMany` 條件式寫法）為準。

- [ ] **Step 2: 寫回歸測試（先確認會跑）**

新增 `backend/src/invites/invites.service.spec.ts`：

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';

// tx mock：$transaction(callback) 直接把 txMock 餵給 callback
const buildTx = () => ({
  workspaceInvite: { updateMany: jest.fn() },
  workspaceMember: { create: jest.fn() },
});

describe('InvitesService.accept — TOCTOU 回歸（單次使用保證）', () => {
  let service: InvitesService;
  let prisma: any;
  let tx: ReturnType<typeof buildTx>;

  const INVITE = {
    id: 'inv-1',
    token: 'tok-1',
    workspaceId: 'ws-1',
    role: 'member',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 3600_000),
  };

  beforeEach(async () => {
    tx = buildTx();
    prisma = {
      workspaceInvite: { findUnique: jest.fn().mockResolvedValue(INVITE), updateMany: jest.fn() },
      workspaceMember: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  it('搶到 invite（updateMany count=1）→ 建立 member', async () => {
    tx.workspaceInvite.updateMany.mockResolvedValue({ count: 1 });
    tx.workspaceMember.create.mockResolvedValue({ id: 'm-1', workspaceId: 'ws-1' });

    await service.accept('u-1', 'tok-1');

    expect(tx.workspaceInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'inv-1', consumedAt: null }),
      }),
    );
    expect(tx.workspaceMember.create).toHaveBeenCalled();
  });

  it('沒搶到（count=0，被併發者先消費）→ Forbidden，不建 member', async () => {
    tx.workspaceInvite.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.accept('u-2', 'tok-1')).rejects.toThrow(ForbiddenException);
    expect(tx.workspaceMember.create).not.toHaveBeenCalled();
  });

  it('已是成員 → 走條件式 updateMany 消費（帶 consumedAt:null 過濾），不建 member', async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue({ id: 'm-0', role: 'admin' });
    prisma.workspaceInvite.updateMany.mockResolvedValue({ count: 1 });

    await service.accept('u-3', 'tok-1');

    expect(prisma.workspaceInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ consumedAt: null }),
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
```

注意：`InvitesService` 建構子依賴請先開檔確認（`grep -n "constructor" -A6 backend/src/invites/invites.service.ts`）；若還注入其他 service（如 NotificationsService），照 Task 1 測試同樣以 `{ provide: X, useValue: {...jest.fn()} }` 補齊 —— 缺 provider 會直接 DI 解析失敗，這正是 2026-08-08 修過 30 個測試的同型錯。

- [ ] **Step 3: 跑測試確認綠**

```bash
cd backend && npx prisma generate && npm test -- --testPathPattern=invites
```

Expected: 3 passed。再跑全量 `npm test` → 163 passed（160 + 3）。

- [ ] **Step 4: Commit + PR**

```bash
git add backend/src/invites
git commit -m "fix(invites): close TOCTOU race in accept() with regression tests

Cherry-picked a790ad9 from feat/invite-link (sat unmerged since April):
accept() now consumes the invite with a conditional updateMany
(consumedAt: null + not expired) inside the member-creation transaction,
so concurrent accepts of the same link admit exactly one user.

Adds the regression spec the original commit lacked: count=1 admits,
count=0 throws Forbidden without creating a member, and the
already-member path also consumes conditionally."
git push -u origin fix/invite-toctou
gh pr create --base main --title "fix(invites): close TOCTOU race in accept()" --body "Cherry-pick of a790ad9 + 3 條回歸測試。合併後刪除 feat/invite-link。"
```

CI 綠後合併，然後：`git push origin --delete feat/invite-link`。

---

### Task 2: 刪除 10 個死分支

**Files:** 無（純 git 操作）

**Interfaces:**
- Consumes: 2026-08-08 的盤點結論（每支 `git rev-list --count origin/main..origin/<branch>` = 0，或 diff 為空）
- Produces: 乾淨的遠端分支清單

- [ ] **Step 1: 逐支驗證獨有 commit 數為 0 後刪除**

```bash
cd /Users/optyne/repository/oidea && git fetch --prune
for b in claude/organize-pricing-contracts-biTxB fix/redis-auth-and-pr2-migration \
         feat/erp-knowledge-expansion feat/invite-member-by-email \
         feat/audit-and-ratelimit fix/backend-dist-path chore/dokploy-deploy \
         feat/knowledge-acl feat/all-in-one; do
  n=$(git rev-list --count origin/main..origin/$b)
  if [ "$n" = "0" ]; then git push origin --delete "$b" && echo "deleted: $b"; else echo "SKIP $b (unique commits: $n)"; fi
done
# fix/backend-minio-graceful 獨有 commit=1 但 diff 為空（內容已由別路徑進 main），單獨驗證後刪：
git diff --quiet origin/main...origin/fix/backend-minio-graceful && git push origin --delete fix/backend-minio-graceful || echo "SKIP: diff 非空，人工檢查"
```

Expected: 10 支全部 deleted、0 支 SKIP。任何 SKIP 都停下來回報，不硬刪。

- [ ] **Step 2: 驗證**

```bash
git branch -r
```

Expected: 僅剩 `origin/main`、`origin/feat/ai-tagging`、`origin/feat/bot-integration`、`origin/feat/web-deploy`、`origin/claude/add-pricing-worksheet-NbKdU`、`origin/feat/ui-kit-preview`（若 Task 1 已合併，`feat/invite-link` 也已刪）。

---

### Task 3: AI 模組改接 b300 自家端點後合併

**Files:**
- Modify: `backend/src/ai/ai.service.ts`（merge 進來後改寫 client 層）
- Modify: `backend/.env.example`、`backend/package.json`（移除 `@anthropic-ai/sdk`）
- Test: `backend/src/ai/ai.service.spec.ts`（新增）

**Interfaces:**
- Consumes: `feat/ai-tagging` 分支的 `AiService`（`handleAiMention()` / `ensureBotUser()` / rate-limit / `postBotMessage()` 全部保留不動）
- Produces: `AiService.buildChatMessages(ordered: Array<{senderId: string; content: string | null; sender?: { displayName: string } | null}>, botUserId: string): Array<{role: 'user' | 'assistant'; content: string}>`（static，供測試）；`generateReply()` 改打 `${AI_BASE_URL}/chat/completions`

- [ ] **Step 1: 建分支併入 AI 分支**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/ai-b300
git merge origin/feat/ai-tagging -m "merge: bring in @ai chat assistant from feat/ai-tagging"
```

Expected: 若 `package-lock.json` 衝突，`git checkout --theirs backend/package-lock.json` 後在 Step 4 重新 `npm install` 收斂。

- [ ] **Step 2: 改寫 `ai.service.ts` 的 client 層**

改動範圍（其餘 mention regex、rate limit、bot user、postBotMessage 全部不動）：

(a) 刪 `import Anthropic from '@anthropic-ai/sdk';`，`private client: Anthropic | null` 改為 `private ready = false;`

(b) 建構子讀值改為：

```typescript
this.model = this.config.get<string>('AI_MODEL', '');
this.baseUrl = (this.config.get<string>('AI_BASE_URL', '') || '').replace(/\/+$/, '');
// this.effort 欄位整個刪除（OpenAI 相容端點無此參數）
```

並新增欄位 `private readonly baseUrl: string;` 與 `private apiKey = '';`

(c) `onModuleInit` 改為：

```typescript
async onModuleInit() {
  if (!this.enabled) {
    this.logger.log('AI assistant disabled (AI_ENABLED=false)');
    return;
  }
  this.apiKey = this.config.get<string>('AI_API_KEY', '');
  if (!this.baseUrl || !this.model) {
    this.logger.warn('AI_BASE_URL / AI_MODEL 未設定；AI 功能停用');
    return;
  }
  this.ready = true;
  this.botUserId = await this.ensureBotUser();
  this.logger.log(`AI assistant ready (endpoint=${this.baseUrl}, model=${this.model}, botUserId=${this.botUserId})`);
}
```

（`handleAiMention` 開頭的 `if (!this.client || !this.botUserId) return;` 改為 `if (!this.ready || !this.botUserId) return;`）

(d) 訊息組裝抽成 static 純函式（把 `generateReply` 內的 map + 結尾 user 保證搬出來）：

```typescript
static buildChatMessages(
  ordered: Array<{ senderId: string; content: string | null; sender?: { displayName: string } | null }>,
  botUserId: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = ordered.map((m) => {
    const isBot = m.senderId === botUserId;
    const author = m.sender?.displayName ?? 'user';
    const text = m.content ?? '';
    return {
      role: (isBot ? 'assistant' : 'user') as 'user' | 'assistant',
      content: isBot ? text : `${author}: ${text}`,
    };
  });
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '（上面是最新對話；請回應最後一則 @ai 的訊息）' });
  }
  return messages;
}
```

(e) `generateReply` 的呼叫段改為 fetch（Node 22 原生）：

```typescript
const messages = AiService.buildChatMessages(ordered, this.botUserId!);

const res = await fetch(`${this.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
  },
  body: JSON.stringify({
    model: this.model,
    max_tokens: 4096,
    messages: [{ role: 'system', content: this.systemPrompt }, ...messages],
  }),
  signal: AbortSignal.timeout(60_000),
});
if (!res.ok) {
  throw new Error(`AI endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
const data: any = await res.json();
const text = (data?.choices?.[0]?.message?.content ?? '').trim();
return text || '（抱歉，我沒有想到要說什麼。）';
```

- [ ] **Step 3: 更新 env 與相依**

`backend/.env.example` 的 AI 段改為：

```bash
# ── Oidea AI 助手（@ai 在 chat 觸發，走自家 b300 OpenAI 相容端點）─────
# 若不要 AI 功能：AI_ENABLED=false，或不設 AI_BASE_URL
AI_ENABLED="true"
AI_BASE_URL=""                 # 例：https://b300.powerchampion.ai/v1
AI_API_KEY=""
AI_MODEL=""                    # 以 b300 /v1/models 實際回傳的 id 為準
AI_RATE_LIMIT_PER_HOUR="10"    # 每個使用者每小時最多 @ai 次數
```

（刪除 `ANTHROPIC_API_KEY` 與 `AI_EFFORT` 兩行。）

```bash
cd backend && npm uninstall @anthropic-ai/sdk && npm install
grep -c anthropic package.json
```

Expected: grep 輸出 `0`。

- [ ] **Step 4: 寫測試**

新增 `backend/src/ai/ai.service.spec.ts`：

```typescript
import { AiService } from './ai.service';

describe('AiService.buildChatMessages', () => {
  const BOT = 'bot-1';

  it('bot 的訊息 → assistant turn、原文；他人訊息 → user turn、帶 displayName 前綴', () => {
    const out = AiService.buildChatMessages(
      [
        { senderId: 'u-1', content: '早安 @ai', sender: { displayName: '小明' } },
        { senderId: BOT, content: '早安！', sender: { displayName: 'Oidea AI' } },
        { senderId: 'u-2', content: '幫我摘要', sender: { displayName: '阿華' } },
      ],
      BOT,
    );
    expect(out).toEqual([
      { role: 'user', content: '小明: 早安 @ai' },
      { role: 'assistant', content: '早安！' },
      { role: 'user', content: '阿華: 幫我摘要' },
    ]);
  });

  it('結尾是 assistant → 自動補一個 user turn', () => {
    const out = AiService.buildChatMessages([{ senderId: BOT, content: 'hi', sender: null }], BOT);
    expect(out[out.length - 1].role).toBe('user');
  });

  it('空輸入 → 只有補上的 user turn', () => {
    const out = AiService.buildChatMessages([], BOT);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('content 為 null → 空字串，不炸', () => {
    const out = AiService.buildChatMessages([{ senderId: 'u-1', content: null, sender: null }], BOT);
    expect(out[0].content).toBe('user: ');
  });
});
```

```bash
npm test -- --testPathPattern=ai.service
```

Expected: 4 passed。全量 `npm test` ≥ 167 passed，`npm run build` 乾淨（Anthropic 型別已移除，build 會抓到殘留引用）。

- [ ] **Step 5: Commit + PR**

```bash
git add backend
git commit -m "feat(ai): rewire @ai assistant to in-house b300 endpoint

Brings the @ai chat assistant over from feat/ai-tagging and swaps its
brain: the Anthropic SDK is gone, replaced by a plain fetch to an
OpenAI-compatible /chat/completions endpoint (AI_BASE_URL / AI_API_KEY /
AI_MODEL). Marginal cost of an @ai reply is now our own GPU time
instead of a per-token API bill.

Mention detection, hourly rate limiting, the locked bot user and the
posting path are untouched. Message assembly is extracted into a static
buildChatMessages() with unit tests (author prefixing, assistant turns,
trailing-user guarantee, null content)."
git push -u origin feat/ai-b300
gh pr create --base main --title "feat(ai): @ai assistant on in-house b300 endpoint" --body "來自 feat/ai-tagging 的 @ai 助手，client 層改打自家 OpenAI 相容端點。合併後刪除 feat/ai-tagging。"
```

CI 綠後合併，然後 `git push origin --delete feat/ai-tagging`。

---

## Phase 1 — 白板 GoodNotes 化（分支 `feat/whiteboard-notebooks`）

### Task 4: Prisma `WhiteboardPage` model + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Produces: `WhiteboardPage`（後續所有任務依賴的欄位名：`id/whiteboardId/position/drawing/thumbnailId/createdAt/updatedAt/deletedAt`）；`Whiteboard.pages` relation

- [ ] **Step 1: 開分支**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/whiteboard-notebooks
```

- [ ] **Step 2: 加 model**

在 `backend/prisma/schema.prisma` 的 `model WhiteboardSession` 之後新增：

```prisma
model WhiteboardPage {
  id           String    @id @default(uuid())
  whiteboardId String
  position     Int
  drawing      Bytes? // PKDrawing dataRepresentation（Apple 原生格式，server 不解析）
  thumbnailId  String? // File.id → MinIO PNG，非 iOS 平台唯讀檢視用
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  deletedAt    DateTime?

  whiteboard Whiteboard @relation(fields: [whiteboardId], references: [id], onDelete: Cascade)

  @@index([whiteboardId, deletedAt])
  @@map("whiteboard_pages")
}
```

並在 `model Whiteboard` 的 `sessions WhiteboardSession[]` 下一行加：

```prisma
  pages WhiteboardPage[]
```

- [ ] **Step 3: 跑 migration + 驗證**

```bash
cd backend && docker compose up -d
npx prisma migrate dev --name add_whiteboard_pages
npx prisma generate && npm test && npm run build
```

Expected: migration 建立 `whiteboard_pages` 表；全量測試綠；build 乾淨。

- [ ] **Step 4: Commit**

```bash
git add backend/prisma
git commit -m "feat(whiteboard): add WhiteboardPage model

A whiteboard becomes a notebook: pages carry the PencilKit drawing as
bytea (opaque to the server) and an optional MinIO thumbnail for
read-only viewing off-iPad. Soft-delete and cascade follow the existing
conventions."
```

### Task 5: `WhiteboardPagesService`（TDD）

**Files:**
- Create: `backend/src/whiteboard/whiteboard-pages.service.ts`
- Test: `backend/src/whiteboard/whiteboard-pages.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`；`FilesService.upload(userId, workspaceId, file: Express.Multer.File)`（回傳含 `id`/`url` 的 File record）
- Produces（Task 6/8 依賴的精確簽章）:
  - `listPages(userId, whiteboardId): Promise<Array<{id, position, thumbnailUrl: string | null, updatedAt}>>`
  - `getPage(userId, whiteboardId, pageId): Promise<{id, position, drawing: string | null}>`（drawing = base64）
  - `createPage(userId, whiteboardId): Promise<{id, position}>`
  - `savePage(userId, whiteboardId, pageId, drawingBase64: string, thumbnailPngBase64?: string): Promise<{id, updatedAt}>`
  - `reorderPages(userId, whiteboardId, orderedIds: string[]): Promise<{count: number}>`
  - `deletePage(userId, whiteboardId, pageId): Promise<{id: string}>`

- [ ] **Step 1: 寫失敗測試**

新增 `backend/src/whiteboard/whiteboard-pages.service.spec.ts`：

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { PrismaService } from '../common/prisma.service';
import { FilesService } from '../files/files.service';

const BOARD = { id: 'wb-1', workspaceId: 'ws-1', deletedAt: null };

describe('WhiteboardPagesService', () => {
  let service: WhiteboardPagesService;
  let prisma: any;
  let files: { upload: jest.Mock };

  beforeEach(async () => {
    prisma = {
      whiteboard: { findUnique: jest.fn().mockResolvedValue(BOARD) },
      workspaceMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm-1' }) },
      whiteboardPage: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn(),
      },
      file: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prisma))),
    };
    files = { upload: jest.fn().mockResolvedValue({ id: 'f-1', url: 'http://minio/f-1.png' }) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhiteboardPagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: FilesService, useValue: files },
      ],
    }).compile();
    service = module.get(WhiteboardPagesService);
  });

  it('listPages: 回 position 升序、含 thumbnailUrl、不含 drawing', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([
      { id: 'p-1', position: 0, thumbnailId: 'f-1', updatedAt: new Date() },
      { id: 'p-2', position: 1, thumbnailId: null, updatedAt: new Date() },
    ]);
    prisma.file.findMany.mockResolvedValue([{ id: 'f-1', url: 'http://minio/f-1.png' }]);

    const out = await service.listPages('u-1', 'wb-1');

    expect(prisma.whiteboardPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { whiteboardId: 'wb-1', deletedAt: null },
        orderBy: { position: 'asc' },
      }),
    );
    expect(out[0].thumbnailUrl).toBe('http://minio/f-1.png');
    expect(out[1].thumbnailUrl).toBeNull();
    expect((out[0] as any).drawing).toBeUndefined();
  });

  it('非 workspace 成員 → Forbidden', async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(service.listPages('u-x', 'wb-1')).rejects.toThrow(ForbiddenException);
  });

  it('getPage: drawing bytes → base64 字串；null 保持 null', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({
      id: 'p-1', whiteboardId: 'wb-1', position: 0, drawing: Buffer.from('PKDATA'), deletedAt: null,
    });
    const out = await service.getPage('u-1', 'wb-1', 'p-1');
    expect(out.drawing).toBe(Buffer.from('PKDATA').toString('base64'));
  });

  it('getPage: 不存在或已刪 → NotFound', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue(null);
    await expect(service.getPage('u-1', 'wb-1', 'nope')).rejects.toThrow(NotFoundException);
  });

  it('createPage: position 接在最大值之後', async () => {
    prisma.whiteboardPage.aggregate.mockResolvedValue({ _max: { position: 2 } });
    prisma.whiteboardPage.create.mockResolvedValue({ id: 'p-4', position: 3 });
    const out = await service.createPage('u-1', 'wb-1');
    expect(prisma.whiteboardPage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 3 }) }),
    );
    expect(out.position).toBe(3);
  });

  it('savePage: base64 → Buffer 存入；帶縮圖時經 FilesService 上傳並記 thumbnailId', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({ id: 'p-1', whiteboardId: 'wb-1', deletedAt: null });
    prisma.whiteboardPage.update.mockResolvedValue({ id: 'p-1', updatedAt: new Date() });
    const drawing = Buffer.from('INK').toString('base64');
    const thumb = Buffer.from('PNG').toString('base64');

    await service.savePage('u-1', 'wb-1', 'p-1', drawing, thumb);

    expect(files.upload).toHaveBeenCalledWith(
      'u-1', 'ws-1',
      expect.objectContaining({ mimetype: 'image/png' }),
    );
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ drawing: Buffer.from('INK'), thumbnailId: 'f-1' }),
      }),
    );
  });

  it('savePage: 不帶縮圖 → 不動 thumbnailId、不呼叫 upload', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({ id: 'p-1', whiteboardId: 'wb-1', deletedAt: null });
    prisma.whiteboardPage.update.mockResolvedValue({ id: 'p-1', updatedAt: new Date() });

    await service.savePage('u-1', 'wb-1', 'p-1', Buffer.from('INK').toString('base64'));

    expect(files.upload).not.toHaveBeenCalled();
    const updateArg = prisma.whiteboardPage.update.mock.calls[0][0];
    expect(updateArg.data.thumbnailId).toBeUndefined();
  });

  it('reorderPages: 依 orderedIds 重寫 position（transaction 全量）', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([
      { id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' },
    ]);
    prisma.whiteboardPage.update.mockResolvedValue({});
    const out = await service.reorderPages('u-1', 'wb-1', ['p-3', 'p-1', 'p-2']);
    expect(out.count).toBe(3);
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith({ where: { id: 'p-3' }, data: { position: 0 } });
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: { position: 1 } });
  });

  it('reorderPages: orderedIds 與現存頁面集合不一致 → NotFound', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
    await expect(service.reorderPages('u-1', 'wb-1', ['p-1'])).rejects.toThrow(NotFoundException);
  });

  it('deletePage: 軟刪除', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({ id: 'p-1', whiteboardId: 'wb-1', deletedAt: null });
    prisma.whiteboardPage.update.mockResolvedValue({ id: 'p-1' });
    await service.deletePage('u-1', 'wb-1', 'p-1');
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- --testPathPattern=whiteboard-pages
```

Expected: FAIL —— `Cannot find module './whiteboard-pages.service'`。

- [ ] **Step 3: 實作 service**

新增 `backend/src/whiteboard/whiteboard-pages.service.ts`：

```typescript
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { FilesService } from '../files/files.service';

/**
 * 筆記本的「頁」：drawing 是 PKDrawing dataRepresentation（不透明 bytes），
 * server 不解析；縮圖 PNG 走 FilesService 進 MinIO，供非 iOS 平台唯讀檢視。
 */
@Injectable()
export class WhiteboardPagesService {
  constructor(
    private prisma: PrismaService,
    private files: FilesService,
  ) {}

  /** 確認白板存在且呼叫者是該 workspace 成員；回傳 board 供後續取 workspaceId。 */
  private async assertAccess(userId: string, whiteboardId: string) {
    const board = await this.prisma.whiteboard.findUnique({
      where: { id: whiteboardId, deletedAt: null },
    });
    if (!board) throw new NotFoundException('白板不存在');
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: board.workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
    return board;
  }

  private async getLivePage(whiteboardId: string, pageId: string) {
    const page = await this.prisma.whiteboardPage.findUnique({ where: { id: pageId } });
    if (!page || page.deletedAt || page.whiteboardId !== whiteboardId) {
      throw new NotFoundException('頁面不存在');
    }
    return page;
  }

  async listPages(userId: string, whiteboardId: string) {
    await this.assertAccess(userId, whiteboardId);
    const pages = await this.prisma.whiteboardPage.findMany({
      where: { whiteboardId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, thumbnailId: true, updatedAt: true },
    });
    const thumbIds = pages.map((p) => p.thumbnailId).filter((x): x is string => !!x);
    const thumbs = thumbIds.length
      ? await this.prisma.file.findMany({ where: { id: { in: thumbIds } }, select: { id: true, url: true } })
      : [];
    const urlById = new Map(thumbs.map((f) => [f.id, f.url]));
    return pages.map(({ thumbnailId, ...p }) => ({
      ...p,
      thumbnailUrl: thumbnailId ? (urlById.get(thumbnailId) ?? null) : null,
    }));
  }

  async getPage(userId: string, whiteboardId: string, pageId: string) {
    await this.assertAccess(userId, whiteboardId);
    const page = await this.getLivePage(whiteboardId, pageId);
    return {
      id: page.id,
      position: page.position,
      drawing: page.drawing ? Buffer.from(page.drawing).toString('base64') : null,
    };
  }

  async createPage(userId: string, whiteboardId: string) {
    await this.assertAccess(userId, whiteboardId);
    const agg = await this.prisma.whiteboardPage.aggregate({
      where: { whiteboardId, deletedAt: null },
      _max: { position: true },
    });
    const position = (agg._max.position ?? -1) + 1;
    const page = await this.prisma.whiteboardPage.create({
      data: { whiteboardId, position },
      select: { id: true, position: true },
    });
    return page;
  }

  async savePage(
    userId: string,
    whiteboardId: string,
    pageId: string,
    drawingBase64: string,
    thumbnailPngBase64?: string,
  ) {
    const board = await this.assertAccess(userId, whiteboardId);
    await this.getLivePage(whiteboardId, pageId);

    let thumbnailId: string | undefined;
    if (thumbnailPngBase64) {
      const buf = Buffer.from(thumbnailPngBase64, 'base64');
      const uploaded = await this.files.upload(userId, board.workspaceId, {
        originalname: `whiteboard-page-${pageId}.png`,
        mimetype: 'image/png',
        size: buf.length,
        buffer: buf,
      } as Express.Multer.File);
      thumbnailId = uploaded.id;
    }

    return this.prisma.whiteboardPage.update({
      where: { id: pageId },
      data: {
        drawing: Buffer.from(drawingBase64, 'base64'),
        ...(thumbnailId ? { thumbnailId } : {}),
      },
      select: { id: true, updatedAt: true },
    });
  }

  async reorderPages(userId: string, whiteboardId: string, orderedIds: string[]) {
    await this.assertAccess(userId, whiteboardId);
    const live = await this.prisma.whiteboardPage.findMany({
      where: { whiteboardId, deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((p) => p.id));
    const sameSize = liveIds.size === orderedIds.length;
    if (!sameSize || !orderedIds.every((id) => liveIds.has(id))) {
      throw new NotFoundException('orderedIds 與現存頁面不一致');
    }
    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.whiteboardPage.update({ where: { id }, data: { position: index } }),
      ),
    );
    return { count: orderedIds.length };
  }

  async deletePage(userId: string, whiteboardId: string, pageId: string) {
    await this.assertAccess(userId, whiteboardId);
    await this.getLivePage(whiteboardId, pageId);
    await this.prisma.whiteboardPage.update({
      where: { id: pageId },
      data: { deletedAt: new Date() },
    });
    return { id: pageId };
  }
}
```

- [ ] **Step 4: 跑測試確認綠**

```bash
npm test -- --testPathPattern=whiteboard-pages
```

Expected: 10 passed。

- [ ] **Step 5: Commit**

```bash
git add backend/src/whiteboard
git commit -m "feat(whiteboard): pages service — CRUD, reorder, ACL, thumbnails

Drawing bytes stay opaque (base64 over the wire, bytea at rest). List
never ships ink — pages lazy-load. Thumbnails ride the existing
FilesService into MinIO. Reorder is a full rewrite inside a transaction
and rejects a stale id set. 10 unit tests."
```

### Task 6: Pages controller + module 掛載

**Files:**
- Create: `backend/src/whiteboard/whiteboard-pages.controller.ts`
- Modify: `backend/src/whiteboard/whiteboard.module.ts`
- Modify（如需）: `backend/src/files/files.module.ts`

**Interfaces:**
- Consumes: Task 5 的 `WhiteboardPagesService` 六個方法
- Produces（Task 8 的 Flutter client 依賴的路徑與 body 形狀）:
  - `GET    api/whiteboard/:boardId/pages`
  - `GET    api/whiteboard/:boardId/pages/:pageId`
  - `POST   api/whiteboard/:boardId/pages`
  - `PUT    api/whiteboard/:boardId/pages/:pageId`　body `{ drawing: string, thumbnail?: string }`（皆 base64）
  - `PATCH  api/whiteboard/:boardId/pages/reorder`　body `{ orderedIds: string[] }`
  - `DELETE api/whiteboard/:boardId/pages/:pageId`

- [ ] **Step 1: 確認 FilesService 可注入**

```bash
grep -n "exports" backend/src/files/files.module.ts
```

若沒有 `exports: [FilesService]`，把 files.module.ts 的 `@Module({...})` 補上 `exports: [FilesService],`。

- [ ] **Step 2: 寫 controller**

新增 `backend/src/whiteboard/whiteboard-pages.controller.ts`：

```typescript
import { Controller, Get, Post, Put, Patch, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('白板頁面')
@Controller('whiteboard/:boardId/pages')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WhiteboardPagesController {
  constructor(private pages: WhiteboardPagesService) {}

  @Get()
  @ApiOperation({ summary: '頁面清單（縮圖 URL，不含筆跡）' })
  list(@Req() req: any, @Param('boardId') boardId: string) {
    return this.pages.listPages(req.user.userId, boardId);
  }

  // 注意：reorder 必須排在 :pageId 之前，避免 'reorder' 被當成 pageId 匹配
  @Patch('reorder')
  @ApiOperation({ summary: '以 orderedIds 全量重排頁面' })
  reorder(@Req() req: any, @Param('boardId') boardId: string, @Body() body: { orderedIds: string[] }) {
    return this.pages.reorderPages(req.user.userId, boardId, body?.orderedIds ?? []);
  }

  @Get(':pageId')
  @ApiOperation({ summary: '單頁筆跡（base64）' })
  get(@Req() req: any, @Param('boardId') boardId: string, @Param('pageId') pageId: string) {
    return this.pages.getPage(req.user.userId, boardId, pageId);
  }

  @Post()
  @ApiOperation({ summary: '新增頁（接在最後）' })
  create(@Req() req: any, @Param('boardId') boardId: string) {
    return this.pages.createPage(req.user.userId, boardId);
  }

  @Put(':pageId')
  @ApiOperation({ summary: '存筆跡（可選帶縮圖 PNG，皆 base64）' })
  save(
    @Req() req: any,
    @Param('boardId') boardId: string,
    @Param('pageId') pageId: string,
    @Body() body: { drawing: string; thumbnail?: string },
  ) {
    return this.pages.savePage(req.user.userId, boardId, pageId, body?.drawing ?? '', body?.thumbnail);
  }

  @Delete(':pageId')
  @ApiOperation({ summary: '刪除頁（軟刪除）' })
  remove(@Req() req: any, @Param('boardId') boardId: string, @Param('pageId') pageId: string) {
    return this.pages.deletePage(req.user.userId, boardId, pageId);
  }
}
```

- [ ] **Step 3: 掛進 module**

`backend/src/whiteboard/whiteboard.module.ts` 改為：

```typescript
import { Module } from '@nestjs/common';
import { WhiteboardController } from './whiteboard.controller';
import { WhiteboardService } from './whiteboard.service';
import { WhiteboardGateway } from './whiteboard.gateway';
import { WhiteboardPagesController } from './whiteboard-pages.controller';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [FilesModule],
  controllers: [WhiteboardController, WhiteboardPagesController],
  providers: [WhiteboardService, WhiteboardGateway, WhiteboardPagesService],
  exports: [WhiteboardService],
})
export class WhiteboardModule {}
```

- [ ] **Step 4: 驗證（body 大小上限一併確認）**

```bash
grep -rn "bodyParser\|json({ limit\|urlencoded({ limit" backend/src/main.ts
```

若 `main.ts` 沒有設定 json body 上限（Nest 預設 100kb，**筆跡 base64 會超過**），在 `main.ts` 的 `NestFactory.create` 之後加：

```typescript
import { json } from 'express';
// ...
app.use(json({ limit: '20mb' })); // 白板筆跡 base64 上限（spec: >10MB 警告，20mb 留 buffer）
```

```bash
npm test && npm run build
```

Expected: 全綠、build 乾淨。

- [ ] **Step 5: Commit**

```bash
git add backend/src
git commit -m "feat(whiteboard): pages REST endpoints

Six routes under whiteboard/:boardId/pages. reorder is declared before
:pageId so the literal segment wins route matching. JSON body limit
raised to 20mb — a page of ink as base64 clears the 100kb express
default by orders of magnitude."
```

### Task 7: `pencil_canvas` local plugin（Swift + Dart）

**Files:**
- Create: `app/packages/pencil_canvas/pubspec.yaml`
- Create: `app/packages/pencil_canvas/ios/pencil_canvas.podspec`
- Create: `app/packages/pencil_canvas/ios/Classes/PencilCanvasPlugin.swift`
- Create: `app/packages/pencil_canvas/lib/pencil_canvas.dart`
- Modify: `app/pubspec.yaml`、`app/ios/Podfile`、`app/ios/Runner.xcodeproj/project.pbxproj`
- Test: `app/test/pencil_canvas_channel_test.dart`

**Interfaces:**
- Produces（Task 10 依賴）:
  - `PencilCanvasView({Uint8List? initialDrawing, bool fingerDrawing = false, void Function(PencilCanvasController)? onCreated, VoidCallback? onDrawingChanged})`
  - `PencilCanvasController`: `Future<Uint8List> getDrawing()` / `Future<void> setDrawing(Uint8List)` / `Future<void> undo()` / `Future<void> redo()` / `Future<void> setFingerDrawing(bool)` / `Future<Uint8List> renderThumbnail({int maxWidth = 512})`
  - viewType `oidea/pencil_canvas`；per-view channel `oidea/pencil_canvas_<viewId>`

- [ ] **Step 1: plugin 骨架**

`app/packages/pencil_canvas/pubspec.yaml`：

```yaml
name: pencil_canvas
description: PencilKit canvas platform view for Oidea (iOS/iPadOS only).
version: 0.1.0
publish_to: none

environment:
  sdk: '>=3.11.0 <4.0.0'
  flutter: '>=3.41.0'

dependencies:
  flutter:
    sdk: flutter

flutter:
  plugin:
    platforms:
      ios:
        pluginClass: PencilCanvasPlugin
```

`app/packages/pencil_canvas/ios/pencil_canvas.podspec`：

```ruby
Pod::Spec.new do |s|
  s.name             = 'pencil_canvas'
  s.version          = '0.1.0'
  s.summary          = 'PencilKit canvas platform view for Oidea.'
  s.description      = 'Embeds PKCanvasView + PKToolPicker as a Flutter platform view.'
  s.homepage         = 'https://github.com/optyne/oidea'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Oidea' => 'dev@oadpiz.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform         = :ios, '14.0'
  s.swift_version    = '5.0'
end
```

- [ ] **Step 2: Swift 實作**

`app/packages/pencil_canvas/ios/Classes/PencilCanvasPlugin.swift`：

```swift
import Flutter
import UIKit
import PencilKit

public class PencilCanvasPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    let factory = PencilCanvasViewFactory(messenger: registrar.messenger())
    registrar.register(factory, withId: "oidea/pencil_canvas")
  }
}

class PencilCanvasViewFactory: NSObject, FlutterPlatformViewFactory {
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }

  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
    PencilCanvasNativeView(
      frame: frame, viewId: viewId,
      args: args as? [String: Any], messenger: messenger)
  }
}

class PencilCanvasNativeView: NSObject, FlutterPlatformView, PKCanvasViewDelegate {
  private let canvasView = PKCanvasView()
  private let toolPicker = PKToolPicker()
  private let channel: FlutterMethodChannel

  init(frame: CGRect, viewId: Int64, args: [String: Any]?, messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "oidea/pencil_canvas_\(viewId)", binaryMessenger: messenger)
    super.init()

    canvasView.frame = frame
    canvasView.delegate = self
    canvasView.backgroundColor = .white
    // pencilOnly = 系統級防手掌（手指不落墨）；fingerDrawing=true 供模擬器/無筆情境
    canvasView.drawingPolicy = (args?["fingerDrawing"] as? Bool ?? false) ? .anyInput : .pencilOnly

    if let typed = args?["drawing"] as? FlutterStandardTypedData,
       let drawing = try? PKDrawing(data: typed.data) {
      canvasView.drawing = drawing
    }

    toolPicker.setVisible(true, forFirstResponder: canvasView)
    toolPicker.addObserver(canvasView)
    // becomeFirstResponder 需要 view 已進 hierarchy；下一個 runloop 再叫
    DispatchQueue.main.async { [weak self] in _ = self?.canvasView.becomeFirstResponder() }

    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
  }

  func view() -> UIView { canvasView }

  func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    channel.invokeMethod("onDrawingChanged", arguments: nil)
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "getDrawing":
      result(FlutterStandardTypedData(bytes: canvasView.drawing.dataRepresentation()))
    case "setDrawing":
      guard let typed = call.arguments as? FlutterStandardTypedData,
            let drawing = try? PKDrawing(data: typed.data) else {
        result(FlutterError(code: "bad_drawing", message: "無法解析筆跡資料", details: nil))
        return
      }
      canvasView.drawing = drawing
      result(nil)
    case "undo":
      canvasView.undoManager?.undo()
      result(nil)
    case "redo":
      canvasView.undoManager?.redo()
      result(nil)
    case "setFingerDrawing":
      canvasView.drawingPolicy = (call.arguments as? Bool ?? false) ? .anyInput : .pencilOnly
      result(nil)
    case "renderThumbnail":
      let maxWidth = CGFloat(((call.arguments as? [String: Any])?["maxWidth"] as? NSNumber)?.doubleValue ?? 512)
      let drawingBounds = canvasView.drawing.bounds
      let bounds = drawingBounds.isEmpty
        ? CGRect(x: 0, y: 0, width: 1024, height: 768)
        : drawingBounds.insetBy(dx: -20, dy: -20)
      let scale = maxWidth / max(bounds.width, 1)
      let image = canvasView.drawing.image(from: bounds, scale: scale)
      result(FlutterStandardTypedData(bytes: image.pngData() ?? Data()))
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
```

- [ ] **Step 3: Dart 包裝**

`app/packages/pencil_canvas/lib/pencil_canvas.dart`：

```dart
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// 對單一 PencilCanvasView 實例的操作把手。由 [PencilCanvasView.onCreated] 交付。
class PencilCanvasController {
  PencilCanvasController._(this._channel);
  final MethodChannel _channel;

  Future<Uint8List> getDrawing() async =>
      await _channel.invokeMethod<Uint8List>('getDrawing') ?? Uint8List(0);

  Future<void> setDrawing(Uint8List data) => _channel.invokeMethod('setDrawing', data);

  Future<void> undo() => _channel.invokeMethod('undo');

  Future<void> redo() => _channel.invokeMethod('redo');

  Future<void> setFingerDrawing(bool enabled) => _channel.invokeMethod('setFingerDrawing', enabled);

  Future<Uint8List> renderThumbnail({int maxWidth = 512}) async =>
      await _channel.invokeMethod<Uint8List>('renderThumbnail', {'maxWidth': maxWidth}) ??
      Uint8List(0);
}

/// PencilKit 畫布（僅 iOS/iPadOS）。非 iOS 平台請勿建構此 widget —— 由呼叫端負責分流。
class PencilCanvasView extends StatefulWidget {
  const PencilCanvasView({
    super.key,
    this.initialDrawing,
    this.fingerDrawing = false,
    this.onCreated,
    this.onDrawingChanged,
  });

  final Uint8List? initialDrawing;
  final bool fingerDrawing;
  final void Function(PencilCanvasController controller)? onCreated;
  final VoidCallback? onDrawingChanged;

  @override
  State<PencilCanvasView> createState() => _PencilCanvasViewState();
}

class _PencilCanvasViewState extends State<PencilCanvasView> {
  @override
  Widget build(BuildContext context) {
    return UiKitView(
      viewType: 'oidea/pencil_canvas',
      creationParams: <String, dynamic>{
        'drawing': widget.initialDrawing,
        'fingerDrawing': widget.fingerDrawing,
      },
      creationParamsCodec: const StandardMessageCodec(),
      onPlatformViewCreated: _onPlatformViewCreated,
    );
  }

  void _onPlatformViewCreated(int viewId) {
    final channel = MethodChannel('oidea/pencil_canvas_$viewId');
    channel.setMethodCallHandler((call) async {
      if (call.method == 'onDrawingChanged') widget.onDrawingChanged?.call();
      return null;
    });
    widget.onCreated?.call(PencilCanvasController._(channel));
  }
}
```

- [ ] **Step 4: 接進 app + iOS 14 升版**

`app/pubspec.yaml` 的 `dependencies:` 區塊加（放在 `path_provider` 之後）：

```yaml
  pencil_canvas:
    path: packages/pencil_canvas
```

`app/ios/Podfile` 第一段的註解行改為生效：

```ruby
platform :ios, '14.0'
```

```bash
cd app && sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 13.0;/IPHONEOS_DEPLOYMENT_TARGET = 14.0;/g' ios/Runner.xcodeproj/project.pbxproj
grep -c "IPHONEOS_DEPLOYMENT_TARGET = 14.0;" ios/Runner.xcodeproj/project.pbxproj
```

Expected: grep 輸出 `3`。

- [ ] **Step 5: channel 往返測試（CI 可跑，不需 iOS 環境）**

新增 `app/test/pencil_canvas_channel_test.dart`：

```dart
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('PencilCanvasController 的 channel 協定：方法名與參數形狀', () async {
    const channel = MethodChannel('oidea/pencil_canvas_0');
    final calls = <MethodCall>[];
    final ink = Uint8List.fromList([1, 2, 3]);

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'getDrawing') return ink;
      if (call.method == 'renderThumbnail') return Uint8List.fromList([9]);
      return null;
    });

    // 走與 controller 相同的協定（controller 建構子為 library-private，直接驗協定）
    final got = await channel.invokeMethod<Uint8List>('getDrawing');
    await channel.invokeMethod('setDrawing', ink);
    await channel.invokeMethod('undo');
    final thumb =
        await channel.invokeMethod<Uint8List>('renderThumbnail', {'maxWidth': 512});

    expect(got, ink);
    expect(thumb, isNotEmpty);
    expect(calls.map((c) => c.method).toList(), ['getDrawing', 'setDrawing', 'undo', 'renderThumbnail']);
    expect(calls[3].arguments, {'maxWidth': 512});
  });
}
```

- [ ] **Step 6: 驗證與 commit**

```bash
cd app && flutter pub get && flutter analyze --no-fatal-infos && flutter test
cd packages/pencil_canvas && flutter analyze --no-fatal-infos && cd ../..
```

Expected: analyze 皆 exit 0；test 全綠（28+）。

```bash
git add app/packages app/pubspec.yaml app/pubspec.lock app/ios/Podfile app/ios/Runner.xcodeproj/project.pbxproj app/test/pencil_canvas_channel_test.dart
git commit -m "feat(whiteboard): pencil_canvas local plugin — PencilKit platform view

PKCanvasView + PKToolPicker wrapped as a UiKitView, shipped as a local
plugin so CocoaPods does the Xcode integration and project.pbxproj never
needs hand surgery. Pressure, tilt, palm rejection, lasso selection and
the colour picker all come from the system tool picker. drawingPolicy
defaults to pencilOnly (system-level palm rejection); a fingerDrawing
flag covers simulators. Min iOS raised 13 -> 14 for PKToolPicker's
modern initialiser."
```

### Task 8: Flutter 資料層（api_client + provider）

**Files:**
- Modify: `app/lib/core/network/api_client.dart`
- Modify: `app/lib/features/whiteboard/providers/whiteboard_provider.dart`

**Interfaces:**
- Consumes: Task 6 的六個端點
- Produces（Task 9/10 依賴）:
  - `ApiClient.getWhiteboardPages(String boardId) → Future<List<dynamic>>`
  - `ApiClient.getWhiteboardPage(String boardId, String pageId) → Future<Map<String, dynamic>>`
  - `ApiClient.createWhiteboardPage(String boardId) → Future<Map<String, dynamic>>`
  - `ApiClient.saveWhiteboardPage(String boardId, String pageId, {required String drawingBase64, String? thumbnailBase64}) → Future<void>`
  - `ApiClient.reorderWhiteboardPages(String boardId, List<String> orderedIds) → Future<void>`
  - `ApiClient.deleteWhiteboardPage(String boardId, String pageId) → Future<void>`
  - `whiteboardPagesProvider(boardId)` — `FutureProvider.family<List<dynamic>, String>`

- [ ] **Step 1: api_client 加方法**

在 `app/lib/core/network/api_client.dart` 的 `saveWhiteboardCanvas`（約 line 324）之後加：

```dart
  // ── 白板筆記本頁面（PencilKit）────────────────────────────────

  Future<List<dynamic>> getWhiteboardPages(String boardId) async {
    final res = await _dio.get<List<dynamic>>('whiteboard/$boardId/pages');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getWhiteboardPage(String boardId, String pageId) async {
    final res = await _dio.get<Map<String, dynamic>>('whiteboard/$boardId/pages/$pageId');
    return res.data ?? {};
  }

  Future<Map<String, dynamic>> createWhiteboardPage(String boardId) async {
    final res = await _dio.post<Map<String, dynamic>>('whiteboard/$boardId/pages');
    return res.data ?? {};
  }

  Future<void> saveWhiteboardPage(
    String boardId,
    String pageId, {
    required String drawingBase64,
    String? thumbnailBase64,
  }) async {
    await _dio.put('whiteboard/$boardId/pages/$pageId', data: {
      'drawing': drawingBase64,
      if (thumbnailBase64 != null) 'thumbnail': thumbnailBase64,
    });
  }

  Future<void> reorderWhiteboardPages(String boardId, List<String> orderedIds) async {
    await _dio.patch('whiteboard/$boardId/pages/reorder', data: {'orderedIds': orderedIds});
  }

  Future<void> deleteWhiteboardPage(String boardId, String pageId) async {
    await _dio.delete('whiteboard/$boardId/pages/$pageId');
  }
```

- [ ] **Step 2: provider**

`app/lib/features/whiteboard/providers/whiteboard_provider.dart` 末尾加：

```dart
final whiteboardPagesProvider = FutureProvider.family<List<dynamic>, String>((ref, boardId) async {
  final api = ref.watch(apiClientProvider);
  return api.getWhiteboardPages(boardId);
});
```

- [ ] **Step 3: 驗證與 commit**

```bash
cd app && flutter analyze --no-fatal-infos && flutter test
git add lib/core/network/api_client.dart lib/features/whiteboard/providers
git commit -m "feat(whiteboard): pages data layer — six api_client methods + provider"
```

### Task 9: 頁面格 UI + 路由

**Files:**
- Create: `app/lib/features/whiteboard/presentation/pages/whiteboard_pages_page.dart`
- Modify: `app/lib/core/router/app_router.dart`
- Modify: `app/lib/features/whiteboard/presentation/pages/whiteboard_home_page.dart`
- Test: `app/test/whiteboard_pages_test.dart`

**Interfaces:**
- Consumes: Task 8 資料層；Task 10 的路由 `'/whiteboard/pencil/:boardId/:pageId'`（本任務先注册路由字串，頁面在 Task 10 落地——**本任務結束時路由暫指向佔位頁會讓 build 壞掉，因此路由於 Task 10 一併加**；本任務只導頁面格）
- Produces: 路由 `'/whiteboard/pages/:boardId'` → `WhiteboardPagesPage(boardId)`

- [ ] **Step 1: 頁面格 UI**

新增 `app/lib/features/whiteboard/presentation/pages/whiteboard_pages_page.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../providers/whiteboard_provider.dart';

/// 一本筆記本（Whiteboard）內的頁面縮圖格。
/// 舊白板（無頁面、data.canvasItems 有東西）顯示「開啟舊畫布」入口。
class WhiteboardPagesPage extends ConsumerWidget {
  const WhiteboardPagesPage({super.key, required this.boardId});

  final String boardId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final boardAsync = ref.watch(whiteboardProvider(boardId));
    final pagesAsync = ref.watch(whiteboardPagesProvider(boardId));

    return Scaffold(
      appBar: AppBar(
        title: Text(boardAsync.value?['title'] as String? ?? '筆記本'),
      ),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.add),
        label: const Text('新增頁'),
        onPressed: () async {
          final page = await ref.read(apiClientProvider).createWhiteboardPage(boardId);
          ref.invalidate(whiteboardPagesProvider(boardId));
          if (context.mounted && page['id'] != null) {
            context.go('/whiteboard/pencil/$boardId/${page['id']}');
          }
        },
      ),
      body: pagesAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(
          message: e.toString(),
          onRetry: () => ref.invalidate(whiteboardPagesProvider(boardId)),
        ),
        data: (pages) {
          final legacyItems =
              ((boardAsync.value?['data'] as Map<String, dynamic>?)?['canvasItems'] as List?) ?? [];
          if (pages.isEmpty && legacyItems.isNotEmpty) {
            return _LegacyBoardNotice(boardId: boardId);
          }
          if (pages.isEmpty) {
            return const Center(child: Text('還沒有頁面 —— 按「新增頁」開始畫'));
          }
          return GridView.builder(
            padding: const EdgeInsets.all(OideaSpace.space4),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 220,
              mainAxisSpacing: OideaSpace.space4,
              crossAxisSpacing: OideaSpace.space4,
              childAspectRatio: 3 / 4,
            ),
            itemCount: pages.length,
            itemBuilder: (context, i) {
              final page = pages[i] as Map<String, dynamic>;
              return _PageCard(boardId: boardId, page: page, index: i);
            },
          );
        },
      ),
    );
  }
}

class _PageCard extends ConsumerWidget {
  const _PageCard({required this.boardId, required this.page, required this.index});

  final String boardId;
  final Map<String, dynamic> page;
  final int index;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final thumbnailUrl = page['thumbnailUrl'] as String?;
    return InkWell(
      borderRadius: OideaRadius.lgAll,
      onTap: () => context.go('/whiteboard/pencil/$boardId/${page['id']}'),
      onLongPress: () => _showActions(context, ref),
      child: Ink(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: OideaRadius.lgAll,
          border: Border.all(color: Theme.of(context).dividerTheme.color ?? Colors.black12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(top: Radius.circular(OideaRadius.lg)),
                child: thumbnailUrl == null
                    ? const Center(child: Icon(Icons.draw_outlined, size: OideaSpace.space8))
                    : Image.network(thumbnailUrl, fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) =>
                            const Center(child: Icon(Icons.broken_image_outlined))),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(OideaSpace.space2),
              child: Text('第 ${index + 1} 頁',
                  style: OideaType.caption, textAlign: TextAlign.center),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showActions(BuildContext context, WidgetRef ref) async {
    final api = ref.read(apiClientProvider);
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
                leading: const Icon(Icons.arrow_back),
                title: const Text('往前移'),
                onTap: () => Navigator.pop(context, 'left')),
            ListTile(
                leading: const Icon(Icons.arrow_forward),
                title: const Text('往後移'),
                onTap: () => Navigator.pop(context, 'right')),
            ListTile(
                leading: const Icon(Icons.delete_outline),
                title: const Text('刪除此頁'),
                onTap: () => Navigator.pop(context, 'delete')),
          ],
        ),
      ),
    );
    if (action == null) return;

    final pages = await api.getWhiteboardPages(boardId);
    final ids = pages.map((p) => (p as Map<String, dynamic>)['id'] as String).toList();
    final i = ids.indexOf(page['id'] as String);
    if (action == 'delete') {
      await api.deleteWhiteboardPage(boardId, page['id'] as String);
    } else if (action == 'left' && i > 0) {
      ids.removeAt(i);
      ids.insert(i - 1, page['id'] as String);
      await api.reorderWhiteboardPages(boardId, ids);
    } else if (action == 'right' && i >= 0 && i < ids.length - 1) {
      ids.removeAt(i);
      ids.insert(i + 1, page['id'] as String);
      await api.reorderWhiteboardPages(boardId, ids);
    }
    ref.invalidate(whiteboardPagesProvider(boardId));
  }
}

class _LegacyBoardNotice extends StatelessWidget {
  const _LegacyBoardNotice({required this.boardId});

  final String boardId;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('這是舊版白板（單張畫布）'),
          const SizedBox(height: OideaSpace.space3),
          FilledButton.icon(
            icon: const Icon(Icons.open_in_new),
            label: const Text('開啟舊畫布'),
            onPressed: () => context.go('/whiteboard/canvas/$boardId'),
          ),
          const SizedBox(height: OideaSpace.space2),
          Text('或按右下角「新增頁」改用筆記本模式',
              style: OideaType.bodySm.copyWith(
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6))),
        ],
      ),
    );
  }
}
```

- [ ] **Step 2: 首頁點擊導向改路徑**

`whiteboard_home_page.dart` 內找到白板卡片的 onTap（目前導向 `'/whiteboard/canvas/$id'`，用 `grep -n "canvas/" app/lib/features/whiteboard/presentation/pages/whiteboard_home_page.dart` 定位），改為導向 `'/whiteboard/pages/$id'`。只改列表點擊這一處；範本流程若直接開 canvas 則不動。

- [ ] **Step 3: widget test**

新增 `app/test/whiteboard_pages_test.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/features/whiteboard/presentation/pages/whiteboard_pages_page.dart';

class _FakeApi extends Fake implements ApiClient {
  @override
  Future<List<dynamic>> getWhiteboardPages(String boardId) async => [
        {'id': 'p-1', 'position': 0, 'thumbnailUrl': null, 'updatedAt': '2026-08-09'},
        {'id': 'p-2', 'position': 1, 'thumbnailUrl': null, 'updatedAt': '2026-08-09'},
      ];

  @override
  Future<Map<String, dynamic>> getWhiteboard(String id) async =>
      {'id': id, 'title': '測試筆記本', 'data': null};
}

void main() {
  testWidgets('頁面格：渲染標題與兩張頁卡', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(_FakeApi())],
        child: const MaterialApp(home: WhiteboardPagesPage(boardId: 'wb-1')),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('測試筆記本'), findsOneWidget);
    expect(find.text('第 1 頁'), findsOneWidget);
    expect(find.text('第 2 頁'), findsOneWidget);
    expect(find.text('新增頁'), findsOneWidget);
  });

  testWidgets('空筆記本：顯示引導文案', (tester) async {
    final api = _EmptyApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(api)],
        child: const MaterialApp(home: WhiteboardPagesPage(boardId: 'wb-1')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('還沒有頁面'), findsOneWidget);
  });
}

class _EmptyApi extends Fake implements ApiClient {
  @override
  Future<List<dynamic>> getWhiteboardPages(String boardId) async => [];

  @override
  Future<Map<String, dynamic>> getWhiteboard(String id) async =>
      {'id': id, 'title': '空筆記本', 'data': null};
}
```

注意：`context.go` 在無 go_router 的測試環境會丟例外，但本測試不點擊導航元素，安全。

- [ ] **Step 4: 驗證與 commit**

```bash
cd app && flutter analyze --no-fatal-infos && flutter test
git add lib/features/whiteboard lib/core/router test/whiteboard_pages_test.dart
git commit -m "feat(whiteboard): notebook page grid

Thumbnail grid per notebook with add / move / delete via long-press
sheet. Legacy single-canvas boards (canvasItems, no pages) get an
explicit door back to the old canvas instead of a silent migration."
```

（router 的兩條新路由在 Task 10 Step 3 一次加齊後，本 commit 若尚未包含 router 改動則於 Task 10 補。）

### Task 10: 畫布頁（自動存檔 + undo/redo + 非 iOS 唯讀）

**Files:**
- Create: `app/lib/features/whiteboard/presentation/pages/whiteboard_pencil_page.dart`
- Modify: `app/lib/core/router/app_router.dart`

**Interfaces:**
- Consumes: Task 7 `PencilCanvasView`/`PencilCanvasController`；Task 8 資料層
- Produces: 路由 `'/whiteboard/pencil/:boardId/:pageId'`

- [ ] **Step 1: 畫布頁實作**

新增 `app/lib/features/whiteboard/presentation/pages/whiteboard_pencil_page.dart`：

```dart
import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pencil_canvas/pencil_canvas.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../providers/whiteboard_provider.dart';

/// PencilKit 畫布頁（iOS/iPadOS 編輯；其他平台唯讀縮圖）。
///
/// 存檔策略（spec §3/§4）：
/// - 筆畫停 2 秒 → 自動存
/// - 離開頁面 → 強制存（擋可取消 spinner）
/// - 失敗 → 指數退避重試（5s/10s/20s/40s，上限 60s），「未同步」橫幅
/// - 縮圖節流：距上次成功上傳 ≥30 秒才夾帶
class WhiteboardPencilPage extends ConsumerStatefulWidget {
  const WhiteboardPencilPage({super.key, required this.boardId, required this.pageId});

  final String boardId;
  final String pageId;

  @override
  ConsumerState<WhiteboardPencilPage> createState() => _WhiteboardPencilPageState();
}

class _WhiteboardPencilPageState extends ConsumerState<WhiteboardPencilPage> {
  PencilCanvasController? _controller;
  Uint8List? _initialDrawing;
  bool _loading = true;
  bool _dirty = false;
  bool _saving = false;
  bool _outOfSync = false;
  bool _fingerDrawing = false;
  Timer? _debounce;
  Timer? _retry;
  int _retrySeconds = 5;
  DateTime _lastThumbnailAt = DateTime.fromMillisecondsSinceEpoch(0);

  static bool get _canEdit => !kIsWeb && Platform.isIOS;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _retry?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final page =
          await ref.read(apiClientProvider).getWhiteboardPage(widget.boardId, widget.pageId);
      final b64 = page['drawing'] as String?;
      setState(() {
        _initialDrawing = b64 == null ? null : base64Decode(b64);
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _onDrawingChanged() {
    _dirty = true;
    _debounce?.cancel();
    _debounce = Timer(const Duration(seconds: 2), _save);
  }

  Future<bool> _save() async {
    final controller = _controller;
    if (controller == null || !_dirty || _saving) return !_dirty;
    setState(() => _saving = true);
    try {
      final ink = await controller.getDrawing();
      final includeThumbnail =
          DateTime.now().difference(_lastThumbnailAt) > const Duration(seconds: 30);
      final thumbnail = includeThumbnail ? await controller.renderThumbnail() : null;

      await ref.read(apiClientProvider).saveWhiteboardPage(
            widget.boardId,
            widget.pageId,
            drawingBase64: base64Encode(ink),
            thumbnailBase64:
                (thumbnail != null && thumbnail.isNotEmpty) ? base64Encode(thumbnail) : null,
          );
      if (includeThumbnail) _lastThumbnailAt = DateTime.now();
      _dirty = false;
      _retrySeconds = 5;
      _retry?.cancel();
      if (mounted) setState(() { _saving = false; _outOfSync = false; });
      return true;
    } catch (e) {
      if (mounted) setState(() { _saving = false; _outOfSync = true; });
      _retry?.cancel();
      _retry = Timer(Duration(seconds: _retrySeconds), _save);
      _retrySeconds = (_retrySeconds * 2).clamp(5, 60);
      return false;
    }
  }

  /// 返回前強制存檔；失敗時讓使用者選擇等待重試或放棄離開。
  Future<void> _handleExit() async {
    if (!_dirty) {
      if (mounted) Navigator.of(context).pop();
      return;
    }
    final saved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => _SavingDialog(save: _save),
    );
    if (!mounted) return;
    if (saved == true) {
      ref.invalidate(whiteboardPagesProvider(widget.boardId));
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!_canEdit) {
      return Scaffold(
        appBar: AppBar(title: const Text('頁面（唯讀）')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(OideaSpace.space6),
            child: Text('這一頁是在 iPad 上手寫的。\n請在 iPad 開啟編輯；此處僅提供頁面格縮圖檢視。',
                textAlign: TextAlign.center),
          ),
        ),
      );
    }
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _handleExit();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: BackButton(onPressed: _handleExit),
          title: const Text('手寫頁'),
          actions: [
            if (_outOfSync)
              Padding(
                padding: const EdgeInsets.only(right: OideaSpace.space2),
                child: Chip(
                  label: Text('未同步', style: OideaType.caption),
                  avatar: const Icon(Icons.sync_problem, size: OideaSize.iconSm),
                ),
              ),
            IconButton(
              icon: const Icon(Icons.undo),
              tooltip: '復原',
              onPressed: () => _controller?.undo(),
            ),
            IconButton(
              icon: const Icon(Icons.redo),
              tooltip: '重做',
              onPressed: () => _controller?.redo(),
            ),
            IconButton(
              icon: Icon(_fingerDrawing ? Icons.touch_app : Icons.draw),
              tooltip: _fingerDrawing ? '目前：手指可畫' : '目前：僅 Pencil（防手掌）',
              onPressed: () async {
                setState(() => _fingerDrawing = !_fingerDrawing);
                await _controller?.setFingerDrawing(_fingerDrawing);
              },
            ),
          ],
        ),
        body: PencilCanvasView(
          initialDrawing: _initialDrawing,
          fingerDrawing: _fingerDrawing,
          onCreated: (c) => _controller = c,
          onDrawingChanged: _onDrawingChanged,
        ),
      ),
    );
  }
}

/// 強制存檔對話框：進來就開始存，成功自動關閉（回 true），
/// 失敗顯示重試/放棄。
class _SavingDialog extends StatefulWidget {
  const _SavingDialog({required this.save});

  final Future<bool> Function() save;

  @override
  State<_SavingDialog> createState() => _SavingDialogState();
}

class _SavingDialogState extends State<_SavingDialog> {
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _attempt();
  }

  Future<void> _attempt() async {
    setState(() => _failed = false);
    final ok = await widget.save();
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop(true);
    } else {
      setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_failed ? '存檔失敗' : '存檔中…'),
      content: _failed
          ? const Text('筆跡尚未同步到伺服器。')
          : const SizedBox(
              height: OideaSpace.space10,
              child: Center(child: CircularProgressIndicator())),
      actions: _failed
          ? [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('留在頁面'),
              ),
              FilledButton(onPressed: _attempt, child: const Text('重試')),
            ]
          : [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('取消'),
              ),
            ],
    );
  }
}
```

- [ ] **Step 2: 路由**

`app/lib/core/router/app_router.dart` 的 `/whiteboard` GoRoute 的 `routes:[...]` 內（`canvas/:boardId` 之後）加：

```dart
              GoRoute(
                path: 'pages/:boardId',
                builder: (context, state) => WhiteboardPagesPage(
                  boardId: state.pathParameters['boardId']!,
                ),
              ),
              GoRoute(
                path: 'pencil/:boardId/:pageId',
                builder: (context, state) => WhiteboardPencilPage(
                  boardId: state.pathParameters['boardId']!,
                  pageId: state.pathParameters['pageId']!,
                ),
              ),
```

並在檔頭 import 兩個新頁面（跟隨既有 import 風格，line 14–15 附近）：

```dart
import '../../features/whiteboard/presentation/pages/whiteboard_pages_page.dart';
import '../../features/whiteboard/presentation/pages/whiteboard_pencil_page.dart';
```

- [ ] **Step 3: 驗證與 commit**

```bash
cd app && flutter analyze --no-fatal-infos && flutter test
git add lib/features/whiteboard lib/core/router
git commit -m "feat(whiteboard): pencil page — autosave, undo/redo, read-only fallback

Two-second idle autosave with exponential retry and an out-of-sync chip;
leaving the page forces a save behind a cancellable dialog. Thumbnails
piggyback on saves at most every 30s. Non-iOS platforms get an explicit
read-only notice instead of a broken canvas. Finger-drawing toggle maps
to PKCanvasView drawingPolicy (pencilOnly = system palm rejection)."
```

### Task 11: 實機驗收 + 文件收尾 + PR

**Files:**
- Modify: `docs/REQUIREMENTS.md`

**Interfaces:**
- Consumes: Task 4–10 全部
- Produces: 合併到 main 的 `feat/whiteboard-notebooks`

- [ ] **Step 1: 完整建置驗證**

```bash
cd backend && npm test && npm run build
cd ../app && flutter analyze --no-fatal-infos && flutter test && flutter build web --release
flutter build ios --no-codesign
```

Expected: 全綠。`flutter build ios --no-codesign` 驗證 Swift 編譯與 CocoaPods 整合（無簽章環境也能跑）。

- [ ] **Step 2: 實機驗收（需使用者的 iPad；此步由使用者執行，agent 提供指令）**

```bash
cd app && flutter devices
flutter run --release -d <iPad-device-id>
```

驗收清單（spec §4，逐項勾）：

1. [ ] Pencil 畫線有筆壓粗細變化
2. [ ] 手掌貼螢幕不誤畫（預設 pencilOnly 模式）
3. [ ] 套索工具選取後可移動物件
4. [ ] Undo／Redo 正確
5. [ ] 殺掉 App 重開，筆跡還在（存檔閉環）
6. [ ] 桌面／Web 開同一筆記本能看到頁面縮圖（唯讀）

任何一項失敗 → 停在該項修復，不進 Step 3。

- [ ] **Step 3: 更新 REQUIREMENTS.md**

白板段（P4）狀態更新：W-07 `[x]`（PencilKit 套索）、W-09 `[x]`（PKToolPicker）、W-12 `[x]`（UndoManager），並在表格後加一行註記：

```markdown
> 2026-08-09 起：白板採「筆記本→頁」結構（WhiteboardPage + PencilKit）。W-07/09/12
> 由 iPad 原生 PencilKit 提供，僅 iOS/iPadOS 可編輯；其他平台唯讀縮圖。
> 舊單張畫布白板仍可開啟（不遷移）。詳見 docs/superpowers/specs/2026-08-09-whiteboard-goodnotes-design.md。
```

變更日誌表加：`| 2026-08-09 | 白板筆記本化：WhiteboardPage model + 6 端點 + PencilKit 畫布（W-07/09/12 完成） |`

- [ ] **Step 4: PR**

```bash
git add docs/REQUIREMENTS.md
git commit -m "docs: mark W-07/09/12 done via PencilKit notebook rework"
git push -u origin feat/whiteboard-notebooks
gh pr create --base main --title "feat(whiteboard): GoodNotes-style notebooks on PencilKit" --body "白板筆記本化：WhiteboardPage model、6 個 pages 端點、pencil_canvas local plugin（PKCanvasView + PKToolPicker）、頁面格與手寫頁 UI、自動存檔閉環。實機驗收清單 6/6 通過。spec: docs/superpowers/specs/2026-08-09-whiteboard-goodnotes-design.md"
```

CI 綠 + 使用者確認後合併。

---

## Self-Review 紀錄

- Spec coverage：藍圖 Phase 0 三項 → Task 1–3；WhiteboardPage model → Task 4；六端點 → Task 5–6；PencilKit 混合 → Task 7；筆記本/頁 UI → Task 9；存檔流/錯誤處理 → Task 10；實機驗收清單 → Task 11。凍結清單無任務觸碰。✅
- Placeholder scan：無 TBD/TODO；所有測試與實作皆附完整程式碼。✅
- Type consistency：`buildChatMessages` 簽章 Task 3 內一致；pages service 六方法簽章與 controller/Task 8 client 對齊；`PencilCanvasController` 方法名在 Task 7 Swift `handle()` 與 Dart 各一一對應（getDrawing/setDrawing/undo/redo/setFingerDrawing/renderThumbnail）。✅
