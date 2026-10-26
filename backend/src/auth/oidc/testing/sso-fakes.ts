/**
 * 測試用的記憶體版 Prisma：只實作 SSO 登入（員工對應、refresh token、JwtAuthGuard、
 * attendance/today、audit）用到的查詢。只給 *.spec.ts 使用。
 *
 * - 照真的 DB 擋唯一性（丟 code=P2002）：User.email、User.username（大小寫敏感，跟 Postgres 一樣）、
 *   Account(provider, providerId)、EmployeeProfile.userId、WorkspaceMember(workspaceId, userId)。
 * - `$transaction(fn)`：fn 丟錯時把所有資料表還原成交易開始前的樣子（模擬 rollback）。
 */
import { randomUUID } from 'crypto';
import { Clock } from '../../../common/clock';

export interface SsoUserRow {
  id: string;
  email: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}
export interface SsoAccountRow {
  id: string;
  userId: string;
  provider: string;
  providerId: string | null;
}
export interface SsoProfileRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  email: string;
  employeeNo: string;
  fullName: string;
  employmentStatus: string;
}
export interface SsoWorkspaceRow {
  id: string;
  name: string;
  ownerId: string;
  isCompany: boolean;
  pendingOwnerEmail: string | null;
  deletedAt: Date | null;
}
export interface SsoMemberRow {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
}
export interface SsoBotRow {
  id: string;
  workspaceId: string;
  userId: string;
  tokenPrefix: string;
  tokenHash: string;
  createdById: string;
  revokedAt: Date | null;
}
export interface SsoRefreshRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  createdAt: Date;
}
export interface SsoAuditRow {
  actorId: string | null;
  workspaceId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, any>;
}

interface Tables {
  users: SsoUserRow[];
  accounts: SsoAccountRow[];
  profiles: SsoProfileRow[];
  workspaces: SsoWorkspaceRow[];
  members: SsoMemberRow[];
  bots: SsoBotRow[];
  refreshRows: SsoRefreshRow[];
  auditLogs: SsoAuditRow[];
}

const p2002 = (target: string) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002' });
const p2025 = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' });

function matchValue(actual: any, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond !== 'object') return actual === cond;
  if ('equals' in cond) {
    if (typeof actual !== 'string') return false;
    return cond.mode === 'insensitive'
      ? actual.toLowerCase() === String(cond.equals).toLowerCase()
      : actual === cond.equals;
  }
  if ('startsWith' in cond) return typeof actual === 'string' && actual.startsWith(cond.startsWith);
  if ('not' in cond) return cond.not === null ? actual !== null && actual !== undefined : actual !== cond.not;
  throw new Error(`FakeSsoPrisma: unsupported condition ${JSON.stringify(cond)}`);
}

function matchWhere(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'NOT') return !matchWhere(row, v);
    return matchValue(row[k], v);
  });
}

function pick(row: Record<string, any> | undefined | null, select?: Record<string, any>) {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Record<string, any> = {};
  for (const [k, on] of Object.entries(select)) if (on === true && k in row) out[k] = row[k];
  return out;
}

export class FakeSsoPrisma implements Tables {
  users: SsoUserRow[] = [];
  accounts: SsoAccountRow[] = [];
  profiles: SsoProfileRow[] = [];
  workspaces: SsoWorkspaceRow[] = [];
  members: SsoMemberRow[] = [];
  bots: SsoBotRow[] = [];
  refreshRows: SsoRefreshRow[] = [];
  auditLogs: SsoAuditRow[] = [];
  transactions = 0;

  constructor(private readonly clock: Clock) {}

