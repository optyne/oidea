import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { Clock } from '../common/clock';
import { AuditService, AuditRequestContext } from '../audit/audit.service';

/** 剛被換掉的 token 在這段時間內再被使用，視為客戶端重試（不算盜用）。 */
export const REFRESH_REUSE_GRACE_MS = 10_000;
const DEFAULT_REFRESH_TTL = '7d';

/** 解析 `7d` / `12h` / `30m` / `45s` / 純數字（秒）。看不懂就回 null。 */
export function parseDurationMs(value: string | number | undefined | null): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 0 ? value * 1000 : null;
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return n > 0 ? n * factor : null;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** revokeAllForUser 可用的 client：PrismaService 或交易 client（`$transaction` 的 tx）。 */
export type RefreshTokenDb = Pick<Prisma.TransactionClient, 'refreshToken'>;

export interface RotatedRefreshToken {
  userId: string;
  email: string;
  refreshToken: string;
}

/**
 * 不透明 refresh token（spec §4.3「token」）。
 *
 * - 明文 = 32 bytes 隨機數的 base64url；DB 只存 sha256（`RefreshToken.tokenHash`）。
 * - 每次 refresh 都換發新的一組，新 token 沿用同一個 familyId。
 * - 被換掉的 token 在 10 秒內再被使用 → 在同一 family 再簽一組新的（DB 只有 hash，給不回舊的那組）。
 * - 超過 10 秒還被使用 → 視為盜用，撤銷**整個 family**（同一使用者其他 family 不受影響），回 401。
 * - 換發與撤銷 family 同時發生時，新 token 不能活下來。兩邊都「先寫、再讀」：
 *   換發方建好新 row（已 commit）之後，檢查 family 裡有沒有被撤銷的 row，有就把新 row 也撤銷並回 401；
 *   撤銷方做完第一次 updateMany 之後再做一次，撈出撤銷途中才 commit 的新 row。
 *   在 READ COMMITTED 下兩個「讀」至少有一個看得到對方的「寫」，所以兩種交錯都擋得住。
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    const raw = config.get<string>('JWT_REFRESH_EXPIRATION', DEFAULT_REFRESH_TTL);
    this.ttlMs = parseDurationMs(raw) ?? parseDurationMs(DEFAULT_REFRESH_TTL)!;
  }

  /** 新登入：開一個新的 family。 */
  async issueNewFamily(userId: string): Promise<string> {
    return this.issue(userId, randomUUID());
  }

  async rotate(token: string, req?: AuditRequestContext): Promise<RotatedRefreshToken> {
    const now = this.clock.now();
    const row = await this.findUsable(token, now);

    if (row.rotatedAt == null) {
      // 條件式更新：併發的兩個請求只有一個能把 rotatedAt 從 null 改掉
      const claimed = await this.prisma.refreshToken.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now },
      });
      if (claimed.count === 1) {
        return this.issueFor(row);
      }
      // 被併發者搶先換發：重新讀一次，交給下面的寬限期判斷
      const fresh = await this.prisma.refreshToken.findUnique({ where: { id: row.id } });
      if (!fresh || fresh.revokedAt || !fresh.rotatedAt) {
        throw new UnauthorizedException('Refresh token 無效');
      }
      row.rotatedAt = fresh.rotatedAt;
    }

    const sinceRotation = now.getTime() - row.rotatedAt!.getTime();
    if (sinceRotation <= REFRESH_REUSE_GRACE_MS) {
      return this.issueFor(row);
    }

    // 盜用：撤銷整個 family
    const revoked = await this.revokeWhere({ familyId: row.familyId }, now);
    this.logger.warn(`refresh token reuse detected; family revoked (${revoked.count} tokens)`);
    await this.audit.record({
      actorId: row.userId,
      action: 'auth.refresh_reuse',
      targetType: 'refresh_token_family',
      targetId: row.familyId,
      metadata: { revokedCount: revoked.count, secondsSinceRotation: Math.floor(sinceRotation / 1000) },
      req,
    });
    throw new UnauthorizedException('Refresh token 已失效，請重新登入');
  }

  /**
   * 登出：撤銷這個 token 所屬的整個 family（這台裝置這次登入換發出來的全部 token）。
   * 找不到 token 時回 null（呼叫端仍回 ok，登出是冪等的）。
   */
  async revokeFamilyOf(token: string): Promise<{ userId: string; familyId: string; count: number } | null> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      select: { userId: true, familyId: true },
    });
    if (!row) return null;
    const res = await this.revokeWhere({ familyId: row.familyId }, this.clock.now());
    return { userId: row.userId, familyId: row.familyId, count: res.count };
  }

  /**
   * 撤銷某使用者全部 refresh token（H1 綁定 SSO、H2 離職使用）。
   * `db` 可傳交易 client（在呼叫端的交易裡撤銷）；交易 commit 後建議再呼叫一次（不傳 db），
   * 撈出交易期間才 commit 的換發（見類別說明）。
   */
  async revokeAllForUser(userId: string, db: RefreshTokenDb = this.prisma): Promise<number> {
    const res = await this.revokeWhere({ userId }, this.clock.now(), db);
    return res.count;
  }

  private async findUsable(token: string, now: Date) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException('Refresh token 無效');
    }
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      include: { user: { select: { id: true, email: true, disabledAt: true, deletedAt: true } } },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedException('Refresh token 無效或已過期');
    }
    if (!row.user || row.user.disabledAt || row.user.deletedAt) {
      throw new UnauthorizedException('帳號已停用');
    }
    return row;
  }

  /**
   * 撤銷符合條件、還沒撤銷的 row。做兩次：第二次撈出第一次之後才 commit 的 row
   * （與 rotate 同時換發出來的新 token）。回傳總共撤銷幾筆。
   */
  private async revokeWhere(
    where: { familyId: string } | { userId: string },
    now: Date,
    db: RefreshTokenDb = this.prisma,
  ) {
    const first = await db.refreshToken.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: now },
    });
    const second = await db.refreshToken.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: now },
    });
    return { count: first.count + second.count };
  }

  /** rotate 換發：建好新 row 之後確認 family 沒被同時撤銷；被撤銷了就連新 row 一起撤銷並回 401。 */
  private async issueFor(
    row: { userId: string; familyId: string; user: { email: string } },
  ): Promise<RotatedRefreshToken> {
    const refreshToken = await this.issue(row.userId, row.familyId);
    const revokedInFamily = await this.prisma.refreshToken.count({
      where: { familyId: row.familyId, revokedAt: { not: null } },
    });
    if (revokedInFamily > 0) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: this.clock.now() },
      });
      throw new UnauthorizedException('Refresh token 已失效，請重新登入');
    }
    return { userId: row.userId, email: row.user.email, refreshToken };
  }

  private async issue(userId: string, familyId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashRefreshToken(token),
        expiresAt: new Date(this.clock.now().getTime() + this.ttlMs),
      },
    });
    return token;
  }
}
