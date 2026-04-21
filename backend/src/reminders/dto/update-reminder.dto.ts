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
import {
  RECURRENCE_RULES,
  RecurrenceRule,
} from './create-reminder.dto';

export class UpdateReminderDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  triggerAt?: string;

  @ApiProperty({ required: false, enum: RECURRENCE_RULES })
  @IsOptional()
  @IsIn(RECURRENCE_RULES as unknown as string[])
  recurrence?: RecurrenceRule;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  recurrenceInterval?: number;
}
