import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDatabaseDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ example: '合約請款追蹤' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;
}
