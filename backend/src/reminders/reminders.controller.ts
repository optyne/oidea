import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RemindersService } from './reminders.service';
import { CreateReminderDto } from './dto/create-reminder.dto';
import { UpdateReminderDto } from './dto/update-reminder.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('提醒')
@Controller('reminders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class RemindersController {
  constructor(private remindersService: RemindersService) {}

  @Post()
  @ApiOperation({ summary: '建立提醒' })
  create(@Req() req: any, @Body() dto: CreateReminderDto) {
    return this.remindersService.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '取得工作空間提醒列表' })
  findByWorkspace(
    @Req() req: any,
    @Query('workspaceId') workspaceId: string,
    @Query('includeCompleted') includeCompleted?: string,
  ) {
    return this.remindersService.findByWorkspace(req.user.userId, workspaceId, {
      includeCompleted: includeCompleted === 'true',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '取得提醒' })
  findById(@Req() req: any, @Param('id') id: string) {
    return this.remindersService.findById(req.user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新提醒' })
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateReminderDto,
  ) {
    return this.remindersService.update(req.user.userId, id, dto);
  }

  @Post(':id/pause')
  @ApiOperation({ summary: '暫停提醒' })
  pause(@Req() req: any, @Param('id') id: string) {
    return this.remindersService.pause(req.user.userId, id);
  }

  @Post(':id/resume')
  @ApiOperation({ summary: '恢復提醒' })
  resume(@Req() req: any, @Param('id') id: string) {
    return this.remindersService.resume(req.user.userId, id);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: '標記為已完成 (停止循環)' })
  complete(@Req() req: any, @Param('id') id: string) {
    return this.remindersService.complete(req.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '軟刪除提醒' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.remindersService.remove(req.user.userId, id);
  }
}
