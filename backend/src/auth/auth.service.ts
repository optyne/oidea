import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RegisterDto, LoginDto } from './dto/register.dto';
import { AuditService, AuditRequestContext } from '../audit/audit.service';
import { RefreshTokenService } from './refresh-token.service';
import { ACCESS_TOKEN_TYPE, AccessTokenPayload } from './token-types';
import { AuthConfig, PublicAuthConfig } from '../common/auth-config';
import { CompanyService } from '../company/company.service';

const BAD_CREDENTIALS = '信箱或密碼錯誤';

/**
 * 帳密登入關閉時，register／login 回的 404。所有「關閉」與「緊急登入被拒」的情況都用同一個，
 * 不透露 email 是否在 BREAK_GLASS_OWNER_EMAILS、密碼對不對、是不是 owner。
 */
const passwordLoginNotFound = () => new NotFoundException('Not Found');

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private audit: AuditService,
    private refreshTokens: RefreshTokenService,
    private authConfig: AuthConfig,
    private company: CompanyService,
  ) {}

  /** GET /auth/config：給 Flutter 登入頁決定要顯示哪些登入方式。只有布林值。 */
  publicConfig(): PublicAuthConfig {
    return this.authConfig.publicConfig();
  }

  async register(dto: RegisterDto) {
    // 帳密登入關閉（正式環境預設）時註冊不存在：一律 404，跟緊急登入名單無關
    if (!this.authConfig.passwordLoginEnabled()) throw passwordLoginNotFound();

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

  /**
   * 帳密登入。`AUTH_PASSWORD_LOGIN_ENABLED` 關閉時改走緊急登入（breakGlassLogin），其他人一律 404。
   */
  async login(dto: LoginDto, req?: AuditRequestContext) {
    if (!this.authConfig.passwordLoginEnabled()) return this.breakGlassLogin(dto, req);

    const user = await this.verifyPassword(dto, req);
    if (!user) throw new UnauthorizedException(BAD_CREDENTIALS);

    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      req,
    });
    return this.generateTokens(user.id, user.email);
  }

  /**
   * 緊急登入（spec §4.3 break-glass）：帳密登入關閉時，只有 BREAK_GLASS_OWNER_EMAILS 名單上、
   * 而且是公司工作空間 owner 的帳號能用帳密登入；每次成功都寫 audit `auth.break_glass`。
   * 任何不符合的情況都回同一個 404（跟「帳密登入關閉」一樣）。
   */
  private async breakGlassLogin(dto: LoginDto, req?: AuditRequestContext): Promise<AuthTokens> {
    if (!this.authConfig.isBreakGlassEmail(dto.email)) {
      await this.audit.record({
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'password_login_disabled' },
        req,
      });
      throw passwordLoginNotFound();
    }

    const user = await this.verifyPassword(dto, req);
    if (!user) throw passwordLoginNotFound();

    const company = await this.company.findCompanyOwnership(user.id);
    if (!company) {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'break_glass_not_company_owner' },
        req,
      });
      throw passwordLoginNotFound();
    }

    await this.audit.record({
      actorId: user.id,
      workspaceId: company.id,
      action: 'auth.break_glass',
      targetType: 'user',
      targetId: user.id,
      req,
    });
    this.logger.warn(`緊急登入（break-glass）成功：user ${user.id}`);
    return this.generateTokens(user.id, user.email);
  }

  /**
   * 檢查帳號與密碼；失敗時寫 audit `auth.login_failed` 並回 null（呼叫端決定回 401 或 404）。
   * passwordHash 為 null（只走 SSO 的帳號）一律當成密碼錯誤。
   */
  private async verifyPassword(dto: LoginDto, req?: AuditRequestContext) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      await this.audit.record({
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'user_not_found' },
        req,
      });
      return null;
    }

    if (!user.passwordHash) {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'no_password' },
        req,
      });
      return null;
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'bad_password' },
        req,
      });
      return null;
    }

    // 停用或已刪除的帳號：回跟密碼錯誤一樣的訊息（不透露帳號狀態），不發 refresh token。
    if (user.disabledAt || user.deletedAt) {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: user.deletedAt ? 'deleted' : 'disabled' },
        req,
      });
      return null;
    }
    return user;
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
