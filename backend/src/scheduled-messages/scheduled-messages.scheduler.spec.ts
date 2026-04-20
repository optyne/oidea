import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ScheduledMessagesScheduler } from './scheduled-messages.scheduler';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { MessagesService } from '../messages/messages.service';

describe('ScheduledMessagesScheduler (C-17)', () => {
  let scheduler: ScheduledMessagesScheduler;
  let scheduled: {
    findDue: jest.Mock;
    markSent: jest.Mock;
    markFailed: jest.Mock;
  };
  let messages: { broadcast: jest.Mock };

  const NOW = new Date('2026-04-25T09:00:00Z');

  beforeEach(async () => {
    scheduled = {
      findDue: jest.fn(),
      markSent: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn().mockResolvedValue({}),
    };
    messages = { broadcast: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledMessagesScheduler,
        { provide: ScheduledMessagesService, useValue: scheduled },
        { provide: MessagesService, useValue: messages },
      ],
    }).compile();

    scheduler = module.get(ScheduledMessagesScheduler);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  const due = (overrides: any = {}) => ({
    id: 'sm-1',
    createdBy: 'u-1',
    channelIds: ['c-1'],
    type: 'text',
    content: 'hi',
    metadata: null,
    ...overrides,
  });

  it('TC-C17-SC01: 成功廣播 → markSent 帶回 broadcastId', async () => {
    scheduled.findDue.mockResolvedValue([due()]);
    messages.broadcast.mockResolvedValue({ broadcastId: 'b-99', messages: [] });
    const out = await scheduler.pollAndFire(NOW);
    expect(out).toEqual({ sent: 1, failed: 0 });
    expect(messages.broadcast).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ channelIds: ['c-1'], content: 'hi' }),
    );
    expect(scheduled.markSent).toHaveBeenCalledWith('sm-1', NOW, 'b-99');
    expect(scheduled.markFailed).not.toHaveBeenCalled();
  });

  it('TC-C17-SC02: broadcast 噴錯 → markFailed 帶入原因', async () => {
    scheduled.findDue.mockResolvedValue([due()]);
    messages.broadcast.mockRejectedValue(new Error('非頻道成員：c-1'));
    const out = await scheduler.pollAndFire(NOW);
    expect(out).toEqual({ sent: 0, failed: 1 });
    expect(scheduled.markFailed).toHaveBeenCalledWith('sm-1', '非頻道成員：c-1');
    expect(scheduled.markSent).not.toHaveBeenCalled();
  });

  it('TC-C17-SC03: 批次中失敗不阻塞後續', async () => {
    scheduled.findDue.mockResolvedValue([
      due({ id: 'bad' }),
      due({ id: 'good' }),
    ]);
    messages.broadcast
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ broadcastId: 'b-1', messages: [] });
    const out = await scheduler.pollAndFire(NOW);
    expect(out).toEqual({ sent: 1, failed: 1 });
    expect(scheduled.markFailed).toHaveBeenCalledWith('bad', 'boom');
    expect(scheduled.markSent).toHaveBeenCalledWith('good', NOW, 'b-1');
  });

  it('TC-C17-SC04: 沒有到期 → 零呼叫', async () => {
    scheduled.findDue.mockResolvedValue([]);
    const out = await scheduler.pollAndFire(NOW);
    expect(out).toEqual({ sent: 0, failed: 0 });
    expect(messages.broadcast).not.toHaveBeenCalled();
  });

  it('TC-C17-SC05: content = null 傳 undefined 給 broadcast', async () => {
    scheduled.findDue.mockResolvedValue([due({ content: null })]);
    messages.broadcast.mockResolvedValue({ broadcastId: 'b', messages: [] });
    await scheduler.pollAndFire(NOW);
    expect(messages.broadcast).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ content: undefined }),
    );
  });

  it('TC-C17-SC06: markFailed 失敗只記 log，不拋', async () => {
    scheduled.findDue.mockResolvedValue([due()]);
    messages.broadcast.mockRejectedValue(new Error('step1'));
    scheduled.markFailed.mockRejectedValue(new Error('step2'));
    await expect(scheduler.pollAndFire(NOW)).resolves.toEqual({
      sent: 0,
      failed: 1,
    });
  });
});
