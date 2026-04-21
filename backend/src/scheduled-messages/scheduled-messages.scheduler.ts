import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MessagesService } from '../messages/messages.service';
import { ScheduledMessagesService } from './scheduled-messages.service';

/**
 * 每分鐘輪詢到期的 ScheduledMessage。對每筆：
 *   1. 以 createdBy 的身份呼叫 MessagesService.broadcast
 *   2. 成功 → 記錄 status = sent + sentBroadcastId
 *   3. 失敗 → status = failed + failedReason（仍繼續下一筆）
 *
 * Membership 以 fire 當下為準，所以建立者之後退出頻道會失敗；
 * 這符合實際情境「已經不是成員就不該再代發」。
 */
@Injectable()
export class ScheduledMessagesScheduler {
  private readonly logger = new Logger(ScheduledMessagesScheduler.name);

  constructor(
    private readonly scheduled: ScheduledMessagesService,
    private readonly messages: MessagesService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    await this.pollAndFire(new Date());
  }

  async pollAndFire(now: Date): Promise<{ sent: number; failed: number }> {
    const due = await this.scheduled.findDue(now);
    let sent = 0;
    let failed = 0;

    for (const record of due) {
      try {
        const result = await this.messages.broadcast(record.createdBy, {
          channelIds: record.channelIds,
          type: record.type,
          content: record.content ?? undefined,
          metadata: record.metadata ?? undefined,
        });
        await this.scheduled.markSent(record.id, now, result.broadcastId);
        sent += 1;
      } catch (err) {
        const reason = (err as Error).message || 'unknown error';
        this.logger.error(`排程訊息送出失敗 id=${record.id}: ${reason}`);
        try {
          await this.scheduled.markFailed(record.id, reason);
        } catch (inner) {
          this.logger.error(
            `markFailed 也失敗 id=${record.id}: ${(inner as Error).message}`,
          );
        }
        failed += 1;
      }
    }

    return { sent, failed };
  }
}
