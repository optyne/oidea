import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RegisterDto, LoginDto } from './dto/register.dto';
import { AuditService, AuditRequestContext } from '../audit/audit.service';
import { RefreshTokenService } from './refresh-token.service';
import { ACCESS_TOKEN_TYPE, AccessTokenPayload } from './token-types';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
}

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private audit: AuditService,
    private refreshTokens: RefreshTokenService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('此信箱已註冊');
    }

    const existingUsername = await this.usersService.findByUsername(dto.username);
    if (existingUsername) {
      throw new ConflictException('此使用者名稱已被使用');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.usersService.create({
      email: dto.email,
      username: dto.username,
      displayName: dto.displayName,
      passwordHash,
    });

    return this.generateTokens(user.id, user.email);
  }

  async login(dto: LoginDto, req?: AuditRequestContext) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      await this.audit.record({
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'user_not_found' },
        req,
      });
      throw new UnauthorizedException('信箱或密碼錯誤');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'bad_password' },
        req,
      });
      throw new UnauthorizedException('信箱或密碼錯誤');
    }

    // 停用或已刪除的帳號：回跟密碼錯誤一樣的訊息（不透露帳號狀態），不發 refresh token。
    if (user.disabledAt || user.deletedAt) {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: user.deletedAt ? 'deleted' : 'disabled' },
        req,
      });
      throw new UnauthorizedException('信箱或密碼錯誤');
    }

    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      req,
    });
    return this.generateTokens(user.id, user.email);
  }

  /**
   * 用 refresh token 換一組新的 token（body 帶 token，不經 JwtAuthGuard）。
   * 換發、寬限期與盜用偵測見 RefreshTokenService.rotate。
   */
  async refresh(refreshToken: string, req?: AuditRequestContext): Promise<AuthTokens> {
    const rotated = await this.refreshTokens.rotate(refreshToken, req);
    return {
      accessToken: this.signAccessToken(rotated.userId, rotated.email),
      refreshToken: rotated.refreshToken,
      user: { id: rotated.userId, email: rotated.email },
    };
  }

  /** 登出：撤銷這個 refresh token 所屬的整個 family。冪等：未知 token 也回 ok。 */
  async logout(refreshToken: string, req?: AuditRequestContext): Promise<{ ok: true }> {
    const revoked = await this.refreshTokens.revokeFamilyOf(refreshToken);
    if (revoked) {
      await this.audit.record({
        actorId: revoked.userId,
        action: 'auth.logout',
        targetType: 'refresh_token_family',
        targetId: revoked.familyId,
        metadata: { revokedCount: revoked.count },
        req,
      });
    }
    return { ok: true };
  }

  async validateUser(userId: string) {
    return this.usersService.findById(userId);
  }

  private signAccessToken(userId: string, email: string): string {
    const payload: AccessTokenPayload = { sub: userId, email, typ: ACCESS_TOKEN_TYPE };
    // 有效期由 JwtModule 的 signOptions（JWT_EXPIRATION，預設 15m）決定
    return this.jwtService.sign(payload);
  }

  private async generateTokens(userId: string, email: string): Promise<AuthTokens> {
    return {
      accessToken: this.signAccessToken(userId, email),
      refreshToken: await this.refreshTokens.issueNewFamily(userId),
      user: { id: userId, email },
    };
  }
}
