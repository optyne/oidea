/**
 * 測試用的記憶體版 Prisma（只實作 auth 用到的部分）與 Redis。
 * 只給 *.spec.ts 使用；沒有 DB／Redis 的環境也能跑。
 */
import { randomUUID } from 'crypto';
import { FakeClock } from '../../common/clock';

export interface FakeUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
  tokenVersion: number;
}

export interface FakeRefreshRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  tokenVersion: number;
  createdAt: Date;
}

export interface FakeBot {
  id: string;
  tokenPrefix: string;
  tokenHash: string;
  revokedAt: Date | null;
  userId: string;
  workspaceId: string;
  createdById: string;
  createdAt?: Date;
}

const matches = (row: Record<string, any>, where: Record<string, any>) =>
  Object.entries(where).every(([k, v]) => {
    const actual = row[k];
    if (v === null) return actual === null || actual === undefined;
    return actual === v;
  });

const pick = (row: Record<string, any>, select?: Record<string, boolean>) => {
  if (!select) return { ...row };
  const out: Record<string, any> = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = row[k];
  return out;
};

export class FakePrisma {
  users = new Map<string, FakeUser>();
  refreshRows: FakeRefreshRow[] = [];
  bots: FakeBot[] = [];

  constructor(private readonly clock: FakeClock) {}

  addUser(partial: Partial<FakeUser> & { id: string; email: string }): FakeUser {
    const u: FakeUser = {
      username: partial.id,
      displayName: partial.id,
      passwordHash: 'hashed:pw',
      disabledAt: null,
      deletedAt: null,
      tokenVersion: 0,
      ...partial,
    };
    this.users.set(u.id, u);
    return u;
  }

  user = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const u = this.users.get(where.id);
      return u ? pick(u, select) : null;
    }),
  };

  refreshToken = {
    create: jest.fn(async ({ data }: any) => {
      const row: FakeRefreshRow = {
        id: randomUUID(),
        revokedAt: null,
        rotatedAt: null,
        tokenVersion: 0,
        createdAt: this.clock.now(),
        ...data,
      };
      this.refreshRows.push(row);
      return { ...row };
    }),
    findUnique: jest.fn(async ({ where, include, select }: any) => {
      const row = this.refreshRows.find((r) => matches(r, where));
      if (!row) return null;
      const out: any = pick(row, select);
      if (include?.user) {
        const u = this.users.get(row.userId);
        out.user = u ? pick(u, include.user.select) : null;
      }
      return out;
    }),
    /** 只支援 rotate 用到的 `{ familyId, revokedAt: { not: null } }` 與一般等值條件。 */
    count: jest.fn(async ({ where }: any) => {
      const { revokedAt, ...rest } = where ?? {};
      return this.refreshRows.filter((r) => {
        if (!matches(r, rest)) return false;
        if (revokedAt === undefined) return true;
        if (revokedAt && typeof revokedAt === 'object' && 'not' in revokedAt && revokedAt.not === null) {
          return r.revokedAt != null;
        }
        return matches(r, { revokedAt });
      }).length;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of this.refreshRows) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    }),
  };

  botAccount = {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const b = this.bots.find((x) => x.tokenPrefix === where.tokenPrefix);
      return b ? pick(b, select) : null;
    }),
    update: jest.fn(async () => ({})),
  };

  auditLog = { create: jest.fn(async () => ({})) };
}

export type RedisMode = 'ok' | 'throw' | 'hang';

export class FakeRedis {
  store = new Map<string, string>();
  mode: RedisMode = 'ok';

  private gate<T>(fn: () => T): Promise<T> {
    if (this.mode === 'throw') return Promise.reject(new Error('ECONNREFUSED'));
    if (this.mode === 'hang') return new Promise<T>(() => undefined);
    return Promise.resolve(fn());
  }

  get = jest.fn((key: string) => this.gate(() => this.store.get(key) ?? null));
  set = jest.fn((key: string, value: string, _ttl?: number) =>
    this.gate(() => {
      this.store.set(key, value);
    }),
  );
  /** 跟真的 `SET … NX` 一樣：key 已存在就不寫，回傳是否寫入。 */
  setNx = jest.fn((key: string, value: string, _ttl: number) =>
    this.gate(() => {
      if (this.store.has(key)) return false;
      this.store.set(key, value);
      return true;
    }),
  );
  del = jest.fn((key: string) =>
    this.gate(() => {
      this.store.delete(key);
    }),
  );
  flushall(): void {
    this.store.clear();
  }
}
