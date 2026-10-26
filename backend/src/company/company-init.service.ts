import { Injectable } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CompanyService } from './company.service';
import { EmployeesService, normalizeEmail, normalizeEmployeeRow } from '../employees/employees.service';
import { resolveUserIdByEmail } from '../common/email-lookup';
import { SSO_PROVIDER } from '../auth/oidc/sso-login.service';

export interface CompanyInitOptions {
  /** 指定既有工作空間（與 createName 二選一） */
  workspaceId?: string;
  /** 建立新的工作空間（與 workspaceId 二選一） */
  createName?: string;
  /** 新工作空間的 slug；不給就由名稱產生 */
  slug?: string;
  ownerEmail: string;
  /** owner 還沒有員工資料時必填 */
  employeeNo?: string;
  /** owner 還沒有員工資料時必填（已有 User 時預設用他的 displayName） */
  fullName?: string;
  /** owner 還沒有員工資料時必填，YYYY-MM-DD */
  hireDate?: string;
  jobTitle?: string;
  /** --create 且 owner 還沒綁定 SSO 時必填：暫時當 ownerId 的既有使用者 */
  executorEmail?: string;
  /** --workspace 指向的工作空間已有 owner 以外的成員時，必須明確允許才沿用（review S7） */
  allowExistingMembers?: boolean;
}

/** 既有工作空間的成員統計（只有數量，不含 email）。 */
export interface ExistingMemberCounts {
  /** 全部成員（含 owner） */
  total: number;
  /** owner 以外的成員 */
  others: number;
  /** 在這個工作空間沒有 EmployeeProfile 的成員 */
  withoutProfile: number;
  /** 角色是 owner／admin／hr／finance 的成員（成為公司工作空間後就是全公司的後台角色） */
  privileged: number;
}

export interface CompanyInitResult {
  workspaceId: string;
  workspaceCreated: boolean;
  /** owner 已綁定 SSO 時為他的 id（ownerId 已指向他） */
  ownerUserId: string | null;
  /** owner 還沒綁定 SSO：記在 Workspace.pendingOwnerEmail，等他第一次 SSO 登入（會清掉舊密碼等）時移交 */
  pendingOwnerEmail: string | null;
  profile: 'created' | 'existing';
  profileId: string;
  /** 指定的既有工作空間原本有 owner 以外的成員時（用 --allow-existing-members 沿用）的統計；否則 null */
  existingMembers: ExistingMemberCounts | null;
}

const PRIVILEGED_ROLES = new Set(['owner', 'admin', 'hr', 'finance']);

/** CLI 參數或狀態錯誤；訊息直接給操作者看。 */
export class CompanyInitError extends Error {}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

interface ActiveUser {
  id: string;
  displayName: string;
  /** 已有 `authentik` Account：經過 SSO 綁定（綁定時清過密碼、撤銷過 token／bot） */
  ssoBound: boolean;
}

/**
 * `npm run company:init`（spec §4.3「員工對應」第 5 點）：
 * - 設定 `Workspace.isCompany`（已有別的公司工作空間就拒絕；同一個就冪等）。
 * - 確保 owner 的 EmployeeProfile（不綁 userId：第一次 SSO 登入時才綁，綁定流程會清密碼等）。
 * - owner 的 User **已綁定 SSO**（有 authentik Account）：`Workspace.ownerId` 指向他，確保他是 owner 成員，
 *   原本的 owner 降為 admin（跟 transferOwnership 一樣）。
 * - 其他情況（沒有 User，或只有還沒綁 SSO 的帳密 User）：**不**直接給 owner（review B1：那可能是
 *   搶先用老闆 email 註冊的人）。把 email 記在 `Workspace.pendingOwnerEmail`，等他第一次 SSO 登入、
 *   經過綁定的清理流程之後才移交；`--create` 時 ownerId 先指向 `--executor-email` 的使用者。
 * - email 比對：完全相同（小寫）優先，否則不分大小寫；只差大小寫的有兩個以上 → 拒絕。
 * - `--workspace` 指向還不是公司工作空間、而且有 owner 以外成員的工作空間 → 拒絕，除非
 *   `--allow-existing-members`（review S7）。
 * - `--workspace`：執行後的每一位 owner（ownerId 與角色 owner 的成員）都必須已綁定 SSO，或是 pending owner
 *   本人；否則拒絕（只印數量，review R2）。
 */
