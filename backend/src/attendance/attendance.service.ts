import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { hasPermission } from '../common/permissions';
import { CheckInDto } from './dto/check-in.dto';
import { CreateLeaveDto } from './dto/leave-request.dto';

/**
 * 以「日」為單位記錄 [Attendance]。單日單筆，checkInAt/checkOutAt 兩次寫入。
 * `workMinutes` 僅在下班打卡時計算（checkOutAt - checkInAt）。
 */
@Injectable()
export class AttendanceService {
  constructor(
    private prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─────────── 打卡 ───────────

  async checkIn(userId: string, dto: CheckInDto) {
    await this.assertMember(userId, dto.workspaceId);
    const today = this.todayDate();

    const existing = await this.prisma.attendance.findUnique({
      where: { workspaceId_userId_date: { workspaceId: dto.workspaceId, userId, date: today } },
    });
    if (existing?.checkInAt) {
      throw new ForbiddenException('今日已打過上班卡');
    }

    const now = new Date();
    return this.prisma.attendance.upsert({
      where: { workspaceId_userId_date: { workspaceId: dto.workspaceId, userId, date: today } },
      create: {
        workspaceId: dto.workspaceId,
        userId,
        date: today,
        checkInAt: now,
        checkInLocation: dto.location,
        note: dto.note,
      },
      update: {
        checkInAt: now,
        checkInLocation: dto.location,
        note: dto.note,
      },
    });
  }

  async checkOut(userId: string, dto: CheckInDto) {
    await this.assertMember(userId, dto.workspaceId);
    const today = this.todayDate();

    const record = await this.prisma.attendance.findUnique({
      where: { workspaceId_userId_date: { workspaceId: dto.workspaceId, userId, date: today } },
    });
    if (!record?.checkInAt) {
      throw new ForbiddenException('尚未打上班卡，無法打下班卡');
    }
    if (record.checkOutAt) {
      throw new ForbiddenException('今日已打過下班卡');
    }

    const now = new Date();
    const minutes = Math.max(0, Math.round((now.getTime() - record.checkInAt.getTime()) / 60000));

    return this.prisma.attendance.update({
      where: { id: record.id },
      data: {
        checkOutAt: now,
        checkOutLocation: dto.location,
        workMinutes: minutes,
        note: dto.note ?? record.note,
      },
    });
  }

  async getToday(userId: string, workspaceId: string) {
    await this.assertMember(userId, workspaceId);
    return this.prisma.attendance.findUnique({
      where: {
        workspaceId_userId_date: {
          workspaceId,
          userId,
          date: this.todayDate(),
        },
      },
    });
  }

  async myRange(userId: string, workspaceId: string, from: string, to: string) {
    await this.assertMember(userId, workspaceId);
    return this.prisma.attendance.findMany({
      where: {
        workspaceId,
        userId,
        date: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: { date: 'desc' },
    });
  }

  async workspaceReport(userId: string, workspaceId: string, from: string, to: string) {
    await this.assertPermission(userId, workspaceId, 'attendance.report');
    return this.prisma.attendance.findMany({
      where: {
        workspaceId,
        date: { gte: new Date(from), lte: new Date(to) },
      },
      include: {
        user: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
      },
      orderBy: [{ date: 'desc' }, { userId: 'asc' }],
    });
  }

  // ─────────── 請假 ───────────

  async createLeave(userId: string, dto: CreateLeaveDto) {
    await this.assertMember(userId, dto.workspaceId);
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new ForbiddenException('結束日不可早於起始日');
    }
    const leave = await this.prisma.leaveRequest.create({
      data: {
        workspaceId: dto.workspaceId,
        requesterId: userId,
        type: dto.type,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        reason: dto.reason,
      },
    });

    // 找工作空間的 HR / admin 成員發通知
    const approvers = await this.prisma.workspaceMember.findMany({
      where: {
        workspaceId: dto.workspaceId,
        role: { in: ['owner', 'admin', 'hr'] },
        userId: { not: userId },
      },
      select: { userId: true },
    });
    for (const a of approvers) {
      await this.notifications.create({
        userId: a.userId,
        type: 'leave_pending',
        title: `待審核請假：${dto.type}`,
        content: `${dto.startDate} ~ ${dto.endDate}`,
        link: `/attendance/leaves/${leave.id}`,
      });
    }
    return leave;
  }

  async listLeaves(userId: string, workspaceId: string, status?: string) {
    const role = await this.assertMember(userId, workspaceId);
    const canReadAll = hasPermission(role, 'leave.approve');
    return this.prisma.leaveRequest.findMany({
      where: {
        workspaceId,
        ...(status ? { status } : {}),
        ...(canReadAll ? {} : { requesterId: userId }),
      },
      include: {
        requester: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        approver: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async decideLeave(userId: string, id: string, decision: 'approved' | 'rejected', reason?: string) {
    const leave = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) throw new NotFoundException('請假單不存在');
    await this.assertPermission(userId, leave.workspaceId, 'leave.approve');
    if (leave.status !== 'pending') {
      throw new ForbiddenException(`無法審核：目前狀態為 ${leave.status}`);
    }

    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: decision,
        approverId: userId,
        decidedAt: new Date(),
        rejectReason: decision === 'rejected' ? reason ?? null : null,
      },
      include: {
        requester: { select: { id: true, displayName: true } },
      },
    });

    await this.notifications.create({
      userId: leave.requesterId,
      type: decision === 'approved' ? 'leave_approved' : 'leave_rejected',
      title: decision === 'approved' ? `請假已核准` : `請假已退回`,
      content: reason,
      link: `/attendance/leaves/${id}`,
    });

    return updated;
  }

  async cancelLeave(userId: string, id: string) {
    const leave = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) throw new NotFoundException('請假單不存在');
    if (leave.requesterId !== userId) {
      throw new ForbiddenException('僅能取消自己的請假申請');
    }
    if (leave.status !== 'pending') {
      throw new ForbiddenException('僅能取消待審核的請假');
    }
    return this.prisma.leaveRequest.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }

  // ─────────── helpers ───────────

  private todayDate(): Date {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
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
