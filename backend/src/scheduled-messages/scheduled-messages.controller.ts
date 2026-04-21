import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { CreateScheduledMessageDto } from './dto/create-scheduled-message.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('排程訊息')
@Controller('scheduled-messages')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ScheduledMessagesController {
  constructor(private scheduled: ScheduledMessagesService) {}

  @Post()
  @ApiOperation({ summary: '建立排程訊息' })
  create(@Req() req: any, @Body() dto: CreateScheduledMessageDto) {
    return this.scheduled.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '取得工作空間排程訊息 (預設只看 pending)' })
  findByWorkspace(
    @Req() req: any,
    @Query('workspaceId') workspaceId: string,
    @Query('includeHistory') includeHistory?: string,
  ) {
    return this.scheduled.findByWorkspace(req.user.userId, workspaceId, {
      includeHistory: includeHistory === 'true',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '取得排程訊息詳情' })
  findById(@Req() req: any, @Param('id') id: string) {
    return this.scheduled.findById(req.user.userId, id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: '取消 pending 排程 (僅建立者)' })
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.scheduled.cancel(req.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '軟刪除 (僅建立者)' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.scheduled.remove(req.user.userId, id);
  }
}
