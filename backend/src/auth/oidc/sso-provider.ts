/**
 * Account.provider 的值（`Account(provider, providerId)` 唯一）。
 * 獨立成沒有任何 import 的檔案：CompanyService 也要用，直接 import sso-login.service 會形成循環
 * （sso-login → employees → company）。
 */
export const SSO_PROVIDER = 'authentik';
