import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as oidc from 'openid-client';
import { AuthConfig, OidcEnv } from '../../common/auth-config';

/** 測試用的調整（正式環境不提供這個 provider）：允許 http issuer、縮短逾時。 */
export const OIDC_CLIENT_TUNING = Symbol('OIDC_CLIENT_TUNING');
export interface OidcClientTuning {
  /** 允許 http:// 的 issuer／endpoint（只給測試裡的假 IdP 用）。 */
  allowInsecureHttp?: boolean;
  /** 對 IdP 每個 HTTP 請求的逾時秒數。預設 10。 */
  timeoutSeconds?: number;
  /** discovery 失敗後多久內不再重試（毫秒），避免 IdP 掛掉時每個請求都等逾時。預設 30 秒。 */
  discoveryRetryMs?: number;
}

export const OIDC_SCOPE = 'openid email profile';
/** 只接受 RS256 簽的 id_token（spec §4.3；Authentik 沒選簽章金鑰時會改用 HS256，那種設定要擋下）。 */
export const ID_TOKEN_ALG = 'RS256';

export interface OidcIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/** IdP 那邊出的錯（discovery、token endpoint、id_token 驗證）。message 不含任何秘密值。 */
export class OidcProviderError extends Error {
  constructor(
    readonly stage: 'discovery' | 'token' | 'id_token',
    readonly detail: string,
  ) {
    super(`oidc ${stage} failed: ${detail}`);
    this.name = 'OidcProviderError';
  }
}

const isUrl = (v: string, schemes?: string[]) => {
  try {
    const u = new URL(v);
    return !schemes || schemes.includes(u.protocol);
  } catch {
    return false;
  }
};

/**
 * OIDC 設定哪裡有問題（缺少或格式不對）。只回變數名稱，不回值。
 * `APP_MOBILE_CALLBACK_URL` 可省略（預設 `oidea://auth`）。
 */
export function oidcEnvProblems(env: OidcEnv): string[] {
  const problems: string[] = [];
  if (!isUrl(env.issuer, ['https:', 'http:'])) problems.push('OIDC_ISSUER');
  if (!env.clientId) problems.push('OIDC_CLIENT_ID');
  if (!env.clientSecret) problems.push('OIDC_CLIENT_SECRET');
  if (!isUrl(env.redirectUri, ['https:', 'http:'])) problems.push('OIDC_REDIRECT_URI');
  if (!isUrl(env.webCallbackUrl, ['https:', 'http:'])) problems.push('APP_WEB_CALLBACK_URL');
  if (env.mobileCallbackUrl && !isUrl(env.mobileCallbackUrl)) problems.push('APP_MOBILE_CALLBACK_URL');
  return problems;
}

/**
 * 把錯誤摘要成「可以進 log 的字串」：只取錯誤類別、oauth4webapi 的 code、IdP 回的 error 代碼、
 * 比對失敗的 claim 名稱。不取 message 或 cause 的值（可能含 token、code、claims）。
 */
export function describeOidcError(err: unknown): string {
  const parts: string[] = [];
  const add = (p: string) => {
    if (!parts.includes(p)) parts.push(p);
  };
  // openid-client 把 oauth4webapi 的錯包一層（ClientError.cause = OperationProcessingError），往下看三層
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur && typeof cur === 'object'; depth++) {
    const e = cur as { name?: unknown; code?: unknown; error?: unknown; claim?: unknown; cause?: unknown };
    if (cur instanceof Error && typeof e.name === 'string') add(e.name);
    if (typeof e.code === 'string' && /^[A-Z0-9_]{1,64}$/i.test(e.code)) add(e.code);
    if (typeof e.error === 'string' && /^[a-z_]{1,64}$/i.test(e.error)) add(`error=${e.error}`);
    if (typeof e.claim === 'string' && /^[a-z_]{1,32}$/i.test(e.claim)) add(`claim=${e.claim}`);
    // oauth4webapi 的 OperationProcessingError 訊息是固定字串（只會帶 claim／參數名稱），可以記；
    // 仍然擋掉長度過長或含長串 token 狀字元的訊息
    const msg = cur instanceof Error && e.name === 'OperationProcessingError' ? cur.message : '';
    if (msg && msg.length <= 120 && !/[A-Za-z0-9_-]{24,}/.test(msg)) add(`"${msg}"`);
    cur = e.cause;
  }
  return parts.length ? parts.join(' ') : 'unknown';
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** id_token 的 JOSE header alg（解析失敗回 null）。只讀 header，不碰 payload。 */
export function idTokenAlg(idToken: string): string | null {
  const [header] = idToken.split('.');
  const parsed = header ? base64UrlJson(header) : null;
  return parsed && typeof parsed.alg === 'string' ? parsed.alg : null;
}

