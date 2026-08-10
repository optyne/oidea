import { IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RescheduleTaskDto {
  @ApiProperty({ required: false, description: '新 dueDate（ISO）；null/省略 = 清除日期' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
