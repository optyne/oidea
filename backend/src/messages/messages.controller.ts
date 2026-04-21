import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { BroadcastMessageDto } from './dto/broadcast-message.dto';
import { ConvertMessageToTaskDto } from './dto/convert-to-task.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('訊息')
@Controller('messages')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post()
  @ApiOperation({ summary: '發送訊息' })
  async create(@Req() req: any, @Body() dto: CreateMessageDto) {
    return this.messagesService.create(req.user.userId, dto);
  }

  @Post('broadcast')
  @ApiOperation({ summary: 'C-16 跨頻道廣播 (一次發到多個頻道)' })
  async broadcast(@Req() req: any, @Body() dto: BroadcastMessageDto) {
    return this.messagesService.broadcast(req.user.userId, dto);
  }

  @Post(':id/convert-to-task')
  @ApiOperation({ summary: 'C-18 將訊息轉為任務' })
  async convertToTask(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ConvertMessageToTaskDto,
  ) {
    return this.messagesService.convertToTask(req.user.userId, id, dto);
  }

  @Get('channel/:channelId')
  @ApiOperation({ summary: '取得頻道訊息列表' })
  async findByChannel(
    @Req() req: any,
    @Param('channelId') channelId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messagesService.findByChannel(
      req.user.userId, channelId, cursor, limit ? parseInt(limit) : undefined,
    );
  }

  @Get('thread/:parentId')
  @ApiOperation({ summary: '取得討論串訊息' })
  async findThread(
    @Req() req: any,
    @Param('parentId') parentId: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.messagesService.findThread(req.user.userId, parentId, cursor);
  }

  @Put(':id')
  @ApiOperation({ summary: '編輯訊息' })
  async update(@Req() req: any, @Param('id') id: string, @Body() body: { content: string }) {
    return this.messagesService.update(req.user.userId, id, body.content);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除訊息' })
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.messagesService.delete(req.user.userId, id);
  }

  @Post(':id/reactions')
  @ApiOperation({ summary: '新增表情反應' })
  async addReaction(@Req() req: any, @Param('id') id: string, @Body() body: { emoji: string }) {
    return this.messagesService.addReaction(req.user.userId, id, body.emoji);
  }

  @Delete(':id/reactions/:emoji')
  @ApiOperation({ summary: '移除表情反應' })
  async removeReaction(@Req() req: any, @Param('id') id: string, @Param('emoji') emoji: string) {
    return this.messagesService.removeReaction(req.user.userId, id, emoji);
  }

  @Get('search/:channelId')
  @ApiOperation({ summary: '搜尋訊息' })
  async search(@Req() req: any, @Param('channelId') channelId: string, @Query('q') query: string) {
    return this.messagesService.search(req.user.userId, channelId, query);
  }

  @Put(':id/pin')
  @ApiOperation({ summary: '置頂訊息' })
  async pin(@Req() req: any, @Param('id') id: string) {
    return this.messagesService.pin(req.user.userId, id);
  }

  @Put(':id/unpin')
  @ApiOperation({ summary: '取消置頂' })
  async unpin(@Req() req: any, @Param('id') id: string) {
    return this.messagesService.unpin(req.user.userId, id);
  }

  @Get('channel/:channelId/pinned')
  @ApiOperation({ summary: '取得頻道置頂訊息' })
  async findPinned(@Req() req: any, @Param('channelId') channelId: string) {
    return this.messagesService.findPinned(req.user.userId, channelId);
  }
}
