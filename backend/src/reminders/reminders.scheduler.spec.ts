import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { RemindersScheduler } from './reminders.scheduler';
import { RemindersService } from './reminders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../common/prisma.service';

describe('RemindersScheduler', () => {
  let scheduler: RemindersScheduler;
  let prisma: { reminder: { findMany: jest.Mock } };
  let reminders: { advance: jest.Mock };
  let notifications: { create: jest.Mock };

  const NOW = new Date('2026-04-20T09:00:00Z');

  beforeEach(async () => {
    prisma = { reminder: { findMany: jest.fn() } };
    reminders = { advance: jest.fn().mockResolvedValue({}) };
    notifications = { create: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RemindersScheduler,
        { provide: PrismaService, useValue: prisma },
        { provide: RemindersService, useValue: reminders },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    scheduler = module.get(RemindersScheduler);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {}); // 靜音 log
  });

  const ready = (overrides: any = {}) => ({
    id: 'r-1',
    userId: 'u-1',
    title: 'Cequrex 年度維護費 6,000',
    notes: '記得開發票',
    targetType: null,
    targetId: null,
    ...overrides,
  });

  it('TC-D07-SC01: 撈到到期 reminder → 建 Notification + advance', async () => {
    prisma.reminder.findMany.mockResolvedValue([ready()]);
    const n = await scheduler.pollAndFire(NOW);

    expect(n).toBe(1);
    expect(prisma.reminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'active',
          deletedAt: null,
          nextFireAt: { lte: NOW },
        }),
      }),
    );
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'u-1',
      type: 'reminder',
      title: 'Cequrex 年度維護費 6,000',
      content: '記得開發票',
      link: undefined,
    });
    expect(reminders.advance).toHaveBeenCalledWith('r-1', NOW);
  });

  it('TC-D07-SC02: targetType=database_row → link 組裝正確', async () => {
    prisma.reminder.findMany.mockResolvedValue([
      ready({ targetType: 'database_row', targetId: 'row-42' }),
    ]);
    await scheduler.pollAndFire(NOW);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ link: '/databases/rows/row-42' }),
    );
  });

  it('TC-D07-SC03: targetType=task → link /tasks/:id', async () => {
    prisma.reminder.findMany.mockResolvedValue([
      ready({ targetType: 'task', targetId: 't-9' }),
    ]);
    await scheduler.pollAndFire(NOW);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ link: '/tasks/t-9' }),
    );
  });

  it('TC-D07-SC04: 沒有到期 → 零呼叫', async () => {
    prisma.reminder.findMany.mockResolvedValue([]);
    const n = await scheduler.pollAndFire(NOW);
    expect(n).toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(reminders.advance).not.toHaveBeenCalled();
  });

  it('TC-D07-SC05: 單一 reminder 噴錯不阻塞後續', async () => {
    prisma.reminder.findMany.mockResolvedValue([
      ready({ id: 'bad' }),
      ready({ id: 'ok' }),
    ]);
    notifications.create.mockImplementationOnce(() =>
      Promise.reject(new Error('notify down')),
    );

    const n = await scheduler.pollAndFire(NOW);
    expect(n).toBe(1); // 只有第二筆成功
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(reminders.advance).toHaveBeenCalledTimes(1);
    expect(reminders.advance).toHaveBeenCalledWith('ok', NOW);
  });

  it('TC-D07-SC06: advance 噴錯也不影響其他筆', async () => {
    prisma.reminder.findMany.mockResolvedValue([
      ready({ id: 'first' }),
      ready({ id: 'second' }),
    ]);
    reminders.advance.mockImplementationOnce(() =>
      Promise.reject(new Error('db locked')),
    );

    const n = await scheduler.pollAndFire(NOW);
    expect(n).toBe(1);
    expect(notifications.create).toHaveBeenCalledTimes(2);
  });

  it('TC-D07-SC07: content 為 null → 不帶 content 欄位 (undefined)', async () => {
    prisma.reminder.findMany.mockResolvedValue([ready({ notes: null })]);
    await scheduler.pollAndFire(NOW);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: undefined }),
    );
  });
});
