import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { resolveUserIdByEmail } from '../common/email-lookup';

type Db = Prisma.TransactionClient | PrismaService;

const lower = (s: string | null | undefined) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/** 改動員工「身分對應」的動作：解除綁定、改 email（PATCH 或 CSV）、離職。 */
export type IdentityAction = 'unbind' | 'email' | 'terminate';

/**
 * - `pending_owner_email`：待移交 owner 的 profile 不能用 API 改 email（只能重跑 company:init）。
 * - `owner_protected`：對象是任何工作空間的 owner、或是待移交的 owner，只有公司 owner 能解除綁定／改 email。
 * - `admin_protected`：hr 不能對公司 admin 解除綁定、改 email、辦離職。
 */
export type IdentityRefusal = 'pending_owner_email' | 'owner_protected' | 'admin_protected';

export interface IdentityRisk {
  /** 這筆 profile 代表的 User：已綁定的那位；沒綁定時是 email 相同的既有 User（可能是被解除綁定、還沒重新登入的人） */
  userId: string | null;
  /** email 是公司工作空間的 `pendingOwnerEmail` */
  pendingOwner: boolean;
  /** 那位 User 是任何（沒刪除的）工作空間的 `Workspace.ownerId` 或成員角色 owner */
  ownsWorkspace: boolean;
  /** 那位 User 在公司工作空間的角色 */
  companyRole: string | null;
}

export interface ActorStanding {
  role: string | null;
  /** 公司 owner：公司工作空間角色 owner，或公司的 `Workspace.ownerId` */
  isOwner: boolean;
}

export async function actorStanding(db: Db, companyId: string, actorId: string): Promise<ActorStanding> {
  const [ws, member] = await Promise.all([
    db.workspace.findUnique({ where: { id: companyId }, select: { ownerId: true } }),
    db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: companyId, userId: actorId } },
      select: { role: true },
    }),
  ]);
  const role = member?.role ?? null;
  return { role, isOwner: role === 'owner' || ws?.ownerId === actorId };
}

/** 判斷一筆 profile 的身分有多敏感（只讀）。 */
export async function assessIdentity(
  db: Db,
  companyId: string,
  target: { userId: string | null; email: string },
): Promise<IdentityRisk> {
  const ws = await db.workspace.findUnique({ where: { id: companyId }, select: { pendingOwnerEmail: true } });
  const pendingOwner = !!ws?.pendingOwnerEmail && lower(ws.pendingOwnerEmail) === lower(target.email);

  let userId = target.userId;
  if (!userId) {
    const found = await resolveUserIdByEmail(db, target.email, { includeDeleted: false });
    // 只差大小寫的同 email 帳號有好幾個：判斷不出是誰，當成最敏感的情況
    if (found === 'ambiguous') return { userId: null, pendingOwner, ownsWorkspace: true, companyRole: 'admin' };
    userId = found;
  }
  if (!userId) return { userId: null, pendingOwner, ownsWorkspace: false, companyRole: null };

  const [mainOwned, coOwned, member] = await Promise.all([
    db.workspace.count({ where: { ownerId: userId, deletedAt: null } }),
    db.workspaceMember.count({ where: { userId, role: 'owner', workspace: { deletedAt: null } } }),
    db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: companyId, userId } },
      select: { role: true },
    }),
  ]);
  return { userId, pendingOwner, ownsWorkspace: mainOwned + coOwned > 0, companyRole: member?.role ?? null };
}

/** 依 B1 的規則決定要不要擋；回 null 表示可以做。 */
export function identityRefusal(action: IdentityAction, actor: ActorStanding, risk: IdentityRisk): IdentityRefusal | null {
  if (action === 'email' && risk.pendingOwner) return 'pending_owner_email';
  // 離職的 owner 檢查另外走 owner_transfer_required（先移交）；這裡只管解除綁定與改 email
  if (action !== 'terminate' && (risk.ownsWorkspace || risk.pendingOwner) && !actor.isOwner) return 'owner_protected';
  if (actor.role === 'hr' && risk.companyRole === 'admin') return 'admin_protected';
  return null;
}
