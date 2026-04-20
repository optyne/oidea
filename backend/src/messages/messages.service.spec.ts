import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesGateway } from './messages.gateway';
import { PrismaService } from '../common/prisma.service';

/**
 * 本 spec 聚焦在 C-16 `broadcast()`；create / update / delete 等舊方法的
 * 單元測試之後有空再補。
 */
describe('MessagesService.broadcast (C-16)', () => {
  let service: MessagesService;
  let prisma: {
    channel: { findMany: jest.Mock };
    message: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let gateway: { emitNewMessage: jest.Mock };

  const USER_ID = 'u-1';
  const WS_ID = 'ws-1';

  beforeEach(async () => {
    prisma = {
      channel: { findMany: jest.fn() },
      message: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    gateway = { emitNewMessage: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MessagesGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get(MessagesService);
  });

  const okChannel = (id: string, overrides: any = {}) => ({
    id,
    workspaceId: WS_ID,
    members: [{ userId: USER_ID }],
    deletedAt: null,
    ...overrides,
  });

  it('TC-C16-001: 成員、同 workspace、兩個頻道 → 各建一筆、共用 broadcastId', async () => {
    prisma.channel.findMany.mockResolvedValue([
      okChannel('c-1'),
      okChannel('c-2'),
    ]);
    // $transaction 接陣列 Promise-like；我們讓它直接依序 resolve
    prisma.$transaction.mockImplementation(async (ops: any[]) => [
      { id: 'm-1', channelId: 'c-1' },
      { id: 'm-2', channelId: 'c-2' },
    ]);

    const out = await service.broadcast(USER_ID, {
      channelIds: ['c-1', 'c-2'],
      content: '月底結算公告',
    });

    expect(out.broadcastId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.messages).toHaveLength(2);
    expect(gateway.emitNewMessage).toHaveBeenCalledTimes(2);
    expect(gateway.emitNewMessage).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ channelId: 'c-1' }),
    );
    expect(gateway.emitNewMessage).toHaveBeenCalledWith(
      'c-2',
      expect.objectContaining({ channelId: 'c-2' }),
    );
  });

  it('TC-C16-002: channelIds 重複自動去重', async () => {
    prisma.channel.findMany.mockResolvedValue([okChannel('c-1')]);
    prisma.$transaction.mockResolvedValue([{ id: 'm-1', channelId: 'c-1' }]);

    const out = await service.broadcast(USER_ID, {
      channelIds: ['c-1', 'c-1', 'c-1'],
      content: 'x',
    });

    expect(out.messages).toHaveLength(1);
    expect(gateway.emitNewMessage).toHaveBeenCalledTimes(1);
    // findMany 只應查一次 c-1
    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['c-1'] },
        }),
      }),
    );
  });

  it('TC-C16-003: 任一頻道不存在 → NotFound，整批回滾', async () => {
    prisma.channel.findMany.mockResolvedValue([okChannel('c-1')]); // c-2 不存在
    await expect(
      service.broadcast(USER_ID, {
        channelIds: ['c-1', 'c-2'],
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(gateway.emitNewMessage).not.toHaveBeenCalled();
  });

  it('TC-C16-004: 非任一頻道成員 → Forbidden，整批回滾', async () => {
    prisma.channel.findMany.mockResolvedValue([
      okChannel('c-1'),
      okChannel('c-2', { members: [] }), // 非成員
    ]);
    await expect(
      service.broadcast(USER_ID, {
        channelIds: ['c-1', 'c-2'],
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(gateway.emitNewMessage).not.toHaveBeenCalled();
  });

  it('TC-C16-005: 跨 workspace → BadRequest', async () => {
    prisma.channel.findMany.mockResolvedValue([
      okChannel('c-1'),
      okChannel('c-2', { workspaceId: 'ws-2' }),
    ]);
    await expect(
      service.broadcast(USER_ID, {
        channelIds: ['c-1', 'c-2'],
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('TC-C16-006: 空陣列 (去重後 0) → BadRequest', async () => {
    await expect(
      service.broadcast(USER_ID, {
        channelIds: [],
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('TC-C16-007: 透過 $transaction 原子性寫入', async () => {
    prisma.channel.findMany.mockResolvedValue([
      okChannel('c-1'),
      okChannel('c-2'),
    ]);
    prisma.$transaction.mockResolvedValue([
      { id: 'm-1', channelId: 'c-1' },
      { id: 'm-2', channelId: 'c-2' },
    ]);

    await service.broadcast(USER_ID, {
      channelIds: ['c-1', 'c-2'],
      content: 'x',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // 交易參數應為陣列 (批次)
    const txArg = prisma.$transaction.mock.calls[0][0];
    expect(Array.isArray(txArg)).toBe(true);
    expect(txArg).toHaveLength(2);
  });

  it('TC-C16-008: type 與 metadata 會被帶入每筆訊息', async () => {
    prisma.channel.findMany.mockResolvedValue([okChannel('c-1')]);
    // 攔截 message.create 確認 payload
    const created: any[] = [];
    prisma.message.create.mockImplementation((args: any) => {
      created.push(args);
      return Promise.resolve({ id: 'm', channelId: args.data.channelId });
    });
    prisma.$transaction.mockImplementation(async (ops: any[]) => {
      return Promise.all(ops);
    });

    await service.broadcast(USER_ID, {
      channelIds: ['c-1'],
      content: '請看附件',
      type: 'file',
      metadata: { fileId: 'f-9' },
    });

    expect(created[0].data).toEqual(
      expect.objectContaining({
        channelId: 'c-1',
        senderId: USER_ID,
        type: 'file',
        content: '請看附件',
        metadata: { fileId: 'f-9' },
        broadcastId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
  });
});
