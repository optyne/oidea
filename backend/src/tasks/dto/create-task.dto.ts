import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RECURRENCE_RULES } from '../../common/recurrence';

export class CreateTaskDto {
  @ApiProperty()
  @IsString()
  projectId: string;

  @ApiProperty()
  @IsString()
  columnId: string;

  @ApiProperty({ example: 'Design homepage layout' })
  @IsString()
  title: string;

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

  @ApiProperty({
    required: false,
    enum: RECURRENCE_RULES,
    default: 'none',
    description: 'P-14：任務循環規則；完成時會以 dueDate 為基準產生下一張',
  })
  @IsOptional()
  @IsIn(RECURRENCE_RULES as unknown as string[])
  recurrence?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  recurrenceInterval?: number;
}
