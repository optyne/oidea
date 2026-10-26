import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { Clock } from '../../common/clock';
import { AuditRequestContext, AuditService } from '../../audit/audit.service';
import { normalizeEmail } from '../../employees/employees.service';
import { RefreshTokenService } from '../refresh-token.service';
import { UserStatusService } from '../user-status.service';
import { SsoErrorCode } from './oidc-errors';

/** Account.provider 的值（`Account(provider, providerId)` 唯一）。 */
export const SSO_PROVIDER = 'authentik';

export interface SsoClaims {
  /** id_token 的 sub */
  sub: string;
  /** id_token 的 email（呼叫端已確認 email_verified=true） */
  email: string;
}

export type SsoLoginResult =
  | {
      ok: true;
      userId: string;
      email: string;
      userCreated: boolean;
      boundExistingUser: boolean;
      profileBound: boolean;
      ownerTransferred: boolean;
    }
  | { ok: false; code: SsoErrorCode; reason: string };

type Tx = Prisma.TransactionClient;

interface Decision {
  kind: 'deny';
  code: SsoErrorCode;
  reason: string;
  workspaceId: string | null;
  actorId: string | null;
  via: 'account' | 'email' | null;
}

interface Applied {
  kind: 'ok';
  workspaceId: string;
  profileId: string;
  userId: string;
  email: string;
  userCreated: boolean;
  boundExistingUser: boolean;
  profileBound: boolean;
  revokedBots: number;
  ownerTransfer: { fromUserId: string } | null;
}

/** 交易中途發現被併發的登入搶先（profile 已被綁走等），整段重跑一次。 */
class RetryableConflict extends Error {}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

const USER_SELECT = { id: true, email: true, disabledAt: true, deletedAt: true } as const;
const PROFILE_SELECT = {
  id: true,
  workspaceId: true,
  userId: true,
  email: true,
  fullName: true,
  employmentStatus: true,
} as const;

/** email 的 @ 前面那段 → 小寫、只保留 [a-z0-9._-]；空的話用 user。 */
export function usernameBase(email: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return local.slice(0, 40) || 'user';
}

/**
 * SSO 登入的員工對應（spec §4.3「員工對應」1–4）。整段在同一個 DB 交易裡，所有「能不能登入」
 * 的判斷都在任何寫入之前做完；被拒時交易裡沒有任何寫入。
 *
 * 1. `Account(provider=authentik, providerId=sub)` → User → 他的 EmployeeProfile；
 *    找不到 profile 就用 email（小寫）找公司工作空間的 EmployeeProfile。都找不到 → `not_employee`。
 *    `terminated` → `terminated`；User 停用／刪除 → `disabled`。
 * 2. 從 email 找到的 profile 已綁了別的 User → `profile_bound`（hr 解除綁定後再登入）。
 * 3. profile 還沒綁：
 *    - 已有同 email（不分大小寫）的 User → 綁定它，並清掉 passwordHash、撤銷他全部 refresh token、
 *      撤銷他建立的所有 BotAccount、刪除他其他的 Account；
 *    - 沒有 → 新建 User（username 取 email 的 local part，撞名加 -2、-3…）；
 *    - 建 Account、回填 `EmployeeProfile.userId`。
 * 4. upsert 公司工作空間的 WorkspaceMember（新加入 role=member；已有就不動角色）。
 *    `Workspace.pendingOwnerEmail` 等於這位員工的 email → 移交 owner（只會發生一次）。
 *
 * 被拒寫 audit `auth.sso_denied`（workspaceId = 公司工作空間，metadata.reason）。
 */
@Injectable()
export class SsoLoginService {
  private readonly logger = new Logger(SsoLoginService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly userStatus: UserStatusService,
  ) {}

