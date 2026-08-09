import { Controller, Get, Post, Put, Patch, Delete, Body, Param, UseGuards, Req, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('白板頁面')
@Controller('whiteboard/:boardId/pages')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WhiteboardPagesController {
  constructor(private pages: WhiteboardPagesService) {}

  @Get()
  @ApiOperation({ summary: '頁面清單（縮圖 URL，不含筆跡）' })
  list(@Req() req: any, @Param('boardId') boardId: string) {
    return this.pages.listPages(req.user.userId, boardId);
  }

  // 注意：reorder 必須排在 :pageId 之前，避免 'reorder' 被當成 pageId 匹配
  @Patch('reorder')
  @ApiOperation({ summary: '以 orderedIds 全量重排頁面' })
  reorder(@Req() req: any, @Param('boardId') boardId: string, @Body() body: { orderedIds: string[] }) {
    return this.pages.reorderPages(req.user.userId, boardId, body?.orderedIds ?? []);
  }

  @Get(':pageId')
  @ApiOperation({ summary: '單頁筆跡（base64）' })
  get(@Req() req: any, @Param('boardId') boardId: string, @Param('pageId') pageId: string) {
    return this.pages.getPage(req.user.userId, boardId, pageId);
  }

  @Post()
  @ApiOperation({ summary: '新增頁（接在最後；format 預設 pencilkit）' })
  create(
    @Req() req: any,
    @Param('boardId') boardId: string,
    @Body() body: { format?: string },
  ) {
    return this.pages.createPage(req.user.userId, boardId, body?.format ?? 'pencilkit');
  }

  @Put(':pageId')
  @ApiOperation({ summary: '存筆跡（可選帶縮圖 PNG，皆 base64）' })
  save(
    @Req() req: any,
    @Param('boardId') boardId: string,
    @Param('pageId') pageId: string,
    @Body() body: { drawing: string; thumbnail?: string },
  ) {
    if (!body?.drawing) throw new BadRequestException('drawing 必填');
    return this.pages.savePage(req.user.userId, boardId, pageId, body.drawing, body?.thumbnail);
  }

  @Delete(':pageId')
  @ApiOperation({ summary: '刪除頁（軟刪除）' })
  remove(@Req() req: any, @Param('boardId') boardId: string, @Param('pageId') pageId: string) {
    return this.pages.deletePage(req.user.userId, boardId, pageId);
  }
}
