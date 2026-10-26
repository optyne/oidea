import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';

/** 員工主檔。H1 只有 service（CLI 匯入用）；H2 會在這裡加後台 controller。 */
@Module({
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
