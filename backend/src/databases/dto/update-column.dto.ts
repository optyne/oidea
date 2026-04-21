import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsObject,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateColumnDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  options?: { choices: { id: string; label: string; color?: string }[] };

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  position?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}
