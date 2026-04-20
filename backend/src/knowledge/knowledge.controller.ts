import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { KnowledgeService } from './knowledge.service';

@ApiTags('知識庫')
@Controller('knowledge')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  // ─────────── Pages ───────────

  @Post('pages')
  @ApiOperation({ summary: '建立 Page（或資料庫容器）' })
  createPage(@Req() req: any, @Body() dto: CreatePageDto) {
    return this.knowledge.createPage(req.user.userId, dto);
  }

  @Get('pages/workspace/:workspaceId')
  @ApiOperation({ summary: '列出工作空間所有 Page（供左側樹用）' })
  listPages(@Req() req: any, @Param('workspaceId') workspaceId: string) {
    return this.knowledge.listWorkspacePages(req.user.userId, workspaceId);
  }

  @Get('pages/:id')
  @ApiOperation({ summary: '取得 Page（含 blocks 與 database properties）' })
  getPage(@Req() req: any, @Param('id') id: string) {
    return this.knowledge.getPage(req.user.userId, id);
  }

  @Put('pages/:id')
  @ApiOperation({ summary: '更新 Page 中繼資料（標題／圖示／搬移／封存）' })
  updatePage(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePageDto) {
    return this.knowledge.updatePage(req.user.userId, id, dto);
  }

  @Delete('pages/:id')
  @ApiOperation({ summary: '刪除 Page（軟刪除）' })
  deletePage(@Req() req: any, @Param('id') id: string) {
    return this.knowledge.deletePage(req.user.userId, id);
  }

  // ─────────── Blocks ───────────

  @Get('pages/:pageId/blocks')
  @ApiOperation({ summary: '列出 Page 所有 Block' })
  listBlocks(@Req() req: any, @Param('pageId') pageId: string) {
    return this.knowledge.listBlocks(req.user.userId, pageId);
  }

  @Put('pages/:pageId/blocks')
  @ApiOperation({ summary: '整頁覆蓋 Block 陣列' })
  replaceBlocks(
    @Req() req: any,
    @Param('pageId') pageId: string,
    @Body() body: { blocks: any[] },
  ) {
    return this.knowledge.replaceBlocks(req.user.userId, pageId, body.blocks ?? []);
  }

  // ─────────── Database ───────────

  @Post('databases')
  @ApiOperation({ summary: '建立新資料庫' })
  createDatabase(
    @Req() req: any,
    @Body() body: {
      workspaceId: string;
      parentId?: string;
      title: string;
      icon?: string;
      properties?: Array<{ key: string; name: string; type: string; config?: any }>;
    },
  ) {
    return this.knowledge.createDatabase(req.user.userId, body.workspaceId, body);
  }

  @Post('databases/finance-log')
  @ApiOperation({ summary: '一鍵建立記帳資料庫（附預設欄位）' })
  createFinanceLog(
    @Req() req: any,
    @Body() body: { workspaceId: string; parentId?: string },
  ) {
    return this.knowledge.createFinanceLog(req.user.userId, body.workspaceId, body.parentId);
  }

  @Post('databases/:id/properties')
  @ApiOperation({ summary: '新增欄位定義' })
  addProperty(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { key: string; name: string; type: string; config?: any },
  ) {
    return this.knowledge.addProperty(req.user.userId, id, body);
  }

  @Get('databases/:id/rows')
  @ApiOperation({ summary: '列出資料列' })
  listRows(@Req() req: any, @Param('id') id: string) {
    return this.knowledge.listRows(req.user.userId, id);
  }

  @Post('databases/:id/rows')
  @ApiOperation({ summary: '新增資料列' })
  createRow(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { values: Record<string, any> },
  ) {
    return this.knowledge.createRow(req.user.userId, id, body.values ?? {});
  }

  @Put('rows/:rowId')
  @ApiOperation({ summary: '更新資料列（部分更新）' })
  updateRow(
    @Req() req: any,
    @Param('rowId') rowId: string,
    @Body() body: { values: Record<string, any> },
  ) {
    return this.knowledge.updateRow(req.user.userId, rowId, body.values ?? {});
  }

  @Delete('rows/:rowId')
  @ApiOperation({ summary: '刪除資料列' })
  deleteRow(@Req() req: any, @Param('rowId') rowId: string) {
    return this.knowledge.deleteRow(req.user.userId, rowId);
  }

  @Get('databases/:id/finance-summary')
  @ApiOperation({ summary: '記帳月份彙總（yearMonth=YYYY-MM）' })
  financeSummary(
    @Req() req: any,
    @Param('id') id: string,
    @Query('yearMonth') yearMonth: string,
  ) {
    return this.knowledge.financeSummary(req.user.userId, id, yearMonth);
  }
}