  // ── seed helpers ──
  addUser(p: Partial<SsoUserRow> & { id: string; email: string }): SsoUserRow {
    const row: SsoUserRow = {
      username: p.id,
      displayName: p.id,
      passwordHash: null,
      disabledAt: null,
      deletedAt: null,
      createdAt: this.clock.now(),
      ...p,
    };
    this.users.push(row);
    return row;
  }
  addAccount(userId: string, provider: string, providerId: string): SsoAccountRow {
    const row = { id: randomUUID(), userId, provider, providerId };
    this.accounts.push(row);
    return row;
  }
  addWorkspace(p: Partial<SsoWorkspaceRow> & { id: string; ownerId: string }): SsoWorkspaceRow {
    const row: SsoWorkspaceRow = { name: p.id, isCompany: false, pendingOwnerEmail: null, deletedAt: null, ...p };
    this.workspaces.push(row);
    return row;
  }
  addMember(workspaceId: string, userId: string, role: string): SsoMemberRow {
    const row = { id: randomUUID(), workspaceId, userId, role };
    this.members.push(row);
    return row;
  }
  addProfile(p: Partial<SsoProfileRow> & { workspaceId: string; email: string; employeeNo: string }): SsoProfileRow {
    const row: SsoProfileRow = { id: randomUUID(), userId: null, fullName: p.employeeNo, employmentStatus: 'active', ...p };
    this.profiles.push(row);
    return row;
  }

  /** 列數快照：拒絕登入後用來斷言「完全沒有新增 User、Account、WorkspaceMember」。 */
  counts() {
    return {
      users: this.users.length,
      accounts: this.accounts.length,
      members: this.members.length,
      boundProfiles: this.profiles.filter((p) => p.userId).length,
    };
  }

