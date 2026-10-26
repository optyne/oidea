import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export const DEPARTMENT_NAME_MAX = 100;

export class ListDepartmentsQuery {
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  includeArchived?: boolean;
}

export class CreateDepartmentDto {
  @ApiProperty({ example: '研發部' })
  @IsString()
  @MaxLength(DEPARTMENT_NAME_MAX)
  name!: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerProfileId?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(-100000)
  @Max(100000)
  sortOrder?: number;
}

/** PATCH：任何子集；`parentId: null` = 移到根，`managerProfileId: null` = 清掉主管。 */
export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(DEPARTMENT_NAME_MAX)
  name?: string;

  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(64)
  parentId?: string | null;

  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(64)
  managerProfileId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(-100000)
  @Max(100000)
  sortOrder?: number;
}
