import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesGateway } from './messages.gateway';
import { PrismaService } from '../common/prisma.service';

type PrismaMock = {
  channel: { findMany: jest.Mock };
  channelMember: { findUnique: jest.Mock };
  workspaceMember: { findUnique: jest.Mock };
  message: { create: jest.Mock; findUnique: jest.Mock };
  project: { findUnique: jest.Mock };
  projectColumn: { findUnique: jest.Mock };
  task: { create: jest.Mock };
  $transaction: jest.Mock;
};

const buildPrismaMock = (): PrismaMock => ({
  channel: { findMany: jest.fn() },
  channelMember: { findUnique: jest.fn() },
  workspaceMember: { findUnique: jest.fn() },
  message: { create: jest.fn(), findUnique: jest.fn() },
  project: { findUnique: jest.fn() },
  projectColumn: { findUnique: jest.fn() },
  task: { create: jest.fn() },
  $transaction: jest.fn(),
});

const buildGatewayMock = () => ({ emitNewMessage: jest.fn() });

/**
 * 本 spec 聚焦在 C-16 `broadcast()` 與 C-18 `convertToTask()`。
 * 其他舊方法的單元測試之後有空再補。
 */
describe('MessagesService.broadcast (C-16)', () => {
  let service: MessagesService;
  let prisma: PrismaMock;
  let gateway: ReturnType<typeof buildGatewayMock>;

  const USER_ID = 'u-1';
  const WS_ID = 'ws-1';

  beforeEach(async () => {
    prisma = buildPrismaMock();
    gateway = buildGatewayMock();

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

describe('MessagesService.convertToTask (C-18)', () => {
  let service: MessagesService;
  let prisma: PrismaMock;

  const USER_ID = 'u-1';
  const ASSIGNEE_ID = 'u-2';
  const WS_ID = 'ws-1';
  const CH_ID = 'c-1';
  const MSG_ID = 'm-1';
  const PROJ_ID = 'p-1';
  const COL_ID = 'col-1';

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MessagesGateway, useValue: buildGatewayMock() },
      ],
    }).compile();
    service = module.get(MessagesService);
  });

  const arrangeValidSetup = (overrides: { message?: any; project?: any; column?: any } = {}) => {
    prisma.message.findUnique.mockResolvedValue({
      id: MSG_ID,
      channelId: CH_ID,
      content: '請追蹤 Cequrex 合約 60000 + 6000 維護費未請款',
      deletedAt: null,
      channel: { workspaceId: WS_ID },
      ...overrides.message,
    });
    prisma.channelMember.findUnique.mockResolvedValue({
      channelId: CH_ID,
      userId: USER_ID,
    });
    prisma.project.findUnique.mockResolvedValue({
      id: PROJ_ID,
      workspaceId: WS_ID,
      deletedAt: null,
      ...overrides.project,
    });
    prisma.projectColumn.findUnique.mockResolvedValue({
      id: COL_ID,
      projectId: PROJ_ID,
      ...overrides.column,
    });
    prisma.task.create.mockResolvedValue({ id: 't-1' });
  };

  it('TC-C18-001: happy path — 帶回 sourceMessageId 與預設 priority', async () => {
    arrangeValidSetup();
    await service.convertToTask(USER_ID, MSG_ID, {
      projectId: PROJ_ID,
      columnId: COL_ID,
    });
    expect(prisma.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: PROJ_ID,
        columnId: COL_ID,
        sourceMessageId: MSG_ID,
        priority: 'medium',
      }),
    });
  });

  it('TC-C18-002: 預設 title = content 前 100 字，description = 完整 content', async () => {
    const long = 'a'.repeat(150);
    arrangeValidSetup({ message: { content: long } });
    await service.convertToTask(USER_ID, MSG_ID, {
      projectId: PROJ_ID,
      columnId: COL_ID,
    });
    const data = prisma.task.create.mock.calls[0][0].data;
    expect(data.title).toHaveLength(100);
    expect(data.description).toBe(long);
  });

  it('TC-C18-003: 空 content → title fallback 為「（空訊息）」', async () => {
    arrangeValidSetup({ message: { content: null } });
    await service.convertToTask(USER_ID, MSG_ID, {
      projectId: PROJ_ID,
      columnId: COL_ID,
    });
    const data = prisma.task.create.mock.calls[0][0].data;
    expect(data.title).toBe('（空訊息）');
    expect(data.description).toBeUndefined();
  });

  it('TC-C18-004: dto 覆蓋 title / description / priority / dueDate / assignee', async () => {
    arrangeValidSetup();
    prisma.workspaceMember.findUnique.mockResolvedValue({
      workspaceId: WS_ID,
      userId: ASSIGNEE_ID,
    });
    await service.convertToTask(USER_ID, MSG_ID, {
      projectId: PROJ_ID,
      columnId: COL_ID,
      title: '自訂標題',
      description: '自訂描述',
      priority: 'urgent',
      assigneeId: ASSIGNEE_ID,
      dueDate: '2026-05-31',
    });
    const data = prisma.task.create.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({
        title: '自訂標題',
        description: '自訂描述',
        priority: 'urgent',
        assigneeId: ASSIGNEE_ID,
      }),
    );
    expect((data.dueDate as Date).toISOString().startsWith('2026-05-31')).toBe(true);
  });

  it('TC-C18-005: 訊息不存在 / 已軟刪 → NotFound', async () => {
    prisma.message.findUnique.mockResolvedValue(null);
    await expect(
      service.convertToTask(USER_ID, MSG_ID, {
        projectId: PROJ_ID,
        columnId: COL_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('TC-C18-006: 非頻道成員 → Forbidden', async () => {
    arrangeValidSetup();
    prisma.channelMember.findUnique.mockResolvedValue(null);
    await expect(
      service.convertToTask(USER_ID, MSG_ID, {
        projectId: PROJ_ID,
        columnId: COL_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('TC-C18-007: 專案在他 workspace → BadRequest', async () => {
    arrangeValidSetup({ project: { workspaceId: 'ws-2' } });
    await expect(
      service.convertToTask(USER_ID, MSG_ID, {
        projectId: PROJ_ID,
        columnId: COL_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('TC-C18-008: 欄位不屬於此專案 → BadRequest', async () => {
    arrangeValidSetup({ column: { projectId: 'other-proj' } });
    await expect(
      service.convertToTask(USER_ID, MSG_ID, {
        projectId: PROJ_ID,
        columnId: COL_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('TC-C18-009: assignee 非 workspace 成員 → BadRequest', async () => {
    arrangeValidSetup();
    prisma.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(
      service.convertToTask(USER_ID, MSG_ID, {
        projectId: PROJ_ID,
        columnId: COL_ID,
        assigneeId: 'stranger',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

