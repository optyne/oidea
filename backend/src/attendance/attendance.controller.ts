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
import { AttendanceService } from './attendance.service';
import { CheckInDto } from './dto/check-in.dto';
import { CreateLeaveDto } from './dto/leave-request.dto';

@ApiTags('ERP・考勤')
@Controller('attendance')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('check-in')
  @ApiOperation({ summary: '上班打卡' })
  async checkIn(@Req() req: any, @Body() dto: CheckInDto) {
    return this.attendance.checkIn(req.user.userId, dto);
  }

  @Post('check-out')
  @ApiOperation({ summary: '下班打卡' })
  async checkOut(@Req() req: any, @Body() dto: CheckInDto) {
    return this.attendance.checkOut(req.user.userId, dto);
  }

  @Get('today')
  @ApiOperation({ summary: '今日出勤狀態' })
  async today(@Req() req: any, @Query('workspaceId') workspaceId: string) {
    return this.attendance.getToday(req.user.userId, workspaceId);
  }

  @Get('me')
  @ApiOperation({ summary: '自己的出勤紀錄（from=YYYY-MM-DD & to=YYYY-MM-DD）' })
  async me(
    @Req() req: any,
    @Query('workspaceId') workspaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.attendance.myRange(req.user.userId, workspaceId, from, to);
  }

  @Get('workspace/:workspaceId/report')
  @ApiOperation({ summary: '工作空間出勤報表（需 attendance.report 權限）' })
  async report(
    @Req() req: any,
    @Param('workspaceId') workspaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.attendance.workspaceReport(req.user.userId, workspaceId, from, to);
  }

  // ─────────── 請假 ───────────

  @Post('leaves')
  @ApiOperation({ summary: '申請請假' })
  async createLeave(@Req() req: any, @Body() dto: CreateLeaveDto) {
    return this.attendance.createLeave(req.user.userId, dto);
  }

  @Get('leaves/workspace/:workspaceId')
  @ApiOperation({ summary: '列出工作空間請假（非審核者僅見自己）' })
  async listLeaves(
    @Req() req: any,
    @Param('workspaceId') workspaceId: string,
    @Query('status') status?: string,
  ) {
    return this.attendance.listLeaves(req.user.userId, workspaceId, status);
  }

  @Put('leaves/:id/approve')
  @ApiOperation({ summary: '核准請假' })
  async approveLeave(@Req() req: any, @Param('id') id: string) {
    return this.attendance.decideLeave(req.user.userId, id, 'approved');
  }

  @Put('leaves/:id/reject')
  @ApiOperation({ summary: '退回請假' })
  async rejectLeave(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.attendance.decideLeave(req.user.userId, id, 'rejected', body?.reason);
  }

  @Delete('leaves/:id')
  @ApiOperation({ summary: '取消自己的請假（僅 pending）' })
  async cancelLeave(@Req() req: any, @Param('id') id: string) {
    return this.attendance.cancelLeave(req.user.userId, id);
  }
}
