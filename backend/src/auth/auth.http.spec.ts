import { Controller, Get, INestApplication, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';
import { UserStatusService } from './user-status.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { Clock, FakeClock } from '../common/clock';
import { FakePrisma, FakeRedis } from './testing/auth-fakes';

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (pw: string) => `hashed:${pw}`),
  compare: jest.fn(async (pw: string, hash: string) => hash === `hashed:${pw}`),
}));

/** 一個「一般 API」：掛 JwtAuthGuard，回傳 req.user。 */
@Controller('probe')
class ProbeController {
  @Get()
  @UseGuards(JwtAuthGuard)
  get(@Req() req: any) {
    return req.user;
  }
}

/**
 * 端到端（真的 HTTP、真的 passport-jwt、真的 JwtAuthGuard），只有 Prisma／Redis 用記憶體版。
 */
describe('Auth over HTTP（H0 驗收）', () => {
  let app: INestApplication;
  let base: string;
  let prisma: FakePrisma;
  let redis: FakeRedis;
  let audit: { record: jest.Mock };
  let jwt: JwtService;
  let userStatus: UserStatusService;

  beforeEach(async () => {
    const clock = new FakeClock(Date.now());
    prisma = new FakePrisma(clock);
    prisma.addUser({ id: 'u-1', email: 'alice@example.com', passwordHash: 'hashed:pw' });
    prisma.addUser({ id: 'creator-1', email: 'creator@example.com' });
    prisma.bots.push({
      id: 'bot-1',
      tokenPrefix: 'bot_abcdef',
      tokenHash: 'hashed:s3cret',
      revokedAt: null,
      userId: 'bot-user-1',
      workspaceId: 'ws-1',
      createdById: 'creator-1',
    });
    redis = new FakeRedis();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const users = {
      findByEmail: jest.fn(async (email: string) =>
        [...prisma.users.values()].find((u) => u.email === email) ?? null,
      ),
      findById: jest.fn(async (id: string) => prisma.users.get(id) ?? null),
    };
    const config = {
      get: (_k: string, d?: unknown) => d,
      getOrThrow: (k: string) => (k === 'JWT_SECRET' ? 'test-secret' : undefined),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '15m' } }),
      ],
      controllers: [AuthController, ProbeController],
      providers: [
        AuthService,
        RefreshTokenService,
        UserStatusService,
        JwtStrategy,
        { provide: Clock, useValue: clock },
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: UsersService, useValue: users },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    jwt = moduleRef.get(JwtService);
    userStatus = moduleRef.get(UserStatusService);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const probe = (authorization?: string) =>
    fetch(`${base}/probe`, { headers: authorization ? { authorization } : {} });
  const login = async () => {
    const res = await post('/auth/login', { email: 'alice@example.com', password: 'pw' });
    expect(res.status).toBe(201);
    return res.json();
  };

  it('access token 打一般 API → 200', async () => {
    const { accessToken } = await login();
    const res = await probe(`Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'u-1', email: 'alice@example.com' });
  });

  it('refresh token 當 Bearer 打一般 API → 401', async () => {
    const { refreshToken } = await login();
    expect((await probe(`Bearer ${refreshToken}`)).status).toBe(401);
  });

  it('舊格式 token（沒有 typ）與 typ=refresh 的 JWT → 401', async () => {
    const legacy = jwt.sign({ sub: 'u-1', email: 'alice@example.com' });
    expect((await probe(`Bearer ${legacy}`)).status).toBe(401);
    const refreshTyped = jwt.sign({ sub: 'u-1', email: 'alice@example.com', typ: 'refresh' });
    expect((await probe(`Bearer ${refreshTyped}`)).status).toBe(401);
  });

  it('POST /auth/refresh：body 帶 refreshToken、不需要 Authorization → 新的一組 token', async () => {
    const first = await login();
    const res = await post('/auth/refresh', { refreshToken: first.refreshToken });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'refreshToken', 'user']);
    expect(body.user).toEqual({ id: 'u-1', email: 'alice@example.com' });
    expect((await probe(`Bearer ${body.accessToken}`)).status).toBe(200);
  });

  it('POST /auth/refresh：舊做法（access token 當 Bearer、沒有 body）→ 400', async () => {
    const { accessToken } = await login();
    const res = await post('/auth/refresh', {}, { authorization: `Bearer ${accessToken}` });
    expect(res.status).toBe(400);
  });

  it('POST /auth/refresh：無效 token → 401', async () => {
    expect((await post('/auth/refresh', { refreshToken: 'nope' })).status).toBe(401);
  });

  it('POST /auth/logout → {ok:true}，之後這個 refresh token 回 401', async () => {
    const { refreshToken } = await login();
    const res = await post('/auth/logout', { refreshToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await post('/auth/refresh', { refreshToken })).status).toBe(401);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout', actorId: 'u-1' }));
  });

  describe('disabledAt', () => {
    it('設定 disabledAt 並清快取 → 手上的 access token 下一個請求就 401', async () => {
      const { accessToken } = await login();
      expect((await probe(`Bearer ${accessToken}`)).status).toBe(200); // 快取寫入「沒停用」
      prisma.users.get('u-1')!.disabledAt = new Date();
      await userStatus.invalidate('u-1');
      expect((await probe(`Bearer ${accessToken}`)).status).toBe(401);
    });

    it('Redis 被清空（flush）→ 回 DB 查 → 401', async () => {
      const { accessToken } = await login();
      expect((await probe(`Bearer ${accessToken}`)).status).toBe(200);
      prisma.users.get('u-1')!.disabledAt = new Date();
      redis.flushall();
      expect((await probe(`Bearer ${accessToken}`)).status).toBe(401);
    });

    it('Redis 停掉（指令出錯）→ 回 DB 查 → 401', async () => {
      const { accessToken } = await login();
      prisma.users.get('u-1')!.disabledAt = new Date();
      redis.mode = 'throw';
      expect((await probe(`Bearer ${accessToken}`)).status).toBe(401);
    });

    it('Redis 停掉（指令卡住等重連）→ 逾時回 DB 查 → 401', async () => {
      const { accessToken } = await login();
      prisma.users.get('u-1')!.disabledAt = new Date();
      redis.mode = 'hang';
      expect((await probe(`Bearer ${accessToken}`)).status).toBe(401);
    });

    it('Redis 停掉但使用者沒停用 → 照常 200（只是改查 DB）', async () => {
      const { accessToken } = await login();
      redis.mode = 'throw';
      expect((await probe(`Bearer ${accessToken}`)).status).toBe(200);
    });

    it('S5：已停用的帳號用正確密碼登入 → 401、不建立 refresh token row', async () => {
      prisma.users.get('u-1')!.disabledAt = new Date();
      const res = await post('/auth/login', { email: 'alice@example.com', password: 'pw' });
      expect(res.status).toBe(401);
      const wrong = await post('/auth/login', { email: 'alice@example.com', password: 'nope' });
      expect((await res.json()).message).toBe((await wrong.json()).message);
      expect(prisma.refreshRows).toHaveLength(0);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login_failed', metadata: expect.objectContaining({ reason: 'disabled' }) }),
      );
    });

    it('停用後 refresh 也 401', async () => {
      const { refreshToken } = await login();
      prisma.users.get('u-1')!.disabledAt = new Date();
      expect((await post('/auth/refresh', { refreshToken })).status).toBe(401);
    });
  });

  describe('bot token', () => {
    it('建立者正常 → 200', async () => {
      const res = await probe('Bearer bot_abcdef.s3cret');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ userId: 'bot-user-1', isBot: true });
    });

    it('建立者已停用 → 401（Redis 清空時也一樣）', async () => {
      expect((await probe('Bearer bot_abcdef.s3cret')).status).toBe(200);
      prisma.users.get('creator-1')!.disabledAt = new Date();
      redis.flushall();
      expect((await probe('Bearer bot_abcdef.s3cret')).status).toBe(401);
    });
  });
});
