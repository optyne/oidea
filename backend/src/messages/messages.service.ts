import { Inject, Injectable, NotFoundException, ForbiddenException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
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
