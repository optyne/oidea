import { Controller, Get, Post, Delete, Body, Param, UseGuards, Req, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ChannelsService } from './channels.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('頻道')
@Controller('channels')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ChannelsController {
  constructor(private channelsService: ChannelsService) {}

  @Post()
  @ApiOperation({ summary: '建立頻道' })
  async create(@Req() req: any, @Body() dto: CreateChannelDto) {
    return this.channelsService.create(req.user.userId, dto.workspaceId, dto);
  }

  @Get()
  @ApiOperation({ summary: '取得工作空間頻道列表' })
  async findByWorkspace(@Req() req: any, @Query('workspaceId') workspaceId: string) {
    return this.channelsService.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得頻道詳情' })
  async findById(@Req() req: any, @Param('id') id: string) {
    return this.channelsService.findById(req.user.userId, id);
  }

  @Post(':id/join')
  @ApiOperation({ summary: '加入頻道' })
  async join(@Req() req: any, @Param('id') id: string) {
    return this.channelsService.join(req.user.userId, id);
  }

  @Post(':id/leave')
  @ApiOperation({ summary: '離開頻道' })
  async leave(@Req() req: any, @Param('id') id: string) {
    return this.channelsService.leave(req.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除頻道' })
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.channelsService.delete(req.user.userId, id);
  }
}
