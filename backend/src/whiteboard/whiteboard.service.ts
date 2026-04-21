import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateWhiteboardDto } from './dto/create-whiteboard.dto';
import * as Y from 'yjs';

@Injectable()
export class WhiteboardService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateWhiteboardDto) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: dto.workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.whiteboard.create({
      data: {
        workspaceId: dto.workspaceId,
        projectId: dto.projectId,
        title: dto.title,
        description: dto.description,
        isTemplate: dto.isTemplate || false,
        data: {},
      },
    });
  }

  async findByWorkspace(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.whiteboard.findMany({
      where: { workspaceId, deletedAt: null, isTemplate: false },
      include: {
        _count: { select: { sessions: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const board = await this.prisma.whiteboard.findUnique({
      where: { id, deletedAt: null },
    });
    if (!board) throw new NotFoundException('白板不存在');
    return board;
  }

  async update(userId: string, id: string, dto: { title?: string; description?: string }) {
    return this.prisma.whiteboard.update({
      where: { id },
      data: { title: dto.title, description: dto.description },
    });
  }

  async delete(userId: string, id: string) {
    return this.prisma.whiteboard.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async getState(boardId: string): Promise<Buffer> {
    const board = await this.prisma.whiteboard.findUnique({ where: { id: boardId } });
    if (!board) throw new NotFoundException('白板不存在');

    const ydoc = new Y.Doc();
    if (board.data) {
      Y.applyUpdate(ydoc, Buffer.from(board.data as any));
    }
    return Buffer.from(Y.encodeStateAsUpdate(ydoc));
  }

  async saveState(boardId: string, update: Uint8Array) {
    const board = await this.prisma.whiteboard.findUnique({ where: { id: boardId } });
    if (!board) throw new NotFoundException('白板不存在');

    const ydoc = new Y.Doc();
    if (board.data) {
      Y.applyUpdate(ydoc, Buffer.from(board.data as any));
    }
    Y.applyUpdate(ydoc, Buffer.from(update));

    return this.prisma.whiteboard.update({
      where: { id: boardId },
      data: { data: Buffer.from(Y.encodeStateAsUpdate(ydoc)) as any },
    });
  }

  async getTemplates(workspaceId: string) {
    return this.prisma.whiteboard.findMany({
      where: { workspaceId, isTemplate: true, deletedAt: null },
    });
  }

  async duplicateFromTemplate(userId: string, templateId: string, title: string) {
    const template = await this.prisma.whiteboard.findUnique({
      where: { id: templateId },
    });
    if (!template) throw new NotFoundException('範本不存在');

    return this.prisma.whiteboard.create({
      data: {
        workspaceId: template.workspaceId,
        title,
        data: (template.data ?? {}) as any,
      },
    });
  }
}
