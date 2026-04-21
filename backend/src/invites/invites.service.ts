import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';

const VALID_ROLES = ['admin', 'hr', 'finance', 'member'] as const;
const DEFAULT_EXPIRY_DAYS = 7;

@Injectable()
export class InvitesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ─────────────────── 管理端：建 / 列 / 撤 ───────────────────

  async create(
    actorId: string,
    workspaceId: string,
    opts: { email?: string; role?: string; expiresInDays?: number },
  ) {
    await this.assertAdmin(actorId, workspaceId);

    const role = opts.role ?? 'member';
    if (!VALID_ROLES.includes(role as any)) {
      throw new BadRequestException(`角色必須為 ${VALID_ROLES.join(' / ')}`);
    }

    const days = Math.min(Math.max(opts.expiresInDays ?? DEFAULT_EXPIRY_DAYS, 1), 30);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    // 32 bytes → 43 字元 base64url，無 padding，URL-safe
    const token = randomBytes(32).toString('base64url');

    const invite = await this.prisma.workspaceInvite.create({
      data: {
        workspaceId,
        token,
        email: opts.email?.trim() || null,
        role,
        createdById: actorId,
        expiresAt,
      },
    });

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'workspace.role_change',
      targetType: 'workspace_invite',
      targetId: invite.id,
      metadata: { op: 'invite_created', role, email: opts.email, expiresAt },
    });

    return invite;
  }

  async listPending(actorId: string, workspaceId: string) {
    await this.assertAdmin(actorId, workspaceId);
    return this.prisma.workspaceInvite.findMany({
      where: {
        workspaceId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(actorId: string, workspaceId: string, inviteId: string) {
    await this.assertAdmin(actorId, workspaceId);
    const invite = await this.prisma.workspaceInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.workspaceId !== workspaceId) {
      throw new NotFoundException('邀請不存在');
    }
    if (invite.consumedAt) {
      throw new BadRequestException('邀請已被接受，無法撤銷');
    }
    // 用設定 expiresAt=now 代替硬刪，保留稽核痕跡
    await this.prisma.workspaceInvite.update({
      where: { id: inviteId },
      data: { expiresAt: new Date() },
    });
    await this.audit.record({
      actorId,
      workspaceId,
      action: 'workspace.member_remove',
      targetType: 'workspace_invite',
      targetId: inviteId,
      metadata: { op: 'invite_revoked' },
    });
    return { ok: true };
  }

  // ─────────────────── 公開端：peek（無需登入） ───────────────────

  /**
   * 使用者點開邀請連結時用來 render landing page —— 告訴他加入的是哪個工作空間、
   * 得到什麼角色、有沒有過期。無需登入。不回 token 本身也不回私密資訊。
   */
  async peek(token: string) {
    const invite = await this.prisma.workspaceInvite.findUnique({
      where: { token },
      include: {
        workspace: { select: { id: true, name: true, slug: true, iconUrl: true } },
        createdBy: { select: { displayName: true } },
      },
    });
    if (!invite) throw new NotFoundException('邀請連結不存在或已失效');

    const now = new Date();
    const expired = invite.expiresAt <= now;
    const consumed = !!invite.consumedAt;

    return {
      workspace: invite.workspace,
      role: invite.role,
      invitedBy: invite.createdBy?.displayName ?? null,
      email: invite.email,
      expiresAt: invite.expiresAt,
      expired,
      consumed,
      valid: !expired && !consumed,
    };
  }

  // ─────────────────── 接受端：auth required ───────────────────

  async accept(userId: string, token: string) {
    const invite = await this.prisma.workspaceInvite.findUnique({ where: { token } });
    if (!invite) throw new NotFoundException('邀請連結不存在或已失效');

    // 已是成員：以條件式 update 消費 invite（不改 role；若別人搶先消費此 invite 就直接結束）
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
    });
    if (existing) {
      await this.prisma.workspaceInvite.updateMany({
        where: { id: invite.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date(), consumedByUserId: userId },
      });
      return {
        workspaceId: invite.workspaceId,
        alreadyMember: true,
        role: existing.role,
      };
    }

    // 非成員：atomic 搶 invite 再建 member。
    // 關鍵在 updateMany 的 WHERE 帶 consumedAt=null + 未過期；PostgreSQL row-level lock
    // 保證多個併發 caller 只有一人拿到 count=1，其他拿到 count=0 直接 throw。
    // 這樣避免「同一 invite 連結被兩個不同帳號同時接受、兩人都入群」的 TOCTOU race。
    const member = await this.prisma.$transaction(async (tx) => {
      const upd = await tx.workspaceInvite.updateMany({
        where: { id: invite.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date(), consumedByUserId: userId },
      });
      if (upd.count === 0) {
        throw new ForbiddenException('此邀請已被使用或已過期');
      }
      return tx.workspaceMember.create({
        data: { workspaceId: invite.workspaceId, userId, role: invite.role },
        include: {
          workspace: { select: { id: true, name: true, slug: true } },
          user: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      });
    });

    await this.audit.record({
      actorId: userId,
      workspaceId: invite.workspaceId,
      action: 'workspace.role_change',
      targetType: 'workspace_member',
      targetId: userId,
      metadata: { op: 'invite_accepted', inviteId: invite.id, role: invite.role },
    });

    return {
      workspaceId: invite.workspaceId,
      alreadyMember: false,
      role: invite.role,
      workspace: (member as any).workspace,
    };
  }

  // ─────────────────── helpers ───────────────────

  private async assertAdmin(userId: string, workspaceId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!m) throw new ForbiddenException('非此工作空間成員');
    if (m.role !== 'owner' && m.role !== 'admin') {
      throw new ForbiddenException('僅限 owner / admin 操作邀請');
    }
  }
}
