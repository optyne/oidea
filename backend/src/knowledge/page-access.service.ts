import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export type Access = 'view' | 'edit' | 'full';

type ChainNode = {
  id: string;
  parentId: string | null;
  visibility: string;
  inheritParentAcl: boolean;
};

const LEVEL: Record<Access, number> = { view: 1, edit: 2, full: 3 };
const MAX_INHERIT_DEPTH = 32;

/**
 * 集中解析某使用者對某頁面的有效存取權限。
 *
 * 解析順序：
 *   1. workspace 成員檢查；非成員 → 拒
 *   2. workspace owner / admin → 永遠 full
 *   3. page.createdById === userId → 永遠 full（避免自己被鎖在外）
 *   4. 走訪 (page, parent, parent, ...) 直到找到第一個「定義了 permissions 或本頁 visibility !== inherit」的節點：
 *        - 明確對 userId 設定的 PagePermission
 *        - 對此 user 角色設定的 PagePermission
 *        - 落到 visibility 預設：
 *            workspace → 預設 edit
 *            private   → 預設 null（除非有明確命中）
 *            restricted→ 預設 null（除非有明確命中）
 *   5. 若 inheritParentAcl=false 或無 parent → 停止
 */
@Injectable()
export class PageAccessService {
  constructor(private prisma: PrismaService) {}

  async resolve(userId: string, pageId: string): Promise<Access | null> {
    const page = await this.prisma.knowledgePage.findUnique({
      where: { id: pageId },
      select: {
        id: true,
        workspaceId: true,
        parentId: true,
        createdById: true,
        visibility: true,
        inheritParentAcl: true,
        deletedAt: true,
      },
    });
    if (!page || page.deletedAt) return null;

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: page.workspaceId, userId } },
      select: { role: true },
    });
    if (!member) return null;

    // workspace 層 admin/owner 直通
    if (member.role === 'owner' || member.role === 'admin') return 'full';

    // 頁面 creator 直通（避免被踢出自己的頁面）
    if (page.createdById === userId) return 'full';

    return this.walkChain(userId, member.role, page);
  }

  async assertAtLeast(userId: string, pageId: string, min: Access): Promise<Access> {
    const got = await this.resolve(userId, pageId);
    if (!got || LEVEL[got] < LEVEL[min]) {
      throw new ForbiddenException(
        got ? `此頁面需要 ${min} 權限，目前僅有 ${got}` : '無權存取此頁面',
      );
    }
    return got;
  }

  async assertPageExists(pageId: string): Promise<{ workspaceId: string; createdById: string }> {
    const page = await this.prisma.knowledgePage.findUnique({
      where: { id: pageId },
      select: { workspaceId: true, createdById: true, deletedAt: true },
    });
    if (!page || page.deletedAt) throw new NotFoundException('頁面不存在');
    return { workspaceId: page.workspaceId, createdById: page.createdById };
  }

  /**
   * 從 page 向上走 parent chain 找第一個適用的權限設定。
   * 每一層：先看該層 permissions 是否對 userId 或 role 命中；若皆無且 visibility 為 workspace/private/restricted
   * 則由 visibility 決定 default。若 inheritParentAcl=false 或已到 root，在當層決斷。
   */
  private async walkChain(
    userId: string,
    role: string,
    start: ChainNode,
  ): Promise<Access | null> {
    let current: ChainNode | null = start;
    for (let depth = 0; depth < MAX_INHERIT_DEPTH && current; depth++) {
      const perm = await this.prisma.pagePermission.findFirst({
        where: {
          pageId: current.id,
          OR: [{ userId }, { role }],
        },
        select: { access: true, userId: true },
      });
      if (perm) return perm.access as Access;

      const def = this.defaultForVisibility(current.visibility);
      if (def) return def;

      if (!current.inheritParentAcl || !current.parentId) return null;

      current = await this.prisma.knowledgePage.findUnique({
        where: { id: current.parentId },
        select: {
          id: true,
          parentId: true,
          visibility: true,
          inheritParentAcl: true,
        },
      });
    }
    return null;
  }

  private defaultForVisibility(v: string): Access | null {
    if (v === 'workspace') return 'edit';
    return null; // private / restricted 沒有明確命中就是拒
  }

  // ─────────── 分享管理 ───────────

  async list(userId: string, pageId: string) {
    await this.assertAtLeast(userId, pageId, 'view');
    return this.prisma.pagePermission.findMany({
      where: { pageId },
      include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async upsert(
    actorId: string,
    pageId: string,
    dto: { userId?: string; role?: string; access: Access },
  ) {
    await this.assertAtLeast(actorId, pageId, 'full');
    if ((!dto.userId && !dto.role) || (dto.userId && dto.role)) {
      throw new ForbiddenException('必須擇一指定 userId 或 role');
    }
    if (!['view', 'edit', 'full'].includes(dto.access)) {
      throw new ForbiddenException('access 必須為 view / edit / full');
    }
    if (dto.role && !['admin', 'hr', 'finance', 'member'].includes(dto.role)) {
      throw new ForbiddenException('role 必須為 admin / hr / finance / member');
    }
    const where = dto.userId
      ? { pageId_userId: { pageId, userId: dto.userId } }
      : { pageId_role: { pageId, role: dto.role! } };
    return this.prisma.pagePermission.upsert({
      where,
      create: { pageId, userId: dto.userId, role: dto.role, access: dto.access },
      update: { access: dto.access },
    });
  }

  async remove(actorId: string, pageId: string, permissionId: string) {
    await this.assertAtLeast(actorId, pageId, 'full');
    const perm = await this.prisma.pagePermission.findUnique({ where: { id: permissionId } });
    if (!perm || perm.pageId !== pageId) throw new NotFoundException('權限項目不存在');
    await this.prisma.pagePermission.delete({ where: { id: permissionId } });
    return { ok: true };
  }

  async setVisibility(
    actorId: string,
    pageId: string,
    visibility: 'workspace' | 'private' | 'restricted',
    inheritParentAcl?: boolean,
  ) {
    await this.assertAtLeast(actorId, pageId, 'full');
    if (!['workspace', 'private', 'restricted'].includes(visibility)) {
      throw new ForbiddenException('visibility 必須為 workspace / private / restricted');
    }
    return this.prisma.knowledgePage.update({
      where: { id: pageId },
      data: {
        visibility,
        ...(inheritParentAcl !== undefined ? { inheritParentAcl } : {}),
      },
      select: { id: true, visibility: true, inheritParentAcl: true },
    });
  }

  /**
   * 批次解析多個 pageId，回傳使用者有 view 以上權限的集合。
   * 提供給 listWorkspacePages 過濾使用。
   */
  async filterVisible(userId: string, pages: Array<{ id: string; parentId: string | null }>): Promise<Set<string>> {
    const visible = new Set<string>();
    for (const p of pages) {
      const acc = await this.resolve(userId, p.id);
      if (acc) visible.add(p.id);
    }
    return visible;
  }
}
