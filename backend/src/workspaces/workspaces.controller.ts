import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Req, Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';

@ApiTags('工作空間')
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
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

  @Put(':id')
  @ApiOperation({ summary: '更新工作空間' })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspacesService.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除工作空間' })
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.workspacesService.delete(req.user.userId, id);
  }

  @Post(':id/members')
  @ApiOperation({ summary: '邀請成員' })
  async inviteMember(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId: string; role?: string },
  ) {
    return this.workspacesService.inviteMember(req.user.userId, id, body.userId, body.role);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: '移除成員' })
  async removeMember(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
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

  @Put(':id/members/:userId/role')
  @ApiOperation({ summary: '更新成員角色（admin / hr / finance / member）' })
  async updateMemberRole(
    @Req() req: any,
    @Param('id') id: string,
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
}
