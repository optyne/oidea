import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { addRecurrence, RecurrenceRule } from '../common/recurrence';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

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

    return this.prisma.task.create({
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
    const task = await this.prisma.task.findUnique({ where: { id } });
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

    return updated;
  }

  /**
   * P-14：從已完成的循環任務產生下一張。
   * 條件：recurrence ≠ 'none' 且有 dueDate（否則無從推算下期日期）。
   * 新任務 inherit title / description / priority / assignee / 循環規則；
   * completedAt = null，dueDate 為推進後日期。
   *
   * `recurringSourceId` 一律指向序列的「根」任務：
   *   - 若原任務有 recurringSourceId → 沿用
   *   - 否則 → 用原任務的 id (本張就是根)
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
      ...tasksInColumn.map((t, i) =>
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
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('任務不存在');

    const comment = await this.prisma.taskComment.create({
      data: { taskId, userId, content },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    await this.logActivity(taskId, userId, 'commented', { content });

    return comment;
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
