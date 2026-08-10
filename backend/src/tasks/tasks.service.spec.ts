import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { PrismaService } from '../common/prisma.service';
import { AutomationEngine } from '../automation/automation.engine';
import { NotificationsService } from '../notifications/notifications.service';

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

describe('TasksService — P-14 循環任務', () => {
  let service: TasksService;
  let prisma: PrismaMock;
  let automation: { onTaskCompleted: jest.Mock };
  let notifications: { create: jest.Mock };

  const USER_ID = 'u-1';
  const TASK_ID = 't-1';

  beforeEach(async () => {
    prisma = buildMock();
    automation = { onTaskCompleted: jest.fn().mockResolvedValue(0) };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: AutomationEngine, useValue: automation },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(TasksService);
  });

  const baseTask = (overrides: any = {}) => ({
    id: TASK_ID,
    projectId: 'p-1',
    columnId: 'col-1',
    title: 'Cequrex 年度維護費請款',
    description: 'TWD 6000 開發票',
    priority: 'high',
    assigneeId: 'u-2',
    startDate: null,
    dueDate: new Date('2027-04-20T00:00:00Z'),
    completedAt: null,
    recurrence: 'yearly',
    recurrenceInterval: 1,
    recurringSourceId: null,
    deletedAt: null,
    ...overrides,
  });

  // ---------- create ----------
  describe('create', () => {
    it('TC-P14-001: 建立任務時帶入 recurrence 欄位', async () => {
      prisma.project.findUnique.mockResolvedValue({ id: 'p-1', deletedAt: null });
      prisma.projectColumn.findUnique.mockResolvedValue({ id: 'col-1', projectId: 'p-1' });
      prisma.task.count.mockResolvedValue(3);

      await service.create(USER_ID, {
        projectId: 'p-1',
        columnId: 'col-1',
        title: 'x',
        recurrence: 'monthly',
        recurrenceInterval: 2,
      });

      expect(prisma.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recurrence: 'monthly',
          recurrenceInterval: 2,
        }),
        include: expect.any(Object),
      });
    });

    it('TC-P14-002: 沒指定 recurrence → 預設 none + interval=1', async () => {
      prisma.project.findUnique.mockResolvedValue({ id: 'p-1', deletedAt: null });
      prisma.projectColumn.findUnique.mockResolvedValue({ id: 'col-1', projectId: 'p-1' });

      await service.create(USER_ID, {
        projectId: 'p-1',
        columnId: 'col-1',
        title: 'x',
      });

      expect(prisma.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recurrence: 'none',
          recurrenceInterval: 1,
        }),
        include: expect.any(Object),
      });
    });
  });

  // ---------- spawn on complete ----------
  describe('update — spawn next', () => {
    const primeUpdate = (task: any) => {
      prisma.task.findUnique.mockResolvedValue(task);
      prisma.task.update.mockResolvedValue({ ...task, completedAt: new Date() });
    };

    it('TC-P14-010: yearly + dueDate → spawn 推進一年，recurringSourceId = 原 id', async () => {
      primeUpdate(baseTask());
      await service.update(USER_ID, TASK_ID, { completed: true });

      // 第一次 task.create 呼叫是 spawn
      expect(prisma.task.create).toHaveBeenCalledTimes(1);
      const data = prisma.task.create.mock.calls[0][0].data;
      expect((data.dueDate as Date).toISOString()).toBe('2028-04-20T00:00:00.000Z');
      expect(data.recurringSourceId).toBe(TASK_ID);
      expect(data.title).toBe('Cequrex 年度維護費請款');
      expect(data.priority).toBe('high');
      expect(data.assigneeId).toBe('u-2');
      expect(data.recurrence).toBe('yearly');
      expect(data.recurrenceInterval).toBe(1);
      expect(data.completedAt).toBeUndefined();
    });

    it('TC-P14-011: monthly Jan 31 → spawn Feb 28 (平年 clamp)', async () => {
      primeUpdate(
        baseTask({
          recurrence: 'monthly',
          recurrenceInterval: 1,
          dueDate: new Date('2026-01-31T00:00:00Z'),
        }),
      );
      await service.update(USER_ID, TASK_ID, { completed: true });
      const data = prisma.task.create.mock.calls[0][0].data;
      expect((data.dueDate as Date).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    });

    it('TC-P14-012: recurrence=none → 不 spawn', async () => {
      primeUpdate(baseTask({ recurrence: 'none' }));
      await service.update(USER_ID, TASK_ID, { completed: true });
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it('TC-P14-013: recurring 但沒 dueDate → 不 spawn', async () => {
      primeUpdate(baseTask({ dueDate: null }));
      await service.update(USER_ID, TASK_ID, { completed: true });
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it('TC-P14-014: 已 completed 的任務再送 completed=true → 不重複 spawn', async () => {
      primeUpdate(baseTask({ completedAt: new Date('2026-04-20T00:00:00Z') }));
      await service.update(USER_ID, TASK_ID, { completed: true });
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it('TC-P14-015: completed=false (取消完成) → 不 spawn', async () => {
      primeUpdate(baseTask());
      await service.update(USER_ID, TASK_ID, { completed: false });
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it('TC-P14-016: 第二代任務的 recurringSourceId 指向根，不是上一代', async () => {
      primeUpdate(
        baseTask({
          id: 't-gen2',
          recurringSourceId: 't-root', // 上一代 spawn 出來的，根是 t-root
        }),
      );
      await service.update(USER_ID, 't-gen2', { completed: true });
      const data = prisma.task.create.mock.calls[0][0].data;
      expect(data.recurringSourceId).toBe('t-root');
    });

    it('TC-P14-017: startDate 相對 dueDate 的偏移會被保留', async () => {
      primeUpdate(
        baseTask({
          // start 比 due 早 3 天
          startDate: new Date('2027-04-17T00:00:00Z'),
          dueDate: new Date('2027-04-20T00:00:00Z'),
          recurrence: 'yearly',
          recurrenceInterval: 1,
        }),
      );
      await service.update(USER_ID, TASK_ID, { completed: true });
      const data = prisma.task.create.mock.calls[0][0].data;
      expect((data.startDate as Date).toISOString()).toBe('2028-04-17T00:00:00.000Z');
      expect((data.dueDate as Date).toISOString()).toBe('2028-04-20T00:00:00.000Z');
    });
  });

  // ---------- P-15 hook into automation ----------
  describe('automation hook', () => {
    const primeUpdate = (task: any) => {
      prisma.task.findUnique.mockResolvedValue(task);
      prisma.task.update.mockResolvedValue({
        ...task,
        completedAt: new Date(),
      });
    };

    it('TC-P15-H01: 首次完成任務會呼叫 AutomationEngine.onTaskCompleted', async () => {
      primeUpdate(baseTask({ recurrence: 'none' })); // 不要觸發 spawn
      await service.update(USER_ID, TASK_ID, { completed: true });
      expect(automation.onTaskCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ id: TASK_ID, projectId: 'p-1' }),
      );
    });

    it('TC-P15-H02: 非完成的 update 不呼叫 automation', async () => {
      primeUpdate(baseTask({ recurrence: 'none' }));
      await service.update(USER_ID, TASK_ID, { title: 'rename only' });
      expect(automation.onTaskCompleted).not.toHaveBeenCalled();
    });

    it('TC-P15-H03: 已 completed 再送 completed=true → 不重呼 automation', async () => {
      primeUpdate(
        baseTask({ recurrence: 'none', completedAt: new Date() }),
      );
      await service.update(USER_ID, TASK_ID, { completed: true });
      expect(automation.onTaskCompleted).not.toHaveBeenCalled();
    });

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
      prisma.task.findUnique.mockResolvedValueOnce({
        id: TASK_ID, project: { workspaceId: 'w-other' },
      });
      prisma.user.findFirst.mockResolvedValueOnce(null);

      await expect(service.reschedule(USER_ID, TASK_ID, { dueDate: '2026-08-11' }))
        .rejects.toThrow(ForbiddenException);
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('findCalendar：回傳該 workspace 有 dueDate 的任務（跨專案、含 projectName/completed）', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
      prisma.task.findMany.mockResolvedValueOnce([
        { id: 't-a', title: 'A', dueDate: new Date('2026-08-10'), priority: 'high', completedAt: null, assigneeId: USER_ID, projectId: 'p-1', columnId: 'c1', project: { id: 'p-1', name: 'P1' } },
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

    it('findCalendar：跨工作區拒絕（ForbiddenException）', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);
      await expect(service.findCalendar(USER_ID, 'w-other')).rejects.toThrow(ForbiddenException);
      expect(prisma.task.findMany).not.toHaveBeenCalled();
    });
  });
});
