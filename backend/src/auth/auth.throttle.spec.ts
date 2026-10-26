import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * S4：全域 ThrottlerGuard 不能讓 /auth/refresh 回 429（客戶端會因此把人登出）；login 的限流照舊。
 * 限流設定與 app.module.ts 的 ThrottlerModule.forRoot 相同。
 */
describe('Auth 端點速率限制', () => {
  let app: INestApplication;
  let base: string;

  beforeEach(async () => {
    const authService = {
      refresh: jest.fn(async () => {
        throw new UnauthorizedException('Refresh token 無效');
      }),
      login: jest.fn(async () => {
        throw new UnauthorizedException('信箱或密碼錯誤');
      }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'short', ttl: 1000, limit: 20 },
          { name: 'default', ttl: 60_000, limit: 120 },
        ]),
      ],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }, { provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.status);

  it('同一 IP 的 refresh 超過 short（20/秒）與 default（120/分）額度也不會 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) statuses.push(await post('/auth/refresh', { refreshToken: `t-${i}` }));
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    expect(new Set(statuses)).toEqual(new Set([401]));
  });

  it('login 仍然每分鐘 5 次', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await post('/auth/login', { email: 'a@example.com', password: 'x' }));
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});
