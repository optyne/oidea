import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, workspaceId: string, dto: CreateProjectDto) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.project.create({
      data: {
        workspaceId,
        name: dto.name,
        description: dto.description,
        icon: dto.icon,
        color: dto.color,
        columns: {
          createMany: {
            data: [
              { name: '待辦事項', position: 0, color: '#6B7280' },
              { name: '進行中', position: 1, color: '#3B82F6' },
              { name: '審核中', position: 2, color: '#F59E0B' },
              { name: '已完成', position: 3, color: '#10B981' },
            ],
          },
        },
      },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
  }

  async findByWorkspace(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.project.findMany({
      where: { workspaceId, isArchived: false, deletedAt: null },
      include: {
        _count: { select: { tasks: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id, deletedAt: null },
      include: {
        columns: {
          include: {
            tasks: {
              include: {
                assignee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
                tags: true,
                subtasks: true,
                _count: { select: { comments: true, files: true } },
              },
              orderBy: { position: 'asc' },
            },
          },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!project) throw new NotFoundException('專案不存在');
    return project;
  }

  async update(userId: string, id: string, dto: UpdateProjectDto) {
    return this.prisma.project.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        icon: dto.icon,
        color: dto.color,
        isArchived: dto.isArchived,
      },
    });
  }

  async delete(userId: string, id: string) {
    return this.prisma.project.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addColumn(userId: string, projectId: string, name: string, color?: string) {
    const columns = await this.prisma.projectColumn.findMany({
      where: { projectId },
      orderBy: { position: 'desc' },
      take: 1,
    });

    return this.prisma.projectColumn.create({
      data: {
        projectId,
        name,
        color,
        position: columns.length > 0 ? columns[0].position + 1 : 0,
      },
    });
  }

  async updateColumn(columnId: string, data: { name?: string; color?: string; position?: number }) {
    return this.prisma.projectColumn.update({
      where: { id: columnId },
      data,
    });
  }

  async deleteColumn(columnId: string) {
    return this.prisma.projectColumn.delete({ where: { id: columnId } });
  }
}
