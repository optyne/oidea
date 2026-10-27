import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** `POST /auth/refresh` 與 `POST /auth/logout` 的 body。 */
export class RefreshTokenDto {
  @ApiProperty({ description: '登入或上次 refresh 拿到的 refreshToken（不透明字串）' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  refreshToken: string;
}
