# 任務日曆（個人統一日曆：任務 ＋ 會議）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把現有會議日曆改造成「個人統一日曆」——跨專案任務（依 dueDate）＋ 會議同頁呈現，可拖曳任務改日期、點空天建任務、點任務開詳情。

**Architecture:** 後端在 tasks 模組新增 `GET /tasks/calendar`（workspace 範圍、dueDate 過濾、成員 ACL）與 `PUT /tasks/:id/reschedule`（改 dueDate ＋ TaskActivity 軌跡 ＋ workspace ACL），均為現有 `findByProject`/`move` 的鏡射。前端把 `meeting_home_page.dart` 原地改造為 `CalendarPage`：資料來源從「只有會議」擴成「任務 ＋ 會議」，任務依 priority 顯示色點/chip，加上「顯示任務／顯示會議」兩開關與拖曳／建任務互動。路由 `/meetings` → `/calendar`、側欄「會議」→「行事曆」。會議的顯示、join 預覽、視訊房間一概不動。

**Tech Stack:** NestJS + Prisma（既有）、Flutter + Riverpod + `table_calendar`（既有）、Jest（後端）、flutter_test（前端）。

**Spec:** [docs/superpowers/specs/2026-08-10-task-calendar-design.md](../specs/2026-08-10-task-calendar-design.md)

## Global Constraints

- 分支：全計畫在 `feat/task-calendar`（基於 main），每任務一 commit，Task 8 開 PR。
- 基準：backend **183 tests / 15 suites** 全綠（Task 2 後 ≥187）、`npm run build` 乾淨；Flutter **31 tests**、`flutter analyze --no-fatal-infos` exit 0（0 warning）。
- 後端 route 順序：`GET /tasks/calendar` 必須宣告在 `GET /tasks/:id` **之前**（否則 `calendar` 被當成 `:id`）。
- `TaskActivity.action` 為自由字串（schema 已確認非 enum），新增 `'rescheduled'` 免 schema migration。
- 兩個新端點都做 workspace 成員 ACL（spec 驗收要求「跨工作區拒絕」）：用既有 inline 模式 `prisma.user.findFirst({ where: { id: userId, workspaceMembers: { some: { workspaceId } } } })` → null 時 `ForbiddenException`（該 exception 已 import 於 `tasks.service.ts:1`）。
- 任務日期欄位 = `dueDate`（任務只有日期、全天；不做時刻排程、不做 startDate→dueDate 跨天區間）。
- `POST /tasks` 必填 `projectId` + `columnId`（既有 DTO）；建任務對話框要讓使用者選專案，欄位預設該專案第一欄（position 最小者）。
- UI 間距/圓角/字級一律 OideaSpace/OideaRadius/OideaType；文案繁中。
- 凍結區不得觸碰：會議視訊（meeting_room_page.dart、WebRTC）、自動化（P-15）、週期任務 UI（P-14）；pencil/白板頁零改動。
- Commit 訊息照任務內文字，結尾空一行加 `Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>`。

## File Structure

```
backend/src/tasks/tasks.controller.ts          修改（+2 routes：calendar、reschedule）
backend/src/tasks/tasks.service.ts             修改（+findCalendar、+reschedule）
backend/src/tasks/dto/reschedule-task.dto.ts   新（RescheduleTaskDto）
backend/src/tasks/tasks.service.spec.ts        修改（+reschedule 測試、+findCalendar 測試）

app/lib/core/network/api_client.dart           修改（+getCalendarTasks、+rescheduleTask）
app/lib/features/meeting/providers/calendar_provider.dart   新（calendarTasksProvider）
app/lib/features/meeting/presentation/pages/
└─ meeting_home_page.dart → calendar_page.dart  改名 + 改造（class MeetingHomePage → CalendarPage）
app/lib/core/router/app_router.dart            修改（/meetings → /calendar；room 路由獨立）
app/lib/shared/widgets/oidea_sidebar.dart      修改（側欄「會議」→「行事曆」+ 圖示）
app/test/calendar_page_test.dart               新（widget test）

docs/REQUIREMENTS.md                           修改（Task 8：P-09/P-10/M-02/D-07 翻 [x]）
```

---

### Task 1: 後端 `PUT /tasks/:id/reschedule`（TDD）

**Files:**
- Create: `backend/src/tasks/dto/reschedule-task.dto.ts`
- Modify: `backend/src/tasks/tasks.controller.ts`（在 `PUT :id/move` 之後加 route）
- Modify: `backend/src/tasks/tasks.service.ts`（加 `reschedule` 方法）
- Test: `backend/src/tasks/tasks.service.spec.ts`

**Interfaces:**
- Consumes: 既有 `logActivity` helper（`tasks.service.ts:370`）、既有 `move()` 的 findUnique→guard→update→log→re-fetch 模式。
- Produces: `TasksService.reschedule(userId, id, dto)`；`RescheduleTaskDto { dueDate?: string }`；route `PUT /tasks/:id/reschedule`。

- [ ] **Step 1: 建 RescheduleTaskDto**

`backend/src/tasks/dto/reschedule-task.dto.ts`：

```ts
import { IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RescheduleTaskDto {
  @ApiProperty({ required: false, description: '新 dueDate（ISO）；null/省略 = 清除日期' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
```

- [ ] **Step 2: 寫失敗測試（reschedule）**

在 `tasks.service.spec.ts` 既有 `describe(...)` 內（與其他 `it()` 同層）加三條。先擴充 mock：把 `PrismaMock` type 與 `buildMock()` 補上 `user: { findFirst: jest.Mock }`，並讓 `task.findUnique` 能回含 `project` 的任務。

擴充 mock（修改 `tasks.service.spec.ts:8-19` 的 type 與 `21-31` 的 `buildMock`）：

```ts
type PrismaMock = {
  project: { findUnique: jest.Mock };
  projectColumn: { findUnique: jest.Mock };
  task: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  taskActivity: { create: jest.Mock };
  user: { findFirst: jest.Mock };
};

const buildMock = (): PrismaMock => ({
  project: { findUnique: jest.fn() },
  projectColumn: { findUnique: jest.fn() },
  task: {
    create: jest.fn().mockResolvedValue({ id: 'spawned' }),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  },
  taskActivity: { create: jest.fn().mockResolvedValue({}) },
  user: { findFirst: jest.fn() },
});
```

