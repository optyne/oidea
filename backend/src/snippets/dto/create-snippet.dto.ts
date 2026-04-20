import {
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const SNIPPET_VISIBILITY = ['personal', 'workspace'] as const;
export type SnippetVisibility = (typeof SNIPPET_VISIBILITY)[number];

export class CreateSnippetDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ example: '月底結算公告' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '各組長好，本月結算將於 ...' })
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content: string;

  @ApiProperty({
    required: false,
    example: '/billing-notice',
    description: '選填，斜線 + 英數字 / dash，給自動完成用',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^\/[a-z0-9][a-z0-9-]*$/i, {
    message: 'shortcut 需以 / 開頭，僅允許英數與 dash',
  })
  shortcut?: string;

  @ApiProperty({
    enum: SNIPPET_VISIBILITY,
    default: 'personal',
    required: false,
  })
  @IsOptional()
  @IsIn(SNIPPET_VISIBILITY as unknown as string[])
  visibility?: SnippetVisibility;
}
