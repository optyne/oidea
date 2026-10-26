import { Injectable } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CompanyService } from './company.service';
import { EmployeesService, normalizeEmail, normalizeEmployeeRow } from '../employees/employees.service';

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
  /** --create 且 owner 還沒有 User 時必填：暫時當 ownerId 的既有使用者 */
  executorEmail?: string;
}

export interface CompanyInitResult {
  workspaceId: string;
  workspaceCreated: boolean;
  /** owner 已有 User 時為他的 id（ownerId 已指向他） */
  ownerUserId: string | null;
  /** owner 還沒有 User：記在 Workspace.pendingOwnerEmail，等他第一次 SSO 登入時移交 */
  pendingOwnerEmail: string | null;
  profile: 'created' | 'existing';
  profileId: string;
}

/** CLI 參數或狀態錯誤；訊息直接給操作者看。 */
export class CompanyInitError extends Error {}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

interface ActiveUser {
  id: string;
  displayName: string;
}

/**
 * `npm run company:init`（spec §4.3「員工對應」第 5 點）：
 * - 設定 `Workspace.isCompany`（已有別的公司工作空間就拒絕；同一個就冪等）。
 * - 確保 owner 的 EmployeeProfile（不綁 userId：第一次 SSO 登入時才綁，綁定流程會清密碼等）。
 * - owner 已有 User（email 不分大小寫）：`Workspace.ownerId` 指向他，並確保他是 owner 成員。
 * - owner 還沒有 User：把 email 記在 `Workspace.pendingOwnerEmail`；
 *   `--create` 時 ownerId 先指向 `--executor-email` 的使用者。
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

    // ── 1. 決定要用哪個工作空間（還不寫入） ──
    let target: { id: string; name: string } | null = null;
    if (workspaceIdArg) {
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceIdArg },
        select: { id: true, name: true, deletedAt: true },
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
      target = existingCompany; // 同名重跑：冪等，不建第二個
    }

    // ── 2. 先驗證 owner 的員工資料（避免建了工作空間才發現參數不足） ──
    const profilePlan = target
      ? await this.planOwnerProfile(target.id, ownerEmail, opts, ownerUser)
      : await this.planOwnerProfile(null, ownerEmail, opts, ownerUser);

    let executor: ActiveUser | null = null;
    if (!target && !ownerUser) {
      if (!opts.executorEmail) {
        throw new CompanyInitError(
          'owner 還沒有使用者帳號：建立新工作空間時必須用 --executor-email 指定一位既有使用者暫時擔任 owner',
        );
      }
      executor = await this.findActiveUser(normalizeEmail(opts.executorEmail), 'executor');
      if (!executor) throw new CompanyInitError('--executor-email 找不到可用的使用者');
    }

    // ── 3. 寫入 ──
    let workspaceCreated = false;
    let workspaceId: string;
    try {
      if (target) {
        workspaceId = target.id;
        await this.prisma.workspace.update({
          where: { id: workspaceId },
          data: ownerUser
            ? { isCompany: true, ownerId: ownerUser.id, pendingOwnerEmail: null }
            : { isCompany: true, pendingOwnerEmail: ownerEmail },
        });
      } else {
        const initialOwner = (ownerUser ?? executor)!;
        const ws = await this.prisma.workspace.create({
          data: {
            name: createName!,
            slug: await this.uniqueSlug(opts.slug?.trim() || slugify(createName!)),
            ownerId: initialOwner.id,
            isCompany: true,
            pendingOwnerEmail: ownerUser ? null : ownerEmail,
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

    if (ownerUser) {
      await this.prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId: ownerUser.id } },
        create: { workspaceId, userId: ownerUser.id, role: 'owner' },
        update: { role: 'owner' },
      });
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
        ownerUserId: ownerUser?.id ?? null,
        pendingOwner: !ownerUser,
        profile: profilePlan.kind === 'create' ? 'created' : 'existing',
      },
    });

    return {
      workspaceId,
      workspaceCreated,
      ownerUserId: ownerUser?.id ?? null,
      pendingOwnerEmail: ownerUser ? null : ownerEmail,
      profile: profilePlan.kind === 'create' ? 'created' : 'existing',
      profileId,
    };
  }

  private async findActiveUser(email: string, label: 'owner' | 'executor'): Promise<ActiveUser | null> {
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, displayName: true, disabledAt: true, botAccount: { select: { id: true } } },
    });
    if (!user) return null;
    const who = label === 'owner' ? 'owner' : '執行者';
    if (user.disabledAt) throw new CompanyInitError(`${who}的帳號已停用`);
    if (user.botAccount) throw new CompanyInitError(`${who}不能是 bot 帳號`);
    return { id: user.id, displayName: user.displayName };
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
