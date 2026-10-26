import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Characterization tests for the current happy paths of ExpensesService
 * (written before the H0 security changes; kept green afterwards).
 */
describe('ExpensesService — characterization', () => {
  let service: ExpensesService;
  let prisma: any;
  let notifications: { create: jest.Mock };
  let roles: Record<string, string>;
  let current: any;

  beforeEach(async () => {
    roles = { 'u-member': 'member', 'u-fin': 'finance', 'u-admin': 'admin', 'u-hr': 'hr' };
    current = {
      id: 'e-1',
      workspaceId: 'ws-1',
      submitterId: 'u-member',
      title: 'taxi',
      status: 'pending',
    };
    prisma = {
      workspaceMember: {
        findUnique: jest.fn(async ({ where }: any) => {
          const { workspaceId, userId } = where.workspaceId_userId;
          if (workspaceId !== 'ws-1' || !roles[userId]) return null;
          return { role: roles[userId] };
        }),
      },
      expense: {
        create: jest.fn(async ({ data }: any) => ({ id: 'e-new', status: 'pending', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(async () => (current ? { ...current } : null)),
        update: jest.fn(async ({ where, data }: any) => ({ ...current, id: where.id, ...data })),
        updateMany: jest.fn(async ({ data }: any) => {
          current = { ...current, ...data };
          return { count: 1 };
        }),
        aggregate: jest.fn().mockResolvedValue({ _count: 2, _sum: { amount: 100 } }),
        count: jest.fn().mockResolvedValue(1),
      },
      expenseApproval: { create: jest.fn().mockResolvedValue({ id: 'ap-1' }) },
      expenseReceipt: { create: jest.fn(async ({ data }: any) => ({ id: 'r-1', ...data })) },
      $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpensesService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(ExpensesService);
  });

  it('member creates an expense with defaults (TWD, other)', async () => {
    const res = await service.create('u-member', { workspaceId: 'ws-1', title: 'taxi', amount: 120 } as any);
    expect(res).toEqual(
      expect.objectContaining({ submitterId: 'u-member', currency: 'TWD', category: 'other' }),
    );
  });

  it('non-member cannot create', async () => {
    await expect(
      service.create('u-x', { workspaceId: 'ws-1', title: 't', amount: 1 } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('list: finance reads all, member reads own', async () => {
    await service.list('u-fin', 'ws-1');
    expect(prisma.expense.findMany.mock.calls[0][0].where.submitterId).toBeUndefined();
    await service.list('u-member', 'ws-1', 'pending');
    expect(prisma.expense.findMany.mock.calls[1][0].where).toEqual(
      expect.objectContaining({ submitterId: 'u-member', status: 'pending' }),
    );
  });

  it('findById: submitter and finance may read, other member may not', async () => {
    await expect(service.findById('u-member', 'e-1')).resolves.toEqual(expect.objectContaining({ id: 'e-1' }));
    await expect(service.findById('u-fin', 'e-1')).resolves.toEqual(expect.objectContaining({ id: 'e-1' }));
    roles['u-other'] = 'member';
    await expect(service.findById('u-other', 'e-1')).rejects.toBeInstanceOf(ForbiddenException);
    current = null;
    await expect(service.findById('u-fin', 'e-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('finance approves a pending expense: approval row + notification', async () => {
    const res = await service.approve('u-fin', 'e-1', 'ok');
    expect(res).toEqual(expect.objectContaining({ id: 'e-1', status: 'approved' }));
    expect(prisma.expenseApproval.create).toHaveBeenCalledWith({
      data: { expenseId: 'e-1', approverId: 'u-fin', decision: 'approved', comment: 'ok' },
    });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-member', type: 'expense_approved' }),
    );
  });

  it('submitter cannot approve own expense; member/hr lack expense.approve', async () => {
    current.submitterId = 'u-fin';
    await expect(service.approve('u-fin', 'e-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.approve('u-member', 'e-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.approve('u-hr', 'e-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reject requires a reason and sets rejectReason', async () => {
    await expect(service.reject('u-fin', 'e-1', '  ')).rejects.toBeInstanceOf(ForbiddenException);
    const res = await service.reject('u-fin', 'e-1', 'no receipt');
    expect(res).toEqual(expect.objectContaining({ status: 'rejected', rejectReason: 'no receipt' }));
  });

  it('markPaid only for approved expenses', async () => {
    await expect(service.markPaid('u-fin', 'e-1')).rejects.toBeInstanceOf(ForbiddenException);
    current.status = 'approved';
    const res = await service.markPaid('u-fin', 'e-1');
    expect(res).toEqual(expect.objectContaining({ status: 'paid', paidBy: 'u-fin' }));
  });

  it('cancel: own pending expense is soft-deleted', async () => {
    roles['u-other'] = 'member';
    await expect(service.cancel('u-other', 'e-1')).rejects.toBeInstanceOf(ForbiddenException);
    const res = await service.cancel('u-member', 'e-1');
    expect(res.deletedAt).toBeInstanceOf(Date);
  });

  it('addReceipt only by submitter', async () => {
    const data = { fileName: 'a.png', fileType: 'image/png', fileSize: 1, url: 'x' };
    await expect(service.addReceipt('u-fin', 'e-1', data)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.addReceipt('u-member', 'e-1', data)).resolves.toEqual(
      expect.objectContaining({ expenseId: 'e-1', fileName: 'a.png' }),
    );
  });

  it('stats aggregates by status', async () => {
    const res = await service.stats('u-fin', 'ws-1');
    expect(res).toEqual({
      pending: { count: 2, amount: 100 },
      approved: { count: 2, amount: 100 },
      paid: { count: 2, amount: 100 },
      rejected: { count: 1 },
    });
  });

  describe('H0: concurrent decisions use conditional updates', () => {
    beforeEach(() => {
      prisma.expense.updateMany.mockImplementation(async ({ where, data }: any) => {
        const match =
          where.id === current.id &&
          (where.status === undefined || where.status === current.status) &&
          (where.deletedAt === undefined || (current.deletedAt ?? null) === where.deletedAt) &&
          (where.submitterId === undefined || where.submitterId === current.submitterId);
        if (!match) return { count: 0 };
        current = { ...current, ...data };
        return { count: 1 };
      });
    });

    it('two concurrent approvals: exactly one succeeds and only one approval row is written', async () => {
      roles['u-fin2'] = 'finance';
      const results = await Promise.allSettled([
        service.approve('u-fin', 'e-1'),
        service.approve('u-fin2', 'e-1'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(ForbiddenException);
      expect(String(failed.reason.message)).toMatch(/已被其他人處理/);
      expect(prisma.expenseApproval.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('approve vs reject race: one wins', async () => {
      const results = await Promise.allSettled([
        service.approve('u-fin', 'e-1'),
        service.reject('u-admin', 'e-1', 'dup'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(prisma.expenseApproval.create).toHaveBeenCalledTimes(1);
    });

    it('double markPaid: exactly one succeeds', async () => {
      current.status = 'approved';
      const results = await Promise.allSettled([
        service.markPaid('u-fin', 'e-1'),
        service.markPaid('u-admin', 'e-1'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(current.paidBy === 'u-fin' || current.paidBy === 'u-admin').toBe(true);
    });

    it('cancel racing an approval: exactly one wins and the state is consistent', async () => {
      const [approve, cancel] = await Promise.allSettled([
        service.approve('u-fin', 'e-1'),
        service.cancel('u-member', 'e-1'),
      ]);
      expect([approve.status, cancel.status].sort()).toEqual(['fulfilled', 'rejected']);
      if (approve.status === 'fulfilled') {
        expect(current.deletedAt).toBeUndefined();
        expect(current.status).toBe('approved');
      } else {
        expect(current.deletedAt).toBeInstanceOf(Date);
        expect(current.status).toBe('pending');
        expect(prisma.expenseApproval.create).not.toHaveBeenCalled();
      }
    });
  });
});
