import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsBoolean,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RECURRENCE_RULES } from '../../common/recurrence';

export class UpdateTaskDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, enum: ['urgent', 'high', 'medium', 'low'] })
  @IsOptional()
  @IsIn(['urgent', 'high', 'medium', 'low'])
  priority?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @ApiProperty({ required: false, enum: RECURRENCE_RULES })
  @IsOptional()
  @IsIn(RECURRENCE_RULES as unknown as string[])
  recurrence?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  recurrenceInterval?: number;
}
