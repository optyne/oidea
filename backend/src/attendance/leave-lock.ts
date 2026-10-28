import { IdentityLockClient } from '../common/identity-lock';

/**
 * 假日表「整年取代」的 transaction-level advisory lock（H3）。同一個工作空間的兩個取代排隊執行，
 * 後到的先刪掉先到的結果再寫，不會撞到 (workspaceId, date) 的唯一索引變成 500。
 *
 * 跟 identity-lock.ts 一樣用兩個 int4 key（class, hashtext(workspaceId)），class 7303 是另一個 key space。
 * 這把鎖不會跟 org／profile／user 鎖同時拿。SQL 裡的數字要跟常數一樣。
 */
export const LEAVE_POLICY_LOCK_CLASS = 7303;

export async function lockLeavePolicy(tx: IdentityLockClient, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7303, hashtext(${workspaceId}))`;
}
