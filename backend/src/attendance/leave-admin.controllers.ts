import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyPermissionGuard } from '../company/company-permission.guard';
import { RequirePermission } from '../common/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions';
import { LeavePolicyService } from './leave-policy.service';
import { LeaveAdjustmentDto, ReplaceHolidaysDto } from './dto/leave-request.dto';

/** `CompanyPermissionGuard` 放進 req 的公司工作空間 id。 */
const ws = (req: any): string => req.company.workspaceId;
const actor = (req: any): string => req.user.userId;

/** H3 假日後台（公司工作空間，需要 leave.policy.manage：owner、hr）。 */
@ApiTags('後台：請假規則')
@Controller('admin/holidays')
@UseGuards(JwtAuthGuard, CompanyPermissionGuard)
@ApiBearerAuth()
export class AdminHolidaysController {
  constructor(private readonly policy: LeavePolicyService) {}

  @Get()
  @RequirePermission(PERMISSIONS.LEAVE_POLICY_MANAGE)
  @ApiOperation({ summary: '某一年的假日（依日期排序）' })
  list(@Req() req: any, @Query('year') year: string) {
    return this.policy.listHolidays(ws(req), year);
  }

  @Put(':year')
  @RequirePermission(PERMISSIONS.LEAVE_POLICY_MANAGE)
  @ApiOperation({ summary: '整年取代假日清單（一個交易）' })
  replace(@Req() req: any, @Param('year') year: string, @Body() body: ReplaceHolidaysDto) {
    return this.policy.replaceHolidays(actor(req), ws(req), year, body.items, req);
  }
}

/** H3 員工特休餘額後台。路徑掛在 /admin/employees/:id 底下，跟員工主檔同一個資源。 */
@ApiTags('後台：請假規則')
@Controller('admin/employees')
@UseGuards(JwtAuthGuard, CompanyPermissionGuard)
@ApiBearerAuth()
export class AdminLeaveBalanceController {
  constructor(private readonly policy: LeavePolicyService) {}

  @Get(':id/leave-balance')
  @RequirePermission(PERMISSIONS.LEAVE_POLICY_MANAGE)
  @ApiOperation({ summary: '員工的特休：目前與上一個期間、所有調整' })
  balance(@Req() req: any, @Param('id') id: string) {
    return this.policy.employeeBalance(ws(req), id);
  }

  @Post(':id/leave-balance/adjustments')
  @RequirePermission(PERMISSIONS.LEAVE_POLICY_MANAGE)
  @ApiOperation({ summary: '加一筆特休調整（+/-）' })
  adjust(@Req() req: any, @Param('id') id: string, @Body() body: LeaveAdjustmentDto) {
    return this.policy.addAdjustment(actor(req), ws(req), id, body, req);
  }
}