  async loginWithOidc(claims: SsoClaims, req?: AuditRequestContext): Promise<SsoLoginResult> {
    const email = normalizeEmail(claims.email);
    let outcome: Decision | Applied | undefined;
    for (let attempt = 0; attempt < 2 && !outcome; attempt++) {
      try {
        outcome = await this.prisma.$transaction((tx) => this.decideAndApply(tx, claims.sub, email));
      } catch (err) {
        const retryable = err instanceof RetryableConflict || isUniqueViolation(err);
        if (!retryable || attempt === 1) throw err;
      }
    }
    if (!outcome) throw new Error('sso login: no outcome');

    if (outcome.kind === 'deny') {
      await this.audit.record({
        actorId: outcome.actorId,
        workspaceId: outcome.workspaceId,
        action: 'auth.sso_denied',
        metadata: { reason: outcome.reason, code: outcome.code, via: outcome.via, email },
        req,
      });
      this.logger.log(`SSO login denied: ${outcome.reason}`);
      return { ok: false, code: outcome.code, reason: outcome.reason };
    }

    // 交易 commit 之後再撤銷一次：撈出交易期間才 commit 的 refresh token 換發
    if (outcome.boundExistingUser) await this.refreshTokens.revokeAllForUser(outcome.userId);
    // 復職等情況下快取可能還留著舊的「停用」，DB 已確認沒停用 → 清掉
    await this.userStatus.invalidate(outcome.userId);

    if (outcome.profileBound) {
      await this.audit.record({
        actorId: outcome.userId,
        workspaceId: outcome.workspaceId,
        action: 'employee.sso_bind',
        targetType: 'employee_profile',
        targetId: outcome.profileId,
        metadata: {
          userCreated: outcome.userCreated,
          boundExistingUser: outcome.boundExistingUser,
          revokedBots: outcome.revokedBots,
        },
        req,
      });
    }
    if (outcome.ownerTransfer) {
      await this.audit.record({
        actorId: outcome.userId,
        workspaceId: outcome.workspaceId,
        action: 'owner.transfer',
        targetType: 'workspace',
        targetId: outcome.workspaceId,
        metadata: {
          fromUserId: outcome.ownerTransfer.fromUserId,
          toUserId: outcome.userId,
          reason: 'pending_owner_first_sso',
        },
        req,
      });
    }

    return {
      ok: true,
      userId: outcome.userId,
      email: outcome.email,
      userCreated: outcome.userCreated,
      boundExistingUser: outcome.boundExistingUser,
      profileBound: outcome.profileBound,
      ownerTransferred: outcome.ownerTransfer !== null,
    };
  }

