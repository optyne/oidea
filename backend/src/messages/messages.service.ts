import { Inject, Injectable, NotFoundException, ForbiddenException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { MessagesGateway } from './messages.gateway';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MessagesGateway))
    private readonly messagesGateway: MessagesGateway,
    private readonly notifications: NotificationsService,
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

    await this.handleMentions(message.id, dto.channelId, dto.content, userId, message.sender.displayName);

    this.messagesGateway.emitNewMessage(dto.channelId, message);
    return message;
  }

  /** 解析 `@username` 並建立 Mention 記錄與通知。解析範圍限於同工作空間成員。 */
  private async handleMentions(
    messageId: string,
    channelId: string,
    content: string | null | undefined,
    senderId: string,
    senderDisplayName: string,
  ) {
    if (!content) return;
    const usernames = Array.from(
      new Set(Array.from(content.matchAll(/@([A-Za-z0-9_]{2,32})/g), (m) => m[1])),
    );
    if (usernames.length === 0) return;

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true, name: true },
    });
    if (!channel) return;

    const users = await this.prisma.user.findMany({
      where: {
        username: { in: usernames },
        workspaceMembers: { some: { workspaceId: channel.workspaceId } },
      },
      select: { id: true },
    });

    for (const u of users) {
      if (u.id === senderId) continue;
      try {
        await this.prisma.mention.create({ data: { messageId, userId: u.id } });
      } catch {
        // 重複 mention（理論上不會出現，因為 usernames 已去重）忽略
      }
      await this.notifications.create({
        userId: u.id,
        type: 'mention',
        title: `${senderDisplayName} 在 #${channel.name} 提及你`,
        content: content.slice(0, 140),
        link: `/chat/channel/${channelId}?messageId=${messageId}`,
      });
    }
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

  async pin(userId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundException('訊息不存在');
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: message.channelId, userId } },
    });
    if (!member) throw new ForbiddenException('非此頻道成員');

    return this.prisma.pinnedMessage.upsert({
      where: { channelId_messageId: { channelId: message.channelId, messageId } },
      create: { channelId: message.channelId, messageId, pinnedBy: userId },
      update: { pinnedBy: userId, pinnedAt: new Date() },
    });
  }

  async unpin(userId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundException('訊息不存在');
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: message.channelId, userId } },
    });
    if (!member) throw new ForbiddenException('非此頻道成員');

    return this.prisma.pinnedMessage.delete({
      where: { channelId_messageId: { channelId: message.channelId, messageId } },
    });
  }

  async findPinned(userId: string, channelId: string) {
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (!member) throw new ForbiddenException('非此頻道成員');

    return this.prisma.pinnedMessage.findMany({
      where: { channelId },
      include: {
        message: {
          include: {
            sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { pinnedAt: 'desc' },
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
