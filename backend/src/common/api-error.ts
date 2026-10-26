import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 帶機器可讀錯誤碼的 HTTP 錯誤：body 是 `{ statusCode, message, code, ...extra }`
 * （`AllExceptionsFilter` 會把 `code` 與白名單內的 extra 欄位放進回應）。
 * H2 的錯誤碼清單見 notes/h2-api-contract.md「Error body」。
 */
export function apiError(
  status: HttpStatus,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ statusCode: status, message, code, ...extra }, status);
}

/** Prisma 的唯一性衝突：模型上的 @@unique 是 P2002；$queryRaw／$executeRaw 撞到索引是 P2010 + Postgres 23505。 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null;
  if (!e) return false;
  return e.code === 'P2002' || (e.code === 'P2010' && e.meta?.code === '23505');
}

/** Prisma P2002 的 `meta.target`（欄位陣列或索引名稱）是否提到某個欄位。 */
export function uniqueTargetMentions(err: unknown, field: string): boolean {
  const target = (err as { meta?: { target?: unknown } } | null)?.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  return text.toLowerCase().includes(field.toLowerCase());
}

/** 外鍵衝突（例如刪除時還有子部門、寫入時參照的部門剛被刪掉）。 */
export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null;
  return !!e && (e.code === 'P2003' || (e.code === 'P2010' && e.meta?.code === '23503'));
}
