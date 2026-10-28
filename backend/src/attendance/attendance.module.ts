import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { LeavePolicyService } from './leave-policy.service';
import { AdminHolidaysController, AdminLeaveBalanceController } from './leave-admin.controllers';
import { CompanyPermissionGuard } from '../company/company-permission.guard';

@Module({
  imports: [NotificationsModule],
  controllers: [AttendanceController, AdminHolidaysController, AdminLeaveBalanceController],
  providers: [AttendanceService, LeavePolicyService, CompanyPermissionGuard],
  exports: [AttendanceService],
})
export class AttendanceModule {}
