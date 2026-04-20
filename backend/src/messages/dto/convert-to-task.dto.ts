import {
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

/**
 * C-18：把訊息直接建成 Task。
 * 預設 title 取訊息 content 前 100 字、description 保留完整內容；
 * 使用者可在 dto 裡覆蓋 title / description 等欄位。
 */
export class ConvertMessageToTaskDto {
  @ApiProperty()
  @IsString()
  projectId: string;

  @ApiProperty()
  @IsString()
  columnId: string;

  @ApiProperty({ required: false, description: '覆蓋預設 title (預設 = 訊息內容前 100 字)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ required: false, description: '覆蓋預設 description (預設 = 訊息完整內容)' })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiProperty({ required: false, enum: TASK_PRIORITIES })
  @IsOptional()
  @IsIn(TASK_PRIORITIES as unknown as string[])
  priority?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
