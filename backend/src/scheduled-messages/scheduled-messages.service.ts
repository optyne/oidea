import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateScheduledMessageDto } from './dto/create-scheduled-message.dto';

@Injectable()
export class ScheduledMessagesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateScheduledMessageDto) {
    await this.assertWorkspaceMember(userId, dto.workspaceId);

    const sendAt = new Date(dto.sendAt);
    if (Number.isNaN(sendAt.getTime())) {
      throw new BadRequestException('sendAt 需為合法 ISO 日期字串');
    }
    if (sendAt.getTime() <= Date.now()) {
      throw new BadRequestException('sendAt 必須為未來時間');
    }

    const channelIds = Array.from(new Set(dto.channelIds));
    if (channelIds.length === 0) {
      throw new BadRequestException('channelIds 不可為空');
    }

    const channels = await this.prisma.channel.findMany({
      where: { id: { in: channelIds }, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        members: { where: { userId }, select: { userId: true } },
      },
    });
    if (channels.length !== channelIds.length) {
      throw new NotFoundException('部分頻道不存在或已刪除');
    }
    if (channels.some((c) => c.workspaceId !== dto.workspaceId)) {
      throw new BadRequestException('所有頻道需屬於同一 workspace');
    }
    const nonMember = channels.find((c) => c.members.length === 0);
    if (nonMember) {
      throw new ForbiddenException(`非頻道成員：${nonMember.id}`);
    }

    return this.prisma.scheduledMessage.create({
      data: {
        workspaceId: dto.workspaceId,
        createdBy: userId,
        channelIds,
        content: dto.content,
        type: dto.type ?? 'text',
        metadata: dto.metadata,
        sendAt,
      },
    });
  }

  async findByWorkspace(
    userId: string,
    workspaceId: string,
    opts: { includeHistory?: boolean } = {},
  ) {
    await this.assertWorkspaceMember(userId, workspaceId);
    return this.prisma.scheduledMessage.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(opts.includeHistory ? {} : { status: 'pending' }),
      },
      orderBy: { sendAt: 'asc' },
    });
  }

  async findById(userId: string, id: string) {
    const record = await this.loadOrThrow(id);
    await this.assertWorkspaceMember(userId, record.workspaceId);
    return record;
  }

  async cancel(userId: string, id: string) {
    const record = await this.loadOrThrow(id);
    await this.assertWorkspaceMember(userId, record.workspaceId);
    if (record.createdBy !== userId) {
      throw new ForbiddenException('僅建立者可取消');
    }
    if (record.status !== 'pending') {
      throw new BadRequestException(`狀態為 ${record.status}，無法取消`);
    }
    return this.prisma.scheduledMessage.update({
      where: { id },
      data: { status: 'canceled' },
    });
  }

  async remove(userId: string, id: string) {
    const record = await this.loadOrThrow(id);
    await this.assertWorkspaceMember(userId, record.workspaceId);
    if (record.createdBy !== userId) {
      throw new ForbiddenException('僅建立者可刪除');
    }
    return this.prisma.scheduledMessage.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ---------- 給 scheduler 用的 ----------

  async markSent(id: string, sentAt: Date, sentBroadcastId: string) {
    return this.prisma.scheduledMessage.update({
      where: { id },
      data: { status: 'sent', sentAt, sentBroadcastId },
    });
  }

  async markFailed(id: string, reason: string) {
    return this.prisma.scheduledMessage.update({
      where: { id },
      data: { status: 'failed', failedReason: reason.slice(0, 500) },
    });
  }

  async findDue(now: Date, take = 200) {
    return this.prisma.scheduledMessage.findMany({
      where: {
        deletedAt: null,
        status: 'pending',
        sendAt: { lte: now },
      },
      orderBy: { sendAt: 'asc' },
      take,
    });
  }

  // ---------- 內部 ----------

  private async assertWorkspaceMember(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
  }

  private async loadOrThrow(id: string) {
    const record = await this.prisma.scheduledMessage.findUnique({
      where: { id },
    });
    if (!record || record.deletedAt) {
      throw new NotFoundException('排程訊息不存在');
    }
    return record;
  }
}
