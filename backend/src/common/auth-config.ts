import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 登入相關環境變數的唯一讀取點（spec §4.3、§4.5）。
 *
 * - `AUTH_PASSWORD_LOGIN_ENABLED`：帳密登入／註冊開關。沒設時 fail closed：有 `OIDC_ISSUER`
 *   或 `NODE_ENV=production` 為 false，兩個都沒有（本機開發）才是 true。
 *   接受 true/false/1/0/yes/no/on/off（不分大小寫）；無法辨識的值一律當 false（寧可關）。
 * - `BREAK_GLASS_OWNER_EMAILS`：逗號分隔、不分大小寫。帳密登入關閉時，名單上且是公司工作空間 owner
 *   的帳號仍可用帳密登入（緊急登入）。
 * - `COMPANY_TIMEZONE`：判斷「哪一天」用的時區，預設 Asia/Taipei（H4 才實際使用）。無效值退回預設。
 * - `OIDC_*`、`APP_*_CALLBACK_URL`：OIDC 流程用；這裡只提供讀取（`readOidcEnv`）與「SSO 是否設定」。
 */
export type EnvReader = (key: string) => string | undefined;

export const processEnvReader: EnvReader = (key) => process.env[key];

export const DEFAULT_COMPANY_TIMEZONE = 'Asia/Taipei';

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

const clean = (raw: string | undefined): string => (typeof raw === 'string' ? raw.trim() : '');

export function isProduction(read: EnvReader = processEnvReader): boolean {
  return clean(read('NODE_ENV')).toLowerCase() === 'production';
}

/**
 * 帳密登入／註冊開關。沒設 `AUTH_PASSWORD_LOGIN_ENABLED` 時 **fail closed**（review S4）：
 * 設了 `OIDC_ISSUER`（有 SSO）或 `NODE_ENV=production` 就是關；兩個都沒有（本機開發）才開。
 * 明確設定的值優先。
 */
export function isPasswordLoginEnabled(read: EnvReader = processEnvReader): boolean {
  const raw = clean(read('AUTH_PASSWORD_LOGIN_ENABLED')).toLowerCase();
  if (raw === '') return !isProduction(read) && !isSsoConfigured(read);
  if (TRUE_WORDS.has(raw)) return true;
  if (FALSE_WORDS.has(raw)) return false;
  return false;
}

export function getBreakGlassOwnerEmails(read: EnvReader = processEnvReader): string[] {
  const raw = clean(read('BREAK_GLASS_OWNER_EMAILS'));
  if (!raw) return [];
  const out = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...new Set(out)];
}

export function isSsoConfigured(read: EnvReader = processEnvReader): boolean {
  return clean(read('OIDC_ISSUER')) !== '';
}

export function getCompanyTimezone(read: EnvReader = processEnvReader): string {
  const tz = clean(read('COMPANY_TIMEZONE'));
  if (!tz) return DEFAULT_COMPANY_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_COMPANY_TIMEZONE;
  }
}

export interface OidcEnv {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webCallbackUrl: string;
  mobileCallbackUrl: string;
  /** `NODE_ENV=production`：callback URL 必須是 https（mobile 必須是自訂 scheme）。 */
  production: boolean;
}

/** OIDC 流程用的設定。值可能是空字串（未設定）；由 OIDC 流程自己決定缺哪個要拒絕啟動。 */
export function readOidcEnv(read: EnvReader = processEnvReader): OidcEnv {
  return {
    issuer: clean(read('OIDC_ISSUER')),
    clientId: clean(read('OIDC_CLIENT_ID')),
    clientSecret: clean(read('OIDC_CLIENT_SECRET')),
    redirectUri: clean(read('OIDC_REDIRECT_URI')),
    webCallbackUrl: clean(read('APP_WEB_CALLBACK_URL')),
    mobileCallbackUrl: clean(read('APP_MOBILE_CALLBACK_URL')),
    production: isProduction(read),
  };
}

/**
 * 給 GET /auth/config：登入方式的布林值，加上 IdP discovery 的 `end_session_endpoint`
 * （公開資訊；SSO 沒開或拿不到時 null）。不含任何秘密。
 * `breakGlass`：緊急登入開著（有設 BREAK_GLASS_OWNER_EMAILS、而且一般帳密登入是關的）。只透露
 * 「現在是緊急狀態」，不透露名單上是誰；登入頁據此顯示「管理者緊急登入」（review S5）。
 */
export interface PublicAuthConfig {
  sso: boolean;
  passwordLogin: boolean;
  breakGlass: boolean;
  endSessionUrl: string | null;
}

/**
 * Nest 用的包裝：透過 ConfigService 讀（測試可注入假的 ConfigService）。
 * 沒有 ConfigService 時（例如 CLI）直接讀 process.env。
 */
@Injectable()
export class AuthConfig {
  private readonly read: EnvReader;

  constructor(@Optional() config?: ConfigService) {
    this.read = config ? (key) => config.get<string>(key) : processEnvReader;
  }

  passwordLoginEnabled(): boolean {
    return isPasswordLoginEnabled(this.read);
  }

  breakGlassOwnerEmails(): string[] {
    return getBreakGlassOwnerEmails(this.read);
  }

  isBreakGlassEmail(email: string | null | undefined): boolean {
    if (typeof email !== 'string') return false;
    const needle = email.trim().toLowerCase();
    return needle !== '' && this.breakGlassOwnerEmails().includes(needle);
  }

  ssoEnabled(): boolean {
    return isSsoConfigured(this.read);
  }

  companyTimezone(): string {
    return getCompanyTimezone(this.read);
  }

  oidc(): OidcEnv {
    return readOidcEnv(this.read);
  }

  /** 緊急登入開著：有名單、而且一般帳密登入是關的（開著的話直接用一般登入）。 */
  breakGlassActive(): boolean {
    return !this.passwordLoginEnabled() && this.breakGlassOwnerEmails().length > 0;
  }

  publicConfig(endSessionUrl: string | null = null): PublicAuthConfig {
    const sso = this.ssoEnabled();
    return {
      sso,
      passwordLogin: this.passwordLoginEnabled(),
      breakGlass: this.breakGlassActive(),
      endSessionUrl: sso ? endSessionUrl : null,
    };
  }
}
