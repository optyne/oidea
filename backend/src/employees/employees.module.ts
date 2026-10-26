import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { EmployeeAdminService } from './employee-admin.service';
import { DepartmentsService } from './departments.service';
import { ManagerResolver } from './manager-resolver';
import { AdminDepartmentsController, AdminEmployeesController } from './admin.controllers';
import { CompanyMeController, CompanyMeService } from './company-me.controller';
import { CompanyPermissionGuard } from '../company/company-permission.guard';

/**
 * 員工主檔：H1 的匯入 service（CLI 也用），H2 的後台（`/admin/employees*`、`/admin/departments*`）
 * 與 `/company/me`。UserStatusService、RefreshTokenService、SocketRegistry、Clock 來自全域的 AuthModule。
 */
@Module({
  controllers: [AdminEmployeesController, AdminDepartmentsController, CompanyMeController],
  providers: [
    EmployeesService,
    EmployeeAdminService,
    DepartmentsService,
    ManagerResolver,
    CompanyMeService,
    CompanyPermissionGuard,
  ],
  exports: [EmployeesService, ManagerResolver],
})
export class EmployeesModule {}
