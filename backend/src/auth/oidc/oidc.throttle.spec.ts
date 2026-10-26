import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { OidcController } from './oidc.controller';
import { OidcFlowService } from './oidc-flow.service';

/** SSO 三個端點：每 IP 每分鐘 60 次（限流設定與 app.module.ts 相同）。 */
describe('SSO 端點速率限制', () => {
  let app: INestApplication;
  let base: string;

  beforeEach(async () => {
    const flow = {
      start: jest.fn(async () => 'https://idp.example/authorize'),
      callback: jest.fn(async () => 'https://app.example/auth/callback#error=invalid_state'),
      exchange: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', user: { id: 'u', email: 'e' } })),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'short', ttl: 1000, limit: 20 },
          { name: 'default', ttl: 60_000, limit: 120 },
        ]),
      ],
      controllers: [OidcController],
      providers: [{ provide: OidcFlowService, useValue: flow }, { provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });
  afterEach(async () => {
    await app.close();
  });

  // 每批 15 個（低於 short 的 20/秒），批與批之間等 1 秒
  const burst = async (send: () => Promise<number>, total: number) => {
    const statuses: number[] = [];
    while (statuses.length < total) {
      const n = Math.min(15, total - statuses.length);
      for (let i = 0; i < n; i++) statuses.push(await send());
      if (statuses.length < total) await new Promise((r) => setTimeout(r, 1050));
    }
    return statuses;
  };

  it('start：60 次以內 302，第 61 次 429', async () => {
    const statuses = await burst(
      () => fetch(`${base}/auth/oidc/start?client=web&app_challenge=x`, { redirect: 'manual' }).then((r) => r.status),
      61,
    );
    expect(statuses.slice(0, 60).every((s) => s === 302)).toBe(true);
    expect(statuses[60]).toBe(429);
  }, 20_000);

  it('exchange：60 次以內 201，第 61 次 429；start 的額度另外算', async () => {
    const statuses = await burst(
      () =>
        fetch(`${base}/auth/oidc/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket: 't', app_verifier: 'v' }),
        }).then((r) => r.status),
      61,
    );
    expect(statuses.slice(0, 60).every((s) => s === 201)).toBe(true);
    expect(statuses[60]).toBe(429);
    const start = await fetch(`${base}/auth/oidc/start?client=web&app_challenge=x`, { redirect: 'manual' });
    expect(start.status).toBe(302);
  }, 20_000);
});
