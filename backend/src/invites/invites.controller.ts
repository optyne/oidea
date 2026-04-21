import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InvitesService } from './invites.service';

/**
 * 管理端：僅 workspace admin / owner 可建 / 列 / 撤邀請。
 * 使用者端 peek / accept 走 /invites/:token（另一個 controller）。
 */
@ApiTags('工作空間邀請（管理端）')
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WorkspaceInvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post(':id/invites')
  @ApiOperation({ summary: '建立邀請連結' })
  async create(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { email?: string; role?: string; expiresInDays?: number },
  ) {
    return this.invites.create(req.user.userId, id, body ?? {});
  }

  @Get(':id/invites')
  @ApiOperation({ summary: '列出此工作空間所有有效邀請' })
  async list(@Req() req: any, @Param('id') id: string) {
    return this.invites.listPending(req.user.userId, id);
  }

  @Delete(':id/invites/:inviteId')
  @ApiOperation({ summary: '撤銷邀請（未被兌換者）' })
  async revoke(
    @Req() req: any,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.revoke(req.user.userId, id, inviteId);
  }
}

/**
 * 使用者端：peek 無需登入（給 landing page 顯示資訊）；accept 要登入。
 */
@ApiTags('工作空間邀請（使用者端）')
@Controller('invites')
export class InviteAcceptController {
  constructor(private readonly invites: InvitesService) {}

  @Get(':token')
  @ApiOperation({
    summary: '查看邀請資訊（無需登入）',
    description: 'landing page 用來 render 工作空間名、角色、有效性等',
  })
  async peek(@Param('token') token: string) {
    return this.invites.peek(token);
  }

  @Post(':token/accept')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '接受邀請並加入工作空間（需登入）' })
  async accept(@Req() req: any, @Param('token') token: string) {
    return this.invites.accept(req.user.userId, token);
  }
}
