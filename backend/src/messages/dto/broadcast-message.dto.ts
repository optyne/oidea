import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * C-16 跨頻道廣播：一次把同樣內容發到多個頻道。
 *
 * 上限 50 個頻道，避免濫用成「群發」。系統會先檢查每個頻道成員身份，
 * 任一不通則整批拒絕。同一批產生的 Message 會共用同一個 broadcastId。
 */
export class BroadcastMessageDto {
  @ApiProperty({
    type: [String],
    example: ['channel-uuid-1', 'channel-uuid-2'],
    description: '目標頻道 ID 陣列，1-50 個；重複會自動去重',
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
}
