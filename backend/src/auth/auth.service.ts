import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RegisterDto, LoginDto } from './dto/register.dto';
import { AuditService, AuditRequestContext } from '../audit/audit.service';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private audit: AuditService,
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

    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      req,
    });
    return this.generateTokens(user.id, user.email);
  }

  async refreshToken(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('使用者不存在');
    }
    return this.generateTokens(user.id, user.email);
  }

  async validateUser(userId: string) {
    return this.usersService.findById(userId);
  }

  private generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRATION', '7d'),
    });

    return {
      accessToken,
      refreshToken,
      user: { id: userId, email },
    };
  }
}
