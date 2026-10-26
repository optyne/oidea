import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma.module';
import { CompanyModule } from '../company/company.module';
import { AuditService } from '../audit/audit.service';
import { EmployeesService } from '../employees/employees.service';
import { CompanyInitService } from '../company/company-init.service';
import { BreakGlassPasswordService } from '../auth/break-glass-password.service';

/**
 * CLI 用的最小 Nest context：只有 DB、audit 與 CLI 需要的 service，
 * 不載入 HTTP、Redis、排程、gateway。
 */
@Module({
  imports: [PrismaModule, CompanyModule],
  providers: [AuditService, EmployeesService, CompanyInitService, BreakGlassPasswordService],
})
export class CliModule {}
