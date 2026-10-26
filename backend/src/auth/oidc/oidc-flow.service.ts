import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as oidc from 'openid-client';
import { RedisService } from '../../common/redis.service';
import { Clock } from '../../common/clock';
import { AuditRequestContext, AuditService } from '../../audit/audit.service';
import { CompanyService } from '../../company/company.service';
import { PrismaService } from '../../common/prisma.service';
import { AuthConfig } from '../../common/auth-config';
import { AuthService, AuthTokens } from '../auth.service';
import { describeOidcError, oidcEnvProblems, OidcClient, OidcProviderError } from './oidc-client';
import { SsoErrorCode, SsoFlowError, ssoHttpError } from './oidc-errors';
import { SsoLoginService } from './sso-login.service';

export type SsoClient = 'web' | 'mobile';

export const OIDC_STATE_TTL_SECONDS = 600;
export const OIDC_TICKET_TTL_SECONDS = 60;
/** OIDC 流程的 Redis 指令超過這個時間就當失敗（拒絕登入，不像停用快取那樣退回 DB）。 */
export const OIDC_REDIS_TIMEOUT_MS = 2_000;
export const DEFAULT_MOBILE_CALLBACK_URL = 'oidea://auth';

/** base64url（無 padding）的 sha256 = 43 字元。 */
const APP_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** ticket = 32 bytes base64url = 43 字元。 */
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 code_verifier：43–128 個 unreserved 字元。 */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** openid-client randomState() 產生的格式；收到不像的 state 直接拒，不查 Redis。 */
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

interface StoredState {
  client: SsoClient;
  appChallenge: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

interface StoredTicket {
  userId: string;
  email: string;
  appChallenge: string;
  issuedAt: number;
}

const stateKey = (state: string) => `oidc:state:${state}`;
/** Redis key 存 ticket 的 sha256，不存明文。 */
const ticketKey = (ticket: string) => `oidc:ticket:${createHash('sha256').update(ticket, 'utf8').digest('hex')}`;

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // 長度不同也做一次比較，避免用時間差判斷長度
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function isSsoClient(v: unknown): v is SsoClient {
  return v === 'web' || v === 'mobile';
}

/**
 * 後端主導的 OIDC 登入（spec §4.3）：
 *   start    → 302 到 IdP（state、nonce、PKCE S256；state 資料存 Redis 10 分鐘，綁 client 與 app_challenge）
 *   callback → 換 token、驗 id_token、對應員工、建 ticket（60 秒、只能用一次）→ 302 回 App
 *   exchange → ticket + app_verifier（S256 對 app_challenge）→ { accessToken, refreshToken, user }
 *
 * Redis（state、ticket）任何錯誤都拒絕這次登入。client secret、code、id_token、token、ticket
 * 一律不進 log、錯誤訊息、audit 或 URL query（ticket 只放在 web 的 fragment／mobile 的自訂 scheme）。
 */
@Injectable()
export class OidcFlowService {
  private readonly logger = new Logger(OidcFlowService.name);

  constructor(
    private readonly oidcClient: OidcClient,
    private readonly redis: RedisService,
    private readonly clock: Clock,
    private readonly ssoLogin: SsoLoginService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly authConfig: AuthConfig,
    private readonly audit: AuditService,
    private readonly company: CompanyService,
  ) {}

  /**
   * IdP 那一段就被拒絕的登入（email 沒驗證、id_token／token 驗證失敗）也寫 `auth.sso_denied`
   * （review N2）。metadata 只有原因代碼，不含 token、code 或 claims。
   */
  private async auditDenied(
    reason: 'email_unverified' | 'id_token_invalid',
    metadata: Record<string, unknown>,
    req?: AuditRequestContext,
  ): Promise<void> {
    let workspaceId: string | null = null;
    try {
      workspaceId = (await this.company.findCompanyWorkspace())?.id ?? null;
    } catch {
      workspaceId = null;
    }
    await this.audit.record({
      actorId: null,
      workspaceId,
      action: 'auth.sso_denied',
      metadata: { reason, ...metadata },
      req,
    });
  }

  /** SSO 沒開（沒設 OIDC_ISSUER）→ 404；開了但設定不完整 → 503（設定錯誤，記 log）。 */
  assertEnabled(): void {
    if (!this.authConfig.ssoEnabled()) throw new NotFoundException('Not Found');
    const missing = oidcEnvProblems(this.oidcClient.env());
    if (missing.length > 0) {
      this.logger.error(`SSO misconfigured, missing: ${missing.join(', ')}`);
      throw ssoHttpError(HttpStatus.SERVICE_UNAVAILABLE, 'server_error');
    }
  }

