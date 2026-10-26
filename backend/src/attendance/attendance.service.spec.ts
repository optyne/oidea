import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Characterization tests for the current happy paths of AttendanceService
 * (written before the H0 security changes; kept green afterwards).
 */
describe('AttendanceService — characterization', () => {
  let service: AttendanceService;
  let prisma: any;
  let notifications: { create: jest.Mock };
  // userId -> role in ws-1
  let roles: Record<string, string>;

  beforeEach(async () => {
    roles = { 'u-member': 'member', 'u-hr': 'hr', 'u-admin': 'admin', 'u-owner': 'owner' };
    prisma = {
      workspaceMember: {
        findUnique: jest.fn(async ({ where }: any) => {
          const { workspaceId, userId } = where.workspaceId_userId;
          if (workspaceId !== 'ws-1' || !roles[userId]) return null;
          return { role: roles[userId] };
        }),
        findMany: jest.fn().mockResolvedValue([{ userId: 'u-hr' }, { userId: 'u-admin' }]),
      },
      attendance: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(async ({ create }: any) => ({ id: 'a-1', ...create })),
        update: jest.fn(async ({ data }: any) => ({ id: 'a-1', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      leaveRequest: {
        create: jest.fn(async ({ data }: any) => ({ id: 'l-1', status: 'pending', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  describe('check-in / check-out', () => {
    it('member checks in: upsert with today (UTC midnight) and checkInAt', async () => {
      const res = await service.checkIn('u-member', { workspaceId: 'ws-1', location: 'office' });
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.userId).toBe('u-member');
      expect(arg.create.checkInLocation).toBe('office');
      expect(arg.create.checkInAt).toBeInstanceOf(Date);
      const date: Date = arg.create.date;
      expect(date.getUTCHours()).toBe(0);
      expect(date.getUTCMinutes()).toBe(0);
      expect(res.id).toBe('a-1');
    });

    it('second check-in on the same day is rejected', async () => {
      prisma.attendance.findUnique.mockResolvedValue({ id: 'a-1', checkInAt: new Date() });
      await expect(service.checkIn('u-member', { workspaceId: 'ws-1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('non-member cannot check in', async () => {
      await expect(service.checkIn('u-stranger', { workspaceId: 'ws-1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('check-out computes workMinutes from checkInAt', async () => {
      const checkInAt = new Date(Date.now() - 90 * 60000);
      prisma.attendance.findUnique.mockResolvedValue({ id: 'a-1', checkInAt, checkOutAt: null, note: 'n' });
      const res = await service.checkOut('u-member', { workspaceId: 'ws-1' });
      expect(res.workMinutes).toBe(90);
      expect(res.note).toBe('n');
    });

    it('check-out without check-in is rejected', async () => {
      await expect(service.checkOut('u-member', { workspaceId: 'ws-1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('getToday and myRange query own records', async () => {
      await service.getToday('u-member', 'ws-1');
      expect(prisma.attendance.findUnique.mock.calls[0][0].where.workspaceId_userId_date.userId).toBe(
        'u-member',
      );
      await service.myRange('u-member', 'ws-1', '2026-10-01', '2026-10-31');
      expect(prisma.attendance.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ workspaceId: 'ws-1', userId: 'u-member' }),
      );
    });

    it('workspaceReport: hr allowed, member forbidden', async () => {
      await expect(service.workspaceReport('u-hr', 'ws-1', '2026-10-01', '2026-10-31')).resolves.toEqual([]);
      await expect(
        service.workspaceReport('u-member', 'ws-1', '2026-10-01', '2026-10-31'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('leave', () => {
    it('createLeave creates a pending request and notifies approvers', async () => {
      const res = await service.createLeave('u-member', {
        workspaceId: 'ws-1',
        type: 'annual',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
      });
      expect(res.requesterId).toBe('u-member');
      expect(prisma.workspaceMember.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ role: { in: ['owner', 'admin', 'hr'] }, userId: { not: 'u-member' } }),
      );
      expect(notifications.create).toHaveBeenCalledTimes(2);
    });

    it('createLeave with end before start is rejected', async () => {
      await expect(
        service.createLeave('u-member', {
          workspaceId: 'ws-1',
          type: 'annual',
          startDate: '2026-11-03',
          endDate: '2026-11-02',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listLeaves: hr sees all, member sees only own', async () => {
      await service.listLeaves('u-hr', 'ws-1');
      expect(prisma.leaveRequest.findMany.mock.calls[0][0].where.requesterId).toBeUndefined();
      await service.listLeaves('u-member', 'ws-1', 'pending');
      expect(prisma.leaveRequest.findMany.mock.calls[1][0].where).toEqual(
        expect.objectContaining({ requesterId: 'u-member', status: 'pending' }),
      );
    });

    it('hr approves another member’s pending leave', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'l-1',
        workspaceId: 'ws-1',
        requesterId: 'u-member',
        status: 'pending',
      });
      const res = await service.decideLeave('u-hr', 'l-1', 'approved');
      expect(res).toEqual(expect.objectContaining({ id: 'l-1' }));
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-member', type: 'leave_approved' }),
      );
    });

    it('member without leave.approve cannot decide', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'l-1',
        workspaceId: 'ws-1',
        requesterId: 'u-hr',
        status: 'pending',
      });
      await expect(service.decideLeave('u-member', 'l-1', 'approved')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('deciding a non-pending leave is rejected; missing leave is 404', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        workspaceId: 'ws-1',
        requesterId: 'u-member',
        status: 'approved',
      });
      await expect(service.decideLeave('u-hr', 'l-1', 'rejected')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      prisma.leaveRequest.findUnique.mockResolvedValueOnce(null);
      await expect(service.decideLeave('u-hr', 'nope', 'approved')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('requester cancels own pending leave; others cannot', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'l-1',
        workspaceId: 'ws-1',
        requesterId: 'u-member',
        status: 'pending',
      });
      await expect(service.cancelLeave('u-hr', 'l-1')).rejects.toBeInstanceOf(ForbiddenException);
      await service.cancelLeave('u-member', 'l-1');
    });
  });
});
