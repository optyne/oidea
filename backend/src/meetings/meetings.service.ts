import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MeetingsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateMeetingDto) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: dto.workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    const meetingUrl = `oidea://meeting/${uuidv4()}`;

    const meeting = await this.prisma.meeting.create({
      data: {
        workspaceId: dto.workspaceId,
        title: dto.title,
        description: dto.description,
        startTime: new Date(dto.startTime),
        endTime: new Date(dto.endTime),
        meetingUrl,
        organizerId: userId,
        participants: {
          create: [
            { userId, role: 'organizer', status: 'accepted' },
            ...(dto.participantIds || []).map((pid: string) => ({
              userId: pid,
              role: 'participant',
              status: 'invited',
            })),
          ],
        },
      },
      include: {
        organizer: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        participants: {
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
      },
    });

    return meeting;
  }

  async findByWorkspace(userId: string, workspaceId: string) {
    return this.prisma.meeting.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [
          { organizerId: userId },
          { participants: { some: { userId } } },
        ],
      },
      include: {
        organizer: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        _count: { select: { participants: true } },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  async findById(userId: string, id: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id, deletedAt: null },
      include: {
        organizer: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        participants: {
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
        notes: true,
      },
    });
    if (!meeting) throw new NotFoundException('會議不存在');
    return meeting;
  }

  async update(userId: string, id: string, dto: Partial<CreateMeetingDto>) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('會議不存在');
    if (meeting.organizerId !== userId) throw new ForbiddenException('僅會議建立者可更新');

    return this.prisma.meeting.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        startTime: dto.startTime ? new Date(dto.startTime) : undefined,
        endTime: dto.endTime ? new Date(dto.endTime) : undefined,
        status: dto.status,
      },
    });
  }

  async delete(userId: string, id: string) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('會議不存在');
    if (meeting.organizerId !== userId) throw new ForbiddenException('僅會議建立者可刪除');

    return this.prisma.meeting.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'cancelled' },
    });
  }

  async respondToInvitation(userId: string, meetingId: string, status: string) {
    return this.prisma.meetingParticipant.update({
      where: { meetingId_userId: { meetingId, userId } },
      data: { status },
    });
  }

  async updateNotes(userId: string, meetingId: string, content: any) {
    const participant = await this.prisma.meetingParticipant.findUnique({
      where: { meetingId_userId: { meetingId, userId } },
    });
    if (!participant) throw new ForbiddenException('非此會議參與者');

    const existing = await this.prisma.meetingNote.findFirst({ where: { meetingId } });
    if (existing) {
      return this.prisma.meetingNote.update({
        where: { id: existing.id },
        data: { content, createdBy: userId },
      });
    }
    return this.prisma.meetingNote.create({
      data: { meetingId, content, createdBy: userId },
    });
  }
}