  private async decideAndApply(tx: Tx, sub: string, email: string): Promise<Decision | Applied> {
    const deny = (
      code: SsoErrorCode,
      reason: string,
      extra: Partial<Pick<Decision, 'workspaceId' | 'actorId' | 'via'>> = {},
    ): Decision => ({ kind: 'deny', code, reason, workspaceId: null, actorId: null, via: null, ...extra });

    // ── 判斷（不寫入） ──
    const company = await tx.workspace.findFirst({
      where: { isCompany: true },
      select: { id: true, ownerId: true, pendingOwnerEmail: true, deletedAt: true },
    });
    if (!company || company.deletedAt) return deny('not_employee', 'no_company_workspace');
    const ws = { workspaceId: company.id };

    const account = await tx.account.findUnique({
      where: { provider_providerId: { provider: SSO_PROVIDER, providerId: sub } },
      select: { user: { select: USER_SELECT } },
    });
    const accountUser = account?.user ?? null;
    if (accountUser && (accountUser.deletedAt || accountUser.disabledAt)) {
      return deny('disabled', accountUser.deletedAt ? 'user_deleted' : 'user_disabled', {
        ...ws,
        actorId: accountUser.id,
        via: 'account',
      });
    }

    let via: 'account' | 'email' = 'account';
    let profile = accountUser
      ? await tx.employeeProfile.findUnique({ where: { userId: accountUser.id }, select: PROFILE_SELECT })
      : null;
    if (!profile) {
      via = 'email';
      profile = email
        ? await tx.employeeProfile.findUnique({
            where: { workspaceId_email: { workspaceId: company.id, email } },
            select: PROFILE_SELECT,
          })
        : null;
    }
    const ctx = { ...ws, actorId: accountUser?.id ?? null, via };
    if (!profile || profile.workspaceId !== company.id) return deny('not_employee', 'not_in_roster', ctx);
    if (profile.employmentStatus === 'terminated') return deny('terminated', 'terminated', ctx);
    // 從 email 找到、但已綁了別人（accountUser 沒有 profile，所以一定是別人）
    if (via === 'email' && profile.userId) return deny('profile_bound', 'profile_bound_to_other_user', ctx);

    let target: { id: string; email: string } | null = accountUser;
    let userCreated = false;
    let boundExistingUser = false;
    if (!target) {
      const existing = await this.findUserByEmail(tx, profile.email);
      if (existing === 'ambiguous') return deny('server_error', 'ambiguous_email', ctx);
      if (existing) {
        const who = { ...ctx, actorId: existing.id };
        if (existing.deletedAt) return deny('disabled', 'user_deleted', who);
        if (existing.disabledAt) return deny('disabled', 'user_disabled', who);
        if (existing.botAccount) return deny('server_error', 'email_belongs_to_bot', who);
        const otherProfile = await tx.employeeProfile.findUnique({
          where: { userId: existing.id },
          select: { id: true },
        });
        if (otherProfile) return deny('profile_bound', 'user_bound_to_other_profile', who);
        target = { id: existing.id, email: existing.email };
        boundExistingUser = true;
      }
    }

    // ── 寫入 ──
    const now = this.clock.now();
    let revokedBots = 0;
    if (!target) {
      const username = await this.uniqueUsername(tx, profile.email);
      target = await tx.user.create({
        data: {
          email: profile.email,
          username,
          displayName: profile.fullName.trim() || username,
          passwordHash: null,
        },
        select: { id: true, email: true },
      });
      userCreated = true;
    } else if (boundExistingUser) {
      // 防止有人先用員工的 email 註冊、之後搶走帳號或留下後門
      await tx.user.update({ where: { id: target.id }, data: { passwordHash: null } });
      await this.refreshTokens.revokeAllForUser(target.id, tx);
      const bots = await tx.botAccount.updateMany({
        where: { createdById: target.id, revokedAt: null },
        data: { revokedAt: now },
      });
      revokedBots = bots.count;
      await tx.account.deleteMany({ where: { userId: target.id } });
    }

    if (!accountUser) {
      await tx.account.create({ data: { userId: target.id, provider: SSO_PROVIDER, providerId: sub } });
    }

    let profileBound = false;
    if (!profile.userId) {
      const bound = await tx.employeeProfile.updateMany({
        where: { id: profile.id, userId: null },
        data: { userId: target.id },
      });
      if (bound.count !== 1) throw new RetryableConflict('profile bound concurrently');
      profileBound = true;
    }

    const memberKey = { workspaceId_userId: { workspaceId: company.id, userId: target.id } };
    await tx.workspaceMember.upsert({
      where: memberKey,
      create: { workspaceId: company.id, userId: target.id, role: 'member' },
      update: {},
    });

    let ownerTransfer: Applied['ownerTransfer'] = null;
    if (company.pendingOwnerEmail && normalizeEmail(company.pendingOwnerEmail) === profile.email) {
      // 條件式更新：同時兩次登入只會移交一次
      const moved = await tx.workspace.updateMany({
        where: { id: company.id, pendingOwnerEmail: company.pendingOwnerEmail },
        data: { ownerId: target.id, pendingOwnerEmail: null },
      });
      if (moved.count === 1) {
        await tx.workspaceMember.update({ where: memberKey, data: { role: 'owner' } });
        ownerTransfer = { fromUserId: company.ownerId };
      }
    }

    return {
      kind: 'ok',
      workspaceId: company.id,
      profileId: profile.id,
      userId: target.id,
      email: target.email,
      userCreated,
      boundExistingUser,
      profileBound,
      revokedBots,
      ownerTransfer,
    };
  }

  /**
   * 不分大小寫找 User（含已刪除的：email 欄位的唯一性包含它們，新建會撞）。
   * 有完全相同（小寫）的優先；只差大小寫的有兩個以上 → 'ambiguous'。
   */
  private async findUserByEmail(tx: Tx, email: string) {
    const candidates = await tx.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { ...USER_SELECT, botAccount: { select: { id: true } } },
      take: 5,
    });
    const exact = candidates.find((u) => u.email === email);
    if (exact) return exact;
    if (candidates.length > 1) return 'ambiguous' as const;
    return candidates[0] ?? null;
  }

  private async uniqueUsername(tx: Tx, email: string): Promise<string> {
    const base = usernameBase(email);
    const rows = await tx.user.findMany({
      where: { username: { startsWith: base } },
      select: { username: true },
    });
    const taken = new Set(rows.map((r) => r.username));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
