import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * C-17：排程訊息建立。
 * 內容會於建立當下 snapshot，不會追隨原本 snippet 的變更。
 */
export class CreateScheduledMessageDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({
    type: [String],
    description: '目標頻道 1-50 個；fire 時會走 C-16 broadcast 驗證',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  channelIds: string[];

  @ApiProperty({ required: false, enum: ['text', 'image', 'file', 'system'] })
  @IsOptional()
  @IsIn(['text', 'image', 'file', 'system'])
  type?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  content?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  metadata?: any;

  @ApiProperty({
    example: '2026-04-25T09:00:00Z',
    description: '必須為未來時間 (UTC)',
  })
  @IsDateString()
  sendAt: string;
}
