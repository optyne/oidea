import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { MessagesGateway } from '../messages/messages.gateway';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Oidea AI assistant — chat 中 @ai 會觸發。
 *
 * 架構：
 *   1. `onModuleInit` 建立 / 取回 bot user（username='ai'、password 無法使用）
 *   2. `MessagesService.create` 掛勾 → `handleAiMention` 檢 token 中 `@ai`
 *      → 非同步呼叫 Claude → 以 bot 身份 post 新訊息到同 channel + 廣播 socket
 *   3. Prompt caching 啟用於 system prompt（前置固定）
 *   4. 單使用者單小時最多 AI_RATE_LIMIT_PER_HOUR 次（Redis INCR + EXPIRE）
 */
@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  private readonly rateLimit: number;
  private readonly mentionRegex = /(?:^|[^A-Za-z0-9_])@ai(?:$|[^A-Za-z0-9_])/i;
  private readonly systemPrompt: string;

  private client: Anthropic | null = null;
  private botUserId: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly messagesGateway: MessagesGateway,
    private readonly notifications: NotificationsService,
  ) {
    this.enabled = this.config.get<string>('AI_ENABLED', 'true') !== 'false';
    this.model = this.config.get<string>('AI_MODEL', 'claude-opus-4-7');
    this.effort = (this.config.get<string>('AI_EFFORT', 'high') as any) || 'high';
    this.rateLimit = parseInt(this.config.get<string>('AI_RATE_LIMIT_PER_HOUR', '10'), 10);
    this.systemPrompt = [
      '你是 Oidea 協作平台內建的 AI 助手（用戶名 @ai）。',
      '使用繁體中文回覆。保持簡潔、直接、有幫助，回答長度與問題複雜度匹配。',
      '',
      '能力：回答技術問題、幫忙寫 / 改 code、整理 / 摘要討論、翻譯、產生範例。',
      '限制：只看當前 channel 最近幾則訊息作為 context；沒有網路瀏覽、沒有跨 channel 讀取、不能改檔案或 DB。',
      '',
      '規範：',
      '- 用 Markdown（code block 請用 fenced ``` + 語言 tag）。',
      '- 不要假裝查過資料庫或網站 —— 只憑 context 與自身訓練知識。',
      '- 你看不到發問者的真實身份（只有 displayName），不要外推個資。',
      '- 若被 @ai 標記但訊息本身跟問題無關（只是 FYI），回一句「收到」或直接不回話。',
    ].join('\n');
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('AI assistant disabled (AI_ENABLED=false)');
      return;
    }
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY 未設定；AI 功能停用');
      return;
    }
    this.client = new Anthropic({ apiKey });
    this.botUserId = await this.ensureBotUser();
    this.logger.log(`AI assistant ready (model=${this.model}, effort=${this.effort}, botUserId=${this.botUserId})`);
  }

  /** Messages pipeline 呼叫此方法；不會丟例外，內部自己 log。 */
  async handleAiMention(params: {
    messageId: string;
    channelId: string;
    content: string | null | undefined;
    actorId: string;
  }) {
    if (!this.client || !this.botUserId) return;
    if (!params.content) return;
    if (!this.mentionRegex.test(params.content)) return;
    if (params.actorId === this.botUserId) return; // 防自回

    // Rate-limit per actor per hour（單 key 放 Redis，INCR + EXPIRE）
    const rlKey = `ai:rl:${params.actorId}:${new Date().toISOString().slice(0, 13)}`; // yyyy-mm-ddThh
    try {
      const redis = this.redis.getClient();
      const count = await redis.incr(rlKey);
      if (count === 1) await redis.expire(rlKey, 3700);
      if (count > this.rateLimit) {
        await this.postBotMessage(
          params.channelId,
          `⚠️ 你這小時已經 @ai ${this.rateLimit} 次了，先休息一下再問吧～`,
        );
        return;
      }
    } catch (err) {
      // Redis 掛了不擋功能，只 log
      this.logger.warn(`AI rate-limit check failed: ${(err as Error).message}`);
    }

    try {
      const reply = await this.generateReply(params.channelId, params.messageId, params.content);
      await this.postBotMessage(params.channelId, reply);
    } catch (err) {
      this.logger.error(`AI reply failed: ${(err as Error).message}`);
      await this.postBotMessage(
        params.channelId,
        `⚠️ 抱歉，我回覆失敗了。（${(err as Error).message.slice(0, 120)}）`,
      ).catch(() => {});
    }
  }

  // ─────────────────────────────────────────

  private async ensureBotUser(): Promise<string> {
    const existing = await this.prisma.user.findUnique({ where: { username: 'ai' } });
    if (existing) return existing.id;

    // 產一個 bcrypt 鎖死的密碼 hash（沒有對應明文，bot 絕無法從 /auth/login 登入）
    const unusablePw = await bcrypt.hash(randomBytes(64).toString('hex'), 10);
    const bot = await this.prisma.user.create({
      data: {
        email: 'ai@oidea.system',
        username: 'ai',
        displayName: 'Oidea AI',
        passwordHash: unusablePw,
        avatarUrl: null,
      },
    });
    this.logger.log(`Seeded bot user ${bot.id}`);
    return bot.id;
  }

  private async generateReply(channelId: string, triggeringMessageId: string, content: string): Promise<string> {
    // 撈最近 10 則訊息（含觸發訊息）當 context；依時間升序。
    const recent = await this.prisma.message.findMany({
      where: { channelId, deletedAt: null, parentId: null },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        sender: { select: { id: true, displayName: true, username: true } },
      },
    });
    const ordered = recent.reverse();

    // 轉為 Anthropic message 陣列：區分「是 bot 過去發的」→ assistant turn，否則 user turn
    const messages: Anthropic.MessageParam[] = ordered.map((m) => {
      const isBot = m.senderId === this.botUserId;
      const author = m.sender?.displayName ?? 'user';
      const text = m.content ?? '';
      return {
        role: isBot ? 'assistant' : 'user',
        content: isBot ? text : `${author}: ${text}`,
      } as Anthropic.MessageParam;
    });

    // 確保結尾是 user turn；若結尾是 assistant（bot 之前自己發的訊息），補一個 user note
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      messages.push({ role: 'user', content: `（上面是最新對話；請回應最後一則 @ai 的訊息）` });
    }

    const response = await this.client!.messages.create({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort } as any,
      system: [
        {
          type: 'text',
          text: this.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || '（抱歉，我沒有想到要說什麼。）';
  }

  private async postBotMessage(channelId: string, content: string) {
    if (!this.botUserId) return;

    // Bot 不一定是頻道成員；直接寫 Message 即可（不強制 channelMember）
    const message = await this.prisma.message.create({
      data: {
        channelId,
        senderId: this.botUserId,
        type: 'text',
        content,
      },
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        reactions: true,
        _count: { select: { replies: true } },
      },
    });
    this.messagesGateway.emitNewMessage(channelId, message);
  }
}
