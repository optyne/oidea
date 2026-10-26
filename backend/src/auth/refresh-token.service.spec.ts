import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import {
  RefreshTokenService,
  REFRESH_REUSE_GRACE_MS,
  hashRefreshToken,
  parseDurationMs,
} from './refresh-token.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { FakeClock } from '../common/clock';
import { FakePrisma } from './testing/auth-fakes';

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (pw: string) => `hashed:${pw}`),
  compare: jest.fn(async (pw: string, hash: string) => hash === `hashed:${pw}`),
}));

const config = (values: Record<string, string> = {}) =>
  ({
    get: (k: string, d?: unknown) => values[k] ?? d,
    getOrThrow: (k: string) => values[k] ?? 'test-secret',
  }) as any;

describe('RefreshTokenService + AuthService.refresh/logout（H0 token 改造）', () => {
  let clock: FakeClock;
  let prisma: FakePrisma;
  let audit: { record: jest.Mock };
  let refresh: RefreshTokenService;
  let auth: AuthService;
  let jwt: JwtService;
  let strategy: JwtStrategy;

  const login = () => auth.login({ email: 'alice@example.com', password: 'pw' });

  beforeEach(() => {
    clock = new FakeClock(new Date('2026-10-26T00:00:00Z'));
    prisma = new FakePrisma(clock);
    prisma.addUser({ id: 'u-1', email: 'alice@example.com' });
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
    refresh = new RefreshTokenService(prisma as any, clock, audit as any, config());
    const users = {
      findByEmail: jest.fn(async (email: string) =>
        [...prisma.users.values()].find((u) => u.email === email) ?? null,
      ),
      findById: jest.fn(async (id: string) => prisma.users.get(id) ?? null),
    };
    auth = new AuthService(users as any, jwt, audit as any, refresh);
    strategy = new JwtStrategy(config(), { isDisabled: async () => false } as any);
  });

  const accessWorks = async (accessToken: string) => {
    const payload = jwt.verify(accessToken);
    return strategy.validate(payload);
  };

  it('refresh token 是不透明字串（不是 JWT），DB 只存 sha256', async () => {
    const res = await login();
    expect(res.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(() => jwt.verify(res.refreshToken)).toThrow();
    expect(prisma.refreshRows).toHaveLength(1);
    expect(prisma.refreshRows[0].tokenHash).toBe(hashRefreshToken(res.refreshToken));
    expect(JSON.stringify(prisma.refreshRows)).not.toContain(res.refreshToken);
    // 有效期預設 7 天
    expect(prisma.refreshRows[0].expiresAt.getTime() - clock.now().getTime()).toBe(7 * 86_400_000);
  });

  it('refresh 回 {accessToken, refreshToken, user:{id,email}}，換發新 token 且沿用 familyId', async () => {
    const first = await login();
    const second = await auth.refresh(first.refreshToken);
    expect(Object.keys(second).sort()).toEqual(['accessToken', 'refreshToken', 'user']);
    expect(second.user).toEqual({ id: 'u-1', email: 'alice@example.com' });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(accessWorks(second.accessToken)).resolves.toEqual({
      userId: 'u-1',
      email: 'alice@example.com',
    });
    const [a, b] = prisma.refreshRows;
    expect(b.familyId).toBe(a.familyId);
    expect(a.rotatedAt).toEqual(clock.now());
  });

  it('舊 token 在 10 秒內重用 → 拿到一組可用的新 token（同 family）', async () => {
    const first = await login();
    await auth.refresh(first.refreshToken);
    clock.advance(REFRESH_REUSE_GRACE_MS - 1000);

    const retry = await auth.refresh(first.refreshToken);
    await expect(accessWorks(retry.accessToken)).resolves.toMatchObject({ userId: 'u-1' });
    // 新拿到的 refresh token 本身也能繼續換
    const next = await auth.refresh(retry.refreshToken);
    expect(next.refreshToken).toBeTruthy();
    const families = new Set(prisma.refreshRows.map((r) => r.familyId));
    expect(families.size).toBe(1);
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh_reuse' }),
    );
  });

  it('超過 10 秒重用 → 401，整個 family 撤銷；同一使用者另一個 family 照常可用', async () => {
    const deviceA = await login();
    const deviceB = await login();
    const a2 = await auth.refresh(deviceA.refreshToken);

    clock.advance(REFRESH_REUSE_GRACE_MS + 1);
    await expect(auth.refresh(deviceA.refreshToken)).rejects.toThrow(UnauthorizedException);

    // family A 全部撤銷（包括剛換發、還沒用過的 a2）
    const familyA = prisma.refreshRows.filter(
      (r) => r.tokenHash === hashRefreshToken(deviceA.refreshToken),
    )[0].familyId;
    expect(prisma.refreshRows.filter((r) => r.familyId === familyA).every((r) => r.revokedAt)).toBe(true);
    await expect(auth.refresh(a2.refreshToken)).rejects.toThrow(UnauthorizedException);

    // family B 不受影響
    const b2 = await auth.refresh(deviceB.refreshToken);
    await expect(accessWorks(b2.accessToken)).resolves.toMatchObject({ userId: 'u-1' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'u-1',
        action: 'auth.refresh_reuse',
        targetType: 'refresh_token_family',
        targetId: familyA,
      }),
    );
    // 稽核紀錄不含明文 token
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(deviceA.refreshToken);
  });

  it('同一個 token 同時送兩次 refresh → 兩個都拿到可用的新 token（第二個走寬限期）', async () => {
    const first = await login();
    const [x, y] = await Promise.all([
      auth.refresh(first.refreshToken),
      auth.refresh(first.refreshToken),
    ]);
    expect(x.refreshToken).not.toBe(y.refreshToken);
    await expect(auth.refresh(x.refreshToken)).resolves.toBeTruthy();
    await expect(auth.refresh(y.refreshToken)).resolves.toBeTruthy();
  });

  it('過期、未知、空字串、使用者停用 → 401', async () => {
    const first = await login();
    await expect(auth.refresh('not-a-real-token')).rejects.toThrow(UnauthorizedException);
    await expect(auth.refresh('')).rejects.toThrow(UnauthorizedException);

    prisma.users.get('u-1')!.disabledAt = clock.now();
    await expect(auth.refresh(first.refreshToken)).rejects.toThrow(UnauthorizedException);
    prisma.users.get('u-1')!.disabledAt = null;

    clock.advance(7 * 86_400_000);
    await expect(auth.refresh(first.refreshToken)).rejects.toThrow(UnauthorizedException);
  });

  it('logout → 撤銷整個 family、寫 audit auth.logout、回 {ok:true}；其他 family 不受影響', async () => {
    const deviceA = await login();
    const deviceB = await login();
    const a2 = await auth.refresh(deviceA.refreshToken);

    await expect(auth.logout(a2.refreshToken)).resolves.toEqual({ ok: true });
    await expect(auth.refresh(a2.refreshToken)).rejects.toThrow(UnauthorizedException);
    await expect(auth.refresh(deviceB.refreshToken)).resolves.toBeTruthy();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'u-1', action: 'auth.logout' }),
    );
  });

  it('logout 未知 token → 仍回 {ok:true}，不寫 audit（冪等）', async () => {
    await expect(auth.logout('unknown')).resolves.toEqual({ ok: true });
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout' }));
  });

  it('revokeAllForUser → 該使用者所有 family 都失效', async () => {
    const a = await login();
    const b = await login();
    await expect(refresh.revokeAllForUser('u-1')).resolves.toBe(2);
    await expect(auth.refresh(a.refreshToken)).rejects.toThrow(UnauthorizedException);
    await expect(auth.refresh(b.refreshToken)).rejects.toThrow(UnauthorizedException);
  });

  describe('S8：換發與撤銷 family 同時發生', () => {
    const familyRows = (familyId: string) => prisma.refreshRows.filter((r) => r.familyId === familyId);
    const familyOf = (token: string) =>
      prisma.refreshRows.find((r) => r.tokenHash === hashRefreshToken(token))!.familyId;

    /** 下一次建立 refresh row 之前，先跑 `during`（模擬撤銷剛好落在 claim 與 issue 之間）。 */
    const beforeNextCreate = (during: () => Promise<unknown>) => {
      const original = prisma.refreshToken.create.getMockImplementation()!;
      prisma.refreshToken.create.mockImplementationOnce(async (args: any) => {
        await during();
        return original(args);
      });
    };

    it('claim 之後、建新 row 之前被登出 → rotate 回 401，新 row 也被撤銷', async () => {
      const first = await login();
      const familyId = familyOf(first.refreshToken);
      beforeNextCreate(() => auth.logout(first.refreshToken));

      await expect(auth.refresh(first.refreshToken)).rejects.toThrow(UnauthorizedException);
      expect(familyRows(familyId)).toHaveLength(2);
      expect(familyRows(familyId).every((r) => r.revokedAt)).toBe(true);
    });

    it('寬限期重試換發途中，另一個請求觸發盜用偵測 → 重試回 401，family 全部撤銷', async () => {
      const first = await login();
      const familyId = familyOf(first.refreshToken);
      await auth.refresh(first.refreshToken);
      clock.advance(REFRESH_REUSE_GRACE_MS - 1000);

      // 寬限期內的重試走到 issue() 前，有人在寬限期外重用同一個舊 token（盜用偵測撤銷 family）
      beforeNextCreate(async () => {
        clock.advance(2000);
        await expect(auth.refresh(first.refreshToken)).rejects.toThrow(UnauthorizedException);
      });

      await expect(auth.refresh(first.refreshToken)).rejects.toThrow(UnauthorizedException);
      expect(familyRows(familyId).every((r) => r.revokedAt)).toBe(true);
    });

    it('撤銷方第一次 updateMany 之後才 commit 的新 row，也會被第二次撤銷撈到', async () => {
      const first = await login();
      const familyId = familyOf(first.refreshToken);
      const original = prisma.refreshToken.updateMany.getMockImplementation()!;
      prisma.refreshToken.updateMany.mockImplementationOnce(async (args: any) => {
        const res = await original(args);
        // 併發的換發在這之後才 commit（它自己的檢查又剛好在撤銷 commit 之前讀，什麼都沒看到）
        prisma.refreshRows.push({
          id: 'late-row',
          userId: 'u-1',
          familyId,
          tokenHash: 'late-hash',
          expiresAt: new Date(clock.now().getTime() + 86_400_000),
          revokedAt: null,
          rotatedAt: null,
          createdAt: clock.now(),
        });
        return res;
      });

      await auth.logout(first.refreshToken);
      expect(familyRows(familyId).find((r) => r.id === 'late-row')!.revokedAt).not.toBeNull();
      expect(familyRows(familyId).every((r) => r.revokedAt)).toBe(true);
    });
  });

  it('JWT_REFRESH_EXPIRATION 可設定有效期', async () => {
    const short = new RefreshTokenService(prisma as any, clock, audit as any, config({ JWT_REFRESH_EXPIRATION: '1h' }));
    await short.issueNewFamily('u-1');
    const row = prisma.refreshRows[prisma.refreshRows.length - 1];
    expect(row.expiresAt.getTime() - clock.now().getTime()).toBe(3_600_000);
  });

  it('parseDurationMs', () => {
    expect(parseDurationMs('7d')).toBe(7 * 86_400_000);
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('3600')).toBe(3_600_000);
    expect(parseDurationMs('nonsense')).toBeNull();
    expect(parseDurationMs('')).toBeNull();
  });
});
