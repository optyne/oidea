import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isEmail } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { AuditRequestContext, AuditService } from '../audit/audit.service';
import { CompanyService } from '../company/company.service';
import { LOCKED_TX_OPTIONS, lockEmployeeProfile } from '../common/identity-lock';
import { lockOrgStructure } from './org-lock';
import { AuditChange, profileAuditChanges } from './employee-audit';
import type { IdentityRefusal } from './identity-guard';

type Db = Prisma.TransactionClient | PrismaService;

/** 匯入改 email 前的身分保護（H2 後台傳入；CLI 不傳，CLI 的操作者跟 company:init 一樣是可信的）。 */
export type EmailChangeGuard = (db: Db, profile: { userId: string | null; email: string }) => Promise<IdentityRefusal | null>;

/** 這筆既有 profile 是不是呼叫者本人（H2 後台傳入；是的話該列 `cannot_edit_self`）。 */
export type SelfGuard = (db: Db, profile: { userId: string | null; email: string }) => Promise<boolean>;

const EMAIL_GUARD_MESSAGES: Record<IdentityRefusal, string> = {
  pending_owner_email: '待移交 owner 的 email 不能用匯入修改，請重新執行 company:init',
  owner_protected: '這位員工是工作空間的 owner（或待移交的 owner），只有公司 owner 能修改 email',
  admin_protected: 'hr 不能修改公司 admin 的 email',
};

/** 一筆要匯入的員工（CSV 一行或 H2 後台送來的一筆）。字串都還沒正規化。 */
export interface EmployeeImportRow {
  /** 來源行號（CSV 用；後台可省略） */
  line?: number;
  employeeNo: string;
  email: string;
  fullName: string;
  /** YYYY-MM-DD */
  hireDate: string;
  /**
   * 根部門名稱（不分大小寫比對；沒有就建立）。
   * undefined = 這一欄不存在（CSV 檔頭沒有）：更新時**不動**原本的部門（review S10）；
   * 空字串 = 欄位存在但留白：新建時沒有部門，更新時**清掉**部門。
   */
  departmentName?: string;
  /** 同上：undefined = 不動；空字串 = 清成空字串。 */
  jobTitle?: string;
}

/** unchanged = 既有員工、要寫的欄位跟現在完全一樣（不寫入）。 */
export type EmployeeImportStatus = 'created' | 'updated' | 'unchanged' | 'error';

export interface EmployeeImportRowResult {
  line?: number;
  employeeNo: string;
  status: EmployeeImportStatus;
  /** status=error 時的原因（繁體中文） */
  reason?: string;
  /** status=error 時的機器碼（目前只有 `cannot_edit_self`） */
  code?: string;
  profileId?: string;
}

export interface EmployeeImportResult {
  workspaceId: string;
  results: EmployeeImportRowResult[];
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** true = 只試算，沒有寫入任何東西（也沒有寫 audit） */
  dryRun: boolean;
}

export interface NormalizedEmployee {
  employeeNo: string;
  email: string;
  fullName: string;
  hireDate: Date;
  /** undefined = 欄位不存在（更新時不動） */
  departmentName: string | undefined;
  /** undefined = 欄位不存在（更新時不動） */
  jobTitle: string | undefined;
}

const MAX_LEN = { employeeNo: 64, email: 254, fullName: 100, departmentName: 100, jobTitle: 100 };

