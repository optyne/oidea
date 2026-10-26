import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Req, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/permissions.guard';
import { RequirePermission } from '../common/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';

/**
 * 管理類端點以 `:workspaceId` 命名路由參數，讓 `PermissionsGuard` 找得到工作空間。
 * URL 本身不變（參數名稱不影響路徑）。Service 內仍會再做 owner 規則檢查。
 */
@ApiTags('工作空間')
@Controller('workspaces')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth()
export class WorkspacesController {
  constructor(
    private workspacesService: WorkspacesService,
    private audit: AuditService,
    private prisma: PrismaService,
  ) {}

  @Post()
  @ApiOperation({ summary: '建立工作空間' })
  async create(@Req() req: any, @Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '列出我的工作空間' })
  async findAll(@Req() req: any) {
    return this.workspacesService.findAll(req.user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得工作空間詳情' })
  async findById(@Req() req: any, @Param('id') id: string) {
    return this.workspacesService.findById(req.user.userId, id);
  }

  @Put(':workspaceId')
  @RequirePermission(PERMISSIONS.WORKSPACE_MANAGE)
  @ApiOperation({ summary: '更新工作空間（需 workspace.manage）' })
  async update(@Req() req: any, @Param('workspaceId') id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspacesService.update(req.user.userId, id, dto);
  }

  @Delete(':workspaceId')
  @RequirePermission(PERMISSIONS.WORKSPACE_DELETE)
  @ApiOperation({ summary: '刪除工作空間（僅 owner）' })
  async delete(@Req() req: any, @Param('workspaceId') id: string) {
    return this.workspacesService.delete(req.user.userId, id);
  }

  @Post(':workspaceId/members')
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  @ApiOperation({
    summary: '邀請成員（需 member.manage）',
    description: '提供 `identifier`（email 或 username，對方須已註冊），或傳 `userId`（既有行為）',
  })
  async inviteMember(
    @Req() req: any,
    @Param('workspaceId') id: string,
    @Body() body: { userId?: string; identifier?: string; role?: string },
  ) {
    if (body.identifier && body.identifier.trim()) {
      return this.workspacesService.inviteByIdentifier(
        req.user.userId,
        id,
        body.identifier.trim(),
        body.role,
      );
    }
    if (!body.userId) {
      throw new BadRequestException('必須提供 userId 或 identifier（email / username）');
    }
    return this.workspacesService.inviteMember(req.user.userId, id, body.userId, body.role);
  }

  @Delete(':workspaceId/members/:userId')
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  @ApiOperation({ summary: '移除成員（需 member.manage；owner 只能由 owner 移除）' })
  async removeMember(@Req() req: any, @Param('workspaceId') id: string, @Param('userId') userId: string) {
    const before = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: id, userId } },
      select: { role: true },
    });
    const result = await this.workspacesService.removeMember(req.user.userId, id, userId);
    await this.audit.record({
      actorId: req.user.userId,
      workspaceId: id,
      action: 'workspace.member_remove',
      targetType: 'workspace_member',
      targetId: userId,
      metadata: { removedRole: before?.role },
      req: { ip: req.ip, headers: req.headers },
    });
    return result;
  }

  @Get(':id/members')
  @ApiOperation({ summary: '列出成員與角色' })
  async listMembers(@Req() req: any, @Param('id') id: string) {
    return this.workspacesService.listMembers(req.user.userId, id);
  }

  @Put(':workspaceId/members/:userId/role')
  @RequirePermission(PERMISSIONS.MEMBER_ROLE_MANAGE)
  @ApiOperation({ summary: '更新成員角色（需 member.role.manage；指定或降級 owner 只能由 owner 做）' })
  async updateMemberRole(
    @Req() req: any,
    @Param('workspaceId') id: string,
    @Param('userId') userId: string,
    @Body() body: { role: string },
  ) {
    const before = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: id, userId } },
      select: { role: true },
    });
    const result = await this.workspacesService.updateMemberRole(req.user.userId, id, userId, body.role);
    await this.audit.record({
      actorId: req.user.userId,
      workspaceId: id,
      action: 'workspace.role_change',
      targetType: 'workspace_member',
      targetId: userId,
      metadata: { from: before?.role, to: body.role },
      req: { ip: req.ip, headers: req.headers },
    });
    return result;
  }

  @Post(':workspaceId/owner/transfer')
  @RequirePermission(PERMISSIONS.OWNER_TRANSFER)
  @ApiOperation({
    summary: '移交 owner（僅 owner）',
    description: 'body `{ userId }`：目標成為 owner 並寫入 Workspace.ownerId，呼叫者改為 admin。',
  })
  async transferOwnership(
    @Req() req: any,
    @Param('workspaceId') id: string,
    @Body() body: { userId: string },
  ) {
    const result = await this.workspacesService.transferOwnership(req.user.userId, id, body?.userId);
    await this.audit.record({
      actorId: req.user.userId,
      workspaceId: id,
      action: 'owner.transfer',
      targetType: 'workspace_member',
      targetId: result.ownerId,
      metadata: {
        previousOwnerId: result.previousOwnerId,
        previousTargetRole: result.previousTargetRole,
        actorNewRole: result.actorNewRole,
      },
      req: { ip: req.ip, headers: req.headers },
    });
    return result;
  }
}
