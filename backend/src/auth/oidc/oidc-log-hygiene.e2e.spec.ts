import { FakeIdp } from './testing/fake-idp';
import { COMPANY_WS, newVerifier, SsoHarness } from './testing/sso-harness';

/**
 * H1 驗收：錯誤訊息與 log 裡不含 client secret、code、id_token、token、ticket（spec §6.3）。
 * 跑成功路徑與各種失敗路徑，收下 Nest Logger 與 console 的全部輸出，再逐字比對。
 */
describe('SSO：log 與錯誤訊息不含秘密值', () => {
  const idp = new FakeIdp();
  beforeAll(() => idp.start());
  afterAll(() => idp.stop());

  const expectClean = (h: SsoHarness, extra: string[] = []) => {
    const secrets = [...idp.issued, ...h.secrets, ...extra].filter((s) => typeof s === 'string' && s.length >= 16);
    expect(secrets.length).toBeGreaterThan(5);
    const logs = h.allLogs();
    const audits = JSON.stringify(h.prisma.auditLogs);
    for (const s of secrets) {
      expect(logs.includes(s) ? `log contains ${s.slice(0, 6)}…` : null).toBeNull();
      expect(audits.includes(s) ? `audit contains ${s.slice(0, 6)}…` : null).toBeNull();
    }
  };

  it('成功與失敗路徑都不把秘密值寫進 log／audit／錯誤 body', async () => {
    const h = new SsoHarness(idp);
    h.seedCompany();
    h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'alice@corp.com', employeeNo: 'E001' });
    await h.start();
    const bodies: string[] = [];
    try {
      const alice = { sub: 'sub-alice', email: 'alice@corp.com', email_verified: true };

      // 成功：web 與 mobile，再 refresh 一次
      const ok = await h.login(alice);
      expect(ok.exchange!.status).toBe(201);
      await h.login(alice, 'mobile');
      const refreshed = await h.post('/auth/refresh', { refreshToken: ok.exchange!.body.refreshToken });
      h.secrets.push(refreshed.body.accessToken, refreshed.body.refreshToken);

      // ticket 重用、verifier 不符
      const v = newVerifier();
      const cb = await h.callback(await h.toIdpCallback('web', v, alice));
      bodies.push(JSON.stringify((await h.exchange(cb.ticket!, newVerifier())).body));
      bodies.push(JSON.stringify((await h.exchange(cb.ticket!, v)).body));

      // id_token 被拒：nonce、HS256、過期
      idp.idToken = { nonce: 'wrong' };
      expect((await h.login(alice)).callback.error).toBe('server_error');
      idp.idToken = {};
      idp.signWith = 'hs256';
      expect((await h.login(alice)).callback.error).toBe('server_error');
      idp.signWith = 'rs256';
      const now = Math.floor(Date.now() / 1000);
      idp.idToken = { exp: now - 600, iat: now - 1200 };
      expect((await h.login(alice)).callback.error).toBe('server_error');
      idp.idToken = {};

      // token endpoint 拒絕（code 被竄改）
      const back = new URL(await h.toIdpCallback('web', newVerifier(), alice));
      const forgedCode = `forged-${back.searchParams.get('code')}`;
      back.searchParams.set('code', forgedCode);
      expect((await h.callback(back.toString())).error).toBe('server_error');

      // 不是員工、email 未驗證
      expect((await h.login({ sub: 'sub-x', email: 'x@corp.com' })).callback.error).toBe('not_employee');
      expect((await h.login({ ...alice, email_verified: false })).callback.error).toBe('email_unverified');

      // Redis 停掉（callback 與 exchange）
      const v2 = newVerifier();
      const back2 = await h.toIdpCallback('web', v2, alice);
      h.redis.mode = 'throw';
      expect((await h.callback(back2)).error).toBe('server_error');
      h.redis.mode = 'ok';
      const cb3 = await h.callback(await h.toIdpCallback('web', v2, alice));
      h.redis.mode = 'throw';
      bodies.push(JSON.stringify((await h.exchange(cb3.ticket!, v2)).body));
      h.redis.mode = 'ok';

      // 確認 log 真的有收到東西（否則比對沒有意義）
      const logs = h.allLogs();
      expect(logs).toContain('SSO callback failed');
      expect(logs).toContain('SSO login denied');

      expectClean(h, [forgedCode]);
      for (const b of bodies) {
        for (const s of [...idp.issued, ...h.secrets]) expect(b.includes(s)).toBe(false);
      }
    } finally {
      await h.close();
    }
  });

  it('設定不完整時 callback 回 503：log 不含 query 裡的 code／state', async () => {
    const h = await new SsoHarness(idp, { OIDC_CLIENT_SECRET: undefined }).start();
    try {
      const code = 'Q29kZVNob3VsZE5vdEJlTG9nZ2VkMTIzNDU2';
      const state = 'U3RhdGVTaG91bGROb3RCZUxvZ2dlZDEyMzQ1';
      const res = await h.get(`/auth/oidc/callback?code=${code}&state=${state}`);
      expect(res.status).toBe(503);
      expect(h.allLogs()).toContain('/auth/oidc/callback');
      expect(h.allLogs()).not.toContain(code);
      expect(h.allLogs()).not.toContain(state);
      expect(h.allLogs()).not.toContain(idp.clientSecret);
    } finally {
      await h.close();
    }
  });
});
