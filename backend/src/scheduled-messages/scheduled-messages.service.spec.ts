import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { PrismaService } from '../common/prisma.service';

type PrismaMock = {
  workspaceMember: { findUnique: jest.Mock };
  channel: { findMany: jest.Mock };
  scheduledMessage: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

const buildMock = (): PrismaMock => ({
  workspaceMember: { findUnique: jest.fn() },
  channel: { findMany: jest.fn() },
  scheduledMessage: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
});

describe('ScheduledMessagesService (C-17)', () => {
  let service: ScheduledMessagesService;
  let prisma: PrismaMock;

  const USER_ID = 'u-1';
  const OTHER = 'u-2';
  const WS_ID = 'ws-1';
  const SMID = 'sm-1';

  const futureIso = () =>
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    prisma = buildMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledMessagesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ScheduledMessagesService);
  });

  const asMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue({
      id: 'm', workspaceId: WS_ID, userId: USER_ID,
    });
  const asNonMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue(null);

  const goodChannel = (id: string, overrides: any = {}) => ({
    id,
    workspaceId: WS_ID,
    members: [{ userId: USER_ID }],
    ...overrides,
  });

  // ---------- create ----------
  describe('create', () => {
    it('TC-C17-001: member + 同 ws 頻道 + 未來時間 → 建立 pending', async () => {
      asMember();
      prisma.channel.findMany.mockResolvedValue([goodChannel('c-1')]);
      prisma.scheduledMessage.create.mockResolvedValue({ id: SMID });
      await service.create(USER_ID, {
        workspaceId: WS_ID,
        channelIds: ['c-1'],
        content: '月底結算公告',
        sendAt: futureIso(),
      });
      expect(prisma.scheduledMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: WS_ID,
          createdBy: USER_ID,
          channelIds: ['c-1'],
          type: 'text',
        }),
      });
    });

    it('TC-C17-002: sendAt 在過去 → BadRequest', async () => {
      asMember();
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          channelIds: ['c-1'],
          sendAt: '2020-01-01T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-C17-003: 非 workspace 成員 → Forbidden', async () => {
      asNonMember();
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          channelIds: ['c-1'],
          sendAt: futureIso(),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('TC-C17-004: 頻道在他 workspace → BadRequest', async () => {
      asMember();
      prisma.channel.findMany.mockResolvedValue([
        goodChannel('c-1', { workspaceId: 'ws-2' }),
      ]);
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          channelIds: ['c-1'],
          sendAt: futureIso(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-C17-005: 非頻道成員 → Forbidden', async () => {
      asMember();
      prisma.channel.findMany.mockResolvedValue([
        goodChannel('c-1', { members: [] }),
      ]);
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          channelIds: ['c-1'],
          sendAt: futureIso(),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('TC-C17-006: 頻道不存在 → NotFound', async () => {
      asMember();
      prisma.channel.findMany.mockResolvedValue([]); // 0 筆回來
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          channelIds: ['ghost'],
          sendAt: futureIso(),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('TC-C17-007: channelIds 去重', async () => {
      asMember();
      prisma.channel.findMany.mockResolvedValue([goodChannel('c-1')]);
      prisma.scheduledMessage.create.mockResolvedValue({ id: SMID });
      await service.create(USER_ID, {
        workspaceId: WS_ID,
        channelIds: ['c-1', 'c-1', 'c-1'],
        sendAt: futureIso(),
      });
      expect(prisma.scheduledMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ channelIds: ['c-1'] }),
      });
    });
  });

  // ---------- query ----------
  describe('findByWorkspace', () => {
    it('TC-C17-010: 預設只回傳 pending', async () => {
      asMember();
      prisma.scheduledMessage.findMany.mockResolvedValue([]);
      await service.findByWorkspace(USER_ID, WS_ID);
      expect(prisma.scheduledMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'pending' }),
        }),
      );
    });

    it('TC-C17-011: includeHistory=true → 不過濾 status', async () => {
      asMember();
      prisma.scheduledMessage.findMany.mockResolvedValue([]);
      await service.findByWorkspace(USER_ID, WS_ID, { includeHistory: true });
      const call = prisma.scheduledMessage.findMany.mock.calls[0][0];
      expect(call.where.status).toBeUndefined();
    });
  });

  // ---------- cancel / remove ----------
  describe('cancel', () => {
    const rec = (overrides: any = {}) => ({
      id: SMID,
      workspaceId: WS_ID,
      createdBy: USER_ID,
      status: 'pending',
      deletedAt: null,
      ...overrides,
    });

    it('TC-C17-020: 建立者可取消 pending', async () => {
      prisma.scheduledMessage.findUnique.mockResolvedValue(rec());
      asMember();
      prisma.scheduledMessage.update.mockResolvedValue({});
      await service.cancel(USER_ID, SMID);
      expect(prisma.scheduledMessage.update).toHaveBeenCalledWith({
        where: { id: SMID },
        data: { status: 'canceled' },
      });
    });

    it('TC-C17-021: 非建立者 → Forbidden', async () => {
      prisma.scheduledMessage.findUnique.mockResolvedValue(
        rec({ createdBy: OTHER }),
      );
      asMember();
      await expect(service.cancel(USER_ID, SMID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('TC-C17-022: 已 sent 無法取消', async () => {
      prisma.scheduledMessage.findUnique.mockResolvedValue(
        rec({ status: 'sent' }),
      );
      asMember();
      await expect(service.cancel(USER_ID, SMID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
