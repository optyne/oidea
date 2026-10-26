import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';

/** 快取 TTL（秒）。停用時呼叫 markDisabled() 讓它立刻生效，TTL 只是上限。 */
export const USER_STATUS_CACHE_TTL_SECONDS = 30;
/** Redis 斷線時 ioredis 會把指令排隊等重連；超過這個時間就當成快取 miss 回 DB 查。 */
export const USER_STATUS_REDIS_TIMEOUT_MS = 200;

/** 快取值：停用 */
const DISABLED = '1';
/** 快取值：沒停用、沒有 sessionsValidAfter（H0 起就用的值，相容） */
const ACTIVE = '0';
/** 快取值前綴：沒停用、`sessionsValidAfter` 的 epoch 秒，例如 `0:1760000000` */
const ACTIVE_WITH_CUTOFF = '0:';

export interface UserStatus {
  /** 停用、刪除或不存在 */
  disabled: boolean;
  /**
   * `User.sessionsValidAfter` 的 epoch 秒（無條件捨去）；null = 沒設。
   * `iat` 小於這個值的 access token 一律拒絕（同一秒簽發的放行：iat 只有秒的精度）。
   */
  sessionsValidAfterSec: number | null;
}

export type AccessTokenCheck = 'ok' | 'disabled' | 'stale';

function encode(status: UserStatus): string {
  if (status.disabled) return DISABLED;
  return status.sessionsValidAfterSec === null ? ACTIVE : `${ACTIVE_WITH_CUTOFF}${status.sessionsValidAfterSec}`;
}

function decode(raw: string | null): UserStatus | null {
  if (raw === DISABLED) return { disabled: true, sessionsValidAfterSec: null };
  if (raw === ACTIVE) return { disabled: false, sessionsValidAfterSec: null };
  if (typeof raw === 'string' && raw.startsWith(ACTIVE_WITH_CUTOFF)) {
    const rest = raw.slice(ACTIVE_WITH_CUTOFF.length);
    if (/^\d{1,12}$/.test(rest)) return { disabled: false, sessionsValidAfterSec: Number(rest) };
  }
  return null; // 沒有或看不懂 → 當成 miss
}

/**
 * 使用者是否已停用，以及 access token 的最早簽發時間（spec §4.3「停用（離職）」；review S2）。
 *
 * - 快取的是「查 DB 得到的結果」：停用與沒停用都記，TTL 30 秒。沒停用時連同 `sessionsValidAfter` 一起記。
 * - 「沒停用」用 `SET NX` 寫（key 已存在就不寫），「停用」直接覆寫。這樣讀 DB 之後才到的舊
 *   「沒停用」結果，蓋不掉停用流程剛寫的 `markDisabled()`。
 * - 停用流程（H2）：先在 DB 設 `disabledAt`，再呼叫 `markDisabled()`。只呼叫 `invalidate()`
 *   的話，一個在停用前就讀了 DB 的請求，仍可能在 DEL 之後寫回「沒停用」，最多再撐 30 秒。
 * - SSO 綁定既有帳號（設了 `sessionsValidAfter`）：交易 commit 之後呼叫 `refresh()`：重讀 DB 並**覆寫**
 *   快取，理由同上（DEL 之後仍可能被舊的 NX 寫回沒有 cutoff 的結果）。
 * - 快取沒有資料、值看不懂、Redis 出錯或逾時 → **一律回 DB 用主鍵查**；
 *   絕不把「快取沒有」當成「沒停用」。
 * - 使用者不存在或已刪除（deletedAt）也視為停用。
 * - DB 查詢出錯時往上拋（呼叫端因此拒絕請求，fail closed）。
 */
