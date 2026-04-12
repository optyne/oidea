import { IsString, IsOptional, MaxLength, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateChannelDto {
  @ApiProperty({ example: 'general' })
  @IsString()
  @MaxLength(50)
  name: string;

  @ApiProperty({ example: 'public', enum: ['public', 'private', 'dm'] })
  @IsOptional()
  @IsIn(['public', 'private', 'dm'])
  type?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty()
  @IsString()
  workspaceId: string;
}
