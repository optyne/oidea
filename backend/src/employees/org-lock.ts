import { Prisma } from '@prisma/client';

/** 組織結構（部門樹、員工主管鏈、員工的部門）所有變更共用的 advisory lock key。 */
export const ORG_LOCK_KEY = 'oidea:org-structure';

export type OrgLockClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * 在交易裡拿組織結構的 transaction-level advisory lock（交易結束自動釋放）。
 *
 * 「移動部門／改主管時不能形成環」是「先讀整條鏈、再寫」：兩個同時進行的移動（A 移到 B 底下、
 * B 移到 A 底下）各自都讀不到對方的寫入，兩個都會通過檢查。拿同一把鎖讓這類變更排隊執行，
 * 後到的交易一定看得到先到的結果。刪除部門前「確認沒有人在這個部門」也靠它，避免同時把員工指派過來。
 * 用 `$executeRaw`：`pg_advisory_xact_lock` 回傳 void，`$queryRaw` 會反序列化失敗。
 */
export async function lockOrgStructure(tx: OrgLockClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ORG_LOCK_KEY}))`;
}