@Injectable()
export class CompanyInitService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private company: CompanyService,
    private employees: EmployeesService,
  ) {}

  async init(opts: CompanyInitOptions): Promise<CompanyInitResult> {
    const workspaceIdArg = opts.workspaceId?.trim() || undefined;
    const createName = opts.createName?.trim() || undefined;
    if (!!workspaceIdArg === !!createName) {
      throw new CompanyInitError('必須指定 --workspace <id> 或 --create <name> 其中一個');
    }
    const ownerEmail = normalizeEmail(opts.ownerEmail);
    if (!ownerEmail || !isEmail(ownerEmail)) throw new CompanyInitError('--owner-email 格式不正確');

    const existingCompany = await this.company.findCompanyWorkspace();
    const ownerUser = await this.findActiveUser(ownerEmail, 'owner');
    // 只有已綁定 SSO 的帳號能直接當 owner；其他一律等第一次 SSO 登入（review B1）
    const boundOwner = ownerUser?.ssoBound ? ownerUser : null;

    // ── 1. 決定要用哪個工作空間（還不寫入） ──
    let target: { id: string; name: string; ownerId: string; isCompany: boolean } | null = null;
    if (workspaceIdArg) {
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceIdArg },
        select: { id: true, name: true, ownerId: true, isCompany: true, deletedAt: true },
      });
      if (!ws || ws.deletedAt) throw new CompanyInitError(`找不到工作空間 ${workspaceIdArg}`);
      if (existingCompany && existingCompany.id !== ws.id) {
        throw new CompanyInitError(
          `已經有公司工作空間（${existingCompany.id}「${existingCompany.name}」），不能再指定另一個`,
        );
      }
      target = ws;
    } else if (existingCompany) {
      if (existingCompany.name.trim().toLowerCase() !== createName!.toLowerCase()) {
        throw new CompanyInitError(
          `已經有公司工作空間（${existingCompany.id}「${existingCompany.name}」）；要更新它請改用 --workspace ${existingCompany.id}`,
        );
      }
      target = { ...existingCompany, isCompany: true }; // 同名重跑：冪等，不建第二個
    }

    // ── 2. 先驗證 owner 的員工資料（避免建了工作空間才發現參數不足） ──
    const profilePlan = target
      ? await this.planOwnerProfile(target.id, ownerEmail, opts, boundOwner)
      : await this.planOwnerProfile(null, ownerEmail, opts, boundOwner);

    // 既有的專案工作空間第一次變成公司工作空間：原本的成員會直接變成公司成員（review S7）
    let existingMembers: ExistingMemberCounts | null = null;
    if (target && !target.isCompany) {
      const counts = await this.countExistingMembers(target.id, [target.ownerId, boundOwner?.id]);
      if (counts.others > 0) {
        const summary =
          `共 ${counts.total} 位成員，其中 ${counts.others} 位不是 owner；` +
          `${counts.withoutProfile} 位不在員工主檔；${counts.privileged} 位的角色是 owner/admin/hr/finance`;
        if (!opts.allowExistingMembers) {
          throw new CompanyInitError(
            `工作空間 ${target.id} 已有其他成員（${summary}）。成為公司工作空間後，他們都會是公司成員，` +
              '角色就是全公司的後台角色。確認要沿用請加 --allow-existing-members，否則請改用 --create 建立新的公司工作空間',
          );
        }
        existingMembers = counts;
      }
    }

    // review R2：--workspace 之後的每一位 owner（ownerId 與角色是 owner 的成員）都必須已綁定 SSO，
    // 或者就是這次 pending 的 owner 本人（他第一次 SSO 登入時會經綁定清理）。否則一個沒經過清理的
    // 帳號（可能是搶先註冊的人）會直接成為公司 owner。
    if (workspaceIdArg && target) {
      const unbound = await this.countUnboundOwnersAfterInit(target, boundOwner, ownerUser);
      if (unbound.primary + unbound.coOwners > 0) {
        throw new CompanyInitError(
          `工作空間 ${target.id} 執行後會有 ${unbound.primary + unbound.coOwners} 位 owner 還沒綁定 SSO` +
            `（主 owner ${unbound.primary} 位、角色是 owner 的成員 ${unbound.coOwners} 位），而且不是 --owner-email 指定的人。` +
            '公司 owner 必須是綁定過 SSO 的帳號：請先把他們降為 admin 或移出這個工作空間，' +
            '或改用 --create 建立新的公司工作空間（搭配 --executor-email）',
        );
      }
    }

    let executor: ActiveUser | null = null;
    if (!target && !boundOwner) {
      if (!opts.executorEmail) {
        throw new CompanyInitError(
          'owner 還沒有綁定 SSO 的使用者帳號：建立新工作空間時必須用 --executor-email 指定一位既有使用者暫時擔任 owner',
        );
      }
      executor = await this.findActiveUser(normalizeEmail(opts.executorEmail), 'executor');
      if (!executor) throw new CompanyInitError('--executor-email 找不到可用的使用者');
      if (ownerUser && executor.id === ownerUser.id) {
        throw new CompanyInitError(
          '--executor-email 不能是 owner 自己還沒綁定 SSO 的帳號（那正是要等第一次 SSO 登入清理的帳號），請指定另一位使用者',
        );
      }
    }

    // ── 3. 寫入 ──
    let workspaceCreated = false;
    let workspaceId: string;
    try {
      if (target) {
        workspaceId = target.id;
        await this.prisma.workspace.update({
          where: { id: workspaceId },
          data: boundOwner
            ? { isCompany: true, ownerId: boundOwner.id, pendingOwnerEmail: null }
            : { isCompany: true, pendingOwnerEmail: ownerEmail },
        });
      } else {
        const initialOwner = (boundOwner ?? executor)!;
        const ws = await this.prisma.workspace.create({
          data: {
            name: createName!,
            slug: await this.uniqueSlug(opts.slug?.trim() || slugify(createName!)),
            ownerId: initialOwner.id,
            isCompany: true,
            pendingOwnerEmail: boundOwner ? null : ownerEmail,
            members: { create: { userId: initialOwner.id, role: 'owner' } },
          },
          select: { id: true },
        });
        workspaceId = ws.id;
        workspaceCreated = true;
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new CompanyInitError('已經有另一個公司工作空間（可能剛被同時建立），請重新執行確認');
      }
      throw err;
    }

    let previousOwnerDemoted = false;
    if (boundOwner) {
      await this.prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId: boundOwner.id } },
        create: { workspaceId, userId: boundOwner.id, role: 'owner' },
        update: { role: 'owner' },
      });
      // 跟 transferOwnership 一樣：原本的主 owner 降為 admin（不留下永久的共同 owner）
      if (target && target.ownerId !== boundOwner.id) {
        const res = await this.prisma.workspaceMember.updateMany({
          where: { workspaceId, userId: target.ownerId, role: 'owner' },
          data: { role: 'admin' },
        });
        previousOwnerDemoted = res.count > 0;
      }
    }

    let profileId: string;
    if (profilePlan.kind === 'existing' && profilePlan.workspaceId === workspaceId) {
      profileId = profilePlan.profileId;
    } else {
      if (profilePlan.kind !== 'create') {
        // 理論上不會發生：existing 只會出現在已決定的 target 上
        throw new CompanyInitError('員工資料狀態不一致，請重新執行');
      }
      const res = await this.employees.upsertOne(workspaceId, profilePlan.row);
      profileId = res.profileId;
    }

    await this.audit.record({
      actorId: null,
      workspaceId,
      action: 'company.init',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: {
        mode: workspaceIdArg ? 'workspace' : 'create',
        workspaceCreated,
        ownerUserId: boundOwner?.id ?? null,
        pendingOwner: !boundOwner,
        /** owner 有帳號但還沒綁 SSO：不直接給 owner（review B1） */
        ownerUserNotSsoBound: !!ownerUser && !boundOwner,
        previousOwnerDemoted,
        profile: profilePlan.kind === 'create' ? 'created' : 'existing',
        existingMembers,
      },
    });

    return {
      workspaceId,
      workspaceCreated,
      ownerUserId: boundOwner?.id ?? null,
      pendingOwnerEmail: boundOwner ? null : ownerEmail,
      profile: profilePlan.kind === 'create' ? 'created' : 'existing',
      profileId,
      existingMembers,
    };
  }

  /**
   * email → 可用的使用者（不含已刪除）。完全相同（小寫）優先，否則不分大小寫；
   * 只差大小寫的有兩個以上 → 拒絕（不知道是誰）。比對走 email-lookup（不用 ILIKE，review S8）。
   */
  private async findActiveUser(email: string, label: 'owner' | 'executor'): Promise<ActiveUser | null> {
    const who = label === 'owner' ? 'owner' : '執行者';
    const id = await resolveUserIdByEmail(this.prisma, email);
    if (id === 'ambiguous') {
      throw new CompanyInitError(
        `${who}的 email 對到多個只差大小寫的使用者帳號，無法判斷是哪一個；請先在資料庫整理重複的帳號`,
      );
    }
    if (!id) return null;
    const user = await this.prisma.user.findUnique({
      where: { id, deletedAt: null },
      select: {
        id: true,
        displayName: true,
        disabledAt: true,
        botAccount: { select: { id: true } },
        accounts: { where: { provider: SSO_PROVIDER }, select: { id: true } },
      },
    });
    if (!user) return null;
    if (user.disabledAt) throw new CompanyInitError(`${who}的帳號已停用`);
    if (user.botAccount) throw new CompanyInitError(`${who}不能是 bot 帳號`);
    return { id: user.id, displayName: user.displayName, ssoBound: (user.accounts ?? []).length > 0 };
  }

  /**
   * company:init 寫入之後會是 owner 的人當中，沒綁定 SSO、也不是 pending owner 本人的有幾位（只有數量）。
   * - 有已綁定的 owner：ownerId 換成他，原本的主 owner 降為 admin（不算）；其他角色是 owner 的成員照算。
   * - 沒有（pending）：ownerId 不動、角色也不動，全部照算；只有 owner email 自己的帳號例外。
   */
  private async countUnboundOwnersAfterInit(
    target: { id: string; ownerId: string },
    boundOwner: ActiveUser | null,
    ownerUser: ActiveUser | null,
  ): Promise<{ primary: number; coOwners: number }> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: target.id },
      select: { userId: true, role: true },
    });
    const primaryId = boundOwner ? boundOwner.id : target.ownerId;
    const owners = new Map<string, 'primary' | 'co'>([[primaryId, 'primary']]);
    for (const m of members) {
      if (m.role !== 'owner' || owners.has(m.userId)) continue;
      if (boundOwner && m.userId === target.ownerId) continue; // 會被降為 admin
      owners.set(m.userId, 'co');
    }
    const exempt = boundOwner?.id ?? ownerUser?.id ?? null;
    const out = { primary: 0, coOwners: 0 };
    for (const [userId, kind] of owners) {
      if (userId === exempt) continue;
      if (await this.company.isSsoBound(userId)) continue;
      if (kind === 'primary') out.primary++;
      else out.coOwners++;
    }
    return out;
  }

  /** 工作空間的成員統計（只有數量）。`ownerIds` 不算進 others。 */
  private async countExistingMembers(
    workspaceId: string,
    ownerIds: (string | null | undefined)[],
  ): Promise<ExistingMemberCounts> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true, role: true },
    });
    const owners = new Set(ownerIds.filter((x): x is string => !!x));
    const profiled = members.length
      ? await this.prisma.employeeProfile.findMany({
          where: { workspaceId, userId: { in: members.map((m) => m.userId) } },
          select: { userId: true },
        })
      : [];
    const withProfile = new Set(profiled.map((p) => p.userId));
    return {
      total: members.length,
      others: members.filter((m) => !owners.has(m.userId)).length,
      withoutProfile: members.filter((m) => !withProfile.has(m.userId)).length,
      privileged: members.filter((m) => PRIVILEGED_ROLES.has(m.role)).length,
    };
  }

  private async planOwnerProfile(
    workspaceId: string | null,
    ownerEmail: string,
    opts: CompanyInitOptions,
    ownerUser: ActiveUser | null,
  ): Promise<
    | { kind: 'existing'; workspaceId: string; profileId: string }
    | { kind: 'create'; row: { employeeNo: string; email: string; fullName: string; hireDate: string; jobTitle?: string } }
  > {
    const employeeNo = opts.employeeNo?.trim() ?? '';
    if (workspaceId) {
      const existing = await this.prisma.employeeProfile.findUnique({
        where: { workspaceId_email: { workspaceId, email: ownerEmail } },
        select: { id: true, employeeNo: true },
      });
      if (existing) {
        if (employeeNo && employeeNo !== existing.employeeNo) {
          throw new CompanyInitError(
            `owner 已有員工資料（員工編號 ${existing.employeeNo}），與 --employee-no ${employeeNo} 不符`,
          );
        }
        return { kind: 'existing', workspaceId, profileId: existing.id };
      }
    }

    const row = {
      employeeNo,
      email: ownerEmail,
      fullName: opts.fullName?.trim() || ownerUser?.displayName || '',
      hireDate: opts.hireDate?.trim() ?? '',
      jobTitle: opts.jobTitle?.trim() || undefined,
    };
    const missing: string[] = [];
    if (!row.employeeNo) missing.push('--employee-no');
    if (!row.fullName) missing.push('--full-name');
    if (!row.hireDate) missing.push('--hire-date');
    if (missing.length > 0) {
      throw new CompanyInitError(`owner 還沒有員工資料，必須提供：${missing.join(' ')}`);
    }
    const checked = normalizeEmployeeRow(row);
    if ('error' in checked) throw new CompanyInitError(`owner 的員工資料不正確：${checked.error}`);

    if (workspaceId) {
      const byNo = await this.prisma.employeeProfile.findUnique({
        where: { workspaceId_employeeNo: { workspaceId, employeeNo: checked.value.employeeNo } },
        select: { email: true },
      });
      if (byNo && byNo.email !== ownerEmail) {
        throw new CompanyInitError(`員工編號 ${checked.value.employeeNo} 已屬於另一位員工`);
      }
    }
    return { kind: 'create', row };
  }

  private async uniqueSlug(base: string): Promise<string> {
    for (let n = 1; n <= 50; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const taken = await this.prisma.workspace.findUnique({ where: { slug }, select: { id: true } });
      if (!taken) return slug;
    }
    throw new CompanyInitError(`找不到可用的 slug（${base}），請用 --slug 指定`);
  }
}

/** 名稱 → slug：小寫英數與 -；全是非英數（例如中文名稱）時用 company。 */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'company';
}
