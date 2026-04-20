import {
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  IsInt,
  IsObject,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const COLUMN_TYPES = ['text', 'number', 'date', 'select'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export class CreateColumnDto {
  @ApiProperty({ example: '廠商' })
  @IsString()
  @MaxLength(50)
  name: string;

  @ApiProperty({ enum: COLUMN_TYPES, example: 'text' })
  @IsIn(COLUMN_TYPES as unknown as string[])
  type: ColumnType;

  @ApiProperty({
    required: false,
    description: 'select 型別必填：{ choices: [{ id, label, color }] }',
  })
  @IsOptional()
  @IsObject()
  options?: { choices: { id: string; label: string; color?: string }[] };

  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @IsInt()
  position?: number;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}
