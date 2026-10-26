import { Logger } from '@nestjs/common';
import {
  AuthConfig,
  DEFAULT_COMPANY_TIMEZONE,
  getBreakGlassOwnerEmails,
  getCompanyTimezone,
  isPasswordLoginEnabled,
  isSsoConfigured,
  readOidcEnv,
} from './auth-config';
import { BreakGlassReminder } from '../auth/break-glass-reminder';

const env = (values: Record<string, string>) => (k: string) => values[k];

describe('auth-config', () => {
  it('AUTH_PASSWORD_LOGIN_ENABLED 沒設：production 關、其他開', () => {
    expect(isPasswordLoginEnabled(env({ NODE_ENV: 'production' }))).toBe(false);
    expect(isPasswordLoginEnabled(env({ NODE_ENV: 'Production ' }))).toBe(false);
    expect(isPasswordLoginEnabled(env({ NODE_ENV: 'development' }))).toBe(true);
    expect(isPasswordLoginEnabled(env({}))).toBe(true);
  });

  it.each([
    // [NODE_ENV, OIDC_ISSUER, AUTH_PASSWORD_LOGIN_ENABLED, 預期]
    [undefined, undefined, undefined, true], // 本機開發
    ['development', undefined, undefined, true],
    [undefined, 'https://auth.example/application/o/oidea/', undefined, false], // review S4：忘了設 NODE_ENV
    ['development', 'https://auth.example/application/o/oidea/', undefined, false],
    ['production', undefined, undefined, false],
    ['production', 'https://auth.example/application/o/oidea/', undefined, false],
    [undefined, '   ', undefined, true], // 空白的 OIDC_ISSUER 等於沒設
    [undefined, 'https://auth.example/application/o/oidea/', 'true', true], // 明確開啟優先
    ['production', undefined, 'on', true],
    [undefined, undefined, 'false', false],
  ])('預設值矩陣：NODE_ENV=%p OIDC_ISSUER=%p AUTH_PASSWORD_LOGIN_ENABLED=%p → %p', (nodeEnv, issuer, flag, expected) => {
    const values: Record<string, string> = {};
    if (nodeEnv !== undefined) values.NODE_ENV = nodeEnv;
    if (issuer !== undefined) values.OIDC_ISSUER = issuer;
    if (flag !== undefined) values.AUTH_PASSWORD_LOGIN_ENABLED = flag;
    expect(isPasswordLoginEnabled(env(values))).toBe(expected);
  });

  it('review S5：breakGlass = 有名單而且一般帳密登入關著；不含名單內容', () => {
    const cfg = (values: Record<string, string>) => new AuthConfig({ get: (k: string) => values[k] } as any);
    const issuer = 'https://auth.example/application/o/oidea/';
    expect(cfg({ OIDC_ISSUER: issuer }).publicConfig()).toEqual({
      sso: true,
      passwordLogin: false,
      breakGlass: false,
      endSessionUrl: null,
    });
    const emergency = cfg({ OIDC_ISSUER: issuer, BREAK_GLASS_OWNER_EMAILS: 'boss@corp.com' }).publicConfig();
    expect(emergency).toMatchObject({ passwordLogin: false, breakGlass: true });
    expect(JSON.stringify(emergency)).not.toContain('boss');
    // 一般帳密登入開著時不需要緊急登入
    expect(cfg({ BREAK_GLASS_OWNER_EMAILS: 'boss@corp.com' }).publicConfig()).toMatchObject({
      passwordLogin: true,
      breakGlass: false,
    });
    expect(cfg({ OIDC_ISSUER: issuer, BREAK_GLASS_OWNER_EMAILS: ' , ' }).publicConfig().breakGlass).toBe(false);
  });

  it('明確設定優先於 NODE_ENV；無法辨識的值當 false', () => {
    expect(isPasswordLoginEnabled(env({ NODE_ENV: 'production', AUTH_PASSWORD_LOGIN_ENABLED: 'true' }))).toBe(true);
    expect(isPasswordLoginEnabled(env({ NODE_ENV: 'development', AUTH_PASSWORD_LOGIN_ENABLED: '0' }))).toBe(false);
    expect(isPasswordLoginEnabled(env({ AUTH_PASSWORD_LOGIN_ENABLED: 'YES' }))).toBe(true);
    expect(isPasswordLoginEnabled(env({ AUTH_PASSWORD_LOGIN_ENABLED: 'tru' }))).toBe(false);
  });

  it('BREAK_GLASS_OWNER_EMAILS：逗號分隔、去空白、小寫、去重、略過空項', () => {
    expect(getBreakGlassOwnerEmails(env({ BREAK_GLASS_OWNER_EMAILS: ' A@x.com, ,b@x.com,a@X.com,' }))).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
    expect(getBreakGlassOwnerEmails(env({}))).toEqual([]);
    const cfg = new AuthConfig({ get: (k: string) => ({ BREAK_GLASS_OWNER_EMAILS: 'Boss@Corp.com' })[k] } as any);
    expect(cfg.isBreakGlassEmail(' boss@corp.COM ')).toBe(true);
    expect(cfg.isBreakGlassEmail('other@corp.com')).toBe(false);
    expect(cfg.isBreakGlassEmail('')).toBe(false);
  });

  it('SSO 是否設定看 OIDC_ISSUER；readOidcEnv 讀全部 OIDC 變數', () => {
    expect(isSsoConfigured(env({}))).toBe(false);
    expect(isSsoConfigured(env({ OIDC_ISSUER: '  ' }))).toBe(false);
    expect(isSsoConfigured(env({ OIDC_ISSUER: 'https://auth/x/' }))).toBe(true);
    expect(readOidcEnv(env({ OIDC_CLIENT_ID: 'id', APP_MOBILE_CALLBACK_URL: 'oidea://auth' }))).toEqual({
      issuer: '',
      clientId: 'id',
      clientSecret: '',
      redirectUri: '',
      webCallbackUrl: '',
      mobileCallbackUrl: 'oidea://auth',
      production: false,
    });
    expect(readOidcEnv(env({ NODE_ENV: 'production' })).production).toBe(true);
  });

  it('COMPANY_TIMEZONE 預設 Asia/Taipei，無效值退回預設', () => {
    expect(getCompanyTimezone(env({}))).toBe(DEFAULT_COMPANY_TIMEZONE);
    expect(getCompanyTimezone(env({ COMPANY_TIMEZONE: 'Asia/Tokyo' }))).toBe('Asia/Tokyo');
    expect(getCompanyTimezone(env({ COMPANY_TIMEZONE: 'Mars/Olympus' }))).toBe(DEFAULT_COMPANY_TIMEZONE);
  });

  it('沒有 ConfigService 時（CLI）讀 process.env', () => {
    const saved = process.env.BREAK_GLASS_OWNER_EMAILS;
    process.env.BREAK_GLASS_OWNER_EMAILS = 'cli@corp.com';
    try {
      expect(new AuthConfig().breakGlassOwnerEmails()).toEqual(['cli@corp.com']);
    } finally {
      if (saved === undefined) delete process.env.BREAK_GLASS_OWNER_EMAILS;
      else process.env.BREAK_GLASS_OWNER_EMAILS = saved;
    }
  });
});

describe('BreakGlassReminder', () => {
  afterEach(() => jest.restoreAllMocks());

  it('有設名單：啟動時與每日都印 warning（只寫數量，不寫 email）', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const reminder = new BreakGlassReminder(
      new AuthConfig({ get: (k: string) => ({ BREAK_GLASS_OWNER_EMAILS: 'boss@corp.com,co@corp.com' })[k] } as any),
    );
    reminder.onApplicationBootstrap();
    reminder.daily();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('2 個帳號');
    expect(String(warn.mock.calls[0][0])).not.toContain('boss@corp.com');
  });

  it('沒設名單：不印', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const reminder = new BreakGlassReminder(new AuthConfig({ get: () => undefined } as any));
    reminder.onApplicationBootstrap();
    reminder.daily();
    expect(warn).not.toHaveBeenCalled();
  });
});
