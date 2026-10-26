/** access token 的 `typ` claim。JwtStrategy 與 socket 驗證只接受這個值。 */
export const ACCESS_TOKEN_TYPE = 'access' as const;

export interface AccessTokenPayload {
  sub: string;
  email: string;
  typ: typeof ACCESS_TOKEN_TYPE;
  iat?: number;
  exp?: number;
}

/** 驗證過的 access token 內容（HTTP 與 socket 共用）。 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}

export function isAccessPayload(payload: unknown): payload is AccessTokenPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return p.typ === ACCESS_TOKEN_TYPE && typeof p.sub === 'string' && p.sub.length > 0;
}
