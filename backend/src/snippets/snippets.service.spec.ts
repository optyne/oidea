import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SnippetsService } from './snippets.service';
import { PrismaService } from '../common/prisma.service';

type PrismaMock = {
  workspaceMember: { findUnique: jest.Mock };
  messageSnippet: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

const buildMock = (): PrismaMock => ({
  workspaceMember: { findUnique: jest.fn() },
  messageSnippet: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
});

describe('SnippetsService (C-15)', () => {
  let service: SnippetsService;
  let prisma: PrismaMock;

  const USER_ID = 'u-1';
  const OTHER_ID = 'u-2';
  const WS_ID = 'ws-1';
  const SNIP_ID = 's-1';

  beforeEach(async () => {
    prisma = buildMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SnippetsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(SnippetsService);
  });

  const asMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue({
      id: 'm',
      workspaceId: WS_ID,
      userId: USER_ID,
    });
  const asNonMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue(null);

  const snippet = (overrides: any = {}) => ({
    id: SNIP_ID,
    workspaceId: WS_ID,
    createdBy: USER_ID,
    name: 'X',
    content: 'Y',
    shortcut: null,
    visibility: 'personal',
    deletedAt: null,
    ...overrides,
  });

  // ---------- create ----------
  describe('create', () => {
    it('TC-C15-001: member 建立 personal 範本', async () => {
      asMember();
      prisma.messageSnippet.create.mockResolvedValue(snippet());
      await service.create(USER_ID, {
        workspaceId: WS_ID,
        name: '月底結算公告',
        content: '各組長好…',
      });
      expect(prisma.messageSnippet.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: WS_ID,
          createdBy: USER_ID,
          visibility: 'personal',
        }),
      });
    });

    it('TC-C15-002: 指定 visibility=workspace 照寫入', async () => {
      asMember();
      prisma.messageSnippet.create.mockResolvedValue(
        snippet({ visibility: 'workspace' }),
      );
      await service.create(USER_ID, {
        workspaceId: WS_ID,
        name: '公司公告',
        content: '...',
        visibility: 'workspace',
      });
      expect(prisma.messageSnippet.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ visibility: 'workspace' }),
      });
    });

    it('TC-C15-003: 非成員建立 → Forbidden', async () => {
      asNonMember();
      await expect(
        service.create(USER_ID, {
          workspaceId: WS_ID,
          name: 'X',
          content: 'Y',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.messageSnippet.create).not.toHaveBeenCalled();
    });
  });

  // ---------- list / get ----------
  describe('findByWorkspace', () => {
    it('TC-C15-010: 查詢條件包含 "workspace OR own personal"', async () => {
      asMember();
      prisma.messageSnippet.findMany.mockResolvedValue([]);
      await service.findByWorkspace(USER_ID, WS_ID);
      expect(prisma.messageSnippet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: WS_ID,
            deletedAt: null,
            OR: [{ visibility: 'workspace' }, { createdBy: USER_ID }],
          }),
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    it('TC-C15-011: 非成員列出 → Forbidden', async () => {
      asNonMember();
      await expect(
        service.findByWorkspace(USER_ID, WS_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('findById', () => {
    it('TC-C15-020: workspace 可見的他人範本可讀', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(
        snippet({ createdBy: OTHER_ID, visibility: 'workspace' }),
      );
      asMember();
      const out = await service.findById(USER_ID, SNIP_ID);
      expect(out.createdBy).toBe(OTHER_ID);
    });

    it('TC-C15-021: 他人 personal → Forbidden', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(
        snippet({ createdBy: OTHER_ID, visibility: 'personal' }),
      );
      asMember();
      await expect(
        service.findById(USER_ID, SNIP_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('TC-C15-022: 已軟刪 → NotFound', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(
        snippet({ deletedAt: new Date() }),
      );
      await expect(
        service.findById(USER_ID, SNIP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('TC-C15-023: 不存在 → NotFound', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(null);
      await expect(
        service.findById(USER_ID, SNIP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------- update / remove ----------
  describe('update', () => {
    it('TC-C15-030: 作者可以更新自己的', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(snippet());
      asMember();
      prisma.messageSnippet.update.mockResolvedValue(snippet({ name: 'new' }));
      await service.update(USER_ID, SNIP_ID, { name: 'new' });
      expect(prisma.messageSnippet.update).toHaveBeenCalledWith({
        where: { id: SNIP_ID },
        data: expect.objectContaining({ name: 'new' }),
      });
    });

    it('TC-C15-031: 非作者 (即使 workspace 可見) → Forbidden', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(
        snippet({ createdBy: OTHER_ID, visibility: 'workspace' }),
      );
      asMember();
      await expect(
        service.update(USER_ID, SNIP_ID, { name: 'hack' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.messageSnippet.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('TC-C15-040: 作者軟刪成功', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(snippet());
      asMember();
      prisma.messageSnippet.update.mockResolvedValue({});
      await service.remove(USER_ID, SNIP_ID);
      expect(prisma.messageSnippet.update).toHaveBeenCalledWith({
        where: { id: SNIP_ID },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('TC-C15-041: 非作者 → Forbidden', async () => {
      prisma.messageSnippet.findUnique.mockResolvedValue(
        snippet({ createdBy: OTHER_ID }),
      );
      asMember();
      await expect(service.remove(USER_ID, SNIP_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
