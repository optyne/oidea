import { IsString, IsOptional, IsDateString, IsArray, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateMeetingDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ example: 'Sprint Planning' })
  @IsString()
  title: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsDateString()
  startTime: string;

  @ApiProperty()
  @IsDateString()
  endTime: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  participantIds?: string[];

  @ApiProperty({ required: false, enum: ['scheduled', 'ongoing', 'completed', 'cancelled'] })
  @IsOptional()
  @IsString()
  @IsIn(['scheduled', 'ongoing', 'completed', 'cancelled'])
  status?: string;
}
