import { Controller, Post, Body, Req, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { Public } from './decorators/public.decorator';

@ApiTags('認證')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: '使用者註冊（每分鐘上限 10 次）' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: '使用者登入（每分鐘上限 5 次／IP，防暴力破解）' })
  async login(@Body() dto: LoginDto, @Req() req: any) {
    return this.authService.login(dto, { ip: req.ip, headers: req.headers });
  }

  /**
   * 用 body 的 refreshToken 換一組新的 token。**不掛** JwtAuthGuard：
   * access token 過期時才需要 refresh，而 refresh token 不能當 Bearer 用。
   */
  @Post('refresh')
  @Public()
  @ApiOperation({ summary: '刷新 Token（body 帶 refreshToken，每次換發新的一組）' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: any) {
    return this.authService.refresh(dto.refreshToken, { ip: req.ip, headers: req.headers });
  }

  /** 撤銷這個 refresh token 所屬的整個 family（這次登入的所有 token）。冪等。 */
  @Post('logout')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: '登出（撤銷這次登入的 refresh token）' })
  async logout(@Body() dto: RefreshTokenDto, @Req() req: any) {
    return this.authService.logout(dto.refreshToken, { ip: req.ip, headers: req.headers });
  }
}
