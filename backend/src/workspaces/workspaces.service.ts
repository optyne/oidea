import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@Injectable()
export class WorkspacesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateWorkspaceDto) {
    return this.prisma.workspace.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        ownerId: userId,
        members: {
          create: { userId, role: 'owner' },
        },
      },
      include: { members: true },
    });
  }

  async findAll(userId: string) {
    return this.prisma.workspace.findMany({
      where: {
        deletedAt: null,
        members: { some: { userId } },
      },
      include: {
        _count: { select: { members: true, channels: true, projects: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id, deletedAt: null },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                status: true,
              },
            },
          },
        },
        channels: { where: { deletedAt: null } },
        _count: { select: { projects: true } },
      },
    });

    if (!workspace) throw new NotFoundException('工作空間不存在');
    if (!workspace.members.some((m: { userId: string }) => m.userId === userId)) {
      throw new ForbiddenException('無權存取此工作空間');
    }

    return workspace;
  }

  async update(userId: string, id: string, dto: UpdateWorkspaceDto) {
    await this.checkPermission(userId, id, 'admin');
    return this.prisma.workspace.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        iconUrl: dto.iconUrl,
      },
    });
  }

  async delete(userId: string, id: string) {
    await this.checkPermission(userId, id, 'owner');
    return this.prisma.workspace.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async inviteMember(userId: string, workspaceId: string, targetUserId: string, role: string = 'member') {
    await this.checkPermission(userId, workspaceId, 'admin');

    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    if (existing) throw new ForbiddenException('使用者已是成員');

    return this.prisma.workspaceMember.create({
      data: { workspaceId, userId: targetUserId, role },
    });
  }

  async removeMember(userId: string, workspaceId: string, targetUserId: string) {
    await this.checkPermission(userId, workspaceId, 'admin');
    return this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
  }

  async updateMemberRole(userId: string, workspaceId: string, targetUserId: string, role: string) {
    await this.checkPermission(userId, workspaceId, 'admin');

    const validRoles = ['owner', 'admin', 'hr', 'finance', 'member'];
    if (!validRoles.includes(role)) {
      throw new ForbiddenException(`角色必須為 ${validRoles.join(' / ')}`);
    }

    // 不可直接把自己降級為 member，避免誤操作鎖死管理權。
    if (userId === targetUserId && role === 'member') {
      throw new ForbiddenException('不可將自己降為 member，請改由其他管理員操作');
    }

    return this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      data: { role },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    });
  }

  async listMembers(userId: string, workspaceId: string) {
    const self = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!self) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, email: true },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  private async checkPermission(userId: string, workspaceId: string, requiredRole: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    const roleHierarchy: Record<string, number> = {
      owner: 3,
      admin: 2,
      hr: 2,
      finance: 2,
      member: 1,
    };
    const memberRank = roleHierarchy[member.role] ?? 0;
    const requiredRank = roleHierarchy[requiredRole] ?? 0;
    if (memberRank < requiredRank) {
      throw new ForbiddenException('權限不足');
    }
  }
}