@Injectable()
export class UserStatusService {
  private readonly logger = new Logger(UserStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  static cacheKey(userId: string): string {
    return `auth:user-disabled:${userId}`;
  }

  async isDisabled(userId: string): Promise<boolean> {
    return (await this.getStatus(userId)).disabled;
  }

  /**
   * access token（HTTP 與 socket 共用）：停用 → 'disabled'；`iat` 早於 `sessionsValidAfter` → 'stale'。
   * `iat` 缺少或不是數字、而且有設 cutoff → 'stale'（寧可拒絕）。
   */
  async checkAccessToken(userId: string, iat: unknown): Promise<AccessTokenCheck> {
    const status = await this.getStatus(userId);
    if (status.disabled) return 'disabled';
    if (status.sessionsValidAfterSec !== null) {
      if (typeof iat !== 'number' || !Number.isFinite(iat) || iat < status.sessionsValidAfterSec) return 'stale';
    }
    return 'ok';
  }

  /** 不是 access token 的憑證（bot token）：用它的建立時間比。 */
  async isIssuedBeforeCutoff(userId: string, issuedAt: Date): Promise<boolean> {
    const status = await this.getStatus(userId);
    if (status.sessionsValidAfterSec === null) return false;
    return Math.floor(issuedAt.getTime() / 1000) < status.sessionsValidAfterSec;
  }

  async getStatus(userId: string): Promise<UserStatus> {
    const key = UserStatusService.cacheKey(userId);

    let cached: string | null = null;
    try {
      cached = await this.withTimeout(this.redis.get(key));
    } catch (err) {
      this.logger.warn(`user status cache read failed: ${(err as Error).message}`);
      cached = null;
    }
    const hit = decode(cached);
    if (hit) return hit;

    const status = await this.readDb(userId);
    try {
      await this.withTimeout<unknown>(
        status.disabled
          ? this.redis.set(key, DISABLED, USER_STATUS_CACHE_TTL_SECONDS)
          : this.redis.setNx(key, encode(status), USER_STATUS_CACHE_TTL_SECONDS),
      );
    } catch (err) {
      this.logger.warn(`user status cache write failed: ${(err as Error).message}`);
    }
    return status;
  }

  /**
   * 把快取直接設成「停用」（覆寫，TTL 30 秒）。H2 停用時在 DB 寫入 `disabledAt` 之後呼叫：
   * 之後到的舊「沒停用」寫入是 NX，蓋不掉它。
   * Redis 出錯時回 false 並記 log；這時快取裡可能還有舊的「沒停用」，最多再留 30 秒。
   */
  async markDisabled(userId: string): Promise<boolean> {
    try {
      await this.withTimeout(
        this.redis.set(UserStatusService.cacheKey(userId), DISABLED, USER_STATUS_CACHE_TTL_SECONDS),
      );
      return true;
    } catch (err) {
      this.logger.error(`user status cache markDisabled failed for ${userId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * DB 已經改了（例如 SSO 綁定設了 `sessionsValidAfter`、復職清了 `disabledAt`）之後呼叫：
   * 重讀 DB 並覆寫快取（不是 NX），讓變更立刻生效、也蓋得過在途的舊 NX 寫入。
   * Redis 出錯時退而 DEL；兩個都失敗回 false 並記 log（最壞情況舊結果最多再留 30 秒）。DB 出錯往上拋。
   */
  async refresh(userId: string): Promise<boolean> {
    const status = await this.readDb(userId);
    try {
      await this.withTimeout(
        this.redis.set(UserStatusService.cacheKey(userId), encode(status), USER_STATUS_CACHE_TTL_SECONDS),
      );
      return true;
    } catch (err) {
      this.logger.error(`user status cache refresh failed for ${userId}: ${(err as Error).message}`);
      return this.invalidate(userId);
    }
  }

  /**
   * 清掉某使用者的快取（讓下一次回 DB 查；停用請用 `markDisabled()`，DB 有變更請用 `refresh()`）。
   * Redis 出錯時回 false 並記 log；最壞情況是舊結果最多再留 30 秒。
   */
  async invalidate(userId: string): Promise<boolean> {
    try {
      await this.withTimeout(this.redis.del(UserStatusService.cacheKey(userId)));
      return true;
    } catch (err) {
      this.logger.error(`user status cache invalidate failed for ${userId}: ${(err as Error).message}`);
      return false;
    }
  }

  private async readDb(userId: string): Promise<UserStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { disabledAt: true, deletedAt: true, sessionsValidAfter: true },
    });
    const disabled = !user || user.disabledAt != null || user.deletedAt != null;
    const cutoff = user?.sessionsValidAfter;
    return {
      disabled,
      sessionsValidAfterSec: !disabled && cutoff instanceof Date ? Math.floor(cutoff.getTime() / 1000) : null,
    };
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis timeout')), USER_STATUS_REDIS_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
