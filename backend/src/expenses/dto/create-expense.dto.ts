import { IsString, IsOptional, IsIn, IsNumber, IsDateString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class CreateExpenseDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ example: '7/12 計程車' })
  @IsString()
  title: string;

  @ApiProperty({ example: 350.5 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;

  @ApiProperty({ required: false, example: 'TWD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ required: false, enum: ['travel', 'meal', 'transport', 'office', 'other'] })
  @IsOptional()
  @IsIn(['travel', 'meal', 'transport', 'office', 'other'])
  category?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  incurredAt?: string;
}