新增三條測試（放在現有 `it()` 之後、`describe` 結束前）：

```ts
  it('reschedule：改 dueDate 並寫 rescheduled activity', async () => {
    prisma.task.findUnique.mockResolvedValueOnce({
      id: TASK_ID, projectId: 'p-1', dueDate: new Date('2026-08-09T00:00:00Z'),
      project: { workspaceId: 'w-1' },
    });
    prisma.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    prisma.task.findUnique.mockResolvedValueOnce({ id: TASK_ID, dueDate: new Date('2026-08-11') });

    await service.reschedule(USER_ID, TASK_ID, { dueDate: '2026-08-11T00:00:00Z' });

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: { dueDate: new Date('2026-08-11T00:00:00Z') },
    });
    expect(prisma.taskActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskId: TASK_ID, userId: USER_ID, action: 'rescheduled' }),
    });
  });

  it('reschedule：dueDate 為 null 清除日期', async () => {
    prisma.task.findUnique.mockResolvedValueOnce({
      id: TASK_ID, dueDate: new Date('2026-08-09T00:00:00Z'),
      project: { workspaceId: 'w-1' },
    });
    prisma.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    prisma.task.findUnique.mockResolvedValueOnce({ id: TASK_ID, dueDate: null });

    await service.reschedule(USER_ID, TASK_ID, {});

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: { dueDate: null },
    });
  });

  it('reschedule：跨工作區拒絕（ForbiddenException）', async () => {
    const { ForbiddenException } = await import('@nestjs/common');
    prisma.task.findUnique.mockResolvedValueOnce({
      id: TASK_ID, project: { workspaceId: 'w-other' },
    });
    prisma.user.findFirst.mockResolvedValueOnce(null);

    await expect(service.reschedule(USER_ID, TASK_ID, { dueDate: '2026-08-11' }))
      .rejects.toThrow(ForbiddenException);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: 跑測試確認失敗**

```bash
cd backend && npx jest tasks.service.spec -t "reschedule" 2>&1 | tail -15
```

Expected: 3 條 FAIL（`service.reschedule is not a function`）。

- [ ] **Step 4: 實作 reschedule**

在 `tasks.service.ts` 的 `move` 方法之後加（鏡射 `move` 的結構，加上 workspace ACL）：

```ts
  async reschedule(userId: string, id: string, dto: RescheduleTaskDto) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { project: { select: { workspaceId: true } } },
    });
    if (!task) throw new NotFoundException('任務不存在');

    const member = await this.prisma.user.findFirst({
      where: { id: userId, workspaceMembers: { some: { workspaceId: task.project.workspaceId } } },
    });
    if (!member) throw new ForbiddenException();

    const oldDue = task.dueDate;
    const newDue = dto.dueDate ? new Date(dto.dueDate) : null;
    await this.prisma.task.update({
      where: { id },
      data: { dueDate: newDue },
    });
    await this.logActivity(id, userId, 'rescheduled', { from: oldDue, to: newDue });

    return this.prisma.task.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        tags: true,
      },
    });
  }
```

在 `tasks.service.ts` 檔頭 import 加 `RescheduleTaskDto`：

```ts
import { RescheduleTaskDto } from './dto/reschedule-task.dto';
```

- [ ] **Step 5: 掛 controller route**

在 `tasks.controller.ts` 的 `move` 方法（`@Put(':id/move')`）之後加：

```ts
  @Put(':id/reschedule')
  @ApiOperation({ summary: '任務改日期（日曆拖曳）' })
  async reschedule(@Req() req: any, @Param('id') id: string, @Body() dto: RescheduleTaskDto) {
    return this.tasksService.reschedule(req.user.userId, id, dto);
  }
```

檔頭 import 加：

```ts
import { RescheduleTaskDto } from './dto/reschedule-task.dto';
```

- [ ] **Step 6: 綠 + 全量 + commit**

```bash
cd backend && npx jest tasks.service.spec -t "reschedule" 2>&1 | tail -8
cd backend && npm test 2>&1 | tail -6 && npm run build 2>&1 | tail -3
```

Expected: reschedule 3 條 PASS；全量 ≥186 passed、build 乾淨。

```bash
git add backend/src/tasks/dto/reschedule-task.dto.ts backend/src/tasks/tasks.controller.ts backend/src/tasks/tasks.service.ts backend/src/tasks/tasks.service.spec.ts
git commit -m "feat(tasks): PUT /tasks/:id/reschedule — drag-to-reschedule on calendar

