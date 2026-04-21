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
import { ROLE_PERMISSIONS } from '../common/permissions';
import { BotAuthGuard } from './bot-auth.guard';
import { BotsService } from './bots.service';

/**
 * 固定的 capability 清單，不依 role 過濾：所有成員共用的基礎能力。
 * 角色限定的 capability（核准報銷、考勤報表等）在 me() 動態合併。
 */
const BASE_CAPABILITIES = [
  { op: 'send_message', method: 'POST', path: '/messages', desc: '在頻道發訊息（同 /bot/messages）' },
  { op: 'broadcast_message', method: 'POST', path: '/messages/broadcast', desc: '一次發多頻道' },
  { op: 'list_channel_messages', method: 'GET', path: '/messages/channel/:channelId', desc: '讀頻道歷史' },
  { op: 'convert_message_to_task', method: 'POST', path: '/messages/:id/convert-to-task', desc: '把訊息轉為任務卡' },
  { op: 'create_task', method: 'POST', path: '/tasks', desc: '建任務（需要是 project 成員）' },
  { op: 'update_task', method: 'PATCH', path: '/tasks/:id', desc: '改任務欄位 / 狀態' },
  { op: 'submit_expense', method: 'POST', path: '/expenses', desc: '送出報銷單' },
  { op: 'check_in', method: 'POST', path: '/attendance/check-in', desc: '打卡上班' },
  { op: 'check_out', method: 'POST', path: '/attendance/check-out', desc: '打卡下班' },
  { op: 'request_leave', method: 'POST', path: '/attendance/leaves', desc: '送請假單' },
  { op: 'create_knowledge_page', method: 'POST', path: '/knowledge/pages', desc: '建文件頁' },
  { op: 'write_knowledge_blocks', method: 'PUT', path: '/knowledge/pages/:id/blocks', desc: '整頁覆寫 block（寫摘要、報告）' },
  { op: 'create_db_row', method: 'POST', path: '/knowledge/databases/:id/rows', desc: '新增一筆資料列（例如記帳）' },
  { op: 'update_db_row', method: 'PUT', path: '/knowledge/rows/:id', desc: '改資料列' },
  { op: 'search_users', method: 'GET', path: '/users/search', desc: '查詢工作空間成員' },
];

const PERMISSION_CAPABILITIES: Record<string, { op: string; method: string; path: string; desc: string }> = {
  'expense.approve': { op: 'approve_expense', method: 'PUT', path: '/expenses/:id/approve', desc: '核准報銷單（bot 不可核准自己送的）' },
  'expense.mark_paid': { op: 'mark_expense_paid', method: 'PUT', path: '/expenses/:id/paid', desc: '標記報銷為已付款' },
  'expense.read_all': { op: 'list_all_expenses', method: 'GET', path: '/expenses/workspace/:workspaceId', desc: '讀所有人的報銷（否則只能讀自己送的）' },
  'leave.approve': { op: 'approve_leave', method: 'PUT', path: '/attendance/leaves/:id/approve', desc: '核准請假' },
  'attendance.report': { op: 'attendance_report', method: 'GET', path: '/attendance/workspace/:workspaceId/report', desc: '考勤月報' },
  'member.manage': { op: 'manage_members', method: 'PUT', path: '/workspaces/:id/members/:userId/role', desc: '改成員角色 / 移除成員' },
  'workspace.manage': { op: 'manage_workspace', method: 'PUT', path: '/workspaces/:id', desc: '改工作空間設定' },
};

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
  @ApiOperation({
    summary: '驗證 token 並回傳 bot 資訊 + 可用能力清單',
    description:
      '回傳 bot 自己的 user/workspace、目前 role、可加入的頻道清單，以及根據 role 展開的 capability hints（給 LLM-powered bot 拿去當 tools 清單用）',
  })
  async me(@Req() req: any) {
    const ctx = await this.bots.getContext(req.bot.botId);
    if (!ctx) throw new NotFoundException();

    // 撈 role（bot 的 WorkspaceMember 一定存在，是建立時塞的）
    const member = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        },
      },
      select: { role: true },
    });
    const role = member?.role ?? 'member';

    // role → permissions → 額外 capability
    const rolePerms = ROLE_PERMISSIONS[role] ?? [];
    const hasAll = rolePerms.includes('*');
    const extraCaps = Object.entries(PERMISSION_CAPABILITIES)
      .filter(([permKey]) => hasAll || rolePerms.includes(permKey))
      .map(([, cap]) => cap);

    const channels = await this.prisma.channel.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        members: { some: { userId: ctx.userId } },
      },
      select: { id: true, name: true, type: true, workspaceId: true },
      orderBy: { name: 'asc' },
    });

    return {
      ...ctx,
      role,
      channels,
      /**
       * 這個欄位是給程式 / LLM 自我介紹用 —— 列出 bot **以目前 role** 可以
       * 呼叫的主要 API 端點。不是權威白名單（server 的 ACL / permissions
       * guard 才是），但足夠讓龍蝦開機時一次把 system prompt 生成出來。
       */
      capabilities: [...BASE_CAPABILITIES, ...extraCaps],
      apiSpec: {
        /** 完整 OpenAPI 3 spec；想讓 bot 自動學所有 endpoint 時 GET 這條 */
        openapiJson: '/api/docs-json',
        swaggerUi: '/api/docs',
        note: '所有 mutation endpoint 都接 bot token；role 以外的限制會以 403 回。',
      },
    };
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
