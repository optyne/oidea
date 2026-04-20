import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
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
    };

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

    const newAssignee = updated.assigneeId;
    if (newAssignee && newAssignee !== task.assigneeId && newAssignee !== userId) {
      await this.notifyAssigned(newAssignee, id, updated.title, task.project?.name ?? '');
    }

    return updated;
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
