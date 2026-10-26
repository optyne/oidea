import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserStatusService } from '../user-status.service';
import { AuthenticatedUser, isAccessPayload } from '../token-types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly userStatus: UserStatusService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * 只接受 `typ: "access"` 的 token（舊格式沒有 typ 的 token 一律拒絕），
   * 並且每次都檢查使用者是否已停用、token 的 `tv` 是否等於現在的 `User.tokenVersion`（SSO 綁定時 +1，review R1）；
   * 快取 30 秒，miss 或 Redis 出錯就查 DB。
   */
  async validate(payload: unknown): Promise<AuthenticatedUser> {
    if (!isAccessPayload(payload)) {
      throw new UnauthorizedException('Token 類型錯誤');
    }
    const check = await this.userStatus.checkAccessToken(payload.sub, payload.tv);
    if (check === 'disabled') {
      throw new UnauthorizedException('帳號已停用');
    }
    if (check === 'stale') {
      throw new UnauthorizedException('登入已失效，請重新登入');
    }
    return { userId: payload.sub, email: payload.email };
  }
}
