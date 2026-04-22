import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { addRecurrence, RecurrenceRule } from '../common/recurrence';
import { AutomationEngine } from '../automation/automation.engine';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { extractMentionTokens, stripMentionTokensForPreview } from '../common/mentions.util';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private automation: AutomationEngine,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: string, dto: CreateTaskDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId, deletedAt: null },
    });
    if (!project) throw new NotFoundException('專案不存在');

    const column = await this.prisma.projectColumn.findUnique({
      where: { id: dto.columnId },
    });
    if (!column || column.projectId !== dto.projectId) {
      throw new NotFoundException('欄位不存在');
    }

    const taskCount = await this.prisma.task.count({
      where: { columnId: dto.columnId },
    });

    const task = await this.prisma.task.create({
      data: {
        projectId: dto.projectId,
        columnId: dto.columnId,
        title: dto.title,
        description: dto.description,
        priority: dto.priority || 'medium',
        assigneeId: dto.assigneeId,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        position: taskCount,
        recurrence: dto.recurrence ?? 'none',
        recurrenceInterval: dto.recurrenceInterval ?? 1,
      },
      include: {
        assignee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        tags: true,
      },
    });

    if (task.assigneeId && task.assigneeId !== userId) {
      await this.notifyAssigned(task.assigneeId, task.id, task.title, project.name);
    }

    return task;
  }

  async findByProject(userId: string, projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId, deletedAt: null },
      include: {
        assignee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        tags: true,
        subtasks: true,
        _count: { select: { comments: true, files: true } },
      },
      orderBy: { position: 'asc' },
    });
  }

  async findById(userId: string, id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id, deletedAt: null },
      include: {
        assignee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        tags: true,
        comments: {
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        subtasks: { orderBy: { position: 'asc' } },
        activities: {
          include: {
            user: { select: { id: true, username: true, displayName: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        files: true,
      },
    });
    if (!task) throw new NotFoundException('任務不存在');
    return task;
  }

  async update(userId: string, id: string, dto: UpdateTaskDto) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { project: { select: { name: true } } },
    });
    if (!task) throw new NotFoundException('任務不存在');

    const updateData: any = {
      title: dto.title,
      description: dto.description,
      priority: dto.priority,
      assigneeId: dto.assigneeId,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      recurrence: dto.recurrence,
      recurrenceInterval: dto.recurrenceInterval,
    };

    const transitioningToComplete =
      dto.completed === true && !task.completedAt;

    if (dto.completed !== undefined) {
      updateData.completedAt = dto.completed ? new Date() : null;
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: updateData,
      include: {
        assignee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        tags: true,
      },
    });

    await this.logActivity(id, userId, 'updated', dto);

    // P-14: 完成一張循環任務 → 自動生成下一張
    if (transitioningToComplete) {
      await this.spawnRecurringInstance(task);
    }

    // P-15: 派發自動化規則（task_completed 觸發）
    if (transitioningToComplete) {
      await this.automation.onTaskCompleted({
        id: task.id,
        projectId: task.projectId,
        title: updated.title,
        assigneeId: updated.assigneeId,
        dueDate: updated.dueDate,
      });
    }

    // 新指派通知（assignee 變更且非自己指派自己）
    const newAssignee = updated.assigneeId;
    if (newAssignee && newAssignee !== task.assigneeId && newAssignee !== userId) {
      await this.notifyAssigned(newAssignee, id, updated.title, task.project?.name ?? '');
    }

    return updated;
  }

  /**
   * P-14：從已完成的循環任務產生下一張。
   * 條件：recurrence ≠ 'none' 且有 dueDate（否則無從推算下期日期）。
   */
  private async spawnRecurringInstance(task: {
    id: string;
    projectId: string;
    columnId: string;
    title: string;
    description: string | null;
    priority: string;
    assigneeId: string | null;
    startDate: Date | null;
    dueDate: Date | null;
    recurrence: string;
    recurrenceInterval: number;
    recurringSourceId: string | null;
  }) {
    if (task.recurrence === 'none' || !task.dueDate) return null;

    const nextDue = addRecurrence(
      task.dueDate,
      task.recurrence as RecurrenceRule,
      task.recurrenceInterval,
    );

    let nextStart: Date | undefined;
    if (task.startDate && task.dueDate) {
      const offsetMs = task.startDate.getTime() - task.dueDate.getTime();
      nextStart = new Date(nextDue.getTime() + offsetMs);
    }

    const rootId = task.recurringSourceId ?? task.id;
    const siblingCount = await this.prisma.task.count({
      where: { columnId: task.columnId },
    });

    return this.prisma.task.create({
      data: {
        projectId: task.projectId,
        columnId: task.columnId,
        title: task.title,
        description: task.description ?? undefined,
        priority: task.priority,
        assigneeId: task.assigneeId ?? undefined,
        dueDate: nextDue,
        startDate: nextStart,
        position: siblingCount,
        recurrence: task.recurrence,
        recurrenceInterval: task.recurrenceInterval,
        recurringSourceId: rootId,
      },
    });
  }

  private async notifyAssigned(assigneeId: string, taskId: string, title: string, projectName: string) {
    await this.notifications.create({
      userId: assigneeId,
      type: 'task_assigned',
      title: `你被指派了新任務：${title}`,
      content: projectName ? `專案：${projectName}` : undefined,
      link: `/project/task/${taskId}`,
    });
  }

  async move(userId: string, id: string, columnId: string, position: number) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('任務不存在');

    // Reorder tasks in target column
    const tasksInColumn = await this.prisma.task.findMany({
      where: { columnId, id: { not: id }, deletedAt: null },
      orderBy: { position: 'asc' },
    });

    await this.prisma.$transaction([
      this.prisma.task.update({
        where: { id },
        data: { columnId, position },
      }),
      ...tasksInColumn.map((t: { id: string }, i: number) =>
        this.prisma.task.update({
          where: { id: t.id },
          data: { position: i >= position ? i + 1 : i },
        }),
      ),
    ]);

    await this.logActivity(id, userId, 'moved', { columnId, position });

    return this.prisma.task.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        tags: true,
      },
    });
  }

  async delete(userId: string, id: string) {
    return this.prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addComment(userId: string, taskId: string, content: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        project: { select: { workspaceId: true } },
      },
    });
    if (!task) throw new NotFoundException('任務不存在');

    const comment = await this.prisma.taskComment.create({
      data: { taskId, userId, content },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    await this.logActivity(taskId, userId, 'commented', { content });
    // Fire 提及通知（無 Mention row —— schema 的 Mention 綁 Message；只發 notification）
    await this.notifyMentions(
      taskId,
      task.title,
      task.projectId,
      task.project.workspaceId,
      content,
      userId,
      comment.user.displayName,
    );

    return comment;
  }

  /**
   * Task comment 的 @mention 通知。與 MessagesService.handleMentions 類似但：
   *   - 不建立 Mention 記錄（schema 的 Mention 目前只綁 Message）
   *   - 通知 link 指向 task detail
   * 若未來 schema 延伸支援 TaskComment mention，這裡可一併寫入 row。
   */
  private async notifyMentions(
    taskId: string,
    taskTitle: string,
    projectId: string,
    workspaceId: string,
    content: string,
    senderId: string,
    senderDisplayName: string,
  ) {
    const { structuredIds, usernames } = extractMentionTokens(content);
    if (structuredIds.length === 0 && usernames.length === 0) return;

    const structured = structuredIds.length === 0
      ? []
      : await this.prisma.user.findMany({
          where: {
            id: { in: structuredIds },
            workspaceMembers: { some: { workspaceId } },
          },
          select: { id: true },
        });
    const byName = usernames.length === 0
      ? []
      : await this.prisma.user.findMany({
          where: {
            username: { in: usernames },
            workspaceMembers: { some: { workspaceId } },
          },
          select: { id: true },
        });
    const userIds = Array.from(
      new Set([...structured.map((u) => u.id), ...byName.map((u) => u.id)]),
    );
    for (const uid of userIds) {
      if (uid === senderId) continue;
      await this.notifications.create({
        userId: uid,
        type: 'mention',
        title: `${senderDisplayName} 在任務「${taskTitle}」中提及你`,
        content: stripMentionTokensForPreview(content).slice(0, 140),
        link: `/projects/board/${projectId}/task/${taskId}`,
      });
    }
  }

  async addSubtask(taskId: string, title: string) {
    const count = await this.prisma.subtask.count({ where: { taskId } });
    return this.prisma.subtask.create({
      data: { taskId, title, position: count },
    });
  }

  async toggleSubtask(subtaskId: string) {
    const subtask = await this.prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!subtask) throw new NotFoundException('子任務不存在');
    return this.prisma.subtask.update({
      where: { id: subtaskId },
      data: { completed: !subtask.completed },
    });
  }

  private async logActivity(taskId: string, userId: string, action: string, details?: any) {
    return this.prisma.taskActivity.create({
      data: { taskId, userId, action, details },
    });
  }
}
