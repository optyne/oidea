import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { AutomationEngine, renderTemplate } from './automation.engine';
import { AutomationService } from './automation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MessagesService } from '../messages/messages.service';

describe('AutomationEngine (P-15)', () => {
  let engine: AutomationEngine;
  let automation: { findActiveForTrigger: jest.Mock };
  let notifications: { create: jest.Mock };
  let messages: { create: jest.Mock };

  const taskPayload = {
    id: 't-1',
    projectId: 'p-1',
    title: '合約請款 Cequrex 60000',
    assigneeId: null,
    dueDate: new Date('2026-05-01T00:00:00Z'),
  };

  beforeEach(async () => {
    automation = { findActiveForTrigger: jest.fn() };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    messages = { create: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationEngine,
        { provide: AutomationService, useValue: automation },
        { provide: NotificationsService, useValue: notifications },
        { provide: MessagesService, useValue: messages },
      ],
    }).compile();
    engine = module.get(AutomationEngine);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('TC-P15-E01: post_to_channel 觸發 — 走 MessagesService.create + 模板代入', async () => {
    automation.findActiveForTrigger.mockResolvedValue([
      {
        id: 'r-1',
        createdBy: 'u-1',
        action: 'post_to_channel',
        actionConfig: {
          channelId: 'c-finance',
          contentTemplate: '✅ {{task.title}} 已完成 (id={{task.id}})',
        },
      },
    ]);
    const out = await engine.onTaskCompleted(taskPayload);
    expect(out).toBe(1);
    expect(messages.create).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        channelId: 'c-finance',
        content: '✅ 合約請款 Cequrex 60000 已完成 (id=t-1)',
      }),
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('TC-P15-E02: notify_user 觸發 — 建 Notification + link 指向 /tasks/:id', async () => {
    automation.findActiveForTrigger.mockResolvedValue([
      {
        id: 'r-2',
        createdBy: 'u-1',
        action: 'notify_user',
        actionConfig: { userId: 'u-finance', title: '合約任務完成' },
      },
    ]);
    await engine.onTaskCompleted(taskPayload);
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'u-finance',
      type: 'automation',
      title: '合約任務完成',
      content: '合約請款 Cequrex 60000', // 預設模板 = {{task.title}}
      link: '/tasks/t-1',
    });
    expect(messages.create).not.toHaveBeenCalled();
  });

  it('TC-P15-E03: 找不到任何 rule → 0 次呼叫', async () => {
    automation.findActiveForTrigger.mockResolvedValue([]);
    const out = await engine.onTaskCompleted(taskPayload);
    expect(out).toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(messages.create).not.toHaveBeenCalled();
  });

  it('TC-P15-E04: 一條 rule 噴錯不阻塞其他 rules', async () => {
    automation.findActiveForTrigger.mockResolvedValue([
      {
        id: 'bad',
        createdBy: 'u-1',
        action: 'post_to_channel',
        actionConfig: { channelId: 'c-x', contentTemplate: 'x' },
      },
      {
        id: 'ok',
        createdBy: 'u-1',
        action: 'notify_user',
        actionConfig: { userId: 'u-finance' },
      },
    ]);
    messages.create.mockRejectedValueOnce(new Error('非頻道成員'));
    const out = await engine.onTaskCompleted(taskPayload);
    expect(out).toBe(1);
    expect(notifications.create).toHaveBeenCalled();
  });

  it('TC-P15-E05: 不支援的 action 被當作失敗，不影響其他', async () => {
    automation.findActiveForTrigger.mockResolvedValue([
      { id: 'bad', createdBy: 'u-1', action: 'weird', actionConfig: {} },
      {
        id: 'ok',
        createdBy: 'u-1',
        action: 'notify_user',
        actionConfig: { userId: 'u-2' },
      },
    ]);
    const out = await engine.onTaskCompleted(taskPayload);
    expect(out).toBe(1);
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it('TC-P15-E06: 查詢帶入 project scope + trigger=task_completed', async () => {
    automation.findActiveForTrigger.mockResolvedValue([]);
    await engine.onTaskCompleted(taskPayload);
    expect(automation.findActiveForTrigger).toHaveBeenCalledWith(
      'project',
      'p-1',
      'task_completed',
    );
  });

  describe('renderTemplate (純函式)', () => {
    it('TC-P15-E10: 支援 title / id / dueDate', () => {
      const out = renderTemplate(
        '[{{task.id}}] {{task.title}} due {{task.dueDate}}',
        taskPayload,
      );
      expect(out).toBe(
        '[t-1] 合約請款 Cequrex 60000 due 2026-05-01T00:00:00.000Z',
      );
    });

    it('TC-P15-E11: 未知 placeholder 原樣保留', () => {
      const out = renderTemplate('{{task.unknown}} {{other}}', taskPayload);
      expect(out).toBe('{{task.unknown}} {{other}}');
    });

    it('TC-P15-E12: dueDate 為 null → 代入空字串', () => {
      const out = renderTemplate('due {{task.dueDate}}', {
        ...taskPayload,
        dueDate: null,
      });
      expect(out).toBe('due ');
    });
  });
});
