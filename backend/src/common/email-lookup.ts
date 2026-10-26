import { Prisma } from '@prisma/client';

/**
 * 不分大小寫比對 User.email 的唯一入口（review S8）。
 *
 * 不用 Prisma 的 `email: { equals, mode: 'insensitive' }`：在 Postgres 上它可能編成 `ILIKE`，
 * 而 `ILIKE` 把 `_`、`%` 當萬用字元，`tom_lee@` 就會對到 `tom.lee@`（另一個人）。
 * 這裡改用參數化的 `lower("email") = lower($1)`（tagged template，值不會拼進 SQL 字串），
 * 只撈 id 與 email，呼叫端再用 id 載入需要的欄位。
 *
 * 注意：單元測試只能驗呼叫的形狀；真的 Postgres 行為要在 staging 驗（`a_b@` 不可對到 `axb@`）。
 */
export type RawQueryable = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface EmailCandidate {
  id: string;
  email: string;
}

/** 最多撈幾筆（SQL 裡寫死的 LIMIT 5）：只需要分辨 0／1／多筆。 */
export const EMAIL_LOOKUP_LIMIT = 5;

export async function findUserCandidatesByEmail(
  db: RawQueryable,
  email: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<EmailCandidate[]> {
  const needle = typeof email === 'string' ? email.trim() : '';
  if (!needle) return [];
  const rows = opts.includeDeleted
    ? await db.$queryRaw<EmailCandidate[]>`SELECT "id", "email" FROM "users" WHERE lower("email") = lower(${needle}) LIMIT 5`
    : await db.$queryRaw<EmailCandidate[]>`SELECT "id", "email" FROM "users" WHERE lower("email") = lower(${needle}) AND "deletedAt" IS NULL LIMIT 5`;
  return Array.isArray(rows) ? rows : [];
}

/**
 * 從候選中挑一筆：跟 `needle` 完全相同的優先；沒有完全相同、而且只差大小寫的有兩筆以上 → 'ambiguous'
 * （無法判斷是誰，呼叫端要拒絕）；沒有 → null。
 */
export function pickEmailMatch<T extends EmailCandidate>(candidates: T[], needle: string): T | 'ambiguous' | null {
  const exact = candidates.find((c) => c.email === needle);
  if (exact) return exact;
  if (candidates.length > 1) return 'ambiguous';
  return candidates[0] ?? null;
}

/** findUserCandidatesByEmail + pickEmailMatch：回傳 user id、'ambiguous' 或 null。 */
export async function resolveUserIdByEmail(
  db: RawQueryable,
  email: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<string | 'ambiguous' | null> {
  const needle = typeof email === 'string' ? email.trim() : '';
  const picked = pickEmailMatch(await findUserCandidatesByEmail(db, needle, opts), needle);
  return picked === 'ambiguous' || picked === null ? picked : picked.id;
}
