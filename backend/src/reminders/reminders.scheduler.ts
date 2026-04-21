import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RemindersService } from './reminders.service';

/**
 * 每分鐘輪詢到期的 reminder。對每筆：
 *   1. 建立 Notification
 *   2. 呼叫 RemindersService.advance — 非循環設為 completed，循環推進 nextFireAt
 *
 * 單一筆失敗不應中斷批次，錯誤僅記錄在 log。
 */
@Injectable()
export class RemindersScheduler {
  private readonly logger = new Logger(RemindersScheduler.name);

  constructor(
    private prisma: PrismaService,
    private reminders: RemindersService,
    private notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    await this.pollAndFire(new Date());
  }

  /**
   * Public + deterministic input → 單元測試用。
   * Returns 這輪成功觸發的數量。
   */
  async pollAndFire(now: Date): Promise<number> {
    const due = await this.prisma.reminder.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        nextFireAt: { lte: now },
      },
      orderBy: { nextFireAt: 'asc' },
      take: 200,
    });

    let fired = 0;
    for (const reminder of due) {
      try {
        await this.fireOne(reminder, now);
        fired += 1;
      } catch (err) {
        this.logger.error(
          `觸發提醒失敗 id=${reminder.id}: ${(err as Error).message}`,
        );
      }
    }
    return fired;
  }

  private async fireOne(
    reminder: {
      id: string;
      userId: string;
      title: string;
      notes: string | null;
      targetType: string | null;
      targetId: string | null;
    },
    now: Date,
  ) {
    await this.notifications.create({
      userId: reminder.userId,
      type: 'reminder',
      title: reminder.title,
      content: reminder.notes ?? undefined,
      link: buildLink(reminder.targetType, reminder.targetId),
    });
    await this.reminders.advance(reminder.id, now);
  }
}

function buildLink(
  targetType: string | null,
  targetId: string | null,
): string | undefined {
  if (!targetType || !targetId) return undefined;
  switch (targetType) {
    case 'database_row':
      return `/databases/rows/${targetId}`;
    case 'task':
      return `/tasks/${targetId}`;
    default:
      return undefined;
  }
}
