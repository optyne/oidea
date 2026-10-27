import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { BotsService } from './bots.service';

/**
 * 驗證 `Authorization: Bearer bot_...` token，命中後把 bot context 塞到 request。
 *
 * 成功：`req.bot = { botId, userId, workspaceId }`；後續 controller 用 `req.bot.userId`
 *       當 senderId 發訊息 → 跟一般使用者走同一條訊息路徑。
 *
 * 驗證規則跟 JwtAuthGuard 的 bot 路徑是同一份（auth/bot-token.ts）：包含「建立者已停用（離職）→ 401」，
 * 用跟 JwtStrategy 同一套 UserStatusService 快取。查停用狀態出錯 → 往上拋（fail closed）。
 */
@Injectable()
export class BotAuthGuard implements CanActivate {
  constructor(private readonly bots: BotsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers?.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('缺少 Bearer token');
    }
    const token = header.slice(7).trim();
    const ctx = await this.bots.verifyToken(token);
    if (!ctx) {
      throw new UnauthorizedException('無效、已撤銷或建立者已停用的 bot token');
    }
    req.bot = ctx;
    return true;
  }
}