/** email 一律存小寫、去前後空白（spec §4.2）。 */
export function normalizeEmail(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** 'YYYY-MM-DD' → UTC 午夜的 Date（存進 @db.Date）；格式或日期不合法回 null。 */
export function parseIsoDate(raw: string | null | undefined): Date | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** 驗證並正規化一筆；不合法回 { error }。 */
export function normalizeEmployeeRow(row: EmployeeImportRow): { value: NormalizedEmployee } | { error: string } {
  const employeeNo = (row.employeeNo ?? '').trim();
  const email = normalizeEmail(row.email);
  const fullName = (row.fullName ?? '').trim();
  const departmentName = typeof row.departmentName === 'string' ? row.departmentName.trim() : undefined;
  const jobTitle = typeof row.jobTitle === 'string' ? row.jobTitle.trim() : undefined;

  const missing: string[] = [];
  if (!employeeNo) missing.push('employeeNo');
  if (!email) missing.push('email');
  if (!fullName) missing.push('fullName');
  if (!(row.hireDate ?? '').trim()) missing.push('hireDate');
  if (missing.length > 0) return { error: `缺少必填欄位：${missing.join(', ')}` };

  if (!isEmail(email) || email.length > MAX_LEN.email) return { error: 'email 格式不正確' };
  const hireDate = parseIsoDate(row.hireDate);
  if (!hireDate) return { error: 'hireDate 必須是有效的 YYYY-MM-DD 日期' };
  for (const [key, value] of Object.entries({ employeeNo, fullName, departmentName, jobTitle })) {
    if (value !== undefined && value.length > MAX_LEN[key as keyof typeof MAX_LEN]) {
      return { error: `${key} 太長（上限 ${MAX_LEN[key as keyof typeof MAX_LEN]} 字）` };
    }
  }
  return { value: { employeeNo, email, fullName, hireDate, departmentName, jobTitle } };
}

/** 單筆 upsert 的錯誤：會變成該列的 error，不中斷整批。 */
export class EmployeeRowError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

/**
 * 員工主檔匯入（H1 的 CLI 與 H2 的後台共用）。
 *
 * - upsert 依據 (workspaceId, employeeNo)；email 一律小寫。
 * - 同一個 email 已屬於另一個 employeeNo → 該列失敗（不搶別人的 email）。
 * - 更新既有員工時只寫有提供的欄位：departmentName／jobTitle 欄位不存在就不動（review S10）。
 * - 已綁定使用者帳號（userId 有值）的員工不能用匯入改 email → 該列失敗（要在 H2 後台處理）。
 * - 部門只處理根部門：依名稱不分大小寫比對，沒有就建立。
 * - 每一列各自成敗；整批結束寫一筆 audit `employee.import`（只有數量，不含個資）。
 */
@Injectable()
export class EmployeesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private company: CompanyService,
  ) {}

  /** 找出要匯入的公司工作空間；沒有 company:init 就拒絕。 */
  async resolveCompanyWorkspaceId(workspaceId?: string): Promise<string> {
    const company = await this.company.findCompanyWorkspace();
    if (!company) {
      throw new BadRequestException('公司工作空間尚未初始化，請先執行 npm run company:init');
    }
    if (workspaceId && workspaceId !== company.id) {
      throw new BadRequestException('員工資料只能匯入公司工作空間');
    }
    return company.id;
  }

  async importRows(
    rows: EmployeeImportRow[],
    opts: {
      actorId?: string | null;
      workspaceId?: string;
      req?: AuditRequestContext;
      /** 只試算：做同樣的讀取與檢查，但不寫入任何東西、不寫 audit（H2 後台的預覽） */
      dryRun?: boolean;
      /** 併進 audit metadata 的額外數量（例如後台的 CSV 格式錯誤列數）；不可放個資 */
      auditExtra?: Record<string, number | string>;
      /** 既有員工要改 email 時先問這個（H2 後台：owner／待移交 owner／admin 的保護，review B1） */
      guardEmailChange?: EmailChangeGuard;
      /** 既有員工是呼叫者本人 → 該列失敗（H2 後台：不能用匯入改自己的資料，re-verify R1） */
      guardSelf?: SelfGuard;
    } = {},
  ): Promise<EmployeeImportResult> {
    const workspaceId = await this.resolveCompanyWorkspaceId(opts.workspaceId);
    const dryRun = opts.dryRun === true;
    const departmentCache = new Map<string, string>();
    const seenEmployeeNos = new Set<string>();
    // 試算時前面的列沒有真的寫入，「同一批裡 email 重複」要自己記（實際匯入時由 DB 查到）
    const seenEmails = new Map<string, string>();
    const results: EmployeeImportRowResult[] = [];

    for (const row of rows) {
      const employeeNoForReport = (row.employeeNo ?? '').trim();
      const normalized = normalizeEmployeeRow(row);
      if ('error' in normalized) {
        results.push({ line: row.line, employeeNo: employeeNoForReport, status: 'error', reason: normalized.error });
        continue;
      }
      const value = normalized.value;
      if (seenEmployeeNos.has(value.employeeNo)) {
        results.push({
          line: row.line,
          employeeNo: value.employeeNo,
          status: 'error',
          reason: '同一批資料裡員工編號重複',
        });
        continue;
      }
      seenEmployeeNos.add(value.employeeNo);
      const emailOwner = seenEmails.get(value.email);
      if (dryRun && emailOwner !== undefined && emailOwner !== value.employeeNo) {
        results.push({
          line: row.line,
          employeeNo: value.employeeNo,
          status: 'error',
          reason: `此 email 已屬於另一位員工（員工編號 ${emailOwner}）`,
        });
        continue;
      }
      try {
        // 每一列一個交易＋組織結構鎖（review N2）：同時有人刪部門時，不會在檢查與寫入之間被 SetNull 清掉。
        // 不包成整批一個交易：Postgres 交易裡一個語句失敗，整個交易就不能再用（這裡要逐列回報錯誤）。
        // 部門快取在這一列成功之後才併回去（這一列 rollback 時，它建的部門也不存在了）。
        const rowCache = new Map(departmentCache);
        const { status, profileId, fields, changes } = await this.prisma.$transaction(async (tx) => {
          await lockOrgStructure(tx);
          return this.upsertNormalized(workspaceId, value, rowCache, dryRun, tx, opts.guardEmailChange ?? null, true, opts.guardSelf ?? null);
        }, LOCKED_TX_OPTIONS);
        for (const [k, v] of rowCache) departmentCache.set(k, v);
        seenEmails.set(value.email, value.employeeNo);
        results.push({ line: row.line, employeeNo: value.employeeNo, status, profileId });
        // 匯入改到的每一筆都有一筆 employee.update（跟 PATCH 同樣的 changes 格式，H2 re-verify S7）
        if (!dryRun && status === 'updated' && fields && changes) {
          await this.audit.record({
            actorId: opts.actorId ?? null,
            workspaceId,
            action: 'employee.update',
            targetType: 'employee_profile',
            targetId: profileId,
            metadata: { source: 'import', line: row.line ?? null, fields, changes },
            req: opts.req,
          });
        }
      } catch (err) {
        const reason =
          err instanceof EmployeeRowError
            ? err.message
            : isUniqueViolation(err)
              ? '與既有員工資料衝突（員工編號、email 或部門名稱重複），請重試或檢查資料'
              : `寫入失敗：${(err as Error).message}`;
        const code = err instanceof EmployeeRowError ? err.code : undefined;
        results.push({ line: row.line, employeeNo: value.employeeNo, status: 'error', reason, ...(code ? { code } : {}) });
      }
    }

    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    const unchanged = results.filter((r) => r.status === 'unchanged').length;
    const failed = results.filter((r) => r.status === 'error').length;

    if (!dryRun) {
      await this.audit.record({
        actorId: opts.actorId ?? null,
        workspaceId,
        action: 'employee.import',
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { ...(opts.auditExtra ?? {}), total: rows.length, created, updated, unchanged, failed },
        req: opts.req,
      });
    }

    return { workspaceId, results, created, updated, unchanged, failed, dryRun };
  }

  /** 單筆 upsert（不寫 audit）：company:init 建立 owner 的員工資料也用這個。 */
  async upsertOne(
    workspaceId: string,
    row: EmployeeImportRow,
  ): Promise<{ status: 'created' | 'updated' | 'unchanged'; profileId: string }> {
    const normalized = normalizeEmployeeRow(row);
    if ('error' in normalized) throw new EmployeeRowError(normalized.error);
    return this.upsertNormalized(workspaceId, normalized.value, new Map());
  }

  private async upsertNormalized(
    workspaceId: string,
    value: NormalizedEmployee,
    departmentCache: Map<string, string>,
    dryRun = false,
    db: Db = this.prisma,
    guardEmailChange: EmailChangeGuard | null = null,
    /** db 是交易（拿得到 advisory lock）；company:init 的 upsertOne 不在交易裡 */
    inTx = false,
    guardSelf: SelfGuard | null = null,
  ): Promise<{
    status: 'created' | 'updated' | 'unchanged';
    profileId: string;
    fields?: string[];
    changes?: Record<string, AuditChange>;
  }> {
    const findExisting = () =>
      db.employeeProfile.findUnique({
        where: { workspaceId_employeeNo: { workspaceId, employeeNo: value.employeeNo } },
        select: { id: true, email: true, userId: true, fullName: true, hireDate: true, jobTitle: true, departmentId: true },
      });
    let existing = await findExisting();
    if (existing && inTx) {
      // 跟 SSO 綁定、解除綁定排隊（review S3），拿到鎖之後重讀綁定狀態
      await lockEmployeeProfile(db, existing.id);
      existing = await findExisting();
    }
    // email 衝突在 profile 鎖之後才讀（re-verify N-6）
    const byEmail = await db.employeeProfile.findUnique({
      where: { workspaceId_email: { workspaceId, email: value.email } },
      select: { id: true, employeeNo: true },
    });
    if (byEmail && byEmail.employeeNo !== value.employeeNo) {
      throw new EmployeeRowError(`此 email 已屬於另一位員工（員工編號 ${byEmail.employeeNo}）`);
    }
    // 自己的 HR 資料要由別人改，匯入也一樣（re-verify R1；PATCH 是 403 cannot_edit_self）
    if (existing && guardSelf && (await guardSelf(db, { userId: existing.userId, email: existing.email }))) {
      throw new EmployeeRowError('不能用匯入修改自己的員工資料，請由其他管理者處理', 'cannot_edit_self');
    }
    if (existing && existing.email !== value.email && guardEmailChange) {
      const refusal = await guardEmailChange(db, { userId: existing.userId, email: existing.email });
      if (refusal) throw new EmployeeRowError(EMAIL_GUARD_MESSAGES[refusal]);
    }
    if (existing && existing.userId && existing.email !== value.email) {
      // 綁定是用 email 對應的；改 email 會讓這位員工的 SSO 對應改變，要在後台確認後處理
      throw new EmployeeRowError('已綁定帳號的員工不能用匯入改 email，請在後台（H2）處理');
    }

    // undefined = CSV 沒有這一欄 → 不動；'' = 清掉
    const departmentId =
      value.departmentName === undefined
        ? undefined
        : value.departmentName
          ? await this.findOrCreateRootDepartment(workspaceId, value.departmentName, departmentCache, dryRun, db)
          : null;

    const data = {
      email: value.email,
      fullName: value.fullName,
      hireDate: value.hireDate,
      ...(value.jobTitle !== undefined ? { jobTitle: value.jobTitle } : {}),
      ...(departmentId !== undefined ? { departmentId } : {}),
    };

    if (existing) {
      const same =
        existing.email === data.email &&
        existing.fullName === data.fullName &&
        existing.hireDate?.getTime?.() === data.hireDate.getTime() &&
        (data.jobTitle === undefined || existing.jobTitle === data.jobTitle) &&
        (data.departmentId === undefined || existing.departmentId === data.departmentId);
      if (same) return { status: 'unchanged', profileId: existing.id };
      if (dryRun) return { status: 'updated', profileId: existing.id };
      const row = await db.employeeProfile.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      });
      const before = existing as Record<string, unknown>;
      const after = data as Record<string, unknown>;
      const fields = Object.keys(data).filter((k) => {
        const a = before[k];
        const b = after[k];
        return a instanceof Date && b instanceof Date ? a.getTime() !== b.getTime() : a !== b;
      });
      return { status: 'updated', profileId: row.id, fields, changes: profileAuditChanges(fields, before, after) };
    }
    if (dryRun) return { status: 'created', profileId: '' };
    const row = await db.employeeProfile.create({
      data: { workspaceId, employeeNo: value.employeeNo, jobTitle: '', departmentId: null, ...data },
      select: { id: true },
    });
    return { status: 'created', profileId: row.id };
  }

  /** 根部門：名稱不分大小寫比對；沒有就建立。已封存的同名部門 → 該列失敗。 */
  private async findOrCreateRootDepartment(
    workspaceId: string,
    name: string,
    cache: Map<string, string>,
    dryRun = false,
    db: Db = this.prisma,
  ): Promise<string> {
    const key = name.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    // 不用 Prisma 的 `mode: 'insensitive'`：在 Postgres 上是 ILIKE，`_`／`%` 會被當萬用字元
    // （CSV 的部門 `A_B` 會掛到既有的 `AxB`，review N-a）。改用參數化的 `lower("name") = lower($1)`，
    // 跟 migration 的 partial unique index `departments_root_name_key` 用同一個運算式。
    const find = async () => {
      const rows = await db.$queryRaw<{ id: string; archivedAt: Date | null }[]>`SELECT "id", "archivedAt" FROM "departments" WHERE "workspaceId" = ${workspaceId} AND "parentId" IS NULL AND lower("name") = lower(${name}) LIMIT 1`;
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    };

    let dept = await find();
    if (!dept && dryRun) {
      // 試算：不建立部門；用一個不會等於任何真實 id 的佔位值（員工會被算成 updated／created）
      const placeholder = `dry-run:${key}`;
      cache.set(key, placeholder);
      return placeholder;
    }
    if (!dept) {
      try {
        dept = await db.department.create({
          data: { workspaceId, name, parentId: null },
          select: { id: true, archivedAt: true },
        });
      } catch (err) {
        // 同時有人建了同名根部門（partial unique index 擋下）→ 重查一次
        if (!isUniqueViolation(err)) throw err;
        dept = await find();
        if (!dept) throw err;
      }
    }
    if (dept.archivedAt) throw new EmployeeRowError(`部門「${name}」已封存`);
    cache.set(key, dept.id);
    return dept.id;
  }
}
