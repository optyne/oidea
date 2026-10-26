import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { Clock } from '../common/clock';
import { AuditRequestContext, AuditService } from '../audit/audit.service';
import { apiError, isForeignKeyViolation, isUniqueViolation } from '../common/api-error';
import { CreateDepartmentDto, DEPARTMENT_NAME_MAX, UpdateDepartmentDto } from './dto/department.dto';
import { ORG_WALK_LIMIT } from './manager-resolver';
import { lockOrgStructure } from './org-lock';
import { LOCKED_TX_OPTIONS } from '../common/identity-lock';

type Db = Prisma.TransactionClient | PrismaService;

export interface DepartmentDto {
  id: string;
  name: string;
  parentId: string | null;
  managerProfileId: string | null;
  managerName: string | null;
  sortOrder: number;
  archivedAt: string | null;
  /** 不含已離職（terminated）的員工 */
  memberCount: number;
  childCount: number;
}

const DEPARTMENT_SELECT = {
  id: true,
  name: true,
  parentId: true,
  managerProfileId: true,
  sortOrder: true,
  archivedAt: true,
  manager: { select: { fullName: true } },
  _count: {
    select: {
      employees: { where: { employmentStatus: { not: 'terminated' } } },
      children: true,
    },
  },
} as const;

type DepartmentRow = {
  id: string;
  name: string;
  parentId: string | null;
  managerProfileId: string | null;
  sortOrder: number;
  archivedAt: Date | null;
  manager: { fullName: string } | null;
  _count: { employees: number; children: number };
};

export function toDepartmentDto(d: DepartmentRow): DepartmentDto {
  return {
    id: d.id,
    name: d.name,
    parentId: d.parentId,
    managerProfileId: d.managerProfileId,
    managerName: d.manager?.fullName ?? null,
    sortOrder: d.sortOrder,
    archivedAt: d.archivedAt ? d.archivedAt.toISOString() : null,
    memberCount: d._count.employees,
    childCount: d._count.children,
  };
}

export const departmentNotFound = () => apiError(HttpStatus.NOT_FOUND, 'department_not_found', '部門不存在');
const departmentArchived = () => apiError(HttpStatus.BAD_REQUEST, 'department_archived', '部門已封存');
const nameTaken = () => apiError(HttpStatus.CONFLICT, 'department_name_taken', '同一層已有同名的部門（不分大小寫）');
const cycle = () => apiError(HttpStatus.BAD_REQUEST, 'department_cycle', '不能把部門移到自己或自己的下層部門底下');
const managerNotFound = () => apiError(HttpStatus.BAD_REQUEST, 'manager_not_found', '主管必須是公司裡在職的員工');
const notEmpty = () =>
  apiError(HttpStatus.CONFLICT, 'department_not_empty', '部門裡還有員工（含已離職）或子部門，不能刪除；可以改用封存');

/** 部門名稱：去前後空白，1–100 字。 */
function normalizeName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new BadRequestException('部門名稱必填');
  if (name.length > DEPARTMENT_NAME_MAX) throw new BadRequestException(`部門名稱上限 ${DEPARTMENT_NAME_MAX} 字`);
  return name;
}

/**
 * 部門（公司工作空間的樹狀結構，spec §4.2、H2）。
 *
 * - 同一層（同一個上層、或都是根）不能同名，不分大小寫：先在程式裡查（跟 migration 手寫的
 *   partial unique index 用同一個運算式 `lower("name")`），寫入時再靠索引擋同時發生的重名，
 *   兩者都回 409 `department_name_taken`。
 * - 移動時不能形成環：新的上層是自己或自己的子孫 → 400 `department_cycle`。
 * - 有員工（含已離職）或子部門的部門不能刪除（409 `department_not_empty`），只能封存；封存允許有成員。
 * - 主管必須是公司工作空間裡、沒離職的員工主檔。
 * - 所有結構變更在交易裡拿組織結構鎖（org-lock.ts），環與「部門是空的」的檢查不會被同時的變更繞過。
 * - 每個寫入都寫 audit（department.*）。
 */
