import { Prisma } from '@prisma/client';

export type IdentityLockClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * 身分相關寫入的 transaction-level advisory lock（交易結束自動釋放），H2 review S3。
 *
 * 離職、解除綁定、SSO 綁定／登入、移交 owner、建立工作空間、接受邀請都是「先讀狀態、再寫」：
 * 沒有鎖時，一個在離職交易進行中才 commit 的寫入（例如剛好在這時建立工作空間、被移交成 owner、
 * 綁定一個剛被設成離職的 profile）會留下「停用的人擁有工作空間」「離職的 profile 綁著沒停用的 User」。
 * 同一個人的這些交易拿同一把鎖排隊，後到的一定看得到先到的結果。
 *
 * - 用兩個 int4 的 key（class, hashtext(id)）：跟組織結構鎖（`org-lock.ts`，單一 bigint key）是不同的
 *   key space，不會互相撞到。hashtext 撞號只會讓不相關的兩個人多排一次隊。
 * - 加鎖順序（避免死結）：組織結構鎖 → profile 鎖 → user 鎖；一個交易最多拿一個 user 鎖
 *   （移交 owner 只鎖目標）。
 * - 鎖要在交易裡任何寫入之前拿（測試用的記憶體 Prisma 在拿到鎖時重拍 rollback 快照）。
 * - SQL 裡的數字要跟下面的常數一樣（tagged template 的常值不能用變數）。
 */
export const USER_LOCK_CLASS = 7301;
export const PROFILE_LOCK_CLASS = 7302;

/** 鎖住某個 User 的身分狀態（停用、成員資格、owner 身分）。 */
export async function lockUser(tx: IdentityLockClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7301, hashtext(${userId}))`;
}

/** 鎖住某個 EmployeeProfile 的綁定與在職狀態（SSO 綁定、離職、解除綁定、改 email）。 */
export async function lockEmployeeProfile(tx: IdentityLockClient, profileId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7302, hashtext(${profileId}))`;
}

/**
 * 會排隊等鎖的互動式交易的逾時（review N5）。Prisma 預設 maxWait 2 秒、timeout 5 秒，
 * 尖峰時排隊等鎖會變成 500（P2028）。
 */
export const LOCKED_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
