import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';

/** 快取 TTL（秒）。停用時呼叫 invalidate() 讓它立刻生效，TTL 只是上限。 */
export const USER_STATUS_CACHE_TTL_SECONDS = 30;
/** Redis 斷線時 ioredis 會把指令排隊等重連；超過這個時間就當成快取 miss 回 DB 查。 */
export const USER_STATUS_REDIS_TIMEOUT_MS = 200;

const DISABLED = '1';
const ACTIVE = '0';

/**
 * 使用者是否已停用（spec §4.3「停用（離職）」）。
 *
 * - 快取的是「查 DB 得到的結果」：停用與沒停用都記，TTL 30 秒。
 * - 「沒停用」用 `SET NX` 寫（key 已存在就不寫），「停用」直接覆寫。這樣讀 DB 之後才到的舊
 *   「沒停用」結果，蓋不掉停用流程剛寫的 `markDisabled()`。
 * - 停用流程（H2）：先在 DB 設 `disabledAt`，再呼叫 `markDisabled()`。只呼叫 `invalidate()`
 *   的話，一個在停用前就讀了 DB 的請求，仍可能在 DEL 之後寫回「沒停用」，最多再撐 30 秒。
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
    const key = UserStatusService.cacheKey(userId);

    let cached: string | null = null;
    try {
      cached = await this.withTimeout(this.redis.get(key));
    } catch (err) {
      this.logger.warn(`user status cache read failed: ${(err as Error).message}`);
      cached = null;
    }
    if (cached === DISABLED) return true;
    if (cached === ACTIVE) return false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { disabledAt: true, deletedAt: true },
    });
    const disabled = !user || user.disabledAt != null || user.deletedAt != null;

    try {
      await this.withTimeout<unknown>(
        disabled
          ? this.redis.set(key, DISABLED, USER_STATUS_CACHE_TTL_SECONDS)
          : this.redis.setNx(key, ACTIVE, USER_STATUS_CACHE_TTL_SECONDS),
      );
    } catch (err) {
      this.logger.warn(`user status cache write failed: ${(err as Error).message}`);
    }
    return disabled;
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
   * 清掉某使用者的快取（復職時呼叫，讓變更立刻生效；停用請用 `markDisabled()`）。
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

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis timeout')), USER_STATUS_REDIS_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
