import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AutomationService } from './automation.service';
import { PrismaService } from '../common/prisma.service';

type PrismaMock = {
  workspaceMember: { findUnique: jest.Mock };
  automationRule: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

const buildMock = (): PrismaMock => ({
  workspaceMember: { findUnique: jest.fn() },
  automationRule: {
    create: jest.fn().mockResolvedValue({ id: 'r-1' }),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
});

describe('AutomationService (P-15)', () => {
  let service: AutomationService;
  let prisma: PrismaMock;

  const USER_ID = 'u-1';
  const OTHER = 'u-2';
  const WS_ID = 'ws-1';
  const RULE_ID = 'r-1';

  beforeEach(async () => {
    prisma = buildMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AutomationService);
  });

  const asMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue({
      id: 'm',
      workspaceId: WS_ID,
      userId: USER_ID,
    });

  const asNonMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue(null);

  const baseDto = () => ({
    workspaceId: WS_ID,
    name: '合約任務完成 → #財務',
    scope: 'project' as const,
    scopeId: 'p-1',
    trigger: 'task_completed' as const,
    action: 'post_to_channel' as const,
    actionConfig: {
      channelId: 'c-finance',
      contentTemplate: '任務 {{task.title}} 已完成',
    },
  });

  it('TC-P15-001: member 建立合法規則', async () => {
    asMember();
    await service.create(USER_ID, baseDto());
    expect(prisma.automationRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WS_ID,
        createdBy: USER_ID,
        enabled: true,
      }),
    });
  });

  it('TC-P15-002: 非 member → Forbidden', async () => {
    asNonMember();
    await expect(service.create(USER_ID, baseDto())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('TC-P15-003: post_to_channel 缺 channelId → BadRequest', async () => {
    asMember();
    const dto = baseDto();
    (dto.actionConfig as any) = { contentTemplate: 'x' };
    await expect(service.create(USER_ID, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('TC-P15-004: post_to_channel 缺 contentTemplate → BadRequest', async () => {
    asMember();
    const dto = baseDto();
    (dto.actionConfig as any) = { channelId: 'c-1' };
    await expect(service.create(USER_ID, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('TC-P15-005: notify_user 缺 userId → BadRequest', async () => {
    asMember();
    const dto = baseDto();
    (dto.action as any) = 'notify_user';
    (dto.actionConfig as any) = { title: 'done' };
    await expect(service.create(USER_ID, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('TC-P15-006: update 非建立者 → Forbidden', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({
      id: RULE_ID,
      workspaceId: WS_ID,
      createdBy: OTHER,
      action: 'post_to_channel',
      deletedAt: null,
    });
    asMember();
    await expect(
      service.update(USER_ID, RULE_ID, { enabled: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('TC-P15-007: remove 建立者軟刪', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({
      id: RULE_ID,
      workspaceId: WS_ID,
      createdBy: USER_ID,
      action: 'post_to_channel',
      deletedAt: null,
    });
    asMember();
    prisma.automationRule.update.mockResolvedValue({});
    await service.remove(USER_ID, RULE_ID);
    expect(prisma.automationRule.update).toHaveBeenCalledWith({
      where: { id: RULE_ID },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('TC-P15-008: 已軟刪的 rule → NotFound', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({
      id: RULE_ID,
      deletedAt: new Date(),
    });
    await expect(service.findById(USER_ID, RULE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('TC-P15-009: findActiveForTrigger 過濾 enabled + not deleted', async () => {
    prisma.automationRule.findMany.mockResolvedValue([]);
    await service.findActiveForTrigger('project', 'p-1', 'task_completed');
    expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
      where: {
        scope: 'project',
        scopeId: 'p-1',
        trigger: 'task_completed',
        enabled: true,
        deletedAt: null,
      },
    });
  });
});
