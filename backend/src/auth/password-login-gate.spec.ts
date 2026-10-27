import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { AuthConfig } from '../common/auth-config';
import { CompanyService } from '../company/company.service';
import { FakeCompanyPrisma } from '../company/testing/company-fakes';

// 跟真的 bcrypt 一樣：hash 不是字串時丟錯（拿掉 null 檢查的話會變成 500，而不是 401）
jest.mock('bcrypt', () => ({
  hash: jest.fn(async (pw: string) => `hashed:${pw}`),
  compare: jest.fn(async (pw: string, hash: unknown) => {
    if (typeof hash !== 'string') throw new Error('data and hash arguments required');
    return hash === `hashed:${pw}`;
  }),
}));

/**
 * H1：帳密登入開關與緊急登入（spec §4.3 break-glass），真的 HTTP。
 */
describe('帳密登入開關與緊急登入（HTTP）', () => {
  let app: INestApplication | undefined;
  let base: string;
  let prisma: FakeCompanyPrisma;
  let audit: { record: jest.Mock };

  const start = async (env: Record<string, string>) => {
    prisma = new FakeCompanyPrisma();
    // 公司 owner 都已綁定 SSO（review R2：緊急登入只給綁定過的 owner）
    prisma.addUser({ id: 'u-owner', email: 'owner@corp.com', passwordHash: 'hashed:owner-pass', ssoBound: true });
    prisma.addUser({ id: 'u-coowner', email: 'co@corp.com', passwordHash: 'hashed:co-pass', ssoBound: true });
    prisma.addUser({ id: 'u-member', email: 'member@corp.com', passwordHash: 'hashed:member-pass' });
    prisma.addUser({ id: 'u-other-owner', email: 'other@corp.com', passwordHash: 'hashed:other-pass' });
    prisma.addUser({ id: 'u-sso', email: 'sso@corp.com', passwordHash: null });
    prisma.addWorkspace({ id: 'ws-co', ownerId: 'u-owner', isCompany: true });
    prisma.addMember('ws-co', 'u-owner', 'owner');
    prisma.addMember('ws-co', 'u-coowner', 'owner');
    prisma.addMember('ws-co', 'u-member', 'admin');
    // 別的工作空間的 owner 不算公司 owner
    prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-other-owner' });
    prisma.addMember('ws-side', 'u-other-owner', 'owner');

    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const users = {
      findByEmail: jest.fn(async (email: string) => prisma.users.find((u) => u.email === email) ?? null),
      findByUsername: jest.fn(async () => null),
      create: jest.fn(async (data: any) => ({ id: 'u-new', ...data })),
    };
    const config = { get: (k: string, d?: unknown) => env[k] ?? d };

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '15m' } })],
      controllers: [AuthController],
      providers: [
        AuthService,
        AuthConfig,
        { provide: CompanyService, useValue: new CompanyService(prisma as any) },
        { provide: ConfigService, useValue: config },
        { provide: UsersService, useValue: users },
        { provide: AuditService, useValue: audit },
        { provide: RefreshTokenService, useValue: { issueNewFamily: jest.fn(async () => 'opaque-refresh') } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  };

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const login = (email: string, password: string) => post('/auth/login', { email, password });
  const register = () =>
    post('/auth/register', { email: 'new@corp.com', username: 'newbie', displayName: 'New', password: 'password123' });
  const actions = () => audit.record.mock.calls.map((c) => c[0].action);

  describe('正式環境的設定（NODE_ENV=production，沒設 AUTH_PASSWORD_LOGIN_ENABLED）', () => {
    beforeEach(() => start({ NODE_ENV: 'production' }));

    it('POST /auth/register → 404', async () => {
      expect((await register()).status).toBe(404);
    });

    it('POST /auth/login（帳密正確的公司 owner）→ 404，不發 token', async () => {
      const res = await login('owner@corp.com', 'owner-pass');
      expect(res.status).toBe(404);
      expect(res.body.accessToken).toBeUndefined();
      expect(actions()).not.toContain('auth.login');
      expect(actions()).not.toContain('auth.break_glass');
    });

    it('GET /auth/config → { sso: false, passwordLogin: false, breakGlass: false, endSessionUrl: null }', async () => {
      const res = await fetch(`${base}/auth/config`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sso: false, passwordLogin: false, breakGlass: false, endSessionUrl: null });
    });
  });

  describe('review S4：有 OIDC_ISSUER、但忘了設 NODE_ENV 與 AUTH_PASSWORD_LOGIN_ENABLED → 預設關（fail closed）', () => {
    beforeEach(() => start({ OIDC_ISSUER: 'https://auth.example.com/application/o/oidea/' }));

    it('POST /auth/register → 404', async () => {
      expect((await register()).status).toBe(404);
    });

    it('POST /auth/login（帳密正確）→ 404，不發 token', async () => {
      const res = await login('member@corp.com', 'member-pass');
      expect(res.status).toBe(404);
      expect(res.body.accessToken).toBeUndefined();
      expect(actions()).not.toContain('auth.login');
    });

    it('GET /auth/config 的 passwordLogin=false', async () => {
      expect(await (await fetch(`${base}/auth/config`)).json()).toMatchObject({ sso: true, passwordLogin: false });
    });
  });

  describe('BREAK_GLASS_OWNER_EMAILS 有設（帳密登入關閉）', () => {
    beforeEach(() =>
      start({
        AUTH_PASSWORD_LOGIN_ENABLED: 'false',
        BREAK_GLASS_OWNER_EMAILS: ' Owner@Corp.com , member@corp.com,co@corp.com',
      }),
    );

    it('名單上的公司 owner（email 大小寫不同也算名單上）→ 登入成功，每次都寫 auth.break_glass', async () => {
      const first = await login('owner@corp.com', 'owner-pass');
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ refreshToken: 'opaque-refresh', user: { id: 'u-owner' } });
      expect(typeof first.body.accessToken).toBe('string');
      expect((await login('owner@corp.com', 'owner-pass')).status).toBe(201);

      const breakGlass = audit.record.mock.calls.filter((c) => c[0].action === 'auth.break_glass');
      expect(breakGlass).toHaveLength(2);
      expect(breakGlass[0][0]).toMatchObject({ actorId: 'u-owner', workspaceId: 'ws-co', targetId: 'u-owner' });
    });

    it('共同 owner（成員角色 owner，不是 ownerId）也可以', async () => {
      expect((await login('co@corp.com', 'co-pass')).status).toBe(201);
      expect(actions()).toContain('auth.break_glass');
    });

    it('名單上但不是公司 owner（admin）→ 404，回應跟「沒在名單上」一樣', async () => {
      const notOwner = await login('member@corp.com', 'member-pass');
      const notListed = await login('other@corp.com', 'other-pass');
      expect(notOwner.status).toBe(404);
      expect(notListed.status).toBe(404);
      expect(notOwner.body).toEqual(notListed.body);
      expect(actions()).not.toContain('auth.break_glass');
      expect(actions()).not.toContain('auth.login');
    });

    it('review R2：名單上的公司 owner、密碼也對，但帳號還沒綁定 SSO（可能是搶註的人）→ 404，不發 token', async () => {
      prisma.users.find((u) => u.id === 'u-owner')!.ssoBound = false;
      const res = await login('owner@corp.com', 'owner-pass');
      expect(res.status).toBe(404);
      expect(res.body).toEqual((await login('other@corp.com', 'other-pass')).body);
      expect(res.body.accessToken).toBeUndefined();
      expect(actions()).not.toContain('auth.break_glass');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login_failed', metadata: expect.objectContaining({ reason: 'break_glass_not_sso_bound' }) }),
      );
    });

    it('名單上的 owner 打錯密碼 → 404（不是 401，不透露名單）', async () => {
      const wrong = await login('owner@corp.com', 'nope');
      expect(wrong.status).toBe(404);
      expect(wrong.body).toEqual((await login('other@corp.com', 'other-pass')).body);
      expect(actions()).not.toContain('auth.break_glass');
    });

    it('register 仍然 404', async () => {
      expect((await register()).status).toBe(404);
    });

    it('GET /auth/config：passwordLogin 仍是 false；breakGlass=true（review S5：只透露「緊急登入開著」，不透露名單）', async () => {
      const body = await (await fetch(`${base}/auth/config`)).json();
      expect(body).toEqual({ sso: false, passwordLogin: false, breakGlass: true, endSessionUrl: null });
      expect(JSON.stringify(body)).not.toMatch(/owner|member|co@/i);
    });
  });

  it('沒設 BREAK_GLASS_OWNER_EMAILS 時，公司 owner 也是 404', async () => {
    await start({ AUTH_PASSWORD_LOGIN_ENABLED: 'false' });
    expect((await login('owner@corp.com', 'owner-pass')).status).toBe(404);
  });

  describe('帳密登入開啟（開發環境）', () => {
    beforeEach(() =>
      start({
        NODE_ENV: 'development',
        OIDC_ISSUER: 'https://auth.example.com/application/o/oidea/',
        // 有 OIDC_ISSUER 時要明確開啟（review S4）
        AUTH_PASSWORD_LOGIN_ENABLED: 'true',
      }),
    );

    it('一般登入照常 201（不需要是 owner）', async () => {
      expect((await login('member@corp.com', 'member-pass')).status).toBe(201);
      expect(actions()).toContain('auth.login');
      expect(actions()).not.toContain('auth.break_glass');
    });

    it('passwordHash 為 null（只走 SSO 的帳號）→ 401，訊息跟密碼錯誤一樣', async () => {
      const sso = await login('sso@corp.com', 'anything');
      const wrong = await login('member@corp.com', 'wrong');
      expect(sso.status).toBe(401);
      expect(sso.body.message).toBe('信箱或密碼錯誤');
      expect(sso.body).toEqual(wrong.body);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'u-sso',
          action: 'auth.login_failed',
          metadata: { email: 'sso@corp.com', reason: 'no_password' },
        }),
      );
    });

    it('GET /auth/config → { sso: true, passwordLogin: true, breakGlass: false, endSessionUrl }，只有這四個欄位、不含設定值', async () => {
      const body = await (await fetch(`${base}/auth/config`)).json();
      // 這個測試沒有 OidcClient（拿不到 discovery）→ endSessionUrl 是 null
      expect(body).toEqual({ sso: true, passwordLogin: true, breakGlass: false, endSessionUrl: null });
      expect(JSON.stringify(body)).not.toContain('auth.example.com');
    });
  });
});