/**
 * Authentik（或任何 OIDC IdP）的 client。用 openid-client v6：
 * - discovery 結果快取（設定值變了才重抓）；失敗時 `discoveryRetryMs` 內直接回錯，之後再試。
 * - confidential client（client_secret_basic）＋ PKCE S256 ＋ state ＋ nonce。
 * - id_token：`enableNonRepudiationChecks` 讓 openid-client 用 JWKS 驗簽；iss、aud、exp、iat、nonce
 *   由 openid-client 驗；alg 只收 RS256（client metadata 指定，另外自己再看一次 header）。
 * - 不在啟動時連 IdP：沒設 OIDC 環境變數時 SSO 只是關閉，app 照常啟動。
 */
@Injectable()
export class OidcClient {
  private readonly logger = new Logger(OidcClient.name);
  private cached: { key: string; promise: Promise<oidc.Configuration> } | null = null;
  private failure: { key: string; at: number } | null = null;
  private readonly tuning: Required<OidcClientTuning>;

  constructor(
    private readonly authConfig: AuthConfig,
    @Optional() @Inject(OIDC_CLIENT_TUNING) tuning?: OidcClientTuning,
  ) {
    this.tuning = {
      allowInsecureHttp: tuning?.allowInsecureHttp ?? false,
      timeoutSeconds: tuning?.timeoutSeconds ?? 10,
      discoveryRetryMs: tuning?.discoveryRetryMs ?? 30_000,
    };
  }

  env(): OidcEnv {
    return this.authConfig.oidc();
  }

  /** discovery（快取）。失敗丟 OidcProviderError('discovery')。 */
  async configuration(): Promise<oidc.Configuration> {
    const env = this.env();
    const key = `${env.issuer}\n${env.clientId}\n${env.clientSecret}`;
    if (this.cached?.key === key) return this.cached.promise;
    if (this.failure?.key === key && Date.now() - this.failure.at < this.tuning.discoveryRetryMs) {
      throw new OidcProviderError('discovery', 'recently failed');
    }

    let issuer: URL;
    try {
      issuer = new URL(env.issuer);
    } catch {
      throw new OidcProviderError('discovery', 'OIDC_ISSUER is not a URL');
    }

    const promise = oidc
      .discovery(
        issuer,
        env.clientId,
        { id_token_signed_response_alg: ID_TOKEN_ALG },
        oidc.ClientSecretBasic(env.clientSecret),
        {
          execute: this.tuning.allowInsecureHttp ? [oidc.allowInsecureRequests] : [],
          timeout: this.tuning.timeoutSeconds,
        },
      )
      .then((config) => {
        oidc.enableNonRepudiationChecks(config);
        config.timeout = this.tuning.timeoutSeconds;
        return config;
      });
    this.cached = { key, promise };
    try {
      const config = await promise;
      this.failure = null;
      return config;
    } catch (err) {
      if (this.cached?.promise === promise) this.cached = null;
      this.failure = { key, at: Date.now() };
      const detail = describeOidcError(err);
      this.logger.error(`OIDC discovery failed (${detail})`);
      throw new OidcProviderError('discovery', detail);
    }
  }

  /** IdP 的 end_session_endpoint；SSO 沒設定或 discovery 失敗時回 null（不丟錯）。 */
  async endSessionUrl(): Promise<string | null> {
    if (!this.authConfig.ssoEnabled() || oidcEnvProblems(this.env()).length > 0) return null;
    try {
      const config = await this.configuration();
      const url = config.serverMetadata().end_session_endpoint;
      return typeof url === 'string' && url.length > 0 ? url : null;
    } catch {
      return null;
    }
  }

  async authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<URL> {
    const config = await this.configuration();
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.env().redirectUri,
      response_type: 'code',
      scope: OIDC_SCOPE,
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /**
   * 用 callback 收到的參數換 token 並驗證 id_token。`callbackParams` 是 IdP 轉回來的 query
   * （code、state、iss…）；redirect_uri 一律用設定值，不信任請求的 Host。
   */
  async exchangeCode(
    callbackParams: URLSearchParams,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<OidcIdentity> {
    const config = await this.configuration();
    const current = new URL(this.env().redirectUri);
    for (const [k, v] of callbackParams.entries()) current.searchParams.append(k, v);

    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw new OidcProviderError('token', describeOidcError(err));
    }

    const idToken = tokens.id_token;
    if (typeof idToken !== 'string' || idTokenAlg(idToken) !== ID_TOKEN_ALG) {
      throw new OidcProviderError('id_token', 'unexpected alg');
    }
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) {
      throw new OidcProviderError('id_token', 'missing sub');
    }
    const email = typeof claims.email === 'string' ? claims.email : '';
    const name = typeof claims.name === 'string' ? claims.name : '';
    return {
      sub: claims.sub,
      email,
      // 只有 boolean true 才算（字串 "true" 不算）
      emailVerified: claims.email_verified === true,
      name,
    };
  }
}
