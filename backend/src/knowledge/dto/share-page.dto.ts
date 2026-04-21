import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsBoolean, ValidateIf } from 'class-validator';

export class SharePageDto {
  @ApiPropertyOptional({ description: '被分享的使用者 ID（與 role 擇一）' })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => !o.role)
  userId?: string;

  @ApiPropertyOptional({
    description: '被分享的工作空間角色（與 userId 擇一）',
    enum: ['admin', 'hr', 'finance', 'member'],
  })
  @IsOptional()
  @IsIn(['admin', 'hr', 'finance', 'member'])
  @ValidateIf((o) => !o.userId)
  role?: 'admin' | 'hr' | 'finance' | 'member';

  @ApiProperty({ enum: ['view', 'edit', 'full'], description: '授予的存取層級' })
  @IsIn(['view', 'edit', 'full'])
  access!: 'view' | 'edit' | 'full';
}

export class UpdateVisibilityDto {
  @ApiProperty({
    enum: ['workspace', 'private', 'restricted'],
    description: 'workspace=全體成員預設 edit；private=僅 creator 與明確分享對象；restricted=無預設',
  })
  @IsIn(['workspace', 'private', 'restricted'])
  visibility!: 'workspace' | 'private' | 'restricted';

  @ApiPropertyOptional({ description: '是否繼承父頁權限；預設 true' })
  @IsOptional()
  @IsBoolean()
  inheritParentAcl?: boolean;
}
