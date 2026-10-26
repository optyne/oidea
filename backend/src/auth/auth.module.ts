import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';
import { RefreshTokenService } from './refresh-token.service';
import { UserStatusService } from './user-status.service';
import { WsAuthService } from './ws-auth';
import { SocketRegistry } from './socket-registry';
import { Clock, SystemClock } from '../common/clock';

/**
 * 設為 Global：JwtAuthGuard（在各 module 的 controller 上 @UseGuards）需要 UserStatusService，
 * gateway 需要 WsAuthService，H2 離職流程需要 UserStatusService / SocketRegistry / RefreshTokenService。
 */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: {
          // access token 有效期；refresh token 是不透明字串，有效期見 JWT_REFRESH_EXPIRATION
          expiresIn: configService.get('JWT_EXPIRATION', '15m'),
        },
      }),
      inject: [ConfigService],
    }),
    UsersModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    RefreshTokenService,
    UserStatusService,
    WsAuthService,
    SocketRegistry,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [AuthService, RefreshTokenService, UserStatusService, WsAuthService, SocketRegistry, Clock],
})
export class AuthModule {}
