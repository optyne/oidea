import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateChannelDto } from './dto/create-channel.dto';

@Injectable()
export class ChannelsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, workspaceId: string, dto: CreateChannelDto) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.channel.create({
      data: {
        workspaceId,
        name: dto.name,
        type: dto.type || 'public',
        description: dto.description,
        members: {
          create: { userId, role: 'admin' },
        },
      },
      include: { members: true },
    });
  }

  async findByWorkspace(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.channel.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [
          { type: 'public' },
          { members: { some: { userId } } },
        ],
      },
      include: {
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findById(userId: string, channelId: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId, deletedAt: null },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true, displayName: true, avatarUrl: true },
            },
          },
        },
      },
    });
    if (!channel) throw new NotFoundException('頻道不存在');

    if (channel.type === 'private' || channel.type === 'dm') {
      const isMember = channel.members.some((m) => m.userId === userId);
      if (!isMember) throw new ForbiddenException('無權存取此頻道');
    }

    return channel;
  }

  async join(userId: string, channelId: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId, deletedAt: null },
    });
    if (!channel) throw new NotFoundException('頻道不存在');
    if (channel.type === 'private') throw new ForbiddenException('私有頻道需邀請才能加入');

    return this.prisma.channelMember.create({
      data: { channelId, userId },
    });
  }

  async leave(userId: string, channelId: string) {
    return this.prisma.channelMember.delete({
      where: { channelId_userId: { channelId, userId } },
    });
  }

  async delete(userId: string, channelId: string) {
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (!member || member.role !== 'admin') {
      throw new ForbiddenException('僅頻道管理員可刪除頻道');
    }

    return this.prisma.channel.update({
      where: { id: channelId },
      data: { deletedAt: new Date() },
    });
  }
}
