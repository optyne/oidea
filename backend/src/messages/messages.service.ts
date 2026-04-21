import {
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  forwardRef,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { BroadcastMessageDto } from './dto/broadcast-message.dto';
import { ConvertMessageToTaskDto } from './dto/convert-to-task.dto';
import { MessagesGateway } from './messages.gateway';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MessagesGateway))
    private readonly messagesGateway: MessagesGateway,
  ) {}

  async create(userId: string, dto: CreateMessageDto) {
    const channelMember = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: dto.channelId, userId } },
    });
    if (!channelMember) throw new ForbiddenException('非此頻道成員');

    const message = await this.prisma.message.create({
      data: {
        channelId: dto.channelId,
        senderId: userId,
        parentId: dto.parentId,
        type: dto.type || 'text',
        content: dto.content,
        metadata: dto.metadata,
      },
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        reactions: true,
        _count: { select: { replies: true } },
      },
    });

    this.messagesGateway.emitNewMessage(dto.channelId, message);
    return message;
  }

  /**
   * C-16：一次把同樣內容發到多個頻道。
   *
   * 全有全無：任一頻道不存在 / 使用者非成員 / 跨 workspace → 整批拒絕。
   * 寫入用 $transaction 保原子性；成功後對每個頻道 emit WS 事件。
   *
   * 回傳 { broadcastId, messages }，前端可用 broadcastId 做聚合檢視。
   */
  async broadcast(userId: string, dto: BroadcastMessageDto) {
    const channelIds = Array.from(new Set(dto.channelIds));
    if (channelIds.length === 0) {
      throw new BadRequestException('channelIds 不可為空');
    }

    const channels = await this.prisma.channel.findMany({
      where: { id: { in: channelIds }, deletedAt: null },
      select: { id: true, workspaceId: true, members: { where: { userId }, select: { userId: true } } },
    });

    if (channels.length !== channelIds.length) {
      throw new NotFoundException('部分頻道不存在或已刪除');
    }

    const workspaceIds = new Set(channels.map((c) => c.workspaceId));
    if (workspaceIds.size > 1) {
      throw new BadRequestException('廣播範圍需在同一工作空間內');
    }

    const nonMember = channels.find((c) => c.members.length === 0);
    if (nonMember) {
      throw new ForbiddenException(`非頻道成員：${nonMember.id}`);
    }

    const broadcastId = randomUUID();
    const messages = await this.prisma.$transaction(
      channelIds.map((channelId) =>
        this.prisma.message.create({
          data: {
            channelId,
            senderId: userId,
            broadcastId,
            type: dto.type || 'text',
            content: dto.content,
            metadata: dto.metadata,
          },
          include: {
            sender: {
              select: { id: true, username: true, displayName: true, avatarUrl: true },
            },
            reactions: true,
            _count: { select: { replies: true } },
          },
        }),
      ),
    );

    for (const message of messages) {
      this.messagesGateway.emitNewMessage(message.channelId, message);
    }

    return { broadcastId, messages };
  }

  async findByChannel(userId: string, channelId: string, cursor?: string, limit: number = 50) {
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (!member) throw new ForbiddenException('非此頻道成員');

    const where: any = { channelId, deletedAt: null, parentId: null };
    if (cursor) {
      where.createdAt = { lt: new Date(cursor) };
    }

    return this.prisma.message.findMany({
      where,
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        reactions: true,
        _count: { select: { replies: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async findThread(userId: string, parentId: string, cursor?: string, limit: number = 50) {
    const parentMessage = await this.prisma.message.findUnique({
      where: { id: parentId, deletedAt: null },
    });
    if (!parentMessage) throw new NotFoundException('訊息不存在');

    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: parentMessage.channelId, userId } },
    });
    if (!member) throw new ForbiddenException('非此頻道成員');

    const where: any = { parentId, deletedAt: null };
    if (cursor) {
      where.createdAt = { lt: new Date(cursor) };
    }

    return this.prisma.message.findMany({
      where,
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        reactions: true,
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async update(userId: string, messageId: string, content: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundException('訊息不存在');
    if (message.senderId !== userId) throw new ForbiddenException('僅能編輯自己的訊息');

    return this.prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    });
  }

  async delete(userId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundException('訊息不存在');
    if (message.senderId !== userId) throw new ForbiddenException('僅能刪除自己的訊息');

    return this.prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });
  }

  async addReaction(userId: string, messageId: string, emoji: string) {
    return this.prisma.messageReaction.create({
      data: { messageId, userId, emoji },
    });
  }

  async removeReaction(userId: string, messageId: string, emoji: string) {
    return this.prisma.messageReaction.delete({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
  }

  /**
   * C-18：把一則訊息轉成 Task。
   *
   * 權限：訊息的頻道成員才可轉；目標 project 必須同 workspace；
   * 如指定 assignee，對方需為同 workspace 成員。
   *
   * 預設：
   *   - title = message.content 前 100 字 (無內容 → '（空訊息）')
   *   - description = 完整 content
   *   - priority = 'medium'
   * 全部可被 dto 覆蓋。建立的 Task.sourceMessageId 指向原訊息。
   */
  async convertToTask(
    userId: string,
    messageId: string,
    dto: ConvertMessageToTaskDto,
  ) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { channel: { select: { workspaceId: true } } },
    });
    if (!message || message.deletedAt) {
      throw new NotFoundException('訊息不存在');
    }

    const channelMember = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: message.channelId, userId } },
    });
    if (!channelMember) throw new ForbiddenException('非此頻道成員');

    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
    });
    if (!project || project.deletedAt) {
      throw new NotFoundException('專案不存在');
    }
    if (project.workspaceId !== message.channel.workspaceId) {
      throw new BadRequestException('專案必須與訊息在同一工作空間');
    }

    const column = await this.prisma.projectColumn.findUnique({
      where: { id: dto.columnId },
    });
    if (!column) throw new NotFoundException('看板欄位不存在');
    if (column.projectId !== dto.projectId) {
      throw new BadRequestException('看板欄位不屬於指定專案');
    }

    if (dto.assigneeId) {
      const assignee = await this.prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: project.workspaceId,
            userId: dto.assigneeId,
          },
        },
      });
      if (!assignee) throw new BadRequestException('指派對象非此工作空間成員');
    }

    const raw = message.content ?? '';
    const defaultTitle = raw.trim().slice(0, 100) || '（空訊息）';

    return this.prisma.task.create({
      data: {
        projectId: dto.projectId,
        columnId: dto.columnId,
        title: dto.title ?? defaultTitle,
        description: dto.description ?? (raw || undefined),
        priority: dto.priority ?? 'medium',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        assigneeId: dto.assigneeId,
        sourceMessageId: messageId,
      },
    });
  }

  async search(userId: string, channelId: string, query: string) {
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (!member) throw new ForbiddenException('非此頻道成員');

    return this.prisma.message.findMany({
      where: {
        channelId,
        content: { contains: query, mode: 'insensitive' },
        deletedAt: null,
      },
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
