import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { MessagesService } from '../messages/messages.service';
import { AutomationService } from './automation.service';

export type TaskPayload = {
  id: string;
  projectId: string;
  title: string;
  assigneeId: string | null;
  dueDate: Date | null;
};

/**
 * P-15 規則執行引擎。呼叫端（TasksService 等）在事件發生後丟 payload，
 * 引擎自己撈符合的 rules 並分派動作。單一 rule 失敗不阻塞其他。
 */
@Injectable()
export class AutomationEngine {
  private readonly logger = new Logger(AutomationEngine.name);

  constructor(
    private automation: AutomationService,
    private notifications: NotificationsService,
    private messages: MessagesService,
  ) {}

  async onTaskCompleted(task: TaskPayload): Promise<number> {
    const rules = await this.automation.findActiveForTrigger(
      'project',
      task.projectId,
      'task_completed',
    );

    let fired = 0;
    for (const rule of rules) {
      try {
        await this.dispatch(rule, task);
        fired += 1;
      } catch (err) {
        this.logger.error(
          `規則執行失敗 id=${rule.id}: ${(err as Error).message}`,
        );
      }
    }
    return fired;
  }

  private async dispatch(
    rule: {
      id: string;
      createdBy: string;
      action: string;
      actionConfig: unknown;
    },
    task: TaskPayload,
  ) {
    const cfg = (rule.actionConfig ?? {}) as Record<string, unknown>;
    switch (rule.action) {
      case 'notify_user': {
        const userId = cfg.userId as string;
        const title = (cfg.title as string) || '任務已完成';
        const template = (cfg.contentTemplate as string) || '{{task.title}}';
        await this.notifications.create({
          userId,
          type: 'automation',
          title,
          content: renderTemplate(template, task),
          link: `/tasks/${task.id}`,
        });
        return;
      }
      case 'post_to_channel': {
        const channelId = cfg.channelId as string;
        const template = cfg.contentTemplate as string;
        await this.messages.create(rule.createdBy, {
          channelId,
          type: 'text',
          content: renderTemplate(template, task),
        });
        return;
      }
      default:
        throw new Error(`不支援的 action：${rule.action}`);
    }
  }
}

/** 支援 `{{task.title}}` / `{{task.id}}` / `{{task.dueDate}}` 三個佔位符。 */
export function renderTemplate(template: string, task: TaskPayload): string {
  return template
    .replace(/\{\{\s*task\.title\s*\}\}/g, task.title)
    .replace(/\{\{\s*task\.id\s*\}\}/g, task.id)
    .replace(
      /\{\{\s*task\.dueDate\s*\}\}/g,
      task.dueDate ? task.dueDate.toISOString() : '',
    );
}
