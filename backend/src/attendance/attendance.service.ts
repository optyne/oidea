import { BadRequestException, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { hasPermission } from '../common/permissions';
import { CheckInDto } from './dto/check-in.dto';
import { CreateLeaveDto, LeavePreviewQuery } from './dto/leave-request.dto';
import { LOCKED_TX_OPTIONS } from '../common/identity-lock';
import { leaveErrors, parseLeaveRange, toNumber } from './leave-days';
import { LeavePolicyService } from './leave-policy.service';

/** 回應裡的 `days` 是 number（Prisma 的 Decimal 直接序列化會變成字串）。 */
function serializeLeave<T extends { days?: unknown }>(row: T): T & { days: number } {
  return { ...row, days: toNumber(row.days) };
}

/**
 * 以「日」為單位記錄 [Attendance]。單日單筆，checkInAt/checkOutAt 兩次寫入。
 * `workMinutes` 僅在下班打卡時計算（checkOutAt - checkInAt）。
 */
@Injectable()
export class AttendanceService {
  constructor(
    private prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly leavePolicy: LeavePolicyService,
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

  /**
   * H3：算天數（不含週末、假日，可半天）、擋自己 pending／approved 假單的重疊、公司工作空間的特休檢查餘額。
   * 檢查與寫入在同一個交易、requester 的鎖底下（公司特休：profile 鎖 → user 鎖，見 lockForCreate）：
   * 同一個人同時送出的兩張假單排隊，後到的看得到先到的（重疊、已用掉的特休）；改到職日也跟特休排隊。
   */
  async createLeave(userId: string, dto: CreateLeaveDto) {
    await this.assertMember(userId, dto.workspaceId);
    const range = parseLeaveRange(dto);
    const leave = await this.prisma.$transaction(async (tx) => {
      await this.leavePolicy.lockForCreate(tx, userId, dto.workspaceId, dto.type);
      const { days, annual } = await this.leavePolicy.evaluate(tx, userId, dto.workspaceId, dto.type, range);
      if (annual && annual.remaining < days) throw leaveErrors.insufficientBalance(annual.remaining);
      return tx.leaveRequest.create({
        data: {
          workspaceId: dto.workspaceId,
          requesterId: userId,
          type: dto.type,
          startDate: range.start,
          endDate: range.end,
          startPart: range.startPart,
          endPart: range.endPart,
          days,
          reason: dto.reason,
        },
      });
    }, LOCKED_TX_OPTIONS);

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
        content: `${dto.startDate} ~ ${dto.endDate}（${toNumber(leave.days)} 天）`,
        link: `/attendance/leaves/${leave.id}`,
      });
    }
    return serializeLeave(leave);
  }

  /** 不寫入的試算：跟建立一樣的檢查（含重疊），但餘額不足照樣回報 remaining。 */
  async previewLeave(userId: string, q: LeavePreviewQuery) {
    await this.assertMember(userId, q.workspaceId);
    const range = parseLeaveRange(q);
    return this.leavePolicy.evaluate(this.prisma, userId, q.workspaceId, q.type, range);
  }

  async myAnnualBalance(userId: string, workspaceId: string) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new BadRequestException('缺少 workspaceId');
    await this.assertMember(userId, workspaceId);
    return this.leavePolicy.myCurrentBalance(userId, workspaceId);
  }

  async listLeaves(userId: string, workspaceId: string, status?: string) {
    const role = await this.assertMember(userId, workspaceId);
    const canReadAll = hasPermission(role, 'leave.approve');
    const rows = await this.prisma.leaveRequest.findMany({
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
    return rows.map(serializeLeave);
  }

  async decideLeave(userId: string, id: string, decision: 'approved' | 'rejected', reason?: string) {
    const leave = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) throw new NotFoundException('請假單不存在');
    await this.assertPermission(userId, leave.workspaceId, 'leave.approve');
    if (leave.requesterId === userId) {
      throw new ForbiddenException('不可審核自己的請假');
    }
    if (leave.status !== 'pending') {
      throw new ForbiddenException(`無法審核：目前狀態為 ${leave.status}`);
    }

    // 條件式更新：只有仍是 pending 的那一筆會被改；兩個審核同時送出時只有一個成功。
    const { count } = await this.prisma.leaveRequest.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: decision,
        approverId: userId,
        decidedAt: new Date(),
        rejectReason: decision === 'rejected' ? reason ?? null : null,
      },
    });
    if (count === 0) {
      throw new ForbiddenException('無法審核：此請假已被其他人處理');
    }
    const updated = await this.prisma.leaveRequest.findUnique({
      where: { id },
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

    return updated ? serializeLeave(updated) : updated;
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
    // 條件式更新：避免取消覆蓋掉同時發生的核准／退回。
    const { count } = await this.prisma.leaveRequest.updateMany({
      where: { id, requesterId: userId, status: 'pending' },
      data: { status: 'cancelled' },
    });
    if (count === 0) {
      throw new ForbiddenException('僅能取消待審核的請假');
    }
    return serializeLeave({ ...leave, status: 'cancelled' });
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
