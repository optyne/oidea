import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor', 'intern'] as const;
export const EMPLOYMENT_STATUSES = ['active', 'on_leave', 'terminated'] as const;
/** PATCH 只能在這兩個之間切換；terminated 只能經由 terminate 端點（才會執行離職的停用流程）。 */
export const EDITABLE_EMPLOYMENT_STATUSES = ['active', 'on_leave'] as const;

export const EMPLOYEE_FIELD_LIMITS = { employeeNo: 64, email: 254, fullName: 100, jobTitle: 100, phone: 50 } as const;

export class ListEmployeesQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @IsOptional()
  @IsIn(EMPLOYMENT_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class CreateEmployeeDto {
  @ApiProperty({ example: 'E001' })
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.employeeNo)
  employeeNo!: string;

  @ApiProperty({ example: 'a@oadpiz.com' })
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.email)
  email!: string;

  @ApiProperty({ example: '王小明' })
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.fullName)
  fullName!: string;

  @ApiProperty({ example: '2024-03-01' })
  @IsString()
  @MaxLength(10)
  hireDate!: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.jobTitle)
  jobTitle?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerProfileId?: string | null;

  @ApiProperty({ required: false, enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.phone)
  phone?: string;
}

/** PATCH：POST 的任何子集，加上 employmentStatus（active / on_leave）。departmentId、managerProfileId 給 null = 清掉。 */
export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.employeeNo)
  employeeNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.email)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.fullName)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  hireDate?: string;

  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.jobTitle)
  jobTitle?: string;

  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(64)
  managerProfileId?: string | null;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: string;

  @IsOptional()
  @IsIn(EDITABLE_EMPLOYMENT_STATUSES)
  employmentStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_LIMITS.phone)
  phone?: string;
}

export class TerminateEmployeeDto {
  @ApiProperty({ example: '2026-10-31' })
  @IsString()
  @MaxLength(10)
  terminationDate!: string;
}

export class ImportEmployeesDto {
  @ApiProperty({ description: 'CSV 內容（UTF-8，第一行為檔頭，欄位同 CLI），上限 1 MB' })
  @IsString()
  csv!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
