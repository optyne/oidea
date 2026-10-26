import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 登入相關環境變數的唯一讀取點（spec §4.3、§4.5）。
 *
 * - `AUTH_PASSWORD_LOGIN_ENABLED`：帳密登入／註冊開關。沒設時：`NODE_ENV=production` 為 false，其他為 true。
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

export function isPasswordLoginEnabled(read: EnvReader = processEnvReader): boolean {
  const raw = clean(read('AUTH_PASSWORD_LOGIN_ENABLED')).toLowerCase();
  if (raw === '') return clean(read('NODE_ENV')).toLowerCase() !== 'production';
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
  };
}

/** 給 GET /auth/config：只有布林值，不含任何設定值或秘密。 */
export interface PublicAuthConfig {
  sso: boolean;
  passwordLogin: boolean;
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

  publicConfig(): PublicAuthConfig {
    return { sso: this.ssoEnabled(), passwordLogin: this.passwordLoginEnabled() };
  }
}
