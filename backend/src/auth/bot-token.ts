import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma.service';
import { UserStatusService } from './user-status.service';

export interface VerifiedBot {
  botId: string;
  /** bot 自己的 User（senderId 用） */
  userId: string;
  workspaceId: string;
  createdById: string;
}

/** 失敗原因（只給 log／測試；回應一律是 401，不透露哪一步失敗）。 */
export type BotTokenFailure = 'malformed' | 'not_found' | 'revoked' | 'bad_secret' | 'creator_disabled' | 'company_bot';

/** 401 的訊息（繁體中文）。 */
export const BOT_TOKEN_MESSAGES: Record<BotTokenFailure, string> = {
  malformed: 'Bot token 格式錯誤',
  not_found: '無效或已撤銷的 bot token',
  revoked: '無效或已撤銷的 bot token',
  bad_secret: '無效的 bot token',
  creator_disabled: 'Bot 建立者已停用',
  company_bot: '公司工作空間不能使用 bot',
};

export class BotTokenError extends Error {
  constructor(readonly reason: BotTokenFailure) {
    super(`bot token rejected: ${reason}`);
    this.name = 'BotTokenError';
  }
}

/**
 * bot token（`bot_<prefix>.<secret>`）的唯一驗證入口：`JwtAuthGuard` 的 bot 路徑與 `/bot/*` 的
 * `BotAuthGuard` 都走這裡，規則只有一份（spec §4.3「停用（離職）」：bot 那條路也要檢查建立者有沒有被停用）。
 *
 * - 格式、prefix 查得到、沒撤銷、bcrypt 比對 secret；
 * - 建立者已停用（離職）→ 拒絕。用 `UserStatusService`（跟 JwtStrategy 同一套快取；miss／Redis 出錯回 DB 查，
 *   DB 出錯往上拋 → 呼叫端拒絕，fail closed）；
 * - bot 屬於公司工作空間 → 拒絕：公司工作空間的成員只由員工生命週期決定，不能有 bot（H2 起建立時就擋，
 *   這裡擋掉 H1 上線後、H2 之前建的）。
 * 成功時非同步更新 `lastUsedAt`（失敗不影響驗證結果）。
 */
export async function verifyBotToken(
  prisma: PrismaService,
  userStatus: Pick<UserStatusService, 'isDisabled'>,
  rawToken: string | null | undefined,
): Promise<VerifiedBot> {
  if (!rawToken || !rawToken.startsWith('bot_')) throw new BotTokenError('malformed');
  const [prefix, secret] = rawToken.split('.');
  if (!prefix || !secret) throw new BotTokenError('malformed');

  const bot = await prisma.botAccount.findUnique({
    where: { tokenPrefix: prefix },
    select: {
      id: true,
      tokenHash: true,
      revokedAt: true,
      userId: true,
      workspaceId: true,
      createdById: true,
      workspace: { select: { isCompany: true } },
    },
  });
  if (!bot) throw new BotTokenError('not_found');
  if (bot.revokedAt) throw new BotTokenError('revoked');

  const ok = await bcrypt.compare(secret, bot.tokenHash);
  if (!ok) throw new BotTokenError('bad_secret');

  // bot 的建立者被停用（離職）→ bot 一起失效
  if (await userStatus.isDisabled(bot.createdById)) throw new BotTokenError('creator_disabled');
  if (bot.workspace?.isCompany === true) throw new BotTokenError('company_bot');

  prisma.botAccount
    .update({ where: { id: bot.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { botId: bot.id, userId: bot.userId, workspaceId: bot.workspaceId, createdById: bot.createdById };
}