  /**
   * 回傳 302 的目標：IdP authorize URL；IdP 或 Redis 出錯時回 App 的 callback（error=server_error）。
   * 參數格式錯誤丟 400。
   */
  async start(client: unknown, appChallenge: unknown): Promise<string> {
    this.assertEnabled();
    if (!isSsoClient(client) || typeof appChallenge !== 'string' || !APP_CHALLENGE_RE.test(appChallenge)) {
      throw ssoHttpError(HttpStatus.BAD_REQUEST, 'invalid_request');
    }
    try {
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      // 行動版：自訂 scheme `oidea://` 可能被別的 App 搶註冊，那個 App 可以自己發起登入、帶自己的
      // app_challenge。要求 IdP 重新登入（prompt=login），使用者已有的 IdP session 就不會被靜默沿用
      // （review S6；長期解法是 Android App Links，見 DEPLOY_DOKPLOY.md）。
      const url = await this.oidcClient.authorizationUrl({
        state,
        nonce,
        codeChallenge,
        ...(client === 'mobile' ? { prompt: 'login' as const } : {}),
      });
      const stored: StoredState = { client, appChallenge, nonce, codeVerifier, createdAt: this.clock.now().getTime() };
      await this.redisCall(this.redis.set(stateKey(state), JSON.stringify(stored), OIDC_STATE_TTL_SECONDS));
      return url.toString();
    } catch (err) {
      this.logger.error(`SSO start failed (${describeOidcError(err)})`);
      return this.appRedirect(client, { error: 'server_error' });
    }
  }

  /** IdP 轉回來的 callback；一律回傳 302 的目標（App 的 callback，帶 ticket 或 error）。 */
  async callback(query: Record<string, unknown>, req?: AuditRequestContext): Promise<string> {
    this.assertEnabled();
    const state = typeof query.state === 'string' ? query.state : '';
    if (!STATE_RE.test(state)) return this.appRedirect('web', { error: 'invalid_state' });

    let stored: StoredState | null;
    try {
      const raw = await this.redisCall(this.redis.getdel(stateKey(state)));
      stored = raw ? this.parseState(raw) : null;
    } catch (err) {
      this.logger.error(`SSO callback: state lookup failed (${describeOidcError(err)})`);
      // 不知道是哪個 client，只能回 web
      return this.appRedirect('web', { error: 'server_error' });
    }
    if (!stored) return this.appRedirect('web', { error: 'invalid_state' });
    const client = stored.client;

    try {
      if (this.clock.now().getTime() - stored.createdAt > OIDC_STATE_TTL_SECONDS * 1000) {
        throw new SsoFlowError('expired', 'state_expired');
      }
      if (typeof query.error === 'string' && query.error) {
        const idpError = /^[a-z_]{1,64}$/i.test(query.error) ? query.error : 'invalid';
        throw new SsoFlowError('server_error', `idp_error:${idpError}`);
      }
      if (typeof query.code !== 'string' || !query.code) throw new SsoFlowError('server_error', 'missing_code');

      const params = new URLSearchParams();
      for (const k of ['code', 'state', 'iss', 'session_state']) {
        const v = query[k];
        if (typeof v === 'string') params.set(k, v);
      }
      const identity = await this.oidcClient.exchangeCode(params, {
        state,
        nonce: stored.nonce,
        codeVerifier: stored.codeVerifier,
      });
      if (!identity.emailVerified || !identity.email) {
        const detail = identity.email ? 'email_not_verified' : 'missing_email';
        await this.auditDenied(
          'email_unverified',
          { code: 'email_unverified', detail, client, ...(identity.email ? { email: identity.email.trim().toLowerCase() } : {}) },
          req,
        );
        throw new SsoFlowError('email_unverified', detail);
      }

      const result = await this.ssoLogin.loginWithOidc({ sub: identity.sub, email: identity.email }, req);
      if (!result.ok) return this.appRedirect(client, { error: result.code });

      const ticket = randomBytes(32).toString('base64url');
      const payload: StoredTicket = {
        userId: result.userId,
        email: result.email,
        appChallenge: stored.appChallenge,
        issuedAt: this.clock.now().getTime(),
      };
      await this.redisCall(this.redis.set(ticketKey(ticket), JSON.stringify(payload), OIDC_TICKET_TTL_SECONDS));
      return this.appRedirect(client, { ticket });
    } catch (err) {
      const code: SsoErrorCode = err instanceof SsoFlowError ? err.code : 'server_error';
      const detail =
        err instanceof SsoFlowError
          ? err.reason
          : err instanceof OidcProviderError
            ? `${err.stage}: ${err.detail}`
            : describeOidcError(err);
      if (code === 'server_error') this.logger.error(`SSO callback failed (${detail})`);
      else this.logger.warn(`SSO callback rejected (${detail})`);
      // token endpoint 或 id_token 驗證失敗（簽章、nonce、aud、alg…）：可能是竄改，寫 audit
      // （discovery 失敗是 IdP 掛掉，不算拒絕登入）
      if (err instanceof OidcProviderError && err.stage !== 'discovery') {
        await this.auditDenied('id_token_invalid', { code, stage: err.stage, client }, req).catch(() => undefined);
      }
      return this.appRedirect(client, { error: code });
    }
  }

