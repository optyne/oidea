import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  CreateAutomationRuleDto,
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
} from './dto/create-rule.dto';
import { UpdateAutomationRuleDto } from './dto/update-rule.dto';

@Injectable()
export class AutomationService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateAutomationRuleDto) {
    await this.assertWorkspaceMember(userId, dto.workspaceId);
    this.validateActionConfig(dto.action, dto.actionConfig);

    return this.prisma.automationRule.create({
      data: {
        workspaceId: dto.workspaceId,
        createdBy: userId,
        name: dto.name,
        description: dto.description,
        scope: dto.scope,
        scopeId: dto.scopeId,
        trigger: dto.trigger,
        triggerConfig: (dto.triggerConfig ?? undefined) as any,
        action: dto.action,
        actionConfig: dto.actionConfig as any,
        enabled: dto.enabled ?? true,
      },
    });
  }

  async findByWorkspace(userId: string, workspaceId: string) {
    await this.assertWorkspaceMember(userId, workspaceId);
    return this.prisma.automationRule.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findById(userId: string, id: string) {
    const rule = await this.loadOrThrow(id);
    await this.assertWorkspaceMember(userId, rule.workspaceId);
    return rule;
  }

  async update(userId: string, id: string, dto: UpdateAutomationRuleDto) {
    const rule = await this.loadOrThrow(id);
    await this.assertWorkspaceMember(userId, rule.workspaceId);
    if (rule.createdBy !== userId) {
      throw new ForbiddenException('僅建立者可修改規則');
    }
    if (dto.actionConfig !== undefined) {
      this.validateActionConfig(rule.action, dto.actionConfig);
    }
    return this.prisma.automationRule.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        triggerConfig: (dto.triggerConfig ?? undefined) as any,
        actionConfig: (dto.actionConfig ?? undefined) as any,
        enabled: dto.enabled,
      },
    });
  }

  async remove(userId: string, id: string) {
    const rule = await this.loadOrThrow(id);
    await this.assertWorkspaceMember(userId, rule.workspaceId);
    if (rule.createdBy !== userId) {
      throw new ForbiddenException('僅建立者可刪除規則');
    }
    return this.prisma.automationRule.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // 給 engine 用的
  async findActiveForTrigger(
    scope: string,
    scopeId: string,
    trigger: string,
  ) {
    return this.prisma.automationRule.findMany({
      where: {
        scope,
        scopeId,
        trigger,
        enabled: true,
        deletedAt: null,
      },
    });
  }

  // ---------- 內部 ----------

  private async assertWorkspaceMember(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
  }

  private async loadOrThrow(id: string) {
    const rule = await this.prisma.automationRule.findUnique({ where: { id } });
    if (!rule || rule.deletedAt) {
      throw new NotFoundException('自動化規則不存在');
    }
    return rule;
  }

  private validateActionConfig(
    action: string,
    config: Record<string, unknown>,
  ) {
    if (!AUTOMATION_ACTIONS.includes(action as any)) {
      throw new BadRequestException(`不支援的 action：${action}`);
    }
    switch (action) {
      case 'notify_user': {
        if (typeof config.userId !== 'string' || !config.userId) {
          throw new BadRequestException('notify_user 需要 actionConfig.userId');
        }
        return;
      }
      case 'post_to_channel': {
        if (typeof config.channelId !== 'string' || !config.channelId) {
          throw new BadRequestException(
            'post_to_channel 需要 actionConfig.channelId',
          );
        }
        if (
          typeof config.contentTemplate !== 'string' ||
          config.contentTemplate.length === 0
        ) {
          throw new BadRequestException(
            'post_to_channel 需要 actionConfig.contentTemplate',
          );
        }
        return;
      }
    }
  }
}

// 便利 re-export（engine / tests 拿得到）
export { AUTOMATION_TRIGGERS };
