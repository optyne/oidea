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
      await this.withTimeout(
        this.redis.set(key, disabled ? DISABLED : ACTIVE, USER_STATUS_CACHE_TTL_SECONDS),
      );
    } catch (err) {
      this.logger.warn(`user status cache write failed: ${(err as Error).message}`);
    }
    return disabled;
  }

  /**
   * 清掉某使用者的快取（H2 停用／復職時呼叫，讓變更立刻生效）。
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
