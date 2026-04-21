import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
