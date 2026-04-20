import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { PrismaService } from '../common/prisma.service';

type PrismaMock = {
  workspaceMember: { findUnique: jest.Mock };
  reminder: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

const buildMock = (): PrismaMock => ({
  workspaceMember: { findUnique: jest.fn() },
  reminder: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
});

describe('RemindersService', () => {
  let service: RemindersService;
  let prisma: PrismaMock;

  const USER_ID = 'u-1';
  const WS_ID = 'ws-1';
  const REM_ID = 'r-1';

  beforeEach(async () => {
    prisma = buildMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RemindersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(RemindersService);
  });

  const asMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue({
      id: 'm-1',
      workspaceId: WS_ID,
      userId: USER_ID,
    });

  // ---------- create ----------
  describe('create', () => {
    it('TC-D07-S01: member 建立 none 提醒，nextFireAt = triggerAt', async () => {
      asMember();
      prisma.reminder.create.mockResolvedValue({ id: REM_ID });
      await service.create(USER_ID, {
        workspaceId: WS_ID,
        title: '測試',
        triggerAt: '2027-04-20T09:00:00Z',
      });
      const call = prisma.reminder.create.mock.calls[0][0];
      expect(call.data.workspaceId).toBe(WS_ID);
      expect(call.data.userId).toBe(USER_ID);
      expect(call.data.recurrence).toBe('none');
      expect(call.data.recurrenceInterval).toBe(1);
      expect(call.data.triggerAt).toEqual(
        call.data.nextFireAt,
      );
    });

    it('TC-D07-S02: 非 member 建立 → Forbidden', async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          title: '測試',
          triggerAt: '2027-04-20T09:00:00Z',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('TC-D07-S03: yearly + interval=1 的合約維護費提醒', async () => {
      asMember();
      prisma.reminder.create.mockResolvedValue({ id: REM_ID });
      await service.create(USER_ID, {
        workspaceId: WS_ID,
        title: 'Cequrex 年度維護費 6,000',
        triggerAt: '2027-04-20T09:00:00Z',
        recurrence: 'yearly',
        recurrenceInterval: 1,
      });
      const call = prisma.reminder.create.mock.calls[0][0];
      expect(call.data.recurrence).toBe('yearly');
      expect(call.data.recurrenceInterval).toBe(1);
    });

    it('TC-D07-S04: 不支援的 recurrence → BadRequest', async () => {
      asMember();
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          title: 'x',
          triggerAt: '2027-04-20T09:00:00Z',
          recurrence: 'fortnightly' as any,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-D07-S05: targetType 沒 targetId → BadRequest', async () => {
      asMember();
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          title: 'x',
          triggerAt: '2027-04-20T09:00:00Z',
          targetType: 'database_row',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-D07-S06: targetId 沒 targetType → BadRequest', async () => {
      asMember();
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          title: 'x',
          triggerAt: '2027-04-20T09:00:00Z',
          targetId: 'r-xxx',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ---------- findByWorkspace ----------
  describe('findByWorkspace', () => {
    it('TC-D07-S10: 預設排除已完成', async () => {
      asMember();
      prisma.reminder.findMany.mockResolvedValue([]);
      await service.findByWorkspace(USER_ID, WS_ID);
      expect(prisma.reminder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { not: 'completed' },
          }),
        }),
      );
    });

    it('TC-D07-S11: includeCompleted=true 不過濾', async () => {
      asMember();
      prisma.reminder.findMany.mockResolvedValue([]);
      await service.findByWorkspace(USER_ID, WS_ID, { includeCompleted: true });
      const call = prisma.reminder.findMany.mock.calls[0][0];
      expect(call.where.status).toBeUndefined();
    });
  });

  // ---------- lifecycle ----------
  describe('lifecycle', () => {
    const baseReminder = (overrides: any = {}) => ({
      id: REM_ID,
      workspaceId: WS_ID,
      userId: USER_ID,
      title: 't',
      triggerAt: new Date('2026-04-20T09:00:00Z'),
      nextFireAt: new Date('2026-04-20T09:00:00Z'),
      recurrence: 'none',
      recurrenceInterval: 1,
      status: 'active',
      deletedAt: null,
      lastFiredAt: null,
      ...overrides,
    });

    it('TC-D07-S20: pause → status = paused', async () => {
      prisma.reminder.findUnique.mockResolvedValue(baseReminder());
      asMember();
      prisma.reminder.update.mockResolvedValue({});
      await service.pause(USER_ID, REM_ID);
      expect(prisma.reminder.update).toHaveBeenCalledWith({
        where: { id: REM_ID },
        data: { status: 'paused' },
      });
    });

    it('TC-D07-S21: complete → status = completed', async () => {
      prisma.reminder.findUnique.mockResolvedValue(baseReminder());
      asMember();
      prisma.reminder.update.mockResolvedValue({});
      await service.complete(USER_ID, REM_ID);
      expect(prisma.reminder.update).toHaveBeenCalledWith({
        where: { id: REM_ID },
        data: { status: 'completed' },
      });
    });

    it('TC-D07-S22: 已 completed 無法 resume', async () => {
      prisma.reminder.findUnique.mockResolvedValue(
        baseReminder({ status: 'completed' }),
      );
      asMember();
      await expect(service.resume(USER_ID, REM_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('TC-D07-S23: remove → 寫 deletedAt', async () => {
      prisma.reminder.findUnique.mockResolvedValue(baseReminder());
      asMember();
      prisma.reminder.update.mockResolvedValue({});
      await service.remove(USER_ID, REM_ID);
      expect(prisma.reminder.update).toHaveBeenCalledWith({
        where: { id: REM_ID },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('TC-D07-S24: 已刪除的 reminder → NotFound', async () => {
      prisma.reminder.findUnique.mockResolvedValue(
        baseReminder({ deletedAt: new Date() }),
      );
      await expect(service.findById(USER_ID, REM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---------- advance (scheduler 會呼叫) ----------
  describe('advance', () => {
    it('TC-D07-S30: none recurring → status completed', async () => {
      prisma.reminder.findUnique.mockResolvedValue({
        id: REM_ID,
        status: 'active',
        recurrence: 'none',
        recurrenceInterval: 1,
        nextFireAt: new Date('2026-04-20T09:00:00Z'),
        deletedAt: null,
      });
      prisma.reminder.update.mockResolvedValue({});
      await service.advance(REM_ID, new Date('2026-04-20T09:00:00Z'));
      expect(prisma.reminder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'completed' }),
        }),
      );
    });

    it('TC-D07-S31: yearly 推進一年、保留 active', async () => {
      prisma.reminder.findUnique.mockResolvedValue({
        id: REM_ID,
        status: 'active',
        recurrence: 'yearly',
        recurrenceInterval: 1,
        nextFireAt: new Date('2027-04-20T09:00:00Z'),
        deletedAt: null,
      });
      prisma.reminder.update.mockResolvedValue({});
      await service.advance(REM_ID, new Date('2027-04-20T09:05:00Z'));
      const call = prisma.reminder.update.mock.calls[0][0];
      expect((call.data.nextFireAt as Date).toISOString()).toBe(
        '2028-04-20T09:00:00.000Z',
      );
      expect(call.data.status).toBeUndefined(); // 不改 status
    });

    it('TC-D07-S32: paused 狀態 advance → BadRequest', async () => {
      prisma.reminder.findUnique.mockResolvedValue({
        id: REM_ID,
        status: 'paused',
        recurrence: 'daily',
        recurrenceInterval: 1,
        nextFireAt: new Date(),
        deletedAt: null,
      });
      await expect(service.advance(REM_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
