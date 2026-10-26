/**
 * 測試用的記憶體版 Prisma：只實作公司工作空間、員工主檔、部門、緊急登入密碼用到的查詢。
 * 會照真的 DB 擋唯一性（丟 code=P2002），包含 migration 手寫的 partial unique index：
 *   - 全庫最多一個 isCompany=true
 *   - 根部門同名（不分大小寫）
 * 只給 *.spec.ts 使用。
 */
import { randomUUID } from 'crypto';
import { fakeEmailQueryRaw } from '../../common/testing/fake-email-raw';

export interface FakeWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  isCompany: boolean;
  pendingOwnerEmail: string | null;
  deletedAt: Date | null;
}

export interface FakeUserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
  isBot?: boolean;
  /** 有 authentik Account（經過 SSO 綁定） */
  ssoBound?: boolean;
}

export interface FakeProfileRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  email: string;
  employeeNo: string;
  fullName: string;
  departmentId: string | null;
  jobTitle: string;
  hireDate: Date;
  employmentStatus: string;
}

export interface FakeDepartmentRow {
  id: string;
  workspaceId: string;
  name: string;
  parentId: string | null;
  archivedAt: Date | null;
}

const uniqueViolation = (target: string) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002' });

const pick = (row: Record<string, any> | undefined | null, select?: Record<string, any>) => {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Record<string, any> = {};
  for (const [k, on] of Object.entries(select)) if (on && k in row) out[k] = row[k];
  return out;
};

const emailMatches = (actual: string, cond: any) => {
  if (typeof cond === 'string') return actual === cond;
  if (cond && typeof cond === 'object' && 'equals' in cond) {
    return cond.mode === 'insensitive' ? actual.toLowerCase() === String(cond.equals).toLowerCase() : actual === cond.equals;
  }
  return false;
};

export class FakeCompanyPrisma {
  workspaces: FakeWorkspaceRow[] = [];
  members: { workspaceId: string; userId: string; role: string }[] = [];
  users: FakeUserRow[] = [];
  profiles: FakeProfileRow[] = [];
  departments: FakeDepartmentRow[] = [];

  addWorkspace(p: Partial<FakeWorkspaceRow> & { id: string; ownerId: string }): FakeWorkspaceRow {
    const ws: FakeWorkspaceRow = {
      name: p.id,
      slug: p.id,
      isCompany: false,
      pendingOwnerEmail: null,
      deletedAt: null,
      ...p,
    };
    this.workspaces.push(ws);
    return ws;
  }

  addUser(p: Partial<FakeUserRow> & { id: string; email: string }): FakeUserRow {
    const u: FakeUserRow = {
      displayName: p.id,
      passwordHash: null,
      disabledAt: null,
      deletedAt: null,
      ...p,
    };
    this.users.push(u);
    return u;
  }

  addMember(workspaceId: string, userId: string, role: string) {
    this.members.push({ workspaceId, userId, role });
  }

  private assertSingleCompany(candidate: FakeWorkspaceRow) {
    if (candidate.isCompany && this.workspaces.some((w) => w.isCompany && w.id !== candidate.id)) {
      throw uniqueViolation('workspaces_single_company_key');
    }
  }

