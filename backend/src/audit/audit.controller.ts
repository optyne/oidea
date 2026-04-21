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

/**
 * 只讀端點。僅 workspace owner / admin 可查。
 */
@ApiTags('審計日誌')
@Controller('audit')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get('workspaces/:workspaceId')
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
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      throw new ForbiddenException('僅限 owner / admin 查看審計日誌');
    }
  }
}