@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(workspaceId: string, includeArchived = false): Promise<DepartmentDto[]> {
    const rows = await this.prisma.department.findMany({
      where: { workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: DEPARTMENT_SELECT,
    });
    return (rows as DepartmentRow[]).map(toDepartmentDto);
  }

  async create(actorId: string, workspaceId: string, dto: CreateDepartmentDto, req?: AuditRequestContext) {
    const name = normalizeName(dto.name);
    const parentId = dto.parentId ?? null;
    const managerProfileId = dto.managerProfileId ?? null;

    const created = await this.runOrgTx(async (tx) => {
      if (parentId) {
        const parent = await this.findInCompany(tx, workspaceId, parentId);
        if (!parent) throw departmentNotFound();
        if (parent.archivedAt) throw departmentArchived();
      }
      if (managerProfileId) await this.assertManager(tx, workspaceId, managerProfileId);
      if (await this.nameClash(tx, workspaceId, parentId, name, null)) throw nameTaken();
      return tx.department.create({
        data: { workspaceId, name, parentId, managerProfileId, sortOrder: dto.sortOrder ?? 0 },
        select: DEPARTMENT_SELECT,
      });
    });

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'department.create',
      targetType: 'department',
      targetId: created.id,
      metadata: { name, parentId, managerProfileId },
      req,
    });
    return toDepartmentDto(created as DepartmentRow);
  }

  async update(actorId: string, workspaceId: string, id: string, dto: UpdateDepartmentDto, req?: AuditRequestContext) {
    const result = await this.runOrgTx(async (tx) => {
      const current = await this.findInCompany(tx, workspaceId, id);
      if (!current) throw departmentNotFound();

      const data: Prisma.DepartmentUncheckedUpdateInput = {};
      const changed: string[] = [];

      const name = dto.name !== undefined ? normalizeName(dto.name) : current.name;
      if (name !== current.name) {
        data.name = name;
        changed.push('name');
      }

      const parentId = dto.parentId === undefined ? current.parentId : dto.parentId;
      if (parentId !== current.parentId) {
        if (parentId !== null) await this.assertNoCycle(tx, workspaceId, id, parentId);
        data.parentId = parentId;
        changed.push('parentId');
      }

      // 名稱或位置變了才需要檢查重名（不分大小寫；改大小寫本身不算撞到自己）
      if ((data.name !== undefined || data.parentId !== undefined) && (await this.nameClash(tx, workspaceId, parentId, name, id))) {
        throw nameTaken();
      }

      if (dto.managerProfileId !== undefined && dto.managerProfileId !== current.managerProfileId) {
        if (dto.managerProfileId !== null) await this.assertManager(tx, workspaceId, dto.managerProfileId);
        data.managerProfileId = dto.managerProfileId;
        changed.push('managerProfileId');
      }

      if (dto.sortOrder !== undefined && dto.sortOrder !== current.sortOrder) {
        data.sortOrder = dto.sortOrder;
        changed.push('sortOrder');
      }

      if (changed.length === 0) {
        const row = await tx.department.findUnique({ where: { id }, select: DEPARTMENT_SELECT });
        return { row, changed, before: current };
      }
      const row = await tx.department.update({ where: { id }, data, select: DEPARTMENT_SELECT });
      return { row, changed, before: current };
    });

    if (result.changed.length > 0) {
      await this.audit.record({
        actorId,
        workspaceId,
        action: 'department.update',
        targetType: 'department',
        targetId: id,
        metadata: {
          fields: result.changed,
          ...(result.changed.includes('parentId')
            ? { parentFrom: result.before.parentId, parentTo: (result.row as DepartmentRow).parentId }
            : {}),
        },
        req,
      });
    }
    return toDepartmentDto(result.row as DepartmentRow);
  }

  /** 封存／取消封存。已經是那個狀態 → 不寫入也不寫 audit，直接回現況。 */
  async setArchived(actorId: string, workspaceId: string, id: string, archived: boolean, req?: AuditRequestContext) {
    // 在組織結構鎖底下（H2 review N1）：同時「在這個部門底下建子部門／把員工指派過來」的交易，
    // 要嘛先 commit（封存照做，跟封存時已有成員一樣），要嘛排在後面、看到已封存而被擋
    const result = await this.runOrgTx(async (tx) => {
      const current = await this.findInCompany(tx, workspaceId, id);
      if (!current) throw departmentNotFound();
      if (!!current.archivedAt === archived) {
        const row = await tx.department.findUnique({ where: { id }, select: DEPARTMENT_SELECT });
        return { current, row, changed: false };
      }
      const row = await tx.department.update({
        where: { id },
        data: { archivedAt: archived ? this.clock.now() : null },
        select: DEPARTMENT_SELECT,
      });
      return { current, row, changed: true };
    });
    const { current, row } = result;
    if (!result.changed) return toDepartmentDto(row as DepartmentRow);
    await this.audit.record({
      actorId,
      workspaceId,
      action: archived ? 'department.archive' : 'department.unarchive',
      targetType: 'department',
      targetId: id,
      metadata: { name: current.name },
      req,
    });
    return toDepartmentDto(row as DepartmentRow);
  }

  async remove(actorId: string, workspaceId: string, id: string, req?: AuditRequestContext) {
    const removed = await this.runOrgTx(async (tx) => {
      const current = await this.findInCompany(tx, workspaceId, id);
      if (!current) throw departmentNotFound();
      const [members, children] = await Promise.all([
        tx.employeeProfile.count({ where: { departmentId: id } }),
        tx.department.count({ where: { parentId: id } }),
      ]);
      if (members > 0 || children > 0) throw notEmpty();
      await tx.department.delete({ where: { id } });
      return current;
    }, notEmpty);
    await this.audit.record({
      actorId,
      workspaceId,
      action: 'department.delete',
      targetType: 'department',
      targetId: id,
      metadata: { name: removed.name, parentId: removed.parentId },
      req,
    });
    return { ok: true };
  }

  // ── helpers ──

  /**
   * 交易＋組織結構鎖。寫入時撞到唯一索引（同時有人建了同名部門）→ 409；
   * 外鍵衝突（同時有人在這個部門底下建了子部門、或剛把參照的部門刪掉）→ 409／404。
   */
  private async runOrgTx<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    onForeignKey: () => Error = departmentNotFound,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockOrgStructure(tx);
        return fn(tx);
      }, LOCKED_TX_OPTIONS);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      if (isForeignKeyViolation(err)) throw onForeignKey();
      throw err;
    }
  }

  private findInCompany(db: Db, workspaceId: string, id: string) {
    return db.department.findFirst({
      where: { id, workspaceId },
      select: { id: true, name: true, parentId: true, managerProfileId: true, sortOrder: true, archivedAt: true },
    });
  }

  /** 新的上層是自己或自己的子孫 → 400。上層不存在 → 404；上層已封存 → 400。 */
  private async assertNoCycle(db: Db, workspaceId: string, id: string, newParentId: string) {
    if (newParentId === id) throw cycle();
    const parent = await this.findInCompany(db, workspaceId, newParentId);
    if (!parent) throw departmentNotFound();
    if (parent.archivedAt) throw departmentArchived();
    const seen = new Set<string>([newParentId]);
    let cursor: string | null = parent.parentId;
    for (let i = 0; cursor; i++) {
      if (cursor === id) throw cycle();
      // 既有資料已經有環、或樹深得不合理：當成會形成環，拒絕
      if (seen.has(cursor) || i >= ORG_WALK_LIMIT) throw cycle();
      seen.add(cursor);
      const next = await db.department.findFirst({ where: { id: cursor, workspaceId }, select: { parentId: true } });
      cursor = next?.parentId ?? null;
    }
  }

  private async assertManager(db: Db, workspaceId: string, profileId: string) {
    const m = await db.employeeProfile.findFirst({
      where: { id: profileId, workspaceId },
      select: { id: true, employmentStatus: true },
    });
    if (!m || m.employmentStatus === 'terminated') throw managerNotFound();
  }

  /**
   * 同一層有沒有同名部門（不分大小寫，排除 excludeId）。跟 partial unique index 用同一個運算式
   * `lower("name")`；不用 Prisma 的 `mode: 'insensitive'`（Postgres 上是 ILIKE，`_`／`%` 是萬用字元）。
   */
  private async nameClash(db: Db, workspaceId: string, parentId: string | null, name: string, excludeId: string | null) {
    const rows = parentId === null
      ? await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "departments" WHERE "workspaceId" = ${workspaceId} AND "parentId" IS NULL AND lower("name") = lower(${name})`
      : await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "departments" WHERE "workspaceId" = ${workspaceId} AND "parentId" = ${parentId} AND lower("name") = lower(${name})`;
    return (Array.isArray(rows) ? rows : []).some((r) => r.id !== excludeId);
  }
}
