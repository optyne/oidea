import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { MessagesGateway } from '../messages/messages.gateway';
import { BotAuthGuard } from './bot-auth.guard';
import { BotsService } from './bots.service';

/**
 * 管理端：workspace admin / owner 建立 / 列 / 撤銷 bot。
 */
@ApiTags('Bot 整合（管理端）')
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WorkspaceBotsController {
  constructor(private readonly bots: BotsService) {}

  @Post(':id/bots')
  @ApiOperation({ summary: '建立 bot，回傳一次性 plaintext token' })
  create(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { name: string; description?: string },
  ) {
    return this.bots.create(req.user.userId, id, body ?? ({} as any));
  }

  @Get(':id/bots')
  @ApiOperation({ summary: '列出此工作空間的所有 bot（不含 token）' })
  list(@Req() req: any, @Param('id') id: string) {
    return this.bots.listForWorkspace(req.user.userId, id);
  }

  @Delete(':id/bots/:botId')
  @ApiOperation({ summary: '撤銷 bot；token 立即失效' })
  revoke(
    @Req() req: any,
    @Param('id') id: string,
    @Param('botId') botId: string,
  ) {
    return this.bots.revoke(req.user.userId, id, botId);
  }
}

/**
 * Bot 端：用 bot token 認證，提供基本的「讀頻道、發訊息、查自己」介面。
 * 外部 agent（Claude Code / Python / Node / bash 都行）就是打這批。
 */
@ApiTags('Bot 整合（bot 自身）')
@Controller('bot')
@UseGuards(BotAuthGuard)
@ApiBearerAuth()
export class BotSelfController {
  constructor(
    private readonly bots: BotsService,
    private readonly prisma: PrismaService,
    private readonly messagesGateway: MessagesGateway,
  ) {}

  @Get('me')
  @ApiOperation({ summary: '驗證 token 並回傳 bot 資訊（workspace、user id、可用頻道）' })
  async me(@Req() req: any) {
    const ctx = await this.bots.getContext(req.bot.botId);
    if (!ctx) throw new NotFoundException();
    const channels = await this.prisma.channel.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        members: { some: { userId: ctx.userId } },
      },
      select: { id: true, name: true, type: true, workspaceId: true },
      orderBy: { name: 'asc' },
    });
    return { ...ctx, channels };
  }

  @Get('channels/:channelId/messages')
  @ApiOperation({
    summary: '拉某頻道的歷史訊息，可 polling',
    description: '查詢參數 after=ISO 時間，只回傳該時間之後的訊息（包含該秒）。limit 預設 50，最大 200。',
  })
  async messages(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    await this.assertBotInChannel(req.bot.userId, channelId);

    const take = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const where: any = { channelId, deletedAt: null };
    if (after) {
      const d = new Date(after);
      if (!isNaN(d.getTime())) where.createdAt = { gt: d };
    }
    const rows = await this.prisma.message.findMany({
      where,
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
      take,
    });
    return rows;
  }

  @Post('messages')
  @ApiOperation({ summary: '以 bot 身份發訊息到某頻道' })
  async send(
    @Req() req: any,
    @Body() body: { channelId: string; content: string; parentId?: string; metadata?: any },
  ) {
    if (!body?.channelId) throw new NotFoundException('channelId 必填');
    const content = (body.content ?? '').toString();
    if (!content.trim()) throw new NotFoundException('content 不能為空');

    await this.assertBotInChannel(req.bot.userId, body.channelId);

    const message = await this.prisma.message.create({
      data: {
        channelId: body.channelId,
        senderId: req.bot.userId,
        parentId: body.parentId,
        type: 'text',
        content,
        metadata: body.metadata,
      },
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        reactions: true,
        _count: { select: { replies: true } },
      },
    });
    this.messagesGateway.emitNewMessage(body.channelId, message);
    return message;
  }

  private async assertBotInChannel(botUserId: string, channelId: string) {
    const m = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: botUserId } },
    });
    if (!m) {
      throw new ForbiddenException('Bot 不是此頻道成員；請管理員手動加入');
    }
  }
}
