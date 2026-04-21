import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  CreateReminderDto,
  REMINDER_TARGET_TYPES,
} from './dto/create-reminder.dto';
import { UpdateReminderDto } from './dto/update-reminder.dto';
import {
  addRecurrence,
  RECURRENCE_RULES,
  RecurrenceRule,
} from '../common/recurrence';

@Injectable()
export class RemindersService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateReminderDto) {
    await this.assertWorkspaceMember(userId, dto.workspaceId);
    this.validateRecurrence(dto.recurrence, dto.recurrenceInterval);
    this.validateTarget(dto.targetType, dto.targetId);

    const triggerAt = new Date(dto.triggerAt);
    if (Number.isNaN(triggerAt.getTime())) {
      throw new BadRequestException('triggerAt 需為合法日期');
    }

    return this.prisma.reminder.create({
      data: {
        workspaceId: dto.workspaceId,
        userId,
        title: dto.title,
        notes: dto.notes,
        targetType: dto.targetType,
        targetId: dto.targetId,
        triggerAt,
        nextFireAt: triggerAt,
        recurrence: dto.recurrence ?? 'none',
        recurrenceInterval: dto.recurrenceInterval ?? 1,
      },
    });
  }

  async findByWorkspace(
    userId: string,
    workspaceId: string,
    opts: { includeCompleted?: boolean } = {},
  ) {
    await this.assertWorkspaceMember(userId, workspaceId);
    return this.prisma.reminder.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(opts.includeCompleted ? {} : { status: { not: 'completed' } }),
      },
      orderBy: { nextFireAt: 'asc' },
    });
  }

  async findById(userId: string, id: string) {
    const reminder = await this.loadReminderOrThrow(id);
    await this.assertWorkspaceMember(userId, reminder.workspaceId);
    return reminder;
  }

  async update(userId: string, id: string, dto: UpdateReminderDto) {
    const reminder = await this.loadReminderOrThrow(id);
    await this.assertWorkspaceMember(userId, reminder.workspaceId);

    const nextRecurrence = dto.recurrence ?? reminder.recurrence;
    const nextInterval = dto.recurrenceInterval ?? reminder.recurrenceInterval;
    this.validateRecurrence(nextRecurrence as RecurrenceRule, nextInterval);

    const nextTrigger = dto.triggerAt
      ? new Date(dto.triggerAt)
      : reminder.triggerAt;
    if (Number.isNaN(nextTrigger.getTime())) {
      throw new BadRequestException('triggerAt 需為合法日期');
    }

    return this.prisma.reminder.update({
      where: { id },
      data: {
        title: dto.title,
        notes: dto.notes,
        triggerAt: nextTrigger,
        nextFireAt: nextTrigger,
        recurrence: nextRecurrence,
        recurrenceInterval: nextInterval,
      },
    });
  }

  async pause(userId: string, id: string) {
    const reminder = await this.loadReminderOrThrow(id);
    await this.assertWorkspaceMember(userId, reminder.workspaceId);
    return this.prisma.reminder.update({
      where: { id },
      data: { status: 'paused' },
    });
  }

  async resume(userId: string, id: string) {
    const reminder = await this.loadReminderOrThrow(id);
    await this.assertWorkspaceMember(userId, reminder.workspaceId);
    if (reminder.status === 'completed') {
      throw new BadRequestException('已完成的提醒無法恢復，請重建');
    }
    return this.prisma.reminder.update({
      where: { id },
      data: { status: 'active' },
    });
  }

  async complete(userId: string, id: string) {
    const reminder = await this.loadReminderOrThrow(id);
    await this.assertWorkspaceMember(userId, reminder.workspaceId);
    return this.prisma.reminder.update({
      where: { id },
      data: { status: 'completed' },
    });
  }

  async remove(userId: string, id: string) {
    const reminder = await this.loadReminderOrThrow(id);
    await this.assertWorkspaceMember(userId, reminder.workspaceId);
    return this.prisma.reminder.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * 排程器觸發後呼叫：
   *   - 非 recurring → status = completed
   *   - recurring    → 推進 nextFireAt，更新 lastFiredAt
   */
  async advance(id: string, firedAt: Date = new Date()) {
    const reminder = await this.loadReminderOrThrow(id);
    if (reminder.status !== 'active') {
      throw new BadRequestException('僅 active 提醒可 advance');
    }

    if (reminder.recurrence === 'none') {
      return this.prisma.reminder.update({
        where: { id },
        data: { lastFiredAt: firedAt, status: 'completed' },
      });
    }

    const next = addRecurrence(
      reminder.nextFireAt,
      reminder.recurrence as RecurrenceRule,
      reminder.recurrenceInterval,
    );
    return this.prisma.reminder.update({
      where: { id },
      data: { lastFiredAt: firedAt, nextFireAt: next },
    });
  }

  // ---------- 內部工具 ----------

  private async assertWorkspaceMember(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
  }

  private async loadReminderOrThrow(id: string) {
    const reminder = await this.prisma.reminder.findUnique({ where: { id } });
    if (!reminder || reminder.deletedAt) {
      throw new NotFoundException('提醒不存在');
    }
    return reminder;
  }

  private validateRecurrence(
    rule: RecurrenceRule | undefined,
    interval: number | undefined,
  ) {
    const r = rule ?? 'none';
    if (!RECURRENCE_RULES.includes(r)) {
      throw new BadRequestException(`不支援的 recurrence：${r}`);
    }
    if (interval !== undefined && interval < 1) {
      throw new BadRequestException('recurrenceInterval 需 >= 1');
    }
  }

  private validateTarget(
    targetType: string | undefined,
    targetId: string | undefined,
  ) {
    if (targetType && !REMINDER_TARGET_TYPES.includes(targetType as any)) {
      throw new BadRequestException(`不支援的 targetType：${targetType}`);
    }
    if (targetType && !targetId) {
      throw new BadRequestException('targetType 需搭配 targetId');
    }
    if (!targetType && targetId) {
      throw new BadRequestException('targetId 需搭配 targetType');
    }
  }
}
