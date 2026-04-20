import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePageDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiProperty({ required: false, enum: ['page', 'database'], default: 'page' })
  @IsOptional()
  @IsIn(['page', 'database'])
  kind?: string;

  @ApiProperty({ required: false, default: 'Untitled' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  icon?: string;
}
