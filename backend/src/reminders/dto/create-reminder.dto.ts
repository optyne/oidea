import {
  IsString,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const RECURRENCE_RULES = [
  'none',
  'daily',
  'weekly',
  'monthly',
  'yearly',
] as const;
export type RecurrenceRule = (typeof RECURRENCE_RULES)[number];

export const REMINDER_TARGET_TYPES = ['database_row', 'task'] as const;
export type ReminderTargetType = (typeof REMINDER_TARGET_TYPES)[number];

export class CreateReminderDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ example: 'Cequrex 年度維護費請款' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({
    required: false,
    enum: REMINDER_TARGET_TYPES,
    description: '提醒綁定的實體類型',
  })
  @IsOptional()
  @IsIn(REMINDER_TARGET_TYPES as unknown as string[])
  targetType?: ReminderTargetType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetId?: string;

  @ApiProperty({ example: '2027-04-20T09:00:00Z' })
  @IsDateString()
  triggerAt: string;

  @ApiProperty({
    enum: RECURRENCE_RULES,
    default: 'none',
    required: false,
  })
  @IsOptional()
  @IsIn(RECURRENCE_RULES as unknown as string[])
  recurrence?: RecurrenceRule;

  @ApiProperty({
    required: false,
    default: 1,
    description: '搭配 recurrence，例如 monthly + 3 = 每 3 個月',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  recurrenceInterval?: number;
}
