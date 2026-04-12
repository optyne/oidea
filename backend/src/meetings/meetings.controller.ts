import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MeetingsService } from './meetings.service';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('會議')
@Controller('meetings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MeetingsController {
  constructor(private meetingsService: MeetingsService) {}

  @Post()
  @ApiOperation({ summary: '建立會議' })
  async create(@Req() req: any, @Body() dto: CreateMeetingDto) {
    return this.meetingsService.create(req.user.userId, dto);
  }

  @Get('workspace/:workspaceId')
  @ApiOperation({ summary: '取得工作空間會議列表' })
  async findByWorkspace(@Req() req: any, @Param('workspaceId') workspaceId: string) {
    return this.meetingsService.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得會議詳情' })
  async findById(@Req() req: any, @Param('id') id: string) {
    return this.meetingsService.findById(req.user.userId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新會議' })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: Partial<CreateMeetingDto>) {
    return this.meetingsService.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除會議' })
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.meetingsService.delete(req.user.userId, id);
  }

  @Post(':id/respond')
  @ApiOperation({ summary: '回覆會議邀請' })
  async respond(@Req() req: any, @Param('id') id: string, @Body() body: { status: string }) {
    return this.meetingsService.respondToInvitation(req.user.userId, id, body.status);
  }

  @Put(':id/notes')
  @ApiOperation({ summary: '更新會議筆記' })
  async updateNotes(@Req() req: any, @Param('id') id: string, @Body() body: { content: any }) {
    return this.meetingsService.updateNotes(req.user.userId, id, body.content);
  }
}
