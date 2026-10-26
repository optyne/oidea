import { Controller, Get, Injectable, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../common/permissions';
import { CompanyService } from '../company/company.service';
import { companyNotConfigured } from '../company/company-permission.guard';
import { ManagerResolver } from './manager-resolver';
import { formatDate } from './employee-admin.service';

/** 角色展開成權限 key 清單；owner（`*`）展開成全部 key。 */
export function expandPermissions(role: string | null): string[] {
  if (!role) return [];
  const perms = ROLE_PERMISSIONS[role] ?? [];
  if (perms.includes('*')) return Object.values(PERMISSIONS);
  return [...perms];
}

@Injectable()
export class CompanyMeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
    private readonly managers: ManagerResolver,
  ) {}

  async me(userId: string) {
    const company = await this.company.findCompanyWorkspace();
    if (!company || company.deletedAt) throw companyNotConfigured();

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: company.id, userId } },
      select: { role: true },
    });
    const role = member?.role ?? null;

    const p = await this.prisma.employeeProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        workspaceId: true,
        employeeNo: true,
        email: true,
        fullName: true,
        jobTitle: true,
        employmentType: true,
        employmentStatus: true,
        hireDate: true,
        phone: true,
        departmentId: true,
        managerProfileId: true,
        department: { select: { id: true, name: true } },
      },
    });
    let profile = null;
    if (p && p.workspaceId === company.id) {
      const manager = await this.managers.resolve({
        id: p.id,
        workspaceId: p.workspaceId,
        managerProfileId: p.managerProfileId,
        departmentId: p.departmentId,
      });
      profile = {
        id: p.id,
        employeeNo: p.employeeNo,
        email: p.email,
        fullName: p.fullName,
        jobTitle: p.jobTitle,
        employmentType: p.employmentType,
        employmentStatus: p.employmentStatus,
        hireDate: formatDate(p.hireDate),
        phone: p.phone,
        department: p.department ? { id: p.department.id, name: p.department.name } : null,
        manager: manager ? { id: manager.id, fullName: manager.fullName } : null,
      };
    }
    return { workspaceId: company.id, role, permissions: expandPermissions(role), profile };
  }
}

/**
 * `GET /company/me`：任何登入者都能打。回傳自己在公司工作空間的角色、展開後的權限，以及自己的員工資料
 * （「我的資料」頁與側欄「後台」項目用）。不是公司成員時 role = null、permissions = []。
 */
@ApiTags('公司')
@Controller('company')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CompanyMeController {
  constructor(private readonly service: CompanyMeService) {}

  @Get('me')
  @ApiOperation({ summary: '自己在公司工作空間的角色、權限與員工資料' })
  me(@Req() req: any) {
    return this.service.me(req.user.userId);
  }
}
