import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma.service';
import { UserStatusService } from '../user-status.service';

/**
 * JWT 守衛；同時支援 **bot token**（格式 `Bearer bot_<prefix>.<secret>`）。
 *
 * 命中 bot token 時：
 *  - 以 tokenPrefix 索引查出 BotAccount，bcrypt 比對 secret
 *  - 把 `req.user` 設成 `{ userId: bot.userId, botId, workspaceId, isBot: true }`，
 *    與 JWT 路徑相容，controller 沿用 `req.user.userId` 即可。
 *  - 失敗皆 401；成功時非同步更新 `lastUsedAt`（失敗不擋主流程）
 *
 * 效果：目前所有以 @UseGuards(JwtAuthGuard) 保護的端點自動支援 bot token，
 * 外部 agent 可以用同一條 token 呼叫任何使用者能呼叫的 API，受 workspace /
 * 頻道 / ACL 權限限制。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userStatus: UserStatusService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader: string | undefined = req.headers?.authorization;

    if (authHeader && /^Bearer\s+bot_/i.test(authHeader)) {
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const [prefix, secret] = token.split('.');
      if (!prefix || !secret) {
        throw new UnauthorizedException('Bot token 格式錯誤');
      }

      const bot = await this.prisma.botAccount.findUnique({
        where: { tokenPrefix: prefix },
        select: {
          id: true,
          tokenHash: true,
          revokedAt: true,
          userId: true,
          workspaceId: true,
          createdById: true,
        },
      });
      if (!bot || bot.revokedAt) {
        throw new UnauthorizedException('無效或已撤銷的 bot token');
      }

      const ok = await bcrypt.compare(secret, bot.tokenHash);
      if (!ok) {
        throw new UnauthorizedException('無效的 bot token');
      }

      // bot 的建立者被停用（離職）→ bot 一起失效；與 JwtStrategy 共用同一套快取
      if (await this.userStatus.isDisabled(bot.createdById)) {
        throw new UnauthorizedException('Bot 建立者已停用');
      }
      // 建立者的帳號在 SSO 綁定時重設過：綁定交易撤銷他建的所有 bot（revokedAt），commit 之後再撤銷一次
      // （撈出綁定途中才 commit 的新 bot，見 SsoLoginService）；H1 migration 也撤銷了上線前的全部 bot。
      // 這裡只看 revokedAt（review R1：不再用時間 cutoff）。

      // lastUsedAt 非關鍵；失敗不擋主流程
      this.prisma.botAccount
        .update({ where: { id: bot.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});

      req.user = {
        userId: bot.userId,
        botId: bot.id,
        workspaceId: bot.workspaceId,
        /** 其他 controller 若要差異化處理 bot 可檢查此旗標（可選） */
        isBot: true,
      };
      return true;
    }

    // 一般 JWT 路徑
    return (await super.canActivate(context)) as boolean;
  }
}
