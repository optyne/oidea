import { BadRequestException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

/**
 * Flutter 認得的錯誤碼（`app/lib/features/auth/sso/sso_callback.dart`）。
 * callback 轉址時放在 `#error=<code>`（web）／`?error=<code>`（mobile）；
 * `POST /auth/oidc/exchange` 失敗時放在 JSON body 的 `code`。
 */
export type SsoErrorCode =
  | 'not_employee'
  | 'terminated'
  | 'disabled'
  | 'profile_bound'
  | 'email_unverified'
  | 'invalid_state'
  | 'expired'
  | 'server_error';

/** 只出現在 exchange 的 JSON body。 */
export type SsoExchangeErrorCode = SsoErrorCode | 'invalid_ticket' | 'invalid_request';

/** OIDC 流程內部丟的錯；controller 轉成帶 `error=<code>` 的轉址。 */
export class SsoFlowError extends Error {
  constructor(
    readonly code: SsoErrorCode,
    /** 給 log／audit 的簡短原因，絕不含秘密值。 */
    readonly reason: string = code,
  ) {
    super(`sso flow error: ${code} (${reason})`);
    this.name = 'SsoFlowError';
  }
}

/** 帶 `code` 的 JSON 錯誤（AllExceptionsFilter 會把 `code` 原樣放進 body）。 */
export function ssoHttpError(status: HttpStatus, code: SsoExchangeErrorCode): HttpException {
  const body = { code, message: SSO_MESSAGES[code], error: code };
  if (status === HttpStatus.BAD_REQUEST) return new BadRequestException(body);
  if (status === HttpStatus.UNAUTHORIZED) return new UnauthorizedException(body);
  return new HttpException(body, status);
}

export const SSO_MESSAGES: Record<SsoExchangeErrorCode, string> = {
  not_employee: '此帳號尚未建立員工資料，請聯絡人資',
  terminated: '此帳號已停用，請聯絡人資',
  disabled: '此帳號已停用，請聯絡人資',
  profile_bound: '此員工資料已綁定其他帳號，請聯絡人資',
  email_unverified: '公司信箱尚未驗證',
  invalid_state: '登入逾時，請再試一次',
  expired: '登入逾時，請再試一次',
  server_error: '登入失敗，請稍後再試',
  invalid_ticket: '登入失敗，請再試一次',
  invalid_request: '參數錯誤',
};
