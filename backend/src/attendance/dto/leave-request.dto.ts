import { IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const LEAVE_TYPES = ['sick', 'annual', 'personal', 'unpaid', 'other'];

/** GET /attendance/leaves/preview 的 query：跟建立同樣的欄位（沒有 reason）。 */
export class LeavePreviewQuery {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ enum: LEAVE_TYPES })
  @IsIn(LEAVE_TYPES)
  type: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ required: false, enum: ['full', 'pm'], description: '起始日：full 整天、pm 只請下午' })
  @IsOptional()
  @IsIn(['full', 'pm'])
  startPart?: string;

  @ApiProperty({ required: false, enum: ['full', 'am'], description: '結束日：full 整天、am 只請上午' })
  @IsOptional()
  @IsIn(['full', 'am'])
  endPart?: string;
}

/** PUT /admin/holidays/:year；每筆 { date, name } 由 service 驗證（錯誤一律 holiday_invalid）。 */
export class ReplaceHolidaysDto {
  @ApiProperty({ description: '[{ date: YYYY-MM-DD, name }]，最多 60 筆' })
  @IsArray()
  items: unknown[];
}

/** POST /admin/employees/:id/leave-balance/adjustments；內容由 service 驗證（leave_adjustment_invalid）。 */
export class LeaveAdjustmentDto {
  @ApiProperty({ description: '特休期間起始日 YYYY-MM-DD' })
  @IsString()
  periodStart: string;

  @ApiProperty({ description: '正負都可、不為 0、0.5 的倍數' })
  @IsNumber()
  days: number;

  @ApiProperty()
  @IsString()
  reason: string;
}

export class CreateLeaveDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ enum: ['sick', 'annual', 'personal', 'unpaid', 'other'] })
  @IsIn(['sick', 'annual', 'personal', 'unpaid', 'other'])
  type: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ required: false, enum: ['full', 'pm'], description: '起始日：full 整天（預設）、pm 只請下午' })
  @IsOptional()
  @IsIn(['full', 'pm'])
  startPart?: string;

  @ApiProperty({ required: false, enum: ['full', 'am'], description: '結束日：full 整天（預設）、am 只請上午' })
  @IsOptional()
  @IsIn(['full', 'am'])
  endPart?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
