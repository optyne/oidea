/**
 * SSO 端到端測試的組裝（只給 *.spec.ts）：真的 Nest HTTP、真的 OidcController／OidcFlowService／
 * SsoLoginService／OidcClient（openid-client）／AuthService／RefreshTokenService／JwtStrategy／
 * AttendanceController，Prisma 與 Redis 用記憶體版，IdP 用 FakeIdp。
 * Nest Logger 與 console 的輸出全部收進 `logs`，給 log 測試比對。
 */
import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { AuthController } from '../../auth.controller';
import { AuthService } from '../../auth.service';
import { RefreshTokenService } from '../../refresh-token.service';
import { UserStatusService } from '../../user-status.service';
import { JwtStrategy } from '../../strategies/jwt.strategy';
import { SocketRegistry } from '../../socket-registry';
import { UsersService } from '../../../users/users.service';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../common/prisma.service';
import { RedisService } from '../../../common/redis.service';
import { Clock, FakeClock } from '../../../common/clock';
import { AuthConfig } from '../../../common/auth-config';
import { CompanyService } from '../../../company/company.service';
import { AllExceptionsFilter } from '../../../common/http-exception.filter';
import { AttendanceController } from '../../../attendance/attendance.controller';
import { AttendanceService } from '../../../attendance/attendance.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { OidcController } from '../oidc.controller';
import { OIDC_CLIENT_TUNING, OidcClient } from '../oidc-client';
import { OidcFlowService } from '../oidc-flow.service';
import { SsoLoginService } from '../sso-login.service';
import { FakeIdp, FakeIdpUser } from './fake-idp';
import { FakeSsoPrisma, FakeSsoRedis } from './sso-fakes';

export const JWT_TEST_SECRET = 'jwt-test-secret';
export const COMPANY_WS = 'ws-company';

