import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { PermissionsGuard } from '../common/permissions.guard';
import { RequirePermission } from '../common/require-permission.decorator';
import { PERMISSIONS, hasPermission } from '../common/permissions';

/**
 * 只讀端點。需 `audit.read`（owner / admin）。
 */
@ApiTags('審計日誌')
@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get('workspaces/:workspaceId')
  @RequirePermission(PERMISSIONS.AUDIT_READ)
  @ApiOperation({ summary: '列出工作空間審計事件（owner / admin）' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'action', required: false, description: '過濾特定 action，例如 auth.login_failed' })
  @ApiQuery({ name: 'actorId', required: false })
  async listWorkspace(
    @Req() req: any,
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
  ) {
    await this.assertAdmin(req.user.userId, workspaceId);
    const take = Math.min(Math.max(parseInt(limit ?? '100', 10) || 100, 1), 500);
    return this.prisma.auditLog.findMany({
      where: {
        workspaceId,
        ...(action ? { action } : {}),
        ...(actorId ? { actorId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        actor: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
  }

  private async assertAdmin(userId: string, workspaceId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!m || !hasPermission(m.role, PERMISSIONS.AUDIT_READ)) {
      throw new ForbiddenException('僅限 owner / admin 查看審計日誌');
    }
  }
}