  /** ticket + app_verifier → token。錯誤：400/401 帶 `code`；Redis 出錯 503 server_error。 */
  async exchange(ticket: unknown, appVerifier: unknown, req?: AuditRequestContext): Promise<AuthTokens> {
    this.assertEnabled();
    if (typeof ticket !== 'string' || !TICKET_RE.test(ticket) || typeof appVerifier !== 'string' || !VERIFIER_RE.test(appVerifier)) {
      throw ssoHttpError(HttpStatus.BAD_REQUEST, 'invalid_ticket');
    }

    let raw: string | null;
    try {
      // GETDEL：只能用一次，兩個併發 exchange 只有一個拿得到
      raw = await this.redisCall(this.redis.getdel(ticketKey(ticket)));
    } catch (err) {
      this.logger.error(`SSO exchange: ticket lookup failed (${describeOidcError(err)})`);
      throw ssoHttpError(HttpStatus.SERVICE_UNAVAILABLE, 'server_error');
    }
    const stored = raw ? this.parseTicket(raw) : null;
    if (!stored) throw ssoHttpError(HttpStatus.UNAUTHORIZED, 'invalid_ticket');
    if (this.clock.now().getTime() - stored.issuedAt > OIDC_TICKET_TTL_SECONDS * 1000) {
      throw ssoHttpError(HttpStatus.UNAUTHORIZED, 'expired');
    }
    if (!safeEqual(s256(appVerifier), stored.appChallenge)) {
      throw ssoHttpError(HttpStatus.UNAUTHORIZED, 'invalid_ticket');
    }

    // callback 之後到現在（≤ 60 秒）被停用、刪除或離職的話不發 token（review N5）
    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, email: true, disabledAt: true, deletedAt: true },
    });
    if (!user || user.disabledAt || user.deletedAt) throw ssoHttpError(HttpStatus.UNAUTHORIZED, 'disabled');
    const profile = await this.prisma.employeeProfile.findUnique({
      where: { userId: user.id },
      select: { employmentStatus: true },
    });
    if (!profile) throw ssoHttpError(HttpStatus.UNAUTHORIZED, 'not_employee');
    if (profile.employmentStatus === 'terminated') throw ssoHttpError(HttpStatus.UNAUTHORIZED, 'terminated');

    return this.auth.completeSsoLogin(user.id, user.email, req);
  }

  /** App 的 callback URL。web：`#ticket=`／`#error=`（fragment）；mobile：`?ticket=`／`?error=`。 */
  appRedirect(client: SsoClient, result: { ticket: string } | { error: SsoErrorCode }): string {
    const env = this.oidcClient.env();
    const params = new URLSearchParams('ticket' in result ? { ticket: result.ticket } : { error: result.error });
    if (client === 'mobile') {
      const url = new URL(env.mobileCallbackUrl || DEFAULT_MOBILE_CALLBACK_URL);
      url.hash = '';
      for (const [k, v] of params.entries()) url.searchParams.set(k, v);
      return url.toString();
    }
    const url = new URL(env.webCallbackUrl);
    url.hash = params.toString();
    return url.toString();
  }

  private parseState(raw: string): StoredState | null {
    try {
      const v = JSON.parse(raw);
      if (
        v &&
        isSsoClient(v.client) &&
        typeof v.appChallenge === 'string' &&
        typeof v.nonce === 'string' &&
        typeof v.codeVerifier === 'string' &&
        typeof v.createdAt === 'number'
      ) {
        return v;
      }
    } catch {
      /* fallthrough */
    }
    return null;
  }

  private parseTicket(raw: string): StoredTicket | null {
    try {
      const v = JSON.parse(raw);
      if (
        v &&
        typeof v.userId === 'string' &&
        typeof v.email === 'string' &&
        typeof v.appChallenge === 'string' &&
        typeof v.issuedAt === 'number'
      ) {
        return v;
      }
    } catch {
      /* fallthrough */
    }
    return null;
  }

  private redisCall<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis timeout')), OIDC_REDIS_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
