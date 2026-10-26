import { BadRequestException, HttpStatus, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isEmail } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { Clock } from '../common/clock';
import { AuditRequestContext, AuditService } from '../audit/audit.service';
import { apiError, isForeignKeyViolation, isUniqueViolation, uniqueTargetMentions } from '../common/api-error';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { UserStatusService } from '../auth/user-status.service';
import { SocketRegistry } from '../auth/socket-registry';
import { SSO_PROVIDER } from '../auth/oidc/sso-provider';
import { CsvParseError } from './csv';
import { EmployeeCsvHeaderError, parseEmployeeCsv } from './employee-csv';
import { EmployeesService, normalizeEmail, parseIsoDate } from './employees.service';
import { CreateEmployeeDto, ImportEmployeesDto, ListEmployeesQuery, TerminateEmployeeDto, UpdateEmployeeDto } from './dto/employee-admin.dto';
import { ORG_WALK_LIMIT } from './manager-resolver';
import { lockOrgStructure } from './org-lock';

type Db = Prisma.TransactionClient | PrismaService;

/** 後台 CSV 匯入的上限（UTF-8 位元組）。 */
export const EMPLOYEE_IMPORT_MAX_BYTES = 1024 * 1024;

export interface EmployeeDto {
  id: string;
  employeeNo: string;
  email: string;
  fullName: string;
  departmentId: string | null;
  departmentName: string | null;
  jobTitle: string;
  managerProfileId: string | null;
  managerName: string | null;
  employmentType: string;
  employmentStatus: string;
  hireDate: string;
  terminationDate: string | null;
  phone: string;
  userId: string | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const EMPLOYEE_SELECT = {
  id: true,
  workspaceId: true,
  employeeNo: true,
  email: true,
  fullName: true,
  departmentId: true,
  jobTitle: true,
  managerProfileId: true,
  employmentType: true,
  employmentStatus: true,
  hireDate: true,
  terminationDate: true,
  phone: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
  department: { select: { name: true } },
  manager: { select: { fullName: true } },
  user: { select: { disabledAt: true } },
} as const;

type EmployeeRow = {
  id: string;
  workspaceId: string;
  employeeNo: string;
  email: string;
  fullName: string;
  departmentId: string | null;
  jobTitle: string;
  managerProfileId: string | null;
  employmentType: string;
  employmentStatus: string;
  hireDate: Date;
  terminationDate: Date | null;
  phone: string;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
  department: { name: string } | null;
  manager: { fullName: string } | null;
  user: { disabledAt: Date | null } | null;
};

/** `@db.Date` → `YYYY-MM-DD`（Prisma 給的是 UTC 午夜的 Date）。 */
export const formatDate = (d: Date) => d.toISOString().slice(0, 10);

export function toEmployeeDto(p: EmployeeRow): EmployeeDto {
  return {
    id: p.id,
    employeeNo: p.employeeNo,
    email: p.email,
    fullName: p.fullName,
    departmentId: p.departmentId,
    departmentName: p.department?.name ?? null,
    jobTitle: p.jobTitle,
    managerProfileId: p.managerProfileId,
    managerName: p.manager?.fullName ?? null,
    employmentType: p.employmentType,
    employmentStatus: p.employmentStatus,
    hireDate: formatDate(p.hireDate),
    terminationDate: p.terminationDate ? formatDate(p.terminationDate) : null,
    phone: p.phone,
    userId: p.userId,
    disabled: !!p.user?.disabledAt,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const err = {
  notFound: () => new NotFoundException('員工資料不存在'),
  invalidDate: (field: string) => apiError(HttpStatus.BAD_REQUEST, 'invalid_date', `${field} 必須是有效的 YYYY-MM-DD 日期`),
  employeeNoTaken: () => apiError(HttpStatus.CONFLICT, 'employee_no_taken', '員工編號已被使用'),
  emailTaken: () => apiError(HttpStatus.CONFLICT, 'email_taken', '這個 email 已屬於另一位員工'),
  emailLocked: () =>
    apiError(HttpStatus.BAD_REQUEST, 'email_locked_bound', '已綁定帳號的員工不能改 email；請先解除綁定'),
  managerCycle: () => apiError(HttpStatus.BAD_REQUEST, 'manager_cycle', '直屬主管不能是自己，也不能形成循環'),
  managerNotFound: () => apiError(HttpStatus.BAD_REQUEST, 'manager_not_found', '主管必須是公司裡在職的員工'),
  departmentNotFound: () => apiError(HttpStatus.BAD_REQUEST, 'department_not_found', '部門不存在'),
  departmentArchived: () => apiError(HttpStatus.BAD_REQUEST, 'department_archived', '部門已封存'),
  cannotTerminateSelf: () => apiError(HttpStatus.BAD_REQUEST, 'cannot_terminate_self', '不能為自己辦理離職'),
  alreadyTerminated: (msg = '這位員工已經離職') => apiError(HttpStatus.BAD_REQUEST, 'already_terminated', msg),
  notTerminated: () => apiError(HttpStatus.BAD_REQUEST, 'not_terminated', '這位員工沒有離職，不需要復職'),
  notBound: () => apiError(HttpStatus.BAD_REQUEST, 'not_bound', '這位員工還沒有綁定帳號'),
  ownerTransfer: (workspaces: { id: string; name: string }[]) =>
    apiError(HttpStatus.BAD_REQUEST, 'owner_transfer_required', '這位員工是工作空間的 owner，請先移交 owner 再辦理離職', {
      workspaces,
    }),
  invalidCsv: (message: string) => apiError(HttpStatus.BAD_REQUEST, 'invalid_csv', message),
};

function requiredText(raw: string | undefined, field: string, max: number): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new BadRequestException(`${field} 必填`);
  if (v.length > max) throw new BadRequestException(`${field} 太長（上限 ${max} 字）`);
  return v;
}

function validEmail(raw: string | undefined): string {
  const email = normalizeEmail(raw);
  if (!email || !isEmail(email) || email.length > 254) throw new BadRequestException('email 格式不正確');
  return email;
}

function parseDateOrThrow(raw: string | undefined, field: string): Date {
  const d = parseIsoDate(raw);
  if (!d) throw err.invalidDate(field);
  return d;
}

/**
 * H2 員工主檔後台（contract：notes/h2-api-contract.md「Employees」）。
 *
 * 離職（spec §4.3「停用」）是安全控制：HR 一按下去，這個人的 token、bot、socket 都要立刻失效。
 * 1. 任何寫入之前先擋：本人 → `cannot_terminate_self`；已離職 → `already_terminated`；
 *    他是任何（沒刪除的）工作空間的 `Workspace.ownerId` 或成員角色是 owner、或他的 email 是公司工作空間的
 *    `pendingOwnerEmail`（待移交的 owner）→ `owner_transfer_required`（附清單）。
 *    這些檢查在交易裡、寫入之前做；被擋就整個交易回滾，什麼都沒寫。
 * 2. 同一個交易：profile → terminated＋離職日；有 User 的話：`disabledAt = now`、`tokenVersion + 1`、
 *    撤銷全部 refresh token、撤銷他建立的所有 bot、刪除他全部的 WorkspaceMember。
 * 3. commit 之後：再撤銷一次 refresh token 與 bot（撈出交易途中才 commit 的），把停用快取覆寫成停用，斷開 socket。
 * 4. audit `employee.terminate`。
 *
 * 規格沒寫、選了較安全的做法：
 * - 離職時 `tokenVersion + 1`：否則 15 分鐘內復職，他離職前的 access token 會重新變有效。
 * - 解除綁定時也撤銷舊帳號建立的 bot（bot token 不帶 tokenVersion，只能靠撤銷）。
 * - 主管、部門主管只能指定沒離職的員工；建立員工時部門不能是已封存的。
 * - 離職日不能早於到職日。
 */
@Injectable()
export class EmployeeAdminService {
  private readonly logger = new Logger(EmployeeAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly userStatus: UserStatusService,
    private readonly sockets: SocketRegistry,
    private readonly employees: EmployeesService,
  ) {}

  // ─────────────── 讀 ───────────────

  async list(workspaceId: string, query: ListEmployeesQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const q = typeof query.q === 'string' ? query.q.trim() : '';

    const where: Prisma.EmployeeProfileWhereInput = {
      workspaceId,
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.status ? { employmentStatus: query.status } : {}),
      // 名冊不含 bot：綁到 bot User 的 profile 一律排除（正常流程不會發生，SSO 拒絕綁定 bot 的 email）
      NOT: { user: { is: { botAccount: { isNot: null } } } },
    };
    if (q) where.id = { in: await this.searchIds(workspaceId, q) };

    const [rows, total] = await Promise.all([
      this.prisma.employeeProfile.findMany({
        where,
        orderBy: [{ employeeNo: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: EMPLOYEE_SELECT,
      }),
      this.prisma.employeeProfile.count({ where }),
    ]);
    return { items: (rows as EmployeeRow[]).map(toEmployeeDto), total, page, pageSize };
  }

  async get(workspaceId: string, id: string): Promise<EmployeeDto> {
    const row = await this.findRow(this.prisma, workspaceId, id);
    if (!row) throw err.notFound();
    return toEmployeeDto(row);
  }

  /**
   * 關鍵字比對員工編號、email、姓名（不分大小寫、子字串）。用 `strpos(lower(x), lower($q))`，
   * 不用 Prisma 的 `contains` + insensitive（Postgres 上是 ILIKE，`_`／`%` 是萬用字元）。
   */
  private async searchIds(workspaceId: string, q: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "employee_profiles" WHERE "workspaceId" = ${workspaceId} AND (strpos(lower("employeeNo"), lower(${q})) > 0 OR strpos(lower("email"), lower(${q})) > 0 OR strpos(lower("fullName"), lower(${q})) > 0)`;
    return (Array.isArray(rows) ? rows : []).map((r) => r.id);
  }

  // ─────────────── 新增、編輯 ───────────────

  async create(actorId: string, workspaceId: string, dto: CreateEmployeeDto, req?: AuditRequestContext) {
    const employeeNo = requiredText(dto.employeeNo, 'employeeNo', 64);
    const email = validEmail(dto.email);
    const fullName = requiredText(dto.fullName, 'fullName', 100);
    const hireDate = parseDateOrThrow(dto.hireDate, 'hireDate');
    const departmentId = dto.departmentId ?? null;
    const managerProfileId = dto.managerProfileId ?? null;

    const created = await this.runProfileTx(async (tx) => {
      if (await this.byEmployeeNo(tx, workspaceId, employeeNo)) throw err.employeeNoTaken();
      if (await this.byEmail(tx, workspaceId, email)) throw err.emailTaken();
      if (departmentId) await this.assertDepartment(tx, workspaceId, departmentId);
      if (managerProfileId) await this.assertManagerExists(tx, workspaceId, managerProfileId);
      return tx.employeeProfile.create({
        data: {
          workspaceId,
          employeeNo,
          email,
          fullName,
          hireDate,
          departmentId,
          managerProfileId,
          jobTitle: dto.jobTitle?.trim() ?? '',
          employmentType: dto.employmentType ?? 'full_time',
          phone: dto.phone?.trim() ?? '',
        },
        select: EMPLOYEE_SELECT,
      });
    });

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'employee.create',
      targetType: 'employee_profile',
      targetId: created.id,
      metadata: { employeeNo },
      req,
    });
    return toEmployeeDto(created as EmployeeRow);
  }

  async update(actorId: string, workspaceId: string, id: string, dto: UpdateEmployeeDto, req?: AuditRequestContext) {
    const result = await this.runProfileTx(async (tx) => {
      const current = await this.findRow(tx, workspaceId, id);
      if (!current) throw err.notFound();

      const data: Prisma.EmployeeProfileUncheckedUpdateInput = {};
      const changed: string[] = [];
      const set = <K extends keyof Prisma.EmployeeProfileUncheckedUpdateInput>(
        key: K,
        value: Prisma.EmployeeProfileUncheckedUpdateInput[K],
      ) => {
        data[key] = value;
        changed.push(key as string);
      };

      if (dto.employeeNo !== undefined) {
        const employeeNo = requiredText(dto.employeeNo, 'employeeNo', 64);
        if (employeeNo !== current.employeeNo) {
          const other = await this.byEmployeeNo(tx, workspaceId, employeeNo);
          if (other && other.id !== id) throw err.employeeNoTaken();
          set('employeeNo', employeeNo);
        }
      }
      if (dto.email !== undefined) {
        const email = validEmail(dto.email);
        if (email !== current.email) {
          // 綁定是用 email 對應的；改 email 會改變 SSO 對應，必須先解除綁定
          if (current.userId) throw err.emailLocked();
          const other = await this.byEmail(tx, workspaceId, email);
          if (other && other.id !== id) throw err.emailTaken();
          set('email', email);
        }
      }
      if (dto.fullName !== undefined) {
        const fullName = requiredText(dto.fullName, 'fullName', 100);
        if (fullName !== current.fullName) set('fullName', fullName);
      }
      if (dto.hireDate !== undefined) {
        const hireDate = parseDateOrThrow(dto.hireDate, 'hireDate');
        if (current.terminationDate && hireDate.getTime() > current.terminationDate.getTime()) {
          throw err.invalidDate('hireDate（不能晚於離職日）');
        }
        if (hireDate.getTime() !== current.hireDate.getTime()) set('hireDate', hireDate);
      }
      if (dto.jobTitle !== undefined) {
        const jobTitle = dto.jobTitle.trim();
        if (jobTitle !== current.jobTitle) set('jobTitle', jobTitle);
      }
      if (dto.phone !== undefined) {
        const phone = dto.phone.trim();
        if (phone !== current.phone) set('phone', phone);
      }
      if (dto.employmentType !== undefined && dto.employmentType !== current.employmentType) {
        set('employmentType', dto.employmentType);
      }
      if (dto.employmentStatus !== undefined && dto.employmentStatus !== current.employmentStatus) {
        // 離職的人不能用 PATCH 改回在職：復職要走 reinstate（才會清掉 User.disabledAt）
        if (current.employmentStatus === 'terminated') throw err.alreadyTerminated('已離職的員工請用「復職」');
        set('employmentStatus', dto.employmentStatus);
      }
      if (dto.departmentId !== undefined && dto.departmentId !== current.departmentId) {
        if (dto.departmentId !== null) await this.assertDepartment(tx, workspaceId, dto.departmentId);
        set('departmentId', dto.departmentId);
      }
      if (dto.managerProfileId !== undefined && dto.managerProfileId !== current.managerProfileId) {
        if (dto.managerProfileId !== null) await this.assertManagerNoCycle(tx, workspaceId, id, dto.managerProfileId);
        set('managerProfileId', dto.managerProfileId);
      }

      if (changed.length === 0) return { row: current, changed, before: current };
      const row = (await tx.employeeProfile.update({ where: { id }, data, select: EMPLOYEE_SELECT })) as EmployeeRow;
      return { row, changed, before: current };
    });

    if (result.changed.length > 0) {
      await this.audit.record({
        actorId,
        workspaceId,
        action: 'employee.update',
        targetType: 'employee_profile',
        targetId: id,
        // 只記改了哪些欄位，不記值（個資）；狀態與部門是結構性資料，記前後
        metadata: {
          fields: result.changed,
          ...(result.changed.includes('employmentStatus')
            ? { statusFrom: result.before.employmentStatus, statusTo: result.row.employmentStatus }
            : {}),
          ...(result.changed.includes('departmentId')
            ? { departmentFrom: result.before.departmentId, departmentTo: result.row.departmentId }
            : {}),
        },
        req,
      });
    }
    return toEmployeeDto(result.row);
  }

  // ─────────────── 離職、復職、解除綁定 ───────────────

  async terminate(actorId: string, workspaceId: string, id: string, dto: TerminateEmployeeDto, req?: AuditRequestContext) {
    const terminationDate = parseDateOrThrow(dto.terminationDate, 'terminationDate');
    const now = this.clock.now();

    const outcome = await this.prisma.$transaction(async (tx) => {
      const profile = await this.findRow(tx, workspaceId, id);
      if (!profile) throw err.notFound();
      // ── 先擋（任何寫入之前） ──
      if (profile.userId && profile.userId === actorId) throw err.cannotTerminateSelf();
      if (profile.employmentStatus === 'terminated') throw err.alreadyTerminated();
      if (terminationDate.getTime() < profile.hireDate.getTime()) throw err.invalidDate('terminationDate（不能早於到職日）');
      const owned = profile.userId ? await this.ownedWorkspaces(tx, profile.userId) : [];
      // 待移交的 owner（company:init 時他還沒綁 SSO，記在 pendingOwnerEmail）：跟現任 owner 一樣要先改指定別人。
      // 否則他離職後再也不能 SSO 登入，移交永遠不會發生，公司就一直由 company:init 的執行者當 owner。
      const pending = await this.pendingOwnerWorkspace(tx, workspaceId, profile.email);
      if (pending && !owned.some((w) => w.id === pending.id)) owned.push(pending);
      if (owned.length > 0) throw err.ownerTransfer(owned.sort((a, b) => a.name.localeCompare(b.name)));

      // ── 寫入 ──
      await tx.employeeProfile.update({
        where: { id },
        data: { employmentStatus: 'terminated', terminationDate },
      });
      const stats = { revokedRefreshTokens: 0, revokedBots: 0, removedMemberships: 0 };
      if (profile.userId) {
        const userId = profile.userId;
        await tx.user.update({
          where: { id: userId },
          data: { disabledAt: now, tokenVersion: { increment: 1 } },
        });
        stats.revokedRefreshTokens = await this.refreshTokens.revokeAllForUser(userId, tx);
        stats.revokedBots = (
          await tx.botAccount.updateMany({ where: { createdById: userId, revokedAt: null }, data: { revokedAt: now } })
        ).count;
        stats.removedMemberships = (await tx.workspaceMember.deleteMany({ where: { userId } })).count;
      }
      return { profile, stats };
    });

    const userId = outcome.profile.userId;
    let disconnectedSockets = 0;
    if (userId) {
      // commit 之後再撤銷一次：撈出交易途中才 commit 的 refresh token 換發與新建的 bot
      outcome.stats.revokedRefreshTokens += await this.refreshTokens.revokeAllForUser(userId);
      outcome.stats.revokedBots += (
        await this.prisma.botAccount.updateMany({
          where: { createdById: userId, revokedAt: null },
          data: { revokedAt: this.clock.now() },
        })
      ).count;
      // 覆寫成停用（不是只刪 key）：在途的舊「沒停用」NX 寫入蓋不掉它
      if (!(await this.userStatus.markDisabled(userId))) {
        this.logger.error(`terminate: could not mark user ${userId} disabled in cache; DB is disabled, cache may lag ≤30s`);
      }
      disconnectedSockets = this.sockets.disconnectUser(userId);
    }

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'employee.terminate',
      targetType: 'employee_profile',
      targetId: id,
      metadata: {
        employeeNo: outcome.profile.employeeNo,
        terminationDate: formatDate(terminationDate),
        userId,
        ...outcome.stats,
        disconnectedSockets,
      },
      req,
    });
    return this.get(workspaceId, id);
  }

  async reinstate(actorId: string, workspaceId: string, id: string, req?: AuditRequestContext) {
    const profile = await this.prisma.$transaction(async (tx) => {
      const current = await this.findRow(tx, workspaceId, id);
      if (!current) throw err.notFound();
      if (current.employmentStatus !== 'terminated') throw err.notTerminated();
      await tx.employeeProfile.update({ where: { id }, data: { employmentStatus: 'active', terminationDate: null } });
      if (current.userId) {
        await tx.user.update({ where: { id: current.userId }, data: { disabledAt: null } });
      }
      return current;
    });
    // 重讀 DB 並覆寫快取：快取裡的「停用」立刻換掉（不會等 30 秒）
    if (profile.userId) await this.userStatus.refresh(profile.userId);

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'employee.reinstate',
      targetType: 'employee_profile',
      targetId: id,
      metadata: {
        employeeNo: profile.employeeNo,
        userId: profile.userId,
        previousTerminationDate: profile.terminationDate ? formatDate(profile.terminationDate) : null,
      },
      req,
    });
    return this.get(workspaceId, id);
  }

  /**
   * 解除綁定（spec §4.3「員工對應」第 2 點：Authentik 重建帳號導致 sub 改變）：profile.userId → null、
   * 刪除舊 User 的 authentik Account，並結束舊帳號的所有 session（tokenVersion + 1、撤銷 refresh token、
   * 斷開 socket），也撤銷他建立的 bot。之後用新的 sub 登入時會依 email 重新綁定。
   */
  async unbind(actorId: string, workspaceId: string, id: string, req?: AuditRequestContext) {
    const now = this.clock.now();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await this.findRow(tx, workspaceId, id);
      if (!current) throw err.notFound();
      if (!current.userId) throw err.notBound();
      const userId = current.userId;
      const cleared = await tx.employeeProfile.updateMany({ where: { id, userId }, data: { userId: null } });
      if (cleared.count !== 1) throw err.notBound();
      const accounts = await tx.account.deleteMany({ where: { userId, provider: SSO_PROVIDER } });
      await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
      const revokedRefreshTokens = await this.refreshTokens.revokeAllForUser(userId, tx);
      const revokedBots = (
        await tx.botAccount.updateMany({ where: { createdById: userId, revokedAt: null }, data: { revokedAt: now } })
      ).count;
      return { current, userId, deletedAccounts: accounts.count, revokedRefreshTokens, revokedBots };
    });

    await this.refreshTokens.revokeAllForUser(outcome.userId);
    await this.prisma.botAccount.updateMany({
      where: { createdById: outcome.userId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    await this.userStatus.refresh(outcome.userId);
    const disconnectedSockets = this.sockets.disconnectUser(outcome.userId);

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'employee.unbind',
      targetType: 'employee_profile',
      targetId: id,
      metadata: {
        employeeNo: outcome.current.employeeNo,
        userId: outcome.userId,
        deletedAccounts: outcome.deletedAccounts,
        revokedRefreshTokens: outcome.revokedRefreshTokens,
        revokedBots: outcome.revokedBots,
        disconnectedSockets,
      },
      req,
    });
    return this.get(workspaceId, id);
  }

  // ─────────────── CSV 匯入 ───────────────

  async importCsv(actorId: string, workspaceId: string, dto: ImportEmployeesDto, req?: AuditRequestContext) {
    if (Buffer.byteLength(dto.csv, 'utf8') > EMPLOYEE_IMPORT_MAX_BYTES) {
      throw new PayloadTooLargeException('CSV 超過 1 MB');
    }
    let parsed: ReturnType<typeof parseEmployeeCsv>;
    try {
      parsed = parseEmployeeCsv(dto.csv);
    } catch (e) {
      if (e instanceof CsvParseError || e instanceof EmployeeCsvHeaderError) throw err.invalidCsv(e.message);
      throw e;
    }
    if (parsed.rows.length === 0 && parsed.malformed.length === 0) throw err.invalidCsv('CSV 沒有任何資料列');

    const result = await this.employees.importRows(parsed.rows, {
      actorId,
      workspaceId,
      req,
      dryRun: dto.dryRun === true,
      auditExtra: { source: 'admin', malformed: parsed.malformed.length },
    });
    const errors = [
      ...parsed.malformed.map((m) => ({ line: m.line, message: m.reason })),
      ...result.results
        .filter((r) => r.status === 'error')
        .map((r) => ({ line: r.line ?? 0, message: r.reason ?? '' })),
    ].sort((a, b) => a.line - b.line);
    return {
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      errors,
      dryRun: result.dryRun,
    };
  }

  // ─────────────── helpers ───────────────

  private findRow(db: Db, workspaceId: string, id: string): Promise<EmployeeRow | null> {
    return db.employeeProfile.findFirst({ where: { id, workspaceId }, select: EMPLOYEE_SELECT }) as Promise<EmployeeRow | null>;
  }

  private byEmployeeNo(db: Db, workspaceId: string, employeeNo: string) {
    return db.employeeProfile.findUnique({
      where: { workspaceId_employeeNo: { workspaceId, employeeNo } },
      select: { id: true },
    });
  }

  private byEmail(db: Db, workspaceId: string, email: string) {
    return db.employeeProfile.findUnique({ where: { workspaceId_email: { workspaceId, email } }, select: { id: true } });
  }

  /** 交易＋組織結構鎖；撞到唯一索引（同時有人用了同一個編號／email）→ 409，外鍵（部門剛被刪）→ 400。 */
  private async runProfileTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockOrgStructure(tx);
        return fn(tx);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw uniqueTargetMentions(e, 'email') ? err.emailTaken() : err.employeeNoTaken();
      if (isForeignKeyViolation(e)) throw err.departmentNotFound();
      throw e;
    }
  }

  private async assertDepartment(db: Db, workspaceId: string, departmentId: string) {
    const dept = await db.department.findFirst({
      where: { id: departmentId, workspaceId },
      select: { id: true, archivedAt: true },
    });
    if (!dept) throw err.departmentNotFound();
    if (dept.archivedAt) throw err.departmentArchived();
  }

  private async assertManagerExists(db: Db, workspaceId: string, managerProfileId: string) {
    const m = await db.employeeProfile.findFirst({
      where: { id: managerProfileId, workspaceId },
      select: { id: true, employmentStatus: true },
    });
    if (!m || m.employmentStatus === 'terminated') throw err.managerNotFound();
  }

  /** 新主管不能是自己；沿新主管的主管鏈往上走，碰到自己就是循環。 */
  private async assertManagerNoCycle(db: Db, workspaceId: string, selfId: string, managerProfileId: string) {
    if (managerProfileId === selfId) throw err.managerCycle();
    const m = await db.employeeProfile.findFirst({
      where: { id: managerProfileId, workspaceId },
      select: { id: true, employmentStatus: true, managerProfileId: true },
    });
    if (!m || m.employmentStatus === 'terminated') throw err.managerNotFound();
    const seen = new Set<string>([m.id]);
    let cursor = m.managerProfileId;
    for (let i = 0; cursor; i++) {
      if (cursor === selfId) throw err.managerCycle();
      // 既有資料已經有環、或鏈長得不合理：當成循環，拒絕
      if (seen.has(cursor) || i >= ORG_WALK_LIMIT) throw err.managerCycle();
      seen.add(cursor);
      const next = await db.employeeProfile.findFirst({
        where: { id: cursor, workspaceId },
        select: { managerProfileId: true },
      });
      cursor = next?.managerProfileId ?? null;
    }
  }

  /** 他是哪些（沒刪除的）工作空間的 owner：主 owner（Workspace.ownerId）或成員角色 owner。 */
  private async ownedWorkspaces(db: Db, userId: string): Promise<{ id: string; name: string }[]> {
    const [main, coOwned] = await Promise.all([
      db.workspace.findMany({ where: { ownerId: userId, deletedAt: null }, select: { id: true, name: true } }),
      db.workspaceMember.findMany({
        where: { userId, role: 'owner', workspace: { deletedAt: null } },
        select: { workspace: { select: { id: true, name: true } } },
      }),
    ]);
    const byId = new Map<string, { id: string; name: string }>();
    for (const w of main) byId.set(w.id, { id: w.id, name: w.name });
    for (const m of coOwned) byId.set(m.workspace.id, { id: m.workspace.id, name: m.workspace.name });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 公司工作空間的 `pendingOwnerEmail` 是不是這個 email（不分大小寫）；是就回傳該工作空間。 */
  private async pendingOwnerWorkspace(db: Db, workspaceId: string, email: string): Promise<{ id: string; name: string } | null> {
    const ws = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, pendingOwnerEmail: true, deletedAt: true },
    });
    if (!ws || ws.deletedAt || !ws.pendingOwnerEmail) return null;
    return normalizeEmail(ws.pendingOwnerEmail) === normalizeEmail(email) ? { id: ws.id, name: ws.name } : null;
  }
}
