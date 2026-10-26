import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyPermissionGuard } from '../company/company-permission.guard';
import { RequirePermission } from '../common/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions';
import { EmployeeAdminService } from './employee-admin.service';
import { DepartmentsService } from './departments.service';
import {
  CreateEmployeeDto,
  ImportEmployeesDto,
  ListEmployeesQuery,
  TerminateEmployeeDto,
  UpdateEmployeeDto,
} from './dto/employee-admin.dto';
import { CreateDepartmentDto, ListDepartmentsQuery, UpdateDepartmentDto } from './dto/department.dto';

/** `CompanyPermissionGuard` 放進 req 的公司工作空間 id。 */
const ws = (req: any): string => req.company.workspaceId;
const actor = (req: any): string => req.user.userId;

/**
 * 員工主檔後台（contract：notes/h2-api-contract.md「Employees」）。工作空間一律是公司工作空間，
 * 由 CompanyPermissionGuard 在伺服器端找出；每個 handler 都必須有 @RequirePermission（沒有就 403）。
 */
@ApiTags('後台：員工')
@Controller('admin/employees')
@UseGuards(JwtAuthGuard, CompanyPermissionGuard)
@ApiBearerAuth()
export class AdminEmployeesController {
  constructor(private readonly employees: EmployeeAdminService) {}

  @Get()
  @RequirePermission(PERMISSIONS.EMPLOYEE_READ_ALL)
  @ApiOperation({ summary: '員工名冊（不含 bot）' })
  list(@Req() req: any, @Query() query: ListEmployeesQuery) {
    return this.employees.list(ws(req), query);
  }

  // 寫在 `:id` 之前，`import` 才不會被當成 id
  @Post('import')
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: 'CSV 匯入（欄位同 CLI；dryRun 不寫入）' })
  import(@Req() req: any, @Body() body: ImportEmployeesDto) {
    return this.employees.importCsv(actor(req), ws(req), body, req);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.EMPLOYEE_READ_ALL)
  get(@Req() req: any, @Param('id') id: string) {
    return this.employees.get(ws(req), id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  @ApiOperation({ summary: '新增（預建）員工' })
  create(@Req() req: any, @Body() body: CreateEmployeeDto) {
    return this.employees.create(actor(req), ws(req), body, req);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateEmployeeDto) {
    return this.employees.update(actor(req), ws(req), id, body, req);
  }

  @Post(':id/terminate')
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: '離職：停用帳號、撤銷 token 與 bot、斷開 socket、移出所有工作空間' })
  terminate(@Req() req: any, @Param('id') id: string, @Body() body: TerminateEmployeeDto) {
    return this.employees.terminate(actor(req), ws(req), id, body, req);
  }

  @Post(':id/reinstate')
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  @HttpCode(200)
  reinstate(@Req() req: any, @Param('id') id: string) {
    return this.employees.reinstate(actor(req), ws(req), id, req);
  }

  @Post(':id/unbind')
  @RequirePermission(PERMISSIONS.EMPLOYEE_MANAGE)
  @HttpCode(200)
  @ApiOperation({ summary: '解除 SSO 綁定（sub 改變時用）' })
  unbind(@Req() req: any, @Param('id') id: string) {
    return this.employees.unbind(actor(req), ws(req), id, req);
  }
}

/** 部門後台（contract「Departments」）。 */
@ApiTags('後台：部門')
@Controller('admin/departments')
@UseGuards(JwtAuthGuard, CompanyPermissionGuard)
@ApiBearerAuth()
export class AdminDepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.EMPLOYEE_READ_ALL)
  list(@Req() req: any, @Query() query: ListDepartmentsQuery) {
    return this.departments.list(ws(req), query.includeArchived === true);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DEPARTMENT_MANAGE)
  create(@Req() req: any, @Body() body: CreateDepartmentDto) {
    return this.departments.create(actor(req), ws(req), body, req);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DEPARTMENT_MANAGE)
  update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateDepartmentDto) {
    return this.departments.update(actor(req), ws(req), id, body, req);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.DEPARTMENT_MANAGE)
  @HttpCode(200)
  archive(@Req() req: any, @Param('id') id: string) {
    return this.departments.setArchived(actor(req), ws(req), id, true, req);
  }

  @Post(':id/unarchive')
  @RequirePermission(PERMISSIONS.DEPARTMENT_MANAGE)
  @HttpCode(200)
  unarchive(@Req() req: any, @Param('id') id: string) {
    return this.departments.setArchived(actor(req), ws(req), id, false, req);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.DEPARTMENT_MANAGE)
  remove(@Req() req: any, @Param('id') id: string) {
    return this.departments.remove(actor(req), ws(req), id, req);
  }
}
