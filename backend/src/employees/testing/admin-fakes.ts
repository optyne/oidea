/**
 * H2 後台測試用的記憶體版 Prisma（只給 *.spec.ts）。延伸 SSO 的 FakeSsoPrisma（SSO 登入、refresh token、
 * JwtStrategy、attendance/today 照舊能跑），再加上部門與完整的員工主檔查詢。
 *
 * 跟真的 DB 一樣擋：
 * - 唯一性（丟 code=P2002）：User.email／username、EmployeeProfile (workspaceId, email)／(workspaceId, employeeNo)／userId、
 *   WorkspaceMember (workspaceId, userId)、BotAccount.tokenPrefix，以及 migration 手寫的兩個 partial unique index
 *   `departments_root_name_key`（同一個工作空間的根部門 lower(name)）、`departments_child_name_key`（同一個上層的 lower(name)）。
 * - 外鍵（丟 code=P2003）：Department.parentId 指向不存在的部門、刪除還有子部門的部門（onDelete: Restrict）；
 *   刪除部門時員工的 departmentId、部門主管 SetNull（跟 schema 一樣）。
 * - `$transaction(fn)`：fn 丟錯時所有資料表還原（rollback）。
 * - `pg_advisory_xact_lock`（org-lock.ts）：真的會互斥，直到持有它的交易結束；用來證明「同時移動部門」不會形成環。
 *   注意：只有拿了鎖的交易會被排隊；沒拿鎖、又同時跑的交易，rollback 的快照會互相覆蓋（測試不要這樣用）。
 * - Prisma 的 `mode: 'insensitive'` 一律丟錯：正式程式要用 `lower() = lower()`／`strpos(lower())`（Postgres 上 insensitive 是 ILIKE）。
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { Clock } from '../../common/clock';
import { fakeEmailQueryRaw, sqlText } from '../../common/testing/fake-email-raw';
import { FakeSsoPrisma } from '../../auth/oidc/testing/sso-fakes';
import { ORG_LOCK_KEY } from '../org-lock';

type Row = Record<string, any>;
type TableName =
  | 'users'
  | 'accounts'
  | 'profiles'
  | 'departments'
  | 'workspaces'
  | 'members'
  | 'bots'
  | 'refreshRows'
  | 'auditLogs';

interface RelationSpec {
  table: TableName;
  kind: 'one' | 'many';
  on: (row: Row, other: Row) => boolean;
}

const RELATIONS: Partial<Record<TableName, Record<string, RelationSpec>>> = {
  users: {
    botAccount: { table: 'bots', kind: 'one', on: (u, b) => b.userId === u.id },
    accounts: { table: 'accounts', kind: 'many', on: (u, a) => a.userId === u.id },
    employeeProfile: { table: 'profiles', kind: 'one', on: (u, p) => p.userId === u.id },
  },
  profiles: {
    user: { table: 'users', kind: 'one', on: (p, u) => p.userId != null && u.id === p.userId },
    department: { table: 'departments', kind: 'one', on: (p, d) => p.departmentId != null && d.id === p.departmentId },
    manager: { table: 'profiles', kind: 'one', on: (p, m) => p.managerProfileId != null && m.id === p.managerProfileId },
    workspace: { table: 'workspaces', kind: 'one', on: (p, w) => w.id === p.workspaceId },
    reports: { table: 'profiles', kind: 'many', on: (p, r) => r.managerProfileId === p.id },
  },
  departments: {
    parent: { table: 'departments', kind: 'one', on: (d, p) => d.parentId != null && p.id === d.parentId },
    children: { table: 'departments', kind: 'many', on: (d, c) => c.parentId === d.id },
    manager: { table: 'profiles', kind: 'one', on: (d, m) => d.managerProfileId != null && m.id === d.managerProfileId },
    employees: { table: 'profiles', kind: 'many', on: (d, p) => p.departmentId === d.id },
    workspace: { table: 'workspaces', kind: 'one', on: (d, w) => w.id === d.workspaceId },
  },
  members: {
    workspace: { table: 'workspaces', kind: 'one', on: (m, w) => w.id === m.workspaceId },
    user: { table: 'users', kind: 'one', on: (m, u) => u.id === m.userId },
  },
  bots: {
    user: { table: 'users', kind: 'one', on: (b, u) => u.id === b.userId },
    workspace: { table: 'workspaces', kind: 'one', on: (b, w) => w.id === b.workspaceId },
    createdBy: { table: 'users', kind: 'one', on: (b, u) => u.id === b.createdById },
  },
  auditLogs: {
    actor: { table: 'users', kind: 'one', on: (a, u) => a.actorId != null && u.id === a.actorId },
  },
  workspaces: {
    owner: { table: 'users', kind: 'one', on: (w, u) => u.id === w.ownerId },
  },
};

const p2002 = (target: string) =>
  Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002', meta: { target } });
const p2003 = (field: string) =>
  Object.assign(new Error(`Foreign key constraint failed on the field: ${field}`), { code: 'P2003', meta: { field_name: field } });
const p2025 = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' });

const comparable = (v: any) => (v instanceof Date ? v.getTime() : v);

function matchScalar(actual: any, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond !== 'object') return actual === cond;
  if (cond.mode === 'insensitive') {
    throw new Error('FakeAdminPrisma: mode=insensitive is not allowed (ILIKE on Postgres); use lower()/strpos() raw SQL');
  }
  for (const [op, v] of Object.entries(cond)) {
    if (v === undefined) continue;
    switch (op) {
      case 'equals':
        if (!matchScalar(actual, v)) return false;
        break;
      case 'in':
        if (!(v as any[]).some((x) => comparable(x) === comparable(actual))) return false;
        break;
      case 'notIn':
        if ((v as any[]).some((x) => comparable(x) === comparable(actual))) return false;
        break;
      case 'not':
        if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
          if (matchScalar(actual, v)) return false;
        } else if (matchScalar(actual, v)) return false;
        break;
      case 'lt':
        if (!(actual != null && comparable(actual) < comparable(v))) return false;
        break;
      case 'lte':
        if (!(actual != null && comparable(actual) <= comparable(v))) return false;
        break;
      case 'gt':
        if (!(actual != null && comparable(actual) > comparable(v))) return false;
        break;
      case 'gte':
        if (!(actual != null && comparable(actual) >= comparable(v))) return false;
        break;
      case 'startsWith':
        if (!(typeof actual === 'string' && actual.startsWith(v as string))) return false;
        break;
      case 'contains':
        if (!(typeof actual === 'string' && actual.includes(v as string))) return false;
        break;
      default:
        throw new Error(`FakeAdminPrisma: unsupported operator ${op}`);
    }
  }
  return true;
}

/** Prisma 的 compound unique（`workspaceId_email: {...}`）攤平成一般條件。 */
function flattenUnique(where: Row = {}): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (k.includes('_') && v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

interface TxContext {
  releases: (() => void)[];
  snapshot: Row;
}

export class FakeAdminPrisma extends FakeSsoPrisma {
  /** 比 SSO 版多了部門、主管、到職日等欄位 */
  override profiles: any[] = [];
  override bots: any[] = [];
  override auditLogs: any[] = [];
  departments: Row[] = [];
  /**
   * 每個 delegate 查詢延遲多久才執行（毫秒）。> 0 時，同時進來的兩個請求會在 DB 這一步交錯，
   * 用來證明「先讀整條鏈、再寫」在沒有鎖時會被同時的變更繞過。
   */
  latencyMs = 0;
  /** `$executeRaw` 收到的 SQL（斷言有拿組織結構鎖） */
  executed: string[] = [];
  private readonly txContext = new AsyncLocalStorage<TxContext>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly fakeClock: Clock) {
    super(fakeClock);
  }

  // ── seed helpers ──
  override addProfile(p: Row & { workspaceId: string; email: string; employeeNo: string }): any {
    const now = this.fakeClock.now();
    const row: Row = {
      id: randomUUID(),
      userId: null,
      fullName: p.employeeNo,
      departmentId: null,
      jobTitle: '',
      managerProfileId: null,
      employmentType: 'full_time',
      employmentStatus: 'active',
      hireDate: new Date(Date.UTC(2024, 0, 1)),
      terminationDate: null,
      phone: '',
      createdAt: now,
      updatedAt: now,
      ...p,
    };
    this.profiles.push(row as any);
    return row;
  }

  addDepartment(p: Row & { workspaceId: string; name: string }): Row {
    const now = this.fakeClock.now();
    const row: Row = {
      id: randomUUID(),
      parentId: null,
      managerProfileId: null,
      sortOrder: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      ...p,
    };
    this.departments.push(row);
    return row;
  }

  // ── generic engine ──
  private table(name: TableName): Row[] {
    return (this as any)[name] as Row[];
  }

  private related(table: TableName, row: Row, field: string): Row | Row[] | null {
    const spec = RELATIONS[table]?.[field];
    if (!spec) throw new Error(`FakeAdminPrisma: no relation ${table}.${field}`);
    const others = this.table(spec.table).filter((o) => spec.on(row, o));
    return spec.kind === 'one' ? (others[0] ?? null) : others;
  }

  private evalWhere(table: TableName, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(flattenUnique(where))) {
      if (v === undefined) continue;
      if (k === 'AND') {
        if (!(Array.isArray(v) ? v : [v]).every((w) => this.evalWhere(table, row, w))) return false;
        continue;
      }
      if (k === 'OR') {
        if (!(v as Row[]).some((w) => this.evalWhere(table, row, w))) return false;
        continue;
      }
      if (k === 'NOT') {
        if ((Array.isArray(v) ? v : [v]).some((w) => this.evalWhere(table, row, w))) return false;
        continue;
      }
      const spec = RELATIONS[table]?.[k];
      if (spec) {
        const rel = this.related(table, row, k);
        if (spec.kind === 'one') {
          const other = rel as Row | null;
          if (v === null) {
            if (other) return false;
          } else if ('is' in v) {
            if (v.is === null ? !!other : !(other && this.evalWhere(spec.table, other, v.is))) return false;
          } else if ('isNot' in v) {
            if (v.isNot === null ? !other : !!(other && this.evalWhere(spec.table, other, v.isNot))) return false;
          } else if (!other || !this.evalWhere(spec.table, other, v)) return false;
        } else {
          const list = rel as Row[];
          if ('some' in v && !list.some((o) => this.evalWhere(spec.table, o, v.some))) return false;
          if ('none' in v && list.some((o) => this.evalWhere(spec.table, o, v.none))) return false;
          if ('every' in v && !list.every((o) => this.evalWhere(spec.table, o, v.every))) return false;
        }
        continue;
      }
      if (!matchScalar(row[k], v)) return false;
    }
    return true;
  }

  private project(table: TableName, row: Row, select?: Row, include?: Row): Row {
    const scalars = () => {
      const out: Row = {};
      for (const [k, v] of Object.entries(row)) out[k] = v;
      return out;
    };
    if (!select) {
      const out = scalars();
      for (const [k, on] of Object.entries(include ?? {})) if (on) out[k] = this.projectRelation(table, row, k, on);
      return out;
    }
    const out: Row = {};
    for (const [k, on] of Object.entries(select)) {
      if (!on) continue;
      if (k === '_count') {
        const counts: Row = {};
        for (const [rel, cfg] of Object.entries((on as Row).select ?? {})) {
          const spec = RELATIONS[table]?.[rel];
          if (!spec || spec.kind !== 'many') throw new Error(`FakeAdminPrisma: _count on ${table}.${rel}`);
          const list = this.related(table, row, rel) as Row[];
          const where = cfg && typeof cfg === 'object' ? (cfg as Row).where : undefined;
          counts[rel] = list.filter((o) => this.evalWhere(spec.table, o, where)).length;
        }
        out._count = counts;
        continue;
      }
      if (RELATIONS[table]?.[k]) {
        out[k] = this.projectRelation(table, row, k, on);
        continue;
      }
      out[k] = row[k] === undefined ? null : row[k];
    }
    return out;
  }

  private projectRelation(table: TableName, row: Row, field: string, on: any) {
    const spec = RELATIONS[table]![field];
    const rel = this.related(table, row, field);
    const sub = typeof on === 'object' ? on : {};
    if (spec.kind === 'one') return rel ? this.project(spec.table, rel as Row, sub.select, sub.include) : null;
    return (rel as Row[])
      .filter((o) => this.evalWhere(spec.table, o, sub.where))
      .map((o) => this.project(spec.table, o, sub.select, sub.include));
  }

  private sort(rows: Row[], orderBy: any): Row[] {
    const keys: Row[] = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    if (keys.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const key of keys) {
        const [field, dir] = Object.entries(key)[0] as [string, 'asc' | 'desc'];
        const x = comparable(a[field]);
        const y = comparable(b[field]);
        if (x === y) continue;
        const r = x == null ? -1 : y == null ? 1 : x < y ? -1 : 1;
        return dir === 'desc' ? -r : r;
      }
      return 0;
    });
  }

  private applyData(row: Row, data: Row): Row {
    const next: Row = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        if (typeof v.increment === 'number') next[k] = (row[k] ?? 0) + v.increment;
        else if ('set' in v) next[k] = v.set;
        else throw new Error(`FakeAdminPrisma: unsupported data ${k}=${JSON.stringify(v)}`);
      } else {
        next[k] = v;
      }
    }
    return next;
  }

  /** 唯一性與外鍵：照 schema 與 migration 手寫的索引。 */
  private checkConstraints(table: TableName, row: Row) {
    const others = this.table(table).filter((o) => o.id !== row.id);
    const clash = (pred: (o: Row) => boolean, target: string) => {
      if (others.some(pred)) throw p2002(target);
    };
    switch (table) {
      case 'users':
        clash((o) => o.email === row.email, 'users_email_key');
        clash((o) => o.username === row.username, 'users_username_key');
        break;
      case 'profiles':
        clash((o) => o.workspaceId === row.workspaceId && o.email === row.email, 'employee_profiles_workspaceId_email_key');
        clash(
          (o) => o.workspaceId === row.workspaceId && o.employeeNo === row.employeeNo,
          'employee_profiles_workspaceId_employeeNo_key',
        );
        if (row.userId) clash((o) => o.userId === row.userId, 'employee_profiles_userId_key');
        if (row.departmentId && !this.departments.some((d) => d.id === row.departmentId)) throw p2003('departmentId');
        if (row.managerProfileId && !this.profiles.some((p) => p.id === row.managerProfileId)) throw p2003('managerProfileId');
        break;
      case 'departments':
        // migration 手寫的 partial unique index（Prisma schema 裡沒有）
        if (row.parentId === null) {
          clash(
            (o) => o.workspaceId === row.workspaceId && o.parentId === null && o.name.toLowerCase() === row.name.toLowerCase(),
            'departments_root_name_key',
          );
        } else {
          clash(
            (o) =>
              o.workspaceId === row.workspaceId &&
              o.parentId === row.parentId &&
              o.name.toLowerCase() === row.name.toLowerCase(),
            'departments_child_name_key',
          );
          if (!this.departments.some((d) => d.id === row.parentId)) throw p2003('parentId');
        }
        if (row.managerProfileId && !this.profiles.some((p) => p.id === row.managerProfileId)) throw p2003('managerProfileId');
        break;
      case 'members':
        clash((o) => o.workspaceId === row.workspaceId && o.userId === row.userId, 'workspace_members_workspaceId_userId_key');
        break;
      case 'bots':
        clash((o) => o.tokenPrefix === row.tokenPrefix, 'bot_accounts_tokenPrefix_key');
        break;
      default:
        break;
    }
  }

  private defaults(table: TableName): Row {
    const now = this.fakeClock.now();
    switch (table) {
      case 'users':
        return { passwordHash: null, disabledAt: null, deletedAt: null, tokenVersion: 0, avatarUrl: null, createdAt: now };
      case 'profiles':
        return {
          userId: null,
          departmentId: null,
          jobTitle: '',
          managerProfileId: null,
          employmentType: 'full_time',
          employmentStatus: 'active',
          terminationDate: null,
          phone: '',
          createdAt: now,
          updatedAt: now,
        };
      case 'departments':
        return { parentId: null, managerProfileId: null, sortOrder: 0, archivedAt: null, createdAt: now, updatedAt: now };
      case 'members':
        return { role: 'member', joinedAt: now };
      case 'bots':
        return { revokedAt: null, lastUsedAt: null, description: null, createdAt: now };
      case 'auditLogs':
        return { actorId: null, workspaceId: null, targetType: null, targetId: null, metadata: null, ipAddress: null, userAgent: null, createdAt: now };
      default:
        return {};
    }
  }

  private touch(table: TableName, row: Row): Row {
    return table === 'profiles' || table === 'departments' ? { ...row, updatedAt: this.fakeClock.now() } : row;
  }

  private delegate(table: TableName) {
    const rows = () => this.table(table);
    const findAll = (where?: Row) => rows().filter((r) => this.evalWhere(table, r, where));
    const self = this;
    const pause = () => (self.latencyMs > 0 ? new Promise<void>((r) => setTimeout(r, self.latencyMs)) : Promise.resolve());
    const api = {
      findUnique: jest.fn(async ({ where, select, include }: any) => {
        const r = findAll(where)[0];
        return r ? self.project(table, r, select, include) : null;
      }),
      findFirst: jest.fn(async ({ where, select, include, orderBy }: any = {}) => {
        const r = self.sort(findAll(where), orderBy)[0];
        return r ? self.project(table, r, select, include) : null;
      }),
      findMany: jest.fn(async ({ where, select, include, orderBy, skip, take }: any = {}) => {
        const sorted = self.sort(findAll(where), orderBy);
        const start = skip ?? 0;
        const page = take === undefined ? sorted.slice(start) : sorted.slice(start, start + take);
        return page.map((r) => self.project(table, r, select, include));
      }),
      count: jest.fn(async ({ where }: any = {}) => findAll(where).length),
      create: jest.fn(async ({ data, select, include }: any) => {
        const row = self.applyData({ id: randomUUID(), ...self.defaults(table) }, data);
        self.checkConstraints(table, row);
        rows().push(row);
        return self.project(table, row, select, include);
      }),
      update: jest.fn(async ({ where, data, select, include }: any) => {
        const current = findAll(where)[0];
        if (!current) throw p2025();
        const next = self.touch(table, self.applyData(current, data));
        self.checkConstraints(table, next);
        Object.assign(current, next);
        return self.project(table, current, select, include);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const targets = findAll(where);
        for (const t of targets) {
          const next = self.touch(table, self.applyData(t, data));
          self.checkConstraints(table, next);
          Object.assign(t, next);
        }
        return { count: targets.length };
      }),
      upsert: jest.fn(async ({ where, create, update, select }: any) => {
        const current = findAll(where)[0];
        if (current) {
          Object.assign(current, self.applyData(current, update ?? {}));
          return self.project(table, current, select);
        }
        const row = self.applyData({ id: randomUUID(), ...self.defaults(table) }, create);
        self.checkConstraints(table, row);
        rows().push(row);
        return self.project(table, row, select);
      }),
      delete: jest.fn(async ({ where }: any) => {
        const current = findAll(where)[0];
        if (!current) throw p2025();
        self.beforeDelete(table, current);
        (self as any)[table] = rows().filter((r) => r !== current);
        return { ...current };
      }),
      deleteMany: jest.fn(async ({ where }: any = {}) => {
        const targets = findAll(where);
        for (const t of targets) self.beforeDelete(table, t);
        (self as any)[table] = rows().filter((r) => !targets.includes(r));
        return { count: targets.length };
      }),
    };
    // 延遲在讀／寫之前（讓同時的兩個請求在這裡交錯）
    for (const key of Object.keys(api) as (keyof typeof api)[]) {
      const inner = api[key] as unknown as (...args: any[]) => Promise<any>;
      (api as any)[key] = jest.fn(async (...args: any[]) => {
        await pause();
        return inner(...args);
      });
    }
    return api;
  }

  /** onDelete：子部門 Restrict；員工的部門、部門主管 SetNull。 */
  private beforeDelete(table: TableName, row: Row) {
    if (table === 'departments') {
      if (this.departments.some((d) => d.parentId === row.id)) throw p2003('parentId');
      for (const p of this.profiles as Row[]) if (p.departmentId === row.id) p.departmentId = null;
    }
  }

  // ── delegates（覆寫 FakeSsoPrisma 的窄版本；account、refreshToken、attendance 沿用） ──
  override user: any = this.delegate('users');
  override employeeProfile: any = this.delegate('profiles');
  department = this.delegate('departments');
  override workspace: any = this.delegate('workspaces');
  override workspaceMember: any = this.delegate('members');
  override botAccount: any = this.delegate('bots');
  override auditLog: any = {
    ...this.delegate('auditLogs'),
    // 跟 AuditService 一樣：寫入 id 與 createdAt
    create: jest.fn(async ({ data }: any) => {
      const row = { id: randomUUID(), ...this.defaults('auditLogs'), ...data };
      this.auditLogs.push(row as any);
      return { ...row };
    }),
  };
  channel = { findMany: jest.fn(async () => []) };

  // ── raw SQL ──
  private readonly emailRawAdmin = fakeEmailQueryRaw(() => this.users);

  override $queryRaw: any = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = sqlText(strings);
    const lower = (v: unknown) => String(v).toLowerCase();
    // employees.service（H1 匯入）找根部門
    if (/^SELECT "id", "archivedAt" FROM "departments" WHERE "workspaceId" = \$\? AND "parentId" IS NULL AND lower\("name"\) = lower\(\$\?\) LIMIT 1$/.test(sql)) {
      const [workspaceId, name] = values;
      return this.departments
        .filter((d) => d.workspaceId === workspaceId && d.parentId === null && d.name.toLowerCase() === lower(name))
        .slice(0, 1)
        .map((d) => ({ id: d.id, archivedAt: d.archivedAt }));
    }
    // departments.service 的重名檢查
    if (/^SELECT "id" FROM "departments" WHERE "workspaceId" = \$\? AND "parentId" IS NULL AND lower\("name"\) = lower\(\$\?\)$/.test(sql)) {
      const [workspaceId, name] = values;
      return this.departments
        .filter((d) => d.workspaceId === workspaceId && d.parentId === null && d.name.toLowerCase() === lower(name))
        .map((d) => ({ id: d.id }));
    }
    if (/^SELECT "id" FROM "departments" WHERE "workspaceId" = \$\? AND "parentId" = \$\? AND lower\("name"\) = lower\(\$\?\)$/.test(sql)) {
      const [workspaceId, parentId, name] = values;
      return this.departments
        .filter((d) => d.workspaceId === workspaceId && d.parentId === parentId && d.name.toLowerCase() === lower(name))
        .map((d) => ({ id: d.id }));
    }
    // employee-admin.service 的名冊關鍵字（strpos，不把 _／% 當萬用字元）
    if (
      /^SELECT "id" FROM "employee_profiles" WHERE "workspaceId" = \$\? AND \(strpos\(lower\("employeeNo"\), lower\(\$\?\)\) > 0 OR strpos\(lower\("email"\), lower\(\$\?\)\) > 0 OR strpos\(lower\("fullName"\), lower\(\$\?\)\) > 0\)$/.test(sql)
    ) {
      const [workspaceId, q] = values;
      const needle = lower(q);
      return (this.profiles as Row[])
        .filter(
          (p) =>
            p.workspaceId === workspaceId &&
            [p.employeeNo, p.email, p.fullName].some((f) => String(f).toLowerCase().includes(needle)),
        )
        .map((p) => ({ id: p.id }));
    }
    return this.emailRawAdmin(strings, ...values);
  });

  $executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = sqlText(strings);
    this.executed.push(sql);
    if (sql === 'SELECT pg_advisory_xact_lock(hashtext($?))') {
      const ctx = this.txContext.getStore();
      if (!ctx) throw new Error('FakeAdminPrisma: advisory xact lock outside a transaction');
      const key = String(values[0]);
      if (key !== ORG_LOCK_KEY) throw new Error(`FakeAdminPrisma: unexpected lock key ${key}`);
      // 排在目前持有者後面；持有者的交易結束才放行
      const prev = this.locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const chained = prev.then(() => mine);
      this.locks.set(key, chained);
      await prev;
      ctx.snapshot = this.snapshotAll();
      ctx.releases.push(() => {
        release();
        if (this.locks.get(key) === chained) this.locks.delete(key);
      });
      return 1;
    }
    throw new Error(`FakeAdminPrisma: unsupported $executeRaw ${sql}`);
  });

  private snapshotAll() {
    return structuredClone({
      users: this.users,
      accounts: this.accounts,
      profiles: this.profiles,
      departments: this.departments,
      workspaces: this.workspaces,
      members: this.members,
      bots: this.bots,
      refreshRows: this.refreshRows,
      auditLogs: this.auditLogs,
    });
  }

  override async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    this.transactions++;
    // rollback 用的快照：交易開始時拍；拿到鎖之後再重拍一次（排在前面的交易可能剛 commit，
    // 鎖是交易的第一個指令，重拍時這個交易還沒寫任何東西）
    const ctx: TxContext = { releases: [], snapshot: this.snapshotAll() };
    return this.txContext.run(ctx, async () => {
      try {
        return await fn(this);
      } catch (err) {
        Object.assign(this, ctx.snapshot);
        throw err;
      } finally {
        for (const r of ctx.releases) r();
      }
    });
  }
}
