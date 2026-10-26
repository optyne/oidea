import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { PERMISSIONS, WORKSPACE_ROLES, hasPermission } from '../common/permissions';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { COMPANY_REMOVE_FORBIDDEN, CompanyService } from '../company/company.service';

/**
 * 成員管理的 owner 規則（spec §4.4）：
 * - 只有 owner（`owner.transfer`）能指定或移交 owner，也只有 owner 能動另一位 owner。
 * - `Workspace.ownerId` 指向的主 owner 不能被移除或降級，必須先移交。
 * - 任何操作之後都至少保留一位 owner。
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private prisma: PrismaService,
    private company: CompanyService,
  ) {}

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
    await this.checkPermission(userId, id, PERMISSIONS.WORKSPACE_MANAGE);
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
    await this.checkPermission(userId, id, PERMISSIONS.WORKSPACE_DELETE);
    // 公司工作空間不能刪除（spec §4.1）：員工主檔、部門、假別都綁在它身上
    await this.company.assertNotCompanyWorkspace(id, '公司工作空間不能刪除');
    return this.prisma.workspace.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async inviteMember(userId: string, workspaceId: string, targetUserId: string, role: string = 'member') {
    const actorRole = await this.checkPermission(userId, workspaceId, PERMISSIONS.MEMBER_MANAGE);
    // 公司工作空間的成員只由員工生命週期決定（spec §4.3「邀請」）
    await this.company.assertNotCompanyWorkspace(workspaceId);
    this.assertAssignableRole(actorRole, role);

    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    if (existing) throw new ForbiddenException('使用者已是成員');

    return this.prisma.workspaceMember.create({
      data: { workspaceId, userId: targetUserId, role },
    });
  }

  /**
   * 以 email 或 username 邀請既有使用者加入工作空間。對方必須已註冊；
   * 若尚未註冊，回 404 並提示由對方先完成註冊。
   */
  async inviteByIdentifier(
    userId: string,
    workspaceId: string,
    identifier: string,
    role: string = 'member',
  ) {
    const actorRole = await this.checkPermission(userId, workspaceId, PERMISSIONS.MEMBER_MANAGE);
    await this.company.assertNotCompanyWorkspace(workspaceId);
    this.assertAssignableRole(actorRole, role);

    const target = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ email: identifier }, { username: identifier }],
      },
      select: { id: true, email: true, username: true, displayName: true },
    });
    if (!target) {
      throw new NotFoundException(
        `找不到使用者 "${identifier}"；請對方先至 https://oidea.oadpiz.com 註冊後再邀請`,
      );
    }

    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: target.id } },
    });
    if (existing) {
      throw new ForbiddenException(`${target.displayName} 已是成員`);
    }

    const member = await this.prisma.workspaceMember.create({
      data: { workspaceId, userId: target.id, role },
      include: {
        user: { select: { id: true, email: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    return member;
  }

  async removeMember(userId: string, workspaceId: string, targetUserId: string) {
    const actorRole = await this.checkPermission(userId, workspaceId, PERMISSIONS.MEMBER_MANAGE);
    // 公司工作空間的成員只由員工生命週期決定：移除（含移除自己）一律走離職，不能直接移出
    await this.company.assertNotCompanyWorkspace(workspaceId, COMPANY_REMOVE_FORBIDDEN);
    const target = await this.getMemberOrThrow(workspaceId, targetUserId);
    if (target.role === 'owner') {
      await this.assertOwnerMayLoseRole(actorRole, workspaceId, targetUserId, '移除');
    }
    return this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
  }

  async updateMemberRole(userId: string, workspaceId: string, targetUserId: string, role: string) {
    const actorRole = await this.checkPermission(userId, workspaceId, PERMISSIONS.MEMBER_ROLE_MANAGE);

    if (!(WORKSPACE_ROLES as readonly string[]).includes(role)) {
      throw new ForbiddenException(`角色必須為 ${WORKSPACE_ROLES.join(' / ')}`);
    }

    // 不可直接把自己降級為 member，避免誤操作鎖死管理權。
    if (userId === targetUserId && role === 'member') {
      throw new ForbiddenException('不可將自己降為 member，請改由其他管理員操作');
    }

    const target = await this.getMemberOrThrow(workspaceId, targetUserId);
    this.assertAssignableRole(actorRole, role);
    if (target.role === 'owner' && role !== 'owner') {
      await this.assertOwnerMayLoseRole(actorRole, workspaceId, targetUserId, '降級');
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

  /**
   * 移交主 owner：目標成為 owner 並寫入 `Workspace.ownerId`，原 owner 改為 admin。
   * 只有主 owner（`Workspace.ownerId`）能做；共同 owner 雖有 `owner.transfer` 也不行，
   * 否則共同 owner 可以先把主 owner 身分移走、再移除原主 owner。
   * 目標必須是此工作空間的成員，且不是 bot、未停用、未刪除。
   */
  async transferOwnership(userId: string, workspaceId: string, rawTargetUserId: unknown) {
    await this.checkPermission(userId, workspaceId, PERMISSIONS.OWNER_TRANSFER);
    if (typeof rawTargetUserId !== 'string' || rawTargetUserId.trim() === '') {
      throw new BadRequestException('必須提供 userId');
    }
    const targetUserId: string = rawTargetUserId;
    if (targetUserId === userId) throw new BadRequestException('不可移交給自己');

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!workspace) throw new NotFoundException('工作空間不存在');
    // 主 owner 已停用、刪除或不再是成員時，共同 owner 可以接手移交，否則工作空間會卡住。
    const isMainOwner = workspace.ownerId === userId;
    if (!isMainOwner && !(await this.isMainOwnerGone(workspaceId, workspace.ownerId))) {
      throw new ForbiddenException('只有主要 owner 能移交 owner');
    }

    const target = await this.getMemberOrThrow(workspaceId, targetUserId);
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, disabledAt: true, deletedAt: true, botAccount: { select: { id: true } } },
    });
    if (!targetUser || targetUser.deletedAt || targetUser.disabledAt) {
      throw new BadRequestException('目標使用者已停用或不存在');
    }
    if (targetUser.botAccount) {
      throw new BadRequestException('不可移交給 bot 帳號');
    }

    await this.prisma.$transaction(async (tx: any) => {
      await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        data: { role: 'owner' },
      });
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { ownerId: targetUserId },
      });
      if (isMainOwner) {
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId } },
          data: { role: 'admin' },
        });
      }
    });

    return {
      workspaceId,
      ownerId: targetUserId,
      previousOwnerId: workspace.ownerId,
      previousTargetRole: target.role,
      actorNewRole: isMainOwner ? 'admin' : 'owner',
    };
  }

  /** 主 owner 帳號不存在、已刪除、已停用，或已不是此工作空間成員。 */
  private async isMainOwnerGone(workspaceId: string, ownerId: string): Promise<boolean> {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, disabledAt: true, deletedAt: true },
    });
    if (!owner || owner.deletedAt || owner.disabledAt) return true;
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: ownerId } },
    });
    return !membership;
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

  // ─────────── helpers ───────────

  /** 檢查呼叫者在此工作空間有 `key` 權限，回傳其角色。 */
  private async checkPermission(userId: string, workspaceId: string, key: string): Promise<string> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
    if (!hasPermission(member.role, key)) {
      throw new ForbiddenException(`權限不足：需要 ${key}`);
    }
    return member.role;
  }

  private async getMemberOrThrow(workspaceId: string, userId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new NotFoundException('此使用者不是工作空間成員');
    return member;
  }

  /** 邀請或改角色時的目標角色檢查：角色必須合法；指定 owner 只能由 owner 做。 */
  private assertAssignableRole(actorRole: string, role: string) {
    if (!(WORKSPACE_ROLES as readonly string[]).includes(role)) {
      throw new BadRequestException(`角色必須為 ${WORKSPACE_ROLES.join(' / ')}`);
    }
    if (role === 'owner' && !hasPermission(actorRole, PERMISSIONS.OWNER_TRANSFER)) {
      throw new ForbiddenException('只有 owner 能指定 owner');
    }
  }

  /** 目標目前是 owner、即將失去 owner 身分（移除或降級）時的檢查。 */
  private async assertOwnerMayLoseRole(
    actorRole: string,
    workspaceId: string,
    targetUserId: string,
    verb: string,
  ) {
    if (!hasPermission(actorRole, PERMISSIONS.OWNER_TRANSFER)) {
      throw new ForbiddenException(`只有 owner 能${verb} owner`);
    }
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    if (workspace?.ownerId === targetUserId) {
      throw new ForbiddenException(`無法${verb}主要 owner，請先移交 owner`);
    }
    const owners = await this.prisma.workspaceMember.count({
      where: { workspaceId, role: 'owner' },
    });
    if (owners <= 1) {
      throw new ForbiddenException(`工作空間至少要保留一位 owner，無法${verb}`);
    }
  }
}