  workspace = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      const ws = this.workspaces.find((w) => (where?.isCompany === undefined ? true : w.isCompany === where.isCompany));
      return pick(ws, select);
    }),
    findUnique: jest.fn(async ({ where, select }: any) => {
      const ws = this.workspaces.find((w) => (where.id !== undefined ? w.id === where.id : w.slug === where.slug));
      return pick(ws, select);
    }),
    create: jest.fn(async ({ data, select }: any) => {
      const { members, ...rest } = data;
      if (this.workspaces.some((w) => w.slug === rest.slug)) throw uniqueViolation('workspaces_slug_key');
      const ws: FakeWorkspaceRow = {
        id: randomUUID(),
        isCompany: false,
        pendingOwnerEmail: null,
        deletedAt: null,
        ...rest,
      };
      this.assertSingleCompany(ws);
      this.workspaces.push(ws);
      if (members?.create) this.addMember(ws.id, members.create.userId, members.create.role);
      return pick(ws, select);
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const ws = this.workspaces.find((w) => w.id === where.id);
      if (!ws) throw Object.assign(new Error('not found'), { code: 'P2025' });
      this.assertSingleCompany({ ...ws, ...data });
      Object.assign(ws, data);
      return { ...ws };
    }),
  };

  workspaceMember = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const { workspaceId, userId } = where.workspaceId_userId;
      return pick(
        this.members.find((m) => m.workspaceId === workspaceId && m.userId === userId),
        select,
      );
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const { workspaceId, userId } = where.workspaceId_userId;
      const row = this.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      if (row) {
        Object.assign(row, update);
        return { ...row };
      }
      this.members.push({ ...create });
      return { ...create };
    }),
    findMany: jest.fn(async ({ where, select }: any) =>
      this.members.filter((m) => m.workspaceId === where.workspaceId).map((m) => pick(m, select)),
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const m of this.members) {
        if (
          m.workspaceId === where.workspaceId &&
          (where.userId === undefined || m.userId === where.userId) &&
          (where.role === undefined || m.role === where.role)
        ) {
          Object.assign(m, data);
          count++;
        }
      }
      return { count };
    }),
  };

  /** email-lookup.ts 的 `lower("email") = lower($1)`（不把 `_`、`%` 當萬用字元）。 */
  $queryRaw = fakeEmailQueryRaw(() => this.users);

  user = {
    findFirst: jest.fn(async () => {
      throw new Error('FakeCompanyPrisma: user lookups by email must go through email-lookup ($queryRaw)');
    }),
    findUnique: jest.fn(async ({ where, select }: any) => {
      const u = this.users.find((x) => x.id === where.id && (where.deletedAt !== null || x.deletedAt === null));
      if (!u) return null;
      const out: any = pick(u, select);
      if (select?.botAccount) out.botAccount = u.isBot ? { id: `bot-${u.id}` } : null;
      if (select?.accounts) {
        if (select.accounts.where?.provider !== 'authentik') throw new Error('FakeCompanyPrisma: unexpected accounts filter');
        out.accounts = u.ssoBound ? [{ id: `acc-${u.id}` }] : [];
      }
      return out;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const u = this.users.find((x) => x.id === where.id);
      if (!u) throw Object.assign(new Error('not found'), { code: 'P2025' });
      Object.assign(u, data);
      return { ...u };
    }),
  };

  employeeProfile = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      let row: FakeProfileRow | undefined;
      if (where.workspaceId_email) {
        const { workspaceId, email } = where.workspaceId_email;
        row = this.profiles.find((p) => p.workspaceId === workspaceId && p.email === email);
      } else if (where.workspaceId_employeeNo) {
        const { workspaceId, employeeNo } = where.workspaceId_employeeNo;
        row = this.profiles.find((p) => p.workspaceId === workspaceId && p.employeeNo === employeeNo);
      } else if (where.id) {
        row = this.profiles.find((p) => p.id === where.id);
      }
      return pick(row, select);
    }),
    findMany: jest.fn(async ({ where, select }: any) =>
      this.profiles
        .filter(
          (p) =>
            p.workspaceId === where.workspaceId &&
            (where.userId?.in === undefined || (p.userId !== null && where.userId.in.includes(p.userId))),
        )
        .map((p) => pick(p, select)),
    ),
    create: jest.fn(async ({ data, select }: any) => {
      const row: FakeProfileRow = {
        id: randomUUID(),
        userId: null,
        departmentId: null,
        jobTitle: '',
        employmentStatus: 'active',
        ...data,
      };
      this.assertProfileUnique(row);
      this.profiles.push(row);
      return pick(row, select);
    }),
    update: jest.fn(async ({ where, data, select }: any) => {
      const row = this.profiles.find((p) => p.id === where.id);
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
      this.assertProfileUnique({ ...row, ...data });
      Object.assign(row, data);
      return pick(row, select);
    }),
  };

  private assertProfileUnique(row: FakeProfileRow) {
    for (const p of this.profiles) {
      if (p.id === row.id || p.workspaceId !== row.workspaceId) continue;
      if (p.email === row.email) throw uniqueViolation('employee_profiles_workspaceId_email_key');
      if (p.employeeNo === row.employeeNo) throw uniqueViolation('employee_profiles_workspaceId_employeeNo_key');
    }
  }

  department = {
    findFirst: jest.fn(async ({ where, select }: any) => {
      const row = this.departments.find(
        (d) =>
          d.workspaceId === where.workspaceId &&
          d.parentId === (where.parentId ?? null) &&
          emailMatches(d.name, where.name),
      );
      return pick(row, select);
    }),
    create: jest.fn(async ({ data, select }: any) => {
      const row: FakeDepartmentRow = { id: randomUUID(), parentId: null, archivedAt: null, ...data };
      const clash = this.departments.some(
        (d) =>
          d.workspaceId === row.workspaceId &&
          d.parentId === row.parentId &&
          d.name.toLowerCase() === row.name.toLowerCase(),
      );
      if (clash) throw uniqueViolation('departments_root_name_key');
      this.departments.push(row);
      return pick(row, select);
    }),
  };
}
