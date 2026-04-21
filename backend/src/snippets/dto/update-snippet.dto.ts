import {
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  SNIPPET_VISIBILITY,
  SnippetVisibility,
} from './create-snippet.dto';

export class UpdateSnippetDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^\/[a-z0-9][a-z0-9-]*$/i, {
    message: 'shortcut 需以 / 開頭，僅允許英數與 dash',
  })
  shortcut?: string;

  @ApiProperty({ required: false, enum: SNIPPET_VISIBILITY })
  @IsOptional()
  @IsIn(SNIPPET_VISIBILITY as unknown as string[])
  visibility?: SnippetVisibility;
}
