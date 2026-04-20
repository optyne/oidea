import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { hasPermission } from '../common/permissions';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private senderInclude() {
    return {
      submitter: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      approvals: {
        include: {
          approver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
        orderBy: { decidedAt: 'desc' as const },
      },
      receipts: true,
    };
  }

  async create(userId: string, dto: CreateExpenseDto) {
    await this.assertMember(userId, dto.workspaceId);
    return this.prisma.expense.create({
      data: {
        workspaceId: dto.workspaceId,
        submitterId: userId,
        title: dto.title,
        amount: dto.amount as any,
        currency: dto.currency ?? 'TWD',
        category: dto.category ?? 'other',
        description: dto.description,
        incurredAt: dto.incurredAt ? new Date(dto.incurredAt) : new Date(),
      },
      include: this.senderInclude(),
    });
  }

  /**
   * 以工作空間列出報銷。有 `expense.read_all` 權限者看全部；否則只看自己送的。
   */
  async list(userId: string, workspaceId: string, status?: string) {
    const role = await this.assertMember(userId, workspaceId);
    const canReadAll = hasPermission(role, 'expense.read_all');

    return this.prisma.expense.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(status ? { status } : {}),
        ...(canReadAll ? {} : { submitterId: userId }),
      },
      include: this.senderInclude(),
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id, deletedAt: null },
      include: this.senderInclude(),
    });
    if (!expense) throw new NotFoundException('報銷單不存在');

    const role = await this.assertMember(userId, expense.workspaceId);
    const canReadAll = hasPermission(role, 'expense.read_all');
    if (!canReadAll && expense.submitterId !== userId) {
      throw new ForbiddenException('無權檢視此報銷單');
    }
    return expense;
  }

  async approve(userId: string, id: string, comment?: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('報銷單不存在');
    await this.assertPermission(userId, expense.workspaceId, 'expense.approve');
    if (expense.status !== 'pending') {
      throw new ForbiddenException(`無法審核：目前狀態為 ${expense.status}`);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.expense.update({
        where: { id },
        data: { status: 'approved' },
        include: this.senderInclude(),
      }),
      this.prisma.expenseApproval.create({
        data: { expenseId: id, approverId: userId, decision: 'approved', comment },
      }),
    ]);

    await this.notifications.create({
      userId: expense.submitterId,
      type: 'expense_approved',
      title: `報銷已核准：${expense.title}`,
      content: comment,
      link: `/expenses/${id}`,
    });

    return updated;
  }

  async reject(userId: string, id: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new ForbiddenException('拒絕必須附上原因');
    }
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('報銷單不存在');
    await this.assertPermission(userId, expense.workspaceId, 'expense.approve');
    if (expense.status !== 'pending') {
      throw new ForbiddenException(`無法拒絕：目前狀態為 ${expense.status}`);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.expense.update({
        where: { id },
        data: { status: 'rejected', rejectReason: reason },
        include: this.senderInclude(),
      }),
      this.prisma.expenseApproval.create({
        data: { expenseId: id, approverId: userId, decision: 'rejected', comment: reason },
      }),
    ]);

    await this.notifications.create({
      userId: expense.submitterId,
      type: 'expense_rejected',
      title: `報銷已退回：${expense.title}`,
      content: reason,
      link: `/expenses/${id}`,
    });

    return updated;
  }

  async markPaid(userId: string, id: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('報銷單不存在');
    await this.assertPermission(userId, expense.workspaceId, 'expense.mark_paid');
    if (expense.status !== 'approved') {
      throw new ForbiddenException(`僅能為已核准的報銷單標記付款`);
    }

    const updated = await this.prisma.expense.update({
      where: { id },
      data: { status: 'paid', paidAt: new Date(), paidBy: userId },
      include: this.senderInclude(),
    });

    await this.notifications.create({
      userId: expense.submitterId,
      type: 'expense_paid',
      title: `報銷已付款：${expense.title}`,
      link: `/expenses/${id}`,
    });

    return updated;
  }

  async cancel(userId: string, id: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('報銷單不存在');
    if (expense.submitterId !== userId) {
      throw new ForbiddenException('僅能取消自己送出的報銷單');
    }
    if (expense.status !== 'pending') {
      throw new ForbiddenException('僅能取消尚未審核的報銷單');
    }

    return this.prisma.expense.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addReceipt(
    userId: string,
    id: string,
    data: { fileName: string; fileType: string; fileSize: number; url: string },
  ) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('報銷單不存在');
    if (expense.submitterId !== userId) {
      throw new ForbiddenException('僅能為自己的報銷單附加發票');
    }
    return this.prisma.expenseReceipt.create({ data: { expenseId: id, ...data } });
  }

  async stats(userId: string, workspaceId: string) {
    const role = await this.assertMember(userId, workspaceId);
    const canReadAll = hasPermission(role, 'expense.read_all');
    const base = {
      workspaceId,
      deletedAt: null,
      ...(canReadAll ? {} : { submitterId: userId }),
    };
    const [pending, approved, paid, rejected] = await Promise.all([
      this.prisma.expense.aggregate({
        where: { ...base, status: 'pending' },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.expense.aggregate({
        where: { ...base, status: 'approved' },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.expense.aggregate({
        where: { ...base, status: 'paid' },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.expense.count({ where: { ...base, status: 'rejected' } }),
    ]);
    return {
      pending: { count: pending._count, amount: pending._sum.amount ?? 0 },
      approved: { count: approved._count, amount: approved._sum.amount ?? 0 },
      paid: { count: paid._count, amount: paid._sum.amount ?? 0 },
      rejected: { count: rejected },
    };
  }

  private async assertMember(userId: string, workspaceId: string): Promise<string> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
    return member.role;
  }

  private async assertPermission(userId: string, workspaceId: string, key: string) {
    const role = await this.assertMember(userId, workspaceId);
    if (!hasPermission(role, key)) {
      throw new ForbiddenException(`權限不足：需要 ${key}`);
    }
  }
}