  private snapshot(): Tables {
    return structuredClone({
      users: this.users,
      accounts: this.accounts,
      profiles: this.profiles,
      workspaces: this.workspaces,
      members: this.members,
      bots: this.bots,
      refreshRows: this.refreshRows,
      auditLogs: this.auditLogs,
    });
  }

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    this.transactions++;
    const before = this.snapshot();
    try {
      return await fn(this);
    } catch (err) {
      Object.assign(this, before);
      throw err;
    }
  }

  private assertUserUnique(row: SsoUserRow) {
    for (const u of this.users) {
      if (u.id === row.id) continue;
      if (u.email === row.email) throw p2002('users_email_key');
      if (u.username === row.username) throw p2002('users_username_key');
    }
  }

  workspace = {
    findFirst: jest.fn(async ({ where, select }: any) => pick(this.workspaces.find((w) => matchWhere(w, where)), select)),
    findUnique: jest.fn(async ({ where, select }: any) => pick(this.workspaces.find((w) => w.id === where.id), select)),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const w of this.workspaces) {
        if (matchWhere(w, where)) {
          Object.assign(w, data);
          count++;
        }
      }
      return { count };
    }),
  };

  account = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const { provider, providerId } = where.provider_providerId;
      const row = this.accounts.find((a) => a.provider === provider && a.providerId === providerId);
      if (!row) return null;
      const out: any = pick(row, select);
      if (select?.user) out.user = pick(this.users.find((u) => u.id === row.userId), select.user.select);
      return out;
    }),
    create: jest.fn(async ({ data }: any) => {
      if (this.accounts.some((a) => a.provider === data.provider && a.providerId === data.providerId)) {
        throw p2002('accounts_provider_providerId_key');
      }
      const row: SsoAccountRow = { id: randomUUID(), providerId: null, ...data };
      this.accounts.push(row);
      return { ...row };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const before = this.accounts.length;
      this.accounts = this.accounts.filter((a) => !matchWhere(a, where));
      return { count: before - this.accounts.length };
    }),
  };

  employeeProfile = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      let row: SsoProfileRow | undefined;
      if (where.workspaceId_email) {
        const { workspaceId, email } = where.workspaceId_email;
        row = this.profiles.find((p) => p.workspaceId === workspaceId && p.email === email);
      } else if ('userId' in where) {
        row = where.userId ? this.profiles.find((p) => p.userId === where.userId) : undefined;
      } else if (where.id) {
        row = this.profiles.find((p) => p.id === where.id);
      }
      return pick(row, select);
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const p of this.profiles) {
        if (matchWhere(p, where)) {
          if (data.userId && this.profiles.some((o) => o !== p && o.userId === data.userId)) {
            throw p2002('employee_profiles_userId_key');
          }
          Object.assign(p, data);
          count++;
        }
      }
      return { count };
    }),
  };

  user = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const row = this.users.find((u) => u.id === where.id && (where.deletedAt !== null || u.deletedAt === null));
      return pick(row, select);
    }),
    findMany: jest.fn(async ({ where, select, take }: any) => {
      const rows = this.users.filter((u) => matchWhere(u, where)).slice(0, take ?? undefined);
      return rows.map((u) => {
        const out: any = pick(u, select);
        if (select?.botAccount) {
          const bot = this.bots.find((b) => b.userId === u.id);
          out.botAccount = bot ? { id: bot.id } : null;
        }
        return out;
      });
    }),
    create: jest.fn(async ({ data, select }: any) => {
      const row: SsoUserRow = {
        id: randomUUID(),
        passwordHash: null,
        disabledAt: null,
        deletedAt: null,
        createdAt: this.clock.now(),
        ...data,
      };
      this.assertUserUnique(row);
      this.users.push(row);
      return pick(row, select);
    }),
    update: jest.fn(async ({ where, data, select }: any) => {
      const row = this.users.find((u) => u.id === where.id);
      if (!row) throw p2025();
      this.assertUserUnique({ ...row, ...data });
      Object.assign(row, data);
      return pick(row, select);
    }),
  };

  workspaceMember = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const { workspaceId, userId } = where.workspaceId_userId;
      return pick(this.members.find((m) => m.workspaceId === workspaceId && m.userId === userId), select);
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const { workspaceId, userId } = where.workspaceId_userId;
      const row = this.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      if (row) {
        Object.assign(row, update);
        return { ...row };
      }
      const created = { id: randomUUID(), ...create };
      this.members.push(created);
      return { ...created };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const { workspaceId, userId } = where.workspaceId_userId;
      const row = this.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      if (!row) throw p2025();
      Object.assign(row, data);
      return { ...row };
    }),
  };

  botAccount = {
    findUnique: jest.fn(async ({ where, select }: any) =>
      pick(this.bots.find((b) => b.tokenPrefix === where.tokenPrefix), select),
    ),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const b of this.bots) {
        if (matchWhere(b, where)) {
          Object.assign(b, data);
          count++;
        }
      }
      return { count };
    }),
  };

  refreshToken = {
    create: jest.fn(async ({ data }: any) => {
      const row: SsoRefreshRow = {
        id: randomUUID(),
        revokedAt: null,
        rotatedAt: null,
        createdAt: this.clock.now(),
        ...data,
      };
      this.refreshRows.push(row);
      return { ...row };
    }),
    findUnique: jest.fn(async ({ where, include, select }: any) => {
      const row = this.refreshRows.find((r) => matchWhere(r, where));
      if (!row) return null;
      const out: any = pick(row, select);
      if (include?.user) out.user = pick(this.users.find((u) => u.id === row.userId), include.user.select);
      return out;
    }),
    count: jest.fn(async ({ where }: any) => this.refreshRows.filter((r) => matchWhere(r, where)).length),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of this.refreshRows) {
        if (matchWhere(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    }),
  };

  auditLog = {
    create: jest.fn(async ({ data }: any) => {
      this.auditLogs.push({ ...data });
      return { ...data };
    }),
  };

  /** attendance/today：這些測試只關心「能不能打」，沒有出勤紀錄。 */
  attendance = { findUnique: jest.fn(async () => null) };
}

export class FakeSsoRedis {
  store = new Map<string, string>();
  mode: 'ok' | 'throw' = 'ok';
  /** 只讓某些指令失敗（例如只有 set 掛掉）；空的話看 mode。 */
  failOnly = new Set<string>();

  private gate<T>(op: string, fn: () => T): Promise<T> {
    if (this.mode === 'throw' || this.failOnly.has(op)) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(fn());
  }

  get = jest.fn((key: string) => this.gate('get', () => this.store.get(key) ?? null));
  set = jest.fn((key: string, value: string, _ttl?: number) => this.gate('set', () => void this.store.set(key, value)));
  setNx = jest.fn((key: string, value: string, _ttl: number) =>
    this.gate('setNx', () => {
      if (this.store.has(key)) return false;
      this.store.set(key, value);
      return true;
    }),
  );
  del = jest.fn((key: string) => this.gate('del', () => void this.store.delete(key)));
  /** 跟 Redis 的 GETDEL 一樣是原子的：取值與刪除在同一步。 */
  getdel = jest.fn((key: string) =>
    this.gate('getdel', () => {
      const v = this.store.get(key) ?? null;
      this.store.delete(key);
      return v;
    }),
  );
}