Sets dueDate, logs a 'rescheduled' TaskActivity, and rejects
cross-workspace callers. Mirrors the move() shape with an added
workspace-membership guard.

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
```

---

### Task 2: 後端 `GET /tasks/calendar`（TDD）

**Files:**
- Modify: `backend/src/tasks/tasks.controller.ts`（在 `@Get('project/:projectId')` 與 `@Get(':id')` 之間加 route）
- Modify: `backend/src/tasks/tasks.service.ts`（加 `findCalendar` 方法）
- Test: `backend/src/tasks/tasks.service.spec.ts`

**Interfaces:**
- Consumes: 既有 `findByProject` 的 select 風格、workspace ACL inline 模式。
- Produces: `TasksService.findCalendar(userId, workspaceId, from?, to?)`；route `GET /tasks/calendar?workspaceId=&from=&to=`（from/to 選填）。

- [ ] **Step 1: 寫失敗測試（findCalendar）**

在 `tasks.service.spec.ts` 同 `describe` 內加三條：

```ts
  it('findCalendar：回傳該 workspace 有 dueDate 的任務（跨專案）', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    prisma.task.findMany.mockResolvedValueOnce([
      { id: 't-a', title: 'A', dueDate: new Date('2026-08-10'), priority: 'high', completedAt: null, assigneeId: USER_ID, columnId: 'c1', project: { id: 'p-1', name: 'P1' } },
    ]);

    const rows = await service.findCalendar(USER_ID, 'w-1');

    expect(prisma.task.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        project: { workspaceId: 'w-1', deletedAt: null },
        deletedAt: null,
        dueDate: { not: null },
        OR: [{ assigneeId: USER_ID }, { assigneeId: null }],
      }),
    }));
    expect(rows[0]).toMatchObject({ id: 't-a', projectName: 'P1', completed: false });
  });

  it('findCalendar：from/to 縮窗', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    prisma.task.findMany.mockResolvedValueOnce([]);

    await service.findCalendar(USER_ID, 'w-1', new Date('2026-08-01'), new Date('2026-09-01'));

    expect(prisma.task.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        dueDate: { gte: new Date('2026-08-01'), lt: new Date('2026-09-01') },
      }),
    }));
  });

  it('findCalendar：跨工作區拒絕', async () => {
    const { ForbiddenException } = await import('@nestjs/common');
    prisma.user.findFirst.mockResolvedValueOnce(null);
    await expect(service.findCalendar(USER_ID, 'w-other')).rejects.toThrow(ForbiddenException);
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd backend && npx jest tasks.service.spec -t "findCalendar" 2>&1 | tail -15
```

Expected: 3 條 FAIL（`service.findCalendar is not a function`）。

- [ ] **Step 3: 實作 findCalendar**

在 `tasks.service.ts` 的 `findByProject` 之後加：

```ts
  async findCalendar(userId: string, workspaceId: string, from?: Date, to?: Date) {
    const member = await this.prisma.user.findFirst({
      where: { id: userId, workspaceMembers: { some: { workspaceId } } },
    });
    if (!member) throw new ForbiddenException();

    const dueWhere = from && to ? { gte: from, lt: to } : { not: null };
    const rows = await this.prisma.task.findMany({
      where: {
        project: { workspaceId, deletedAt: null },
        deletedAt: null,
        dueDate: dueWhere,
        OR: [{ assigneeId: userId }, { assigneeId: null }],
      },
      select: {
        id: true, title: true, dueDate: true, priority: true,
        projectId: true, columnId: true, completedAt: true, assigneeId: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: 'asc' },
    });
    return rows.map((t) => ({
      id: t.id, title: t.title, dueDate: t.dueDate, priority: t.priority,
      projectId: t.projectId, projectName: t.project.name,
      columnId: t.columnId, completed: t.completedAt !== null,
    }));
  }
```

- [ ] **Step 4: 掛 controller route（順序：在 `:id` 之前）**

在 `tasks.controller.ts` 的 `findByProject` 方法之後、`findById`（`@Get(':id')`）之前加：

```ts
  @Get('calendar')
  @ApiOperation({ summary: '日曆視圖：workspace 內有 dueDate 的任務' })
  async findCalendar(
    @Req() req: any,
    @Query('workspaceId') workspaceId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.tasksService.findCalendar(
      req.user.userId,
      workspaceId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }
```

`Query` 已在檔頭既有 import 中（`tasks.controller.ts:2`）。

- [ ] **Step 5: 綠 + 全量 + commit**

```bash
cd backend && npx jest tasks.service.spec -t "findCalendar" 2>&1 | tail -8
cd backend && npm test 2>&1 | tail -6 && npm run build 2>&1 | tail -3
```

Expected: findCalendar 3 條 PASS；全量 ≥189 passed、build 乾淨。

```bash
git add backend/src/tasks/tasks.controller.ts backend/src/tasks/tasks.service.ts backend/src/tasks/tasks.service.spec.ts
git commit -m "feat(tasks): GET /tasks/calendar — workspace-scoped due-dated tasks

Returns flat rows (id/title/dueDate/priority/projectId/projectName/
columnId/completed) for the caller's workspace, optionally narrowed
by a [from,to) window. Membership-guarded; only own + unassigned tasks.

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
```

---

### Task 3: Flutter api_client + calendarTasksProvider

**Files:**
- Modify: `app/lib/core/network/api_client.dart`（在 `moveTask` 之後加兩方法，`moveTask` 位於 ~L416-418）
- Create: `app/lib/features/meeting/providers/calendar_provider.dart`

**Interfaces:**
- Consumes: Task 1/2 的後端端點。
- Produces: `ApiClient.getCalendarTasks(workspaceId, {from, to})`、`ApiClient.rescheduleTask(taskId, {dueDate})`、`calendarTasksProvider`。

- [ ] **Step 1: api_client 加兩方法**

在 `api_client.dart` 的 `moveTask` 方法（約 L416-418）之後加：

```dart
  Future<List<dynamic>> getCalendarTasks(
    String workspaceId, {
    DateTime? from,
    DateTime? to,
  }) async {
    final res = await _dio.get<List<dynamic>>('tasks/calendar', queryParameters: {
      'workspaceId': workspaceId,
      if (from != null) 'from': from.toIso8601String(),
      if (to != null) 'to': to.toIso8601String(),
    });
    return res.data ?? [];
  }

  Future<void> rescheduleTask(String taskId, {String? dueDate}) async {
    await _dio.put('tasks/$taskId/reschedule', data: {
      if (dueDate != null) 'dueDate': dueDate,
    });
  }
```

- [ ] **Step 2: 建 calendar_provider.dart**

`app/lib/features/meeting/providers/calendar_provider.dart`（鏡射 `meeting_provider.dart` 結構，fetch 全 workspace 有 dueDate 的任務，client 端再依日過濾）：

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

final calendarTasksProvider =
    FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getCalendarTasks(workspaceId);
});
```

- [ ] **Step 3: 驗證 + commit**

```bash
cd app && flutter analyze --no-fatal-infos lib/core/network/api_client.dart lib/features/meeting/providers/calendar_provider.dart 2>&1 | tail -5
```

Expected: No issues found.

```bash
git add app/lib/core/network/api_client.dart app/lib/features/meeting/providers/calendar_provider.dart
git commit -m "feat(calendar): api_client + calendarTasksProvider

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
```

---

### Task 4: 改名 meeting_home_page → CalendarPage ＋ 路由 ＋ 側欄（機械式改造）

**Files:**
- Rename: `app/lib/features/meeting/presentation/pages/meeting_home_page.dart` → `calendar_page.dart`
- Modify: `app/lib/core/router/app_router.dart`（import + `/meetings` home → `/calendar`；`room/:meetingId` 獨立為頂層 route）
- Modify: `app/lib/shared/widgets/oidea_sidebar.dart`（側欄第 3 項「會議」→「行事曆」、圖示改 `calendar_month_outlined`、route 改 `/calendar`）

**Interfaces:**
- Consumes: 無新邏輯，純改名與路由搬移。
- Produces: `CalendarPage` 類別（原 `MeetingHomePage`）；route `/calendar`。

> 目標：這個 commit 只做「改名 + 路由 + 側欄」，行為完全不變（頁面仍只顯示會議）。讓 rename 的迴歸風險獨立可控。

- [ ] **Step 1: 改名檔案 + 類別**

```bash
cd app && git mv lib/features/meeting/presentation/pages/meeting_home_page.dart lib/features/meeting/presentation/pages/calendar_page.dart
```

在 `calendar_page.dart` 內：把 `class MeetingHomePage` → `class CalendarPage`、`ConsumerState<MeetingHomePage>` → `ConsumerState<CalendarPage>`、`_MeetingHomePageState` → `_CalendarPageState`（含 `createState()` 回傳型別）。AppBar 標題 `const Text('會議')` → `const Text('行事曆')`（檔內共 3 處：L61, L33, L40, L46 一律改）。其餘內容不動。

- [ ] **Step 2: app_router.dart 改路由**

import 改：

```dart
import '../../features/meeting/presentation/pages/calendar_page.dart';
```

（取代原 `meeting_home_page.dart` import；`meeting_room_page.dart` import 保留。）

把 `/meetings` route 區塊（原 L109-120）改為：home 改名 `/calendar` 指向 `CalendarPage`，並把 `room/:meetingId` 提升為獨立頂層 route（路徑保持 `/meetings/room/:meetingId` 不變，會議加入導覽不破）：

```dart
          GoRoute(
            path: '/calendar',
            builder: (context, state) => const CalendarPage(),
          ),
          GoRoute(
            path: '/meetings/room/:meetingId',
            builder: (context, state) => MeetingRoomPage(
              meetingId: state.pathParameters['meetingId']!,
            ),
          ),
```

- [ ] **Step 3: 側欄改「行事曆」**

`oidea_sidebar.dart` 第 35 行改（label/icon/route，index 不變）：

```dart
  _NavItem('行事曆', Icons.calendar_month_outlined, '/calendar', 2),
```

- [ ] **Step 4: 驗證 + commit**

```bash
cd app && flutter analyze --no-fatal-infos 2>&1 | tail -5
```

Expected: exit 0（rename 後無未解參照）。

```bash
git add app/lib/features/meeting/presentation/pages/calendar_page.dart app/lib/core/router/app_router.dart app/lib/shared/widgets/oidea_sidebar.dart
git commit -m "refactor(calendar): rename MeetingHomePage -> CalendarPage, route /calendar

Pure rename + route move (meeting room route path unchanged). No
behaviour change — the page still shows meetings only; task support
lands in the next commits.

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
```

---

### Task 5: 日曆顯示任務 ＋ 會議 ＋ 顯示開關

**Files:**
- Modify: `app/lib/features/meeting/presentation/pages/calendar_page.dart`

**Interfaces:**
- Consumes: Task 3 的 `calendarTasksProvider`、既有 `meetingsProvider`、既有 `currentWorkspaceIdProvider`。
- Produces: 日曆同時呈現任務（priority 色點/chip）＋ 會議；`_showTasks`/`_showMeetings` 兩開關。

- [ ] **Step 1: 加狀態欄位 + 載入任務**

在 `_CalendarPageState`（原 `_MeetingHomePageState`）的欄位區（L20-24 附近）加兩個開關：

```dart
  bool _showTasks = true;
  bool _showMeetings = true;
```

在 `build` 內既有 `final meetingsAsync = ref.watch(meetingsProvider(workspaceId));`（L56）之後加：

```dart
    final tasksAsync = ref.watch(calendarTasksProvider(workspaceId));
```

- [ ] **Step 2: AppBar 加兩個過濾開關 + 移除「M-04 日曆整合」徽章**

把 AppBar `actions` 中的「✓ M-04 日曆整合」徽章容器（L75-86）替換為兩個 `IconButton`（toggle style）：

```dart
          IconButton(
            tooltip: '顯示任務',
            onPressed: () => setState(() => _showTasks = !_showTasks),
            icon: Icon(Icons.check_circle,
                color: _showTasks ? Theme.of(context).colorScheme.primary : null),
          ),
          IconButton(
            tooltip: '顯示會議',
            onPressed: () => setState(() => _showMeetings = !_showMeetings),
            icon: Icon(Icons.videocam,
                color: _showMeetings ? Theme.of(context).colorScheme.primary : null),
          ),
```

- [ ] **Step 3: 合併資料來源 + eventLoader**

在 `build` 的 `meetingsAsync.when(...)` 外層改為同時等兩個來源：把現有 `meetingsAsync.when` 改為先讀 `tasksAsync`。最簡作法——在 build 內取兩個值：

```dart
    final meetings = meetingsAsync.valueOrNull ?? const [];
    final tasks = tasksAsync.valueOrNull ?? const [];
    if (meetingsAsync.isLoading || tasksAsync.isLoading) {
      return Scaffold(appBar: AppBar(title: const Text('行事曆')), body: const LoadingWidget());
    }
    if (meetingsAsync.hasError || tasksAsync.hasError) {
      return Scaffold(
        appBar: AppBar(title: const Text('行事曆')),
        body: AppErrorWidget(
          message: (meetingsAsync.error ?? tasksAsync.error).toString(),
          onRetry: () {
            ref.invalidate(meetingsProvider(workspaceId));
            ref.invalidate(calendarTasksProvider(workspaceId));
          },
        ),
      );
    }
    final visibleMeetings = _showMeetings ? meetings : const [];
    final visibleTasks = _showTasks ? tasks : const [];
```

（後續的月視圖 `TableCalendar`、`_buildList`、`_TimeGridView` 都用這兩個 list。）

月視圖 `TableCalendar` 的 `eventLoader`（L136-141）改為合併：先放任務（依 dueDate）再放會議（依 startTime），讓同一日兩者都出現：

```dart
          eventLoader: (day) {
            final t = visibleTasks.where((x) {
              final d = DateTime.tryParse(x['dueDate'] ?? '');
              return d != null && isSameDay(d, day);
            });
            final m = visibleMeetings.where((x) {
              final s = DateTime.tryParse(x['startTime'] ?? '');
              return s != null && isSameDay(s, day);
            });
            return [...t, ...m];
          },
```

- [ ] **Step 4: 月視圖格內 marker 區分任務／會議**

`TableCalendar` 的 `CalendarStyle`（L142-145）改為自訂 marker：用 `markerBuilder` 在格內畫任務色點（priority 色）與會議小方塊。在 `TableCalendar(...)` 參數中加：

```dart
          calendarBuilders: CalendarBuilders(
            markerBuilder: (ctx, day, events) {
              if (events.isEmpty) return const SizedBox.shrink();
              final tasks = events.whereType<Map<String, dynamic>>().where((e) => e['dueDate'] != null).toList();
              final meets = events.whereType<Map<String, dynamic>>().where((e) => e['startTime'] != null).toList();
              return Positioned(
                bottom: 4, left: 0, right: 0,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    ...tasks.take(3).map((e) => Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 1),
                      child: Icon(Icons.circle, size: 6, color: _priorityColor(e['priority'] as String? ?? 'medium')),
                    )),
                    if (meets.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(left: 2),
                        child: Icon(Icons.square, size: 6, color: const Color(0xFF4F46E5)),
                      ),
                  ],
                ),
              );
            },
          ),
```

並在 `_CalendarPageState` 加 priority → Color 小幫手：

```dart
  Color _priorityColor(String p) {
    switch (p) {
      case 'urgent': return const Color(0xFFEF4444);
      case 'high': return const Color(0xFFF59E0B);
      case 'low': return Colors.grey;
      default: return const Color(0xFF3B82F6); // medium
    }
  }
```

- [ ] **Step 5: 週/日視圖 —— 任務進全天區**

`_TimeGridView`/`_DayColumn` 仍吃「會議用 startTime/endTime 排時間格」。任務沒有時刻，改為在 `_TimeGridView` 上方加一條「全天任務」橫列（只週/日視圖顯示）。在 `_TimeGridView` 的 `build` 最外層 `Column`（找其 build 內最外層 Column）的 `children` 最前面插入：

```dart
            if (visibleTasks.isNotEmpty)
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 56),
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: OideaSpace.space2),
                  children: days.expand((d) {
                    return visibleTasks.where((t) {
                      final due = DateTime.tryParse(t['dueDate'] ?? '');
                      return due != null && isSameDay(due, d);
                    }).map((t) => _TaskChip(task: t, onTap: () => _openTaskDetail(t)));
                  }).toList(),
                ),
              ),
```

（`visibleTasks` 透過 `_TimeGridView` 的新增欄位傳入——見 Step 6。）

新增 `_TaskChip` widget（放在檔案末尾）：

```dart
class _TaskChip extends StatelessWidget {
  final Map<String, dynamic> task;
  final VoidCallback onTap;
  const _TaskChip({required this.task, required this.onTap});

  Color _color(String p) => switch (p) {
    'urgent' => const Color(0xFFEF4444),
    'high' => const Color(0xFFF59E0B),
    'low' => Colors.grey,
    _ => const Color(0xFF3B82F6),
  };

  @override
  Widget build(BuildContext context) {
    final completed = task['completed'] == true;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(right: OideaSpace.space2, top: OideaSpace.space1),
        padding: const EdgeInsets.symmetric(horizontal: OideaSpace.space2, vertical: 4),
        decoration: BoxDecoration(
          color: _color(task['priority'] as String? ?? 'medium').withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(OideaRadius.md),
          border: Border.all(color: _color(task['priority'] as String? ?? 'medium')),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(completed ? Icons.check_circle_outline : Icons.circle_outlined, size: 14),
            const SizedBox(width: 4),
            Text(task['title'] ?? '',
                style: TextStyle(
                  fontSize: OideaFontSize.size12,
                  decoration: completed ? TextDecoration.lineThrough : TextDecoration.none,
                  color: completed ? Colors.grey : null,
                )),
          ],
        ),
      ),
    );
  }
}
```

- [ ] **Step 6: 把 visibleTasks 傳進 _TimeGridView**

`_TimeGridView` 增加欄位 `final List<dynamic> tasks;`（與既有 `meetings` 並列），建構子加 `required this.tasks`，內部用 `tasks` 算全天區（Step 5 的 `visibleTasks` 改讀 `widget.tasks`／this.tasks）。呼叫處（月視圖外、`_viewMode != month` 時建構 `_TimeGridView` 的地方）補 `tasks: visibleTasks`。

- [ ] **Step 7: 驗證 + commit**

```bash
cd app && flutter analyze --no-fatal-infos lib/features/meeting/presentation/pages/calendar_page.dart 2>&1 | tail -5 && flutter test 2>&1 | tail -4
```

Expected: analyze 乾淨；31 既有測試仍全綠。

```bash
git add app/lib/features/meeting/presentation/pages/calendar_page.dart
git commit -m "feat(calendar): show tasks + meetings with show/hide toggles

Calendar eventLoader merges tasks (by dueDate) and meetings (by
startTime). Month cells draw priority-coloured task dots + a meeting
square; week/day get an all-day task chip strip above the time grid.

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
```

---

### Task 6: 日曆互動 —— 拖曳改日期 ＋ 點任務開詳情 ＋ 點空天建任務

**Files:**
- Modify: `app/lib/features/meeting/presentation/pages/calendar_page.dart`

**Interfaces:**
- Consumes: Task 1 的 `rescheduleTask`、既有 `createTask`（`POST /tasks`）、既有任務詳情路由 `/projects/board/:projectId/task/:taskId`。
- Produces: 拖曳任務改 dueDate、點任務開詳情、點空天建任務。

- [ ] **Step 1: 點任務開詳情**

在 `_CalendarPageState` 加方法（沿用既有路由）：

```dart
  void _openTaskDetail(Map<String, dynamic> task) {
    final projectId = task['projectId'] as String?;
    final taskId = task['id'] as String?;
    if (projectId != null && taskId != null) {
      context.go('/projects/board/$projectId/task/$taskId');
    }
  }
```

把 `_TaskChip` 的 onTap 已傳 `_openTaskDetail`（Task 5 Step 5）。月視圖 marker 是小圖示、不另開；詳細入口走週/日 chip 與下方日清單（Step 4）。

- [ ] **Step 2: 月視圖下方日清單也列任務 + 可點**

把 `_buildList`（L173-257）的 `meetings` 參數語意擴成「當日任務＋會議」。呼叫處傳合併 list：

```dart
        _buildList(context, [...visibleTasks, ...visibleMeetings])
```

在 `_buildList` 內 `itemBuilder` 中，依 item 是否有 `dueDate`（任務）或 `startTime`（會議）分流渲染：任務用一張簡易 `Card`（標題 + priority 色條 + 完成刪除線），`onTap: () => _openTaskDetail(item)`；會議維持原卡片與 `_openJoinPreview`。

任務卡片 itemBuilder 分支（在原會議卡片之前判斷）：

```dart
        final isTask = (item['dueDate'] != null);
        if (isTask) {
          final completed = item['completed'] == true;
          return Card(
            margin: const EdgeInsets.only(bottom: OideaSpace.space3),
            child: InkWell(
              onTap: () => _openTaskDetail(item),
              borderRadius: BorderRadius.circular(OideaRadius.lg),
              child: Padding(
                padding: const EdgeInsets.all(OideaSpace.space4),
                child: Row(children: [
                  Container(width: 4, height: 40, decoration: BoxDecoration(color: _priorityColor(item['priority'] as String? ?? 'medium'), borderRadius: BorderRadius.circular(2))),
                  const SizedBox(width: OideaSpace.space3),
                  Expanded(child: Text(item['title'] ?? '', style: TextStyle(fontWeight: FontWeight.w600, decoration: completed ? TextDecoration.lineThrough : TextDecoration.none))),
                  Text(item['projectName'] ?? '', style: const TextStyle(color: Colors.grey, fontSize: OideaFontSize.size12)),
                ]),
              ),
            ),
          );
        }
        // …以下為既有會議卡片邏輯（不動）
```

- [ ] **Step 3: 點空天建任務對話框**

在 `_CalendarPageState` 加建任務對話框（預填 dueDate、選專案、欄位預設第一欄）：

```dart
  void _showCreateTask(BuildContext context, String workspaceId, DateTime dueDate) {
    final titleController = TextEditingController();
    final projects = <Map<String, dynamic>>[];
    Map<String, dynamic>? projectDetail;
    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        return AlertDialog(
          title: const Text('新增任務'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(controller: titleController, autofocus: true, decoration: const InputDecoration(labelText: '任務標題 *', border: OutlineInputBorder())),
              const SizedBox(height: OideaSpace.space2),
              FutureBuilder<List<dynamic>>(
                future: ref.read(apiClientProvider).getProjects(workspaceId),
                builder: (ctx, snap) {
                  if (!snap.hasData) return const Padding(padding: EdgeInsets.all(8), child: Text('載入專案…'));
                  if (projects.isEmpty) projects.addAll(snap.data!.whereType<Map<String, dynamic>>());
                  return DropdownButton<String>(
                    value: projectDetail?['id'],
                    hint: const Text('選擇專案 *'),
                    items: projects.map((p) => DropdownMenuItem(value: p['id'] as String, child: Text(p['name'] ?? ''))).toList(),
                    onChanged: (id) async {
                      if (id == null) return;
                      final full = await ref.read(apiClientProvider).getProject(id);
                      setSt(() => projectDetail = full);
                    },
                  );
                },
              ),
              Padding(padding: const EdgeInsets.only(top: OideaSpace.space1), child: Text('到期：${dueDate.year}-${dueDate.month.toString().padLeft(2, '0')}-${dueDate.day.toString().padLeft(2, '0')}', style: const TextStyle(color: Colors.grey))),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(
              onPressed: () async {
                final title = titleController.text.trim();
                final cols = (projectDetail?['columns'] as List?) ?? const [];
                if (title.isEmpty || projectDetail == null || cols.isEmpty) return;
                Navigator.pop(ctx);
                try {
                  await ref.read(apiClientProvider).createTask({
                    'projectId': projectDetail!['id'],
                    'columnId': (cols.first as Map<String, dynamic>)['id'],
                    'title': title,
                    'dueDate': dueDate.toIso8601String(),
                  });
                  ref.invalidate(calendarTasksProvider(workspaceId));
                } catch (e) {
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立失敗：$e')));
                }
              },
              child: const Text('建立'),
            ),
          ],
        );
      }),
    );
  }
```

> **實作提醒（以檔案現況為準）：** `getProjects(workspaceId)` 與 `getProject(id)` 的確切方法名請在 `api_client.dart` grep `/projects/workspace` 與 `/projects/` 確認；若方法名不同（例如 `getProjectsByWorkspace`），以實際為準。`getProject` 需回傳含 `columns`（既有 `GET /projects/:id` 已 include columns）。

把月視圖 `TableCalendar` 的 `onDaySelected` 擴充為長按建任務：在 `TableCalendar` 參數加 `onDayLongPress`（table_calendar 支援）：

```dart
          onDayLongPress: (day, _) => _showCreateTask(context, workspaceId, day),
```

並把 FAB（原 `_showCreateMeeting`，L112-115）改為：預設建任務、長按建會議（與白板 FAB 長按選單同模式）。FAB 改為 `GestureDetector` 包 `FloatingActionButton`：

```dart
      floatingActionButton: GestureDetector(
        onLongPress: () => _showCreateMeeting(context, workspaceId),
        child: FloatingActionButton(
          onPressed: () => _showCreateTask(context, workspaceId, _selectedDay ?? _focusedDay),
          child: const Icon(Icons.add),
        ),
      ),
```

（`_showCreateMeeting` 保留不動，作為長按建會議入口。）

- [ ] **Step 4: 拖曳任務改日期（週/日 chip 拖到別天）**

讓 `_TaskChip` 可拖曳、`_DayColumn`（或全天區的日標頭）可接收。在 `_TaskChip` 外包 `LongPressDraggable<Map<String, dynamic>>`（data: task），並在 `_TimeGridView` 的每日欄標頭包 `DragTarget<Map<String, dynamic>>`，`onAcceptWithDetails` 呼叫 reschedule。

`_TaskChip` 的 `build` 最外層改包：

```dart
    return LongPressDraggable<Map<String, dynamic>>(
      data: task,
      feedback: Material(color: Colors.transparent, child: _chipInner()),
      childWhenDragging: Opacity(opacity: 0.4, child: _chipInner()),
      child: GestureDetector(onTap: onTap, child: _chipInner()),
    );
```

（把現有 Container 圖樣抽成 `_Widget _chipInner()`，`_TaskChip` 改為有該方法。）

`_TimeGridView` 內每日欄標頭（尋找畫星期/日期標題的 Row/Column）包 `DragTarget`：

```dart
              DragTarget<Map<String, dynamic>>(
                onAcceptWithDetails: (d) => _rescheduleTask(d.data, day),
                builder: (ctx, candidate, rejected) => /* 原本該日的標頭 widget */,
              ),
```

在 `_CalendarPageState`（或 `_TimeGridView` 透過 callback 回傳頁面）加：

```dart
  Future<void> _rescheduleTask(Map<String, dynamic> task, DateTime newDay) async {
    final taskId = task['id'] as String?;
    if (taskId == null) return;
    final oldDue = DateTime.tryParse(task['dueDate'] ?? '');
    final newDue = DateTime(newDay.year, newDay.month, newDay.day, 12);
    try {
      await ref.read(apiClientProvider).rescheduleTask(taskId, dueDate: newDue.toIso8601String());
      ref.invalidate(calendarTasksProvider(workspaceId));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('改期失敗：$e')));
    }
  }
```

> **月視圖拖曳：** v1 不強求（`table_calendar` 格內拖曳支援度風險，spec 風險表已記）。改期主要走週/日視圖 chip 拖曳 ＋ 點任務進詳情改 dueDate 兩條路。

- [ ] **Step 5: 驗證 + commit**

```bash
cd app && flutter analyze --no-fatal-infos 2>&1 | tail -5 && flutter test 2>&1 | tail -4
```

Expected: analyze 乾淨；既有測試仍全綠。

```bash
git add app/lib/features/meeting/presentation/pages/calendar_page.dart
git commit -m "feat(calendar): drag-to-reschedule, tap-to-detail, create-on-day

Week/day task chips are draggable onto another day column to change
dueDate (PUT /tasks/:id/reschedule). Tapping a task opens its detail;
long-pressing a day (or the FAB) creates a task due that day.

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
```

---

### Task 7: Flutter widget test

**Files:**
- Create: `app/test/calendar_page_test.dart`

**Interfaces:**
- Consumes: Task 3/5/6 的 `CalendarPage`、`apiClientProvider`、`calendarTasksProvider`、`meetingsProvider`。
- Produces: 4 條 widget test。

- [ ] **Step 1: 寫 widget test**

`app/test/calendar_page_test.dart`（用與 `whiteboard_pages_test.dart` 相同的 Fake ApiClient 手法；workspace provider 用 override）。先確認 `currentWorkspaceIdProvider`/`workspacesProvider` 的 override 方式（grep `workspace_provider.dart`，依現況 override；以下用直接 override `apiClientProvider` + workspace providers 的常見寫法）：

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/features/meeting/presentation/pages/calendar_page.dart';
import 'package:oidea/features/workspace/providers/workspace_provider.dart';

class _FakeApi extends Fake implements ApiClient {
  @override
  Future<List<dynamic>> getCalendarTasks(String workspaceId, {DateTime? from, DateTime? to}) async => [
        {'id': 't-1', 'title': '任務A', 'dueDate': '2026-08-10T00:00:00.000Z', 'priority': 'high', 'projectId': 'p-1', 'projectName': 'P1', 'columnId': 'c1', 'completed': false},
      ];
  @override
  Future<List<dynamic>> getMeetings(String workspaceId) async => [
        {'id': 'm-1', 'title': '會議X', 'startTime': '2026-08-10T10:00:00.000Z', 'endTime': '2026-08-10T11:00:00.000Z', 'status': 'scheduled'},
      ];
  @override
  Future<List<dynamic>> getProjects(String workspaceId) async => [];
}

Future<void> _pump(WidgetTester tester, List<Override> extra) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(_FakeApi()),
        workspacesProvider.overrideWith((_) async => [
              {'id': 'w-1', 'name': 'WS'}
            ]),
        currentWorkspaceIdProvider.overrideWith((_) => 'w-1'),
        ...extra,
      ],
      child: const MaterialApp(home: CalendarPage()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('日曆：同時顯示任務與會議', (tester) async {
    await _pump(tester, const []);
    expect(find.text('行事曆'), findsWidgets);
    expect(find.text('任務A'), findsWidgets); // chip 或日清單
    expect(find.text('會議X'), findsWidgets);
  });

  testWidgets('關閉「顯示任務」後任務消失', (tester) async {
    await _pump(tester, const []);
    await tester.tap(find.byTooltip('顯示任務'));
    await tester.pumpAndSettle();
    expect(find.text('任務A'), findsNothing);
  });

  testWidgets('關閉「顯示會議」後會議消失', (tester) async {
    await _pump(tester, const []);
    await tester.tap(find.byTooltip('顯示會議'));
    await tester.pumpAndSettle();
    expect(find.text('會議X'), findsNothing);
  });

  testWidgets('長按日期建任務：呼叫 createTask', (tester) async {
    final created = <Map<String, dynamic>>[];
    await _pump(tester, [
      apiClientProvider.overrideWithValue(_FakeApiForCreate(created)),
    ]);
    // 長按 FAB 觸發建任務對話框（dueDate = focusedDay）
    await tester.longPress(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    // 標題輸入後建立
    await tester.enterText(find.byType(TextField), '新任務');
    await tester.tap(find.widgetWithText(FilledButton, '建立'));
    await tester.pumpAndSettle();
    expect(created, isNotEmpty);
    expect(created.first['title'], '新任務');
  });
}

class _FakeApiForCreate extends _FakeApi {
  final List<Map<String, dynamic>> created;
  _FakeApiForCreate(this.created);
  @override
  Future<List<dynamic>> getProjects(String workspaceId) async => [
        {'id': 'p-1', 'name': 'P1'}
      ];
  @override
  Future<Map<String, dynamic>> getProject(String id) async =>
      {'id': 'p-1', 'name': 'P1', 'columns': [{'id': 'c1', 'name': '待辦', 'position': 0}]};
  @override
  Future<Map<String, dynamic>> createTask(Map<String, dynamic> body) async {
    created.add(body);
    return {'id': 't-new', ...body};
  }
}
```

> **實作提醒（以檔案現況為準）：** `workspacesProvider`/`currentWorkspaceIdProvider` 的型別（`FutureProvider` vs `StateProvider`）與 override 語法，請 grep `workspace_provider.dart` 對齊；上方用 `overrideWith` 為常見形式，若為 `StateProvider` 改用 `overrideWithValue`。`getProjects`/`getProject` 方法名同 Task 6 Step 3 提醒。任務標題「任務A」在月視圖 marker 不出現文字，故測試切到週視圖（先 tap 週 segment）或直接驗下方日清單——實作時依實際渲染位置調整 `find` 目標。

- [ ] **Step 2: 跑測試 + 全量驗證**

```bash
cd app && flutter test test/calendar_page_test.dart 2>&1 | tail -8
cd app && flutter analyze --no-fatal-infos 2>&1 | tail -3 && flutter test 2>&1 | tail -4
```

Expected: 4 條新測試 PASS；全量 ≥35 passed、analyze exit 0。

- [ ] **Step 3: commit**

```bash
git add app/test/calendar_page_test.dart
git commit -m "test(calendar): widget tests — tasks+meetings render, toggles, create

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
```

---

### Task 8: 過時文件標籤清整 ＋ 全量驗證 ＋ PR

**Files:**
- Modify: `docs/REQUIREMENTS.md`

**Interfaces:**
- Consumes: Tasks 1–7 全部。
- Produces: REQUIREMENTS 標籤校正、PR。

- [ ] **Step 1: 翻正過時標籤**

`docs/REQUIREMENTS.md`：`P-09` 清單檢視 `[ ]`→`[x]`、`P-10` 甘特圖 `[ ]`→`[x]`、`M-02` 行事曆介面 `[~]`→`[x]`、`D-07` 提醒 `[~]`→`[x]`（皆已有實作 UI，見 spec 附帶節）。

- [ ] **Step 2: 全量建置驗證**

```bash
cd backend && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -3
cd ../app && flutter analyze --no-fatal-infos 2>&1 | tail -3 && flutter test 2>&1 | tail -4
```

Expected: backend ≥189 passed、build 乾淨；flutter analyze exit 0、≥35 passed。

- [ ] **Step 3: commit ＋ push ＋ PR**

```bash
git add docs/REQUIREMENTS.md
git commit -m "docs: record task calendar + fix stale P-09/P-10/M-02/D-07 labels

Co-Authored-By: opencode/glm-5.2 <noreply@anthropic.com>"
git push -u origin feat/task-calendar
gh pr create --base main --head feat/task-calendar \
  --title "feat(calendar): unified personal calendar (tasks + meetings)" \
  --body "個人統一日曆：跨專案任務（dueDate）＋ 會議同頁；拖曳改日期、點空天建任務、點任務開詳情。後端新增 GET /tasks/calendar、PUT /tasks/:id/reschedule。spec: docs/superpowers/specs/2026-08-10-task-calendar-design.md"
```

---

## Self-Review 紀錄

- **Spec coverage**：§1 導覽路由→Task 4；§2 兩新端點→Tasks 1/2（含 ACL）；§3 日曆呈現（eventLoader 合併、priority 色點/chip、月/週/日）→Task 5；§4 互動（拖曳改期、點建、點詳情、兩開關）→Tasks 5/6；§5 測試（後端 reschedule/calendar、前端 widget、實機驗收=PR 後使用者）→Tasks 1/2/7 + PR；§6 範圍外（時刻排程、跨天區間、提醒併入、會議改動、週期展開、專案篩選）均無任務觸碰；§7 風險（action 自由字串、月拖曳不強求、rename 迴歸隔離於 Task 4）已於計畫內對應；附帶 P-09/P-10/M-02/D-07→Task 8。✅
- **Placeholder scan**：無 TBD/TODO；兩處刻意的「以檔案現況為準」（getProjects/getProject 方法名、workspace provider override 語法、月任務標題 find 位置）均附明確判準與指定作法，非留白。✅
- **Type consistency**：`reschedule(userId, id, dto)` Task 1 定義、Task 3 前端 `rescheduleTask(taskId, {dueDate})` 呼叫一致；`findCalendar(userId, workspaceId, from?, to?)` Task 2 定義、Task 3 `getCalendarTasks(workspaceId, {from, to})` 一致；`calendarTasksProvider` Task 3 定義、Task 5 使用一致；回傳欄位 `projectName`/`completed` 於 Task 2 service map、Task 5/6/7 前端讀取一致；action 字串 `'rescheduled'` Task 1/2 與 spec §7 風險表一致。✅
- **Route ordering**：Task 2 Step 4 明確 `calendar` 宣告在 `:id` 前（Global Constraints 再述）。✅