class CaptureLogger implements LoggerService {
  constructor(private readonly sink: string[]) {}
  private push(level: string, args: unknown[]) {
    this.sink.push(`${level} ${args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  }
  log(...a: unknown[]) {
    this.push('log', a);
  }
  error(...a: unknown[]) {
    this.push('error', a);
  }
  warn(...a: unknown[]) {
    this.push('warn', a);
  }
  debug(...a: unknown[]) {
    this.push('debug', a);
  }
  verbose(...a: unknown[]) {
    this.push('verbose', a);
  }
  fatal(...a: unknown[]) {
    this.push('fatal', a);
  }
}

export interface SsoCallbackResult {
  /** App callback 的完整 URL（302 Location） */
  location: string;
  ticket?: string;
  error?: string;
  headers: Headers;
}

export function newVerifier(): string {
  return randomBytes(32).toString('base64url');
}
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export class SsoHarness {
  app!: INestApplication;
  base = '';
  readonly clock = new FakeClock(Date.now());
  readonly prisma = new FakeSsoPrisma(this.clock);
  readonly redis = new FakeSsoRedis();
  readonly logs: string[] = [];
  /** 這個 harness 經手的 ticket、access/refresh token（log 測試用） */
  readonly secrets: string[] = [];
  readonly env: Record<string, string | undefined>;
  private restoreConsole: (() => void) | null = null;

  constructor(
    readonly idp: FakeIdp,
    envOverrides: Record<string, string | undefined> = {},
  ) {
    this.env = {
      JWT_SECRET: JWT_TEST_SECRET,
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: idp.clientId,
      OIDC_CLIENT_SECRET: idp.clientSecret,
      APP_WEB_CALLBACK_URL: 'https://app.example/auth/callback',
      APP_MOBILE_CALLBACK_URL: 'oidea://auth',
      ...envOverrides,
    };
  }

  /** 公司工作空間＋一位既有 owner（company:init 的執行者）。 */
  seedCompany(p: { pendingOwnerEmail?: string | null } = {}) {
    this.prisma.addUser({ id: 'u-founder', email: 'founder@corp.com', username: 'founder', passwordHash: 'hash:x' });
    this.prisma.addWorkspace({
      id: COMPANY_WS,
      ownerId: 'u-founder',
      isCompany: true,
      pendingOwnerEmail: p.pendingOwnerEmail ?? null,
    });
    this.prisma.addMember(COMPANY_WS, 'u-founder', 'owner');
  }

  async start(): Promise<this> {
    const sink = this.logs;
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    const capture =
      (level: string) =>
      (...a: unknown[]) =>
        sink.push(`console.${level} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`);
    console.log = capture('log');
    console.error = capture('error');
    console.warn = capture('warn');
    console.info = capture('info');
    console.debug = capture('debug');
    this.restoreConsole = () => Object.assign(console, orig);

    const env = this.env;
    const config = {
      get: (k: string, d?: unknown) => (env[k] !== undefined ? env[k] : d),
      getOrThrow: (k: string) => {
        if (env[k] === undefined) throw new Error(`missing ${k}`);
        return env[k];
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: JWT_TEST_SECRET, signOptions: { expiresIn: '15m' } }),
      ],
      controllers: [OidcController, AuthController, AttendanceController],
      providers: [
        AuthService,
        OidcClient,
        { provide: OIDC_CLIENT_TUNING, useValue: { allowInsecureHttp: true, timeoutSeconds: 5, discoveryRetryMs: 0 } },
        OidcFlowService,
        SsoLoginService,
        RefreshTokenService,
        UserStatusService,
        SocketRegistry,
        JwtStrategy,
        AuditService,
        AuthConfig,
        CompanyService,
        UsersService,
        AttendanceService,
        { provide: NotificationsService, useValue: {} },
        { provide: Clock, useValue: this.clock },
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: this.prisma },
        { provide: RedisService, useValue: this.redis },
      ],
    }).compile();

    this.app = moduleRef.createNestApplication({ logger: new CaptureLogger(sink) });
    this.app.useGlobalFilters(new AllExceptionsFilter());
    this.app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await this.app.listen(0, '127.0.0.1');
    this.base = `http://127.0.0.1:${this.app.getHttpServer().address().port}`;
    if (this.env.OIDC_REDIRECT_URI === undefined) this.env.OIDC_REDIRECT_URI = `${this.base}/auth/oidc/callback`;
    this.idp.redirectUri = this.env.OIDC_REDIRECT_URI ?? '';
    return this;
  }

  async close() {
    await this.app?.close();
    this.restoreConsole?.();
  }

  get(path: string, headers: Record<string, string> = {}) {
    return fetch(`${this.base}${path}`, { redirect: 'manual', headers });
  }

  async post(path: string, body: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  /** GET /auth/oidc/start → 302 Location。 */
  async start302(client: 'web' | 'mobile', challenge: string) {
    const res = await this.get(`/auth/oidc/start?client=${client}&app_challenge=${challenge}`);
    return { status: res.status, location: res.headers.get('location') ?? '', headers: res.headers };
  }

  /** start → 假 IdP authorize → 回到 callback 前一刻：回傳 IdP 給的 callback URL。 */
  async toIdpCallback(client: 'web' | 'mobile', verifier: string, user?: FakeIdpUser): Promise<string> {
    if (user) this.idp.nextUser = user;
    const s = await this.start302(client, challengeOf(verifier));
    if (s.status !== 302 || !s.location.startsWith(this.idp.issuer)) {
      throw new Error(`start did not redirect to IdP (status ${s.status})`);
    }
    const authorize = await fetch(s.location, { redirect: 'manual' });
    const back = authorize.headers.get('location');
    if (authorize.status !== 302 || !back) throw new Error(`IdP authorize failed (${authorize.status})`);
    return back;
  }

  /** 打 callback，解析 App callback 的 ticket／error。 */
  async callback(idpCallbackUrl: string): Promise<SsoCallbackResult> {
    const res = await fetch(idpCallbackUrl, { redirect: 'manual' });
    const location = res.headers.get('location') ?? '';
    const out: SsoCallbackResult = { location, headers: res.headers };
    if (res.status !== 302) throw new Error(`callback status ${res.status}`);
    const url = new URL(location);
    const params = url.protocol === 'oidea:' ? url.searchParams : new URLSearchParams(url.hash.replace(/^#/, ''));
    out.ticket = params.get('ticket') ?? undefined;
    out.error = params.get('error') ?? undefined;
    if (out.ticket) this.secrets.push(out.ticket);
    return out;
  }

  async exchange(ticket: string, appVerifier: string) {
    const res = await this.post('/auth/oidc/exchange', { ticket, app_verifier: appVerifier });
    if (res.body?.accessToken) this.secrets.push(res.body.accessToken);
    if (res.body?.refreshToken) this.secrets.push(res.body.refreshToken);
    return res;
  }

  /** 完整流程：start → IdP → callback →（有 ticket 才）exchange。 */
  async login(user: FakeIdpUser, client: 'web' | 'mobile' = 'web') {
    const verifier = newVerifier();
    const cb = await this.callback(await this.toIdpCallback(client, verifier, user));
    const exchanged = cb.ticket ? await this.exchange(cb.ticket, verifier) : null;
    return { callback: cb, exchange: exchanged, verifier };
  }

  audits(action?: string) {
    return this.prisma.auditLogs.filter((a) => !action || a.action === action);
  }

  allLogs(): string {
    return this.logs.join('\n');
  }
}
