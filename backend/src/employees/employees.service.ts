import { BadRequestException, Injectable } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { AuditRequestContext, AuditService } from '../audit/audit.service';
import { CompanyService } from '../company/company.service';

/** 一筆要匯入的員工（CSV 一行或 H2 後台送來的一筆）。字串都還沒正規化。 */
export interface EmployeeImportRow {
  /** 來源行號（CSV 用；後台可省略） */
  line?: number;
  employeeNo: string;
  email: string;
  fullName: string;
  /** YYYY-MM-DD */
  hireDate: string;
  /** 根部門名稱（不分大小寫比對；沒有就建立）。空字串 = 不指定部門 */
  departmentName?: string;
  jobTitle?: string;
}

export type EmployeeImportStatus = 'created' | 'updated' | 'error';

export interface EmployeeImportRowResult {
  line?: number;
  employeeNo: string;
  status: EmployeeImportStatus;
  /** status=error 時的原因（繁體中文） */
  reason?: string;
  profileId?: string;
}

export interface EmployeeImportResult {
  workspaceId: string;
  results: EmployeeImportRowResult[];
  created: number;
  updated: number;
  failed: number;
}

export interface NormalizedEmployee {
  employeeNo: string;
  email: string;
  fullName: string;
  hireDate: Date;
  departmentName: string;
  jobTitle: string;
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
  const departmentName = (row.departmentName ?? '').trim();
  const jobTitle = (row.jobTitle ?? '').trim();

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
    if (value.length > MAX_LEN[key as keyof typeof MAX_LEN]) {
      return { error: `${key} 太長（上限 ${MAX_LEN[key as keyof typeof MAX_LEN]} 字）` };
    }
  }
  return { value: { employeeNo, email, fullName, hireDate, departmentName, jobTitle } };
}

/** 單筆 upsert 的錯誤：會變成該列的 error，不中斷整批。 */
export class EmployeeRowError extends Error {}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

/**
 * 員工主檔匯入（H1 的 CLI 與 H2 的後台共用）。
 *
 * - upsert 依據 (workspaceId, employeeNo)；email 一律小寫。
 * - 同一個 email 已屬於另一個 employeeNo → 該列失敗（不搶別人的 email）。
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
    opts: { actorId?: string | null; workspaceId?: string; req?: AuditRequestContext } = {},
  ): Promise<EmployeeImportResult> {
    const workspaceId = await this.resolveCompanyWorkspaceId(opts.workspaceId);
    const departmentCache = new Map<string, string>();
    const seenEmployeeNos = new Set<string>();
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
      try {
        const { status, profileId } = await this.upsertNormalized(workspaceId, value, departmentCache);
        results.push({ line: row.line, employeeNo: value.employeeNo, status, profileId });
      } catch (err) {
        const reason =
          err instanceof EmployeeRowError
            ? err.message
            : isUniqueViolation(err)
              ? '與既有員工資料衝突（員工編號、email 或部門名稱重複），請重試或檢查資料'
              : `寫入失敗：${(err as Error).message}`;
        results.push({ line: row.line, employeeNo: value.employeeNo, status: 'error', reason });
      }
    }

    const created = results.filter((r) => r.status === 'created').length;
    const updated = results.filter((r) => r.status === 'updated').length;
    const failed = results.filter((r) => r.status === 'error').length;

    await this.audit.record({
      actorId: opts.actorId ?? null,
      workspaceId,
      action: 'employee.import',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { total: rows.length, created, updated, failed },
      req: opts.req,
    });

    return { workspaceId, results, created, updated, failed };
  }

  /** 單筆 upsert（不寫 audit）：company:init 建立 owner 的員工資料也用這個。 */
  async upsertOne(workspaceId: string, row: EmployeeImportRow): Promise<{ status: 'created' | 'updated'; profileId: string }> {
    const normalized = normalizeEmployeeRow(row);
    if ('error' in normalized) throw new EmployeeRowError(normalized.error);
    return this.upsertNormalized(workspaceId, normalized.value, new Map());
  }

  private async upsertNormalized(
    workspaceId: string,
    value: NormalizedEmployee,
    departmentCache: Map<string, string>,
  ): Promise<{ status: 'created' | 'updated'; profileId: string }> {
    const byEmail = await this.prisma.employeeProfile.findUnique({
      where: { workspaceId_email: { workspaceId, email: value.email } },
      select: { id: true, employeeNo: true },
    });
    if (byEmail && byEmail.employeeNo !== value.employeeNo) {
      throw new EmployeeRowError(`此 email 已屬於另一位員工（員工編號 ${byEmail.employeeNo}）`);
    }

    const departmentId = value.departmentName
      ? await this.findOrCreateRootDepartment(workspaceId, value.departmentName, departmentCache)
      : null;

    const data = {
      email: value.email,
      fullName: value.fullName,
      hireDate: value.hireDate,
      jobTitle: value.jobTitle,
      departmentId,
    };

    const existing = await this.prisma.employeeProfile.findUnique({
      where: { workspaceId_employeeNo: { workspaceId, employeeNo: value.employeeNo } },
      select: { id: true },
    });
    if (existing) {
      const row = await this.prisma.employeeProfile.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      });
      return { status: 'updated', profileId: row.id };
    }
    const row = await this.prisma.employeeProfile.create({
      data: { workspaceId, employeeNo: value.employeeNo, ...data },
      select: { id: true },
    });
    return { status: 'created', profileId: row.id };
  }

  /** 根部門：名稱不分大小寫比對；沒有就建立。已封存的同名部門 → 該列失敗。 */
  private async findOrCreateRootDepartment(
    workspaceId: string,
    name: string,
    cache: Map<string, string>,
  ): Promise<string> {
    const key = name.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    const find = () =>
      this.prisma.department.findFirst({
        where: { workspaceId, parentId: null, name: { equals: name, mode: 'insensitive' } },
        select: { id: true, archivedAt: true },
      });

    let dept = await find();
    if (!dept) {
      try {
        dept = await this.prisma.department.create({
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
