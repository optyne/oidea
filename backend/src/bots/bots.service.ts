import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Bot 整合：讓外部程式（Claude Code、自訂 agent、n8n、你的龍蝦等等）
 * 透過一條 API token 假裝成頻道成員發 / 收訊息。
 *
 * 設計：
 *  - 每個 bot 有一條對應的 User row（senderId 指過去；現有 Message FK 全部通用）
 *  - token 是 `bot_<prefix>.<secret>` 格式，prefix 索引 + bcrypt 比對 secret
 *  - bot 被建立時，自動加入 workspace 的所有「公開且未刪除」頻道（ChannelMember）
 *    私有頻道要另外手動 invite。這樣預設可用、但需要隱私時仍可控制。
 */
@Injectable()
export class BotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────── 管理端 (admin) ───────────────

  async create(
    actorId: string,
    workspaceId: string,
    dto: { name: string; description?: string },
  ) {
    await this.assertAdmin(actorId, workspaceId);

    const name = dto.name?.trim();
    if (!name || name.length > 60) {
      throw new BadRequestException('name 必填且長度 ≤ 60');
    }

    // 產 bot_<10字元prefix>.<32字元secret>，可讀 + 能爆破的位元夠多
    const prefixBytes = randomBytes(7).toString('base64url').slice(0, 10);
    const tokenPrefix = `bot_${prefixBytes}`;
    const secret = randomBytes(32).toString('base64url');
    const fullToken = `${tokenPrefix}.${secret}`;
    const tokenHash = await bcrypt.hash(secret, 10);

    // 產對應 bot user：email / username 內嵌 bot id，避開碰撞
    const botId = randomBytes(8).toString('hex');
    const botUsername = `bot_${botId}`;
    const botEmail = `bot+${botId}@oidea.system`;
    const unusablePw = await bcrypt.hash(randomBytes(64).toString('hex'), 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: botEmail,
          username: botUsername,
          displayName: name,
          passwordHash: unusablePw,
        },
      });

      // 加到 workspace_members（role=member），否則 channel membership 檢查一定會擋
      await tx.workspaceMember.create({
        data: { workspaceId, userId: user.id, role: 'member' },
      });

      // 自動加入所有公開頻道
      const publicChannels = await tx.channel.findMany({
        where: { workspaceId, type: 'public', deletedAt: null },
        select: { id: true },
      });
      if (publicChannels.length > 0) {
        await tx.channelMember.createMany({
          data: publicChannels.map((c) => ({ channelId: c.id, userId: user.id })),
          skipDuplicates: true,
        });
      }

      const bot = await tx.botAccount.create({
        data: {
          workspaceId,
          userId: user.id,
          name,
          description: dto.description?.slice(0, 500),
          tokenHash,
          tokenPrefix,
          createdById: actorId,
        },
      });
      return { bot, user };
    });

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'workspace.role_change',
      targetType: 'bot_account',
      targetId: result.bot.id,
      metadata: { op: 'bot_created', name, botUserId: result.user.id },
    });

    return {
      id: result.bot.id,
      name: result.bot.name,
      description: result.bot.description,
      createdAt: result.bot.createdAt,
      botUserId: result.user.id,
      /// Plaintext token，僅在此時回傳一次；之後永遠無法取回
      token: fullToken,
    };
  }

  async listForWorkspace(actorId: string, workspaceId: string) {
    await this.assertAdmin(actorId, workspaceId);
    return this.prisma.botAccount.findMany({
      where: { workspaceId, revokedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        tokenPrefix: true,
        lastUsedAt: true,
        createdAt: true,
        userId: true,
        createdBy: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(actorId: string, workspaceId: string, botId: string) {
    await this.assertAdmin(actorId, workspaceId);
    const bot = await this.prisma.botAccount.findUnique({ where: { id: botId } });
    if (!bot || bot.workspaceId !== workspaceId) {
      throw new NotFoundException('Bot 不存在');
    }
    if (bot.revokedAt) return { ok: true };

    await this.prisma.botAccount.update({
      where: { id: botId },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'workspace.member_remove',
      targetType: 'bot_account',
      targetId: botId,
      metadata: { op: 'bot_revoked', name: bot.name },
    });
    return { ok: true };
  }

  // ─────────────── Bot 側（以 token 認證）───────────────

  /**
   * 被 BotAuthGuard 呼叫：驗證 token，命中 → 回 bot + user；失敗 → 回 null。
   * Token 格式：`bot_<10>.<secret>`
   */
  async verifyToken(rawToken: string | undefined | null): Promise<{
    botId: string;
    userId: string;
    workspaceId: string;
  } | null> {
    if (!rawToken || !rawToken.startsWith('bot_')) return null;
    const [prefix, secret] = rawToken.split('.');
    if (!prefix || !secret) return null;

    const bot = await this.prisma.botAccount.findUnique({
      where: { tokenPrefix: prefix },
      select: {
        id: true,
        tokenHash: true,
        revokedAt: true,
        userId: true,
        workspaceId: true,
      },
    });
    if (!bot || bot.revokedAt) return null;

    const ok = await bcrypt.compare(secret, bot.tokenHash);
    if (!ok) return null;

    // lastUsedAt 不擋主流程；失敗 (race / DB 掛) 也不影響 auth 結果
    this.prisma.botAccount
      .update({ where: { id: bot.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return { botId: bot.id, userId: bot.userId, workspaceId: bot.workspaceId };
  }

  async getContext(botId: string) {
    return this.prisma.botAccount.findUnique({
      where: { id: botId },
      select: {
        id: true,
        name: true,
        description: true,
        userId: true,
        workspaceId: true,
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        workspace: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  // ─────────────── helpers ───────────────

  private async assertAdmin(userId: string, workspaceId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!m) throw new ForbiddenException('非此工作空間成員');
    if (m.role !== 'owner' && m.role !== 'admin') {
      throw new ForbiddenException('僅限 owner / admin 管理 bot');
    }
  }
}
