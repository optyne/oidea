import { FakeIdp } from './testing/fake-idp';
import { challengeOf, COMPANY_WS, newVerifier, SsoHarness } from './testing/sso-harness';
import { OIDC_TICKET_TTL_SECONDS } from './oidc-flow.service';

/**
 * H1 驗收：假的 OIDC 伺服器（JWKS＋RS256）跑通 start → callback → exchange，
 * 以及每一種該被拒絕的情況（spec §5 H1 驗收條件）。
 */
describe('SSO（OIDC）登入流程 — 端到端', () => {
  const idp = new FakeIdp();
  let h: SsoHarness;

  beforeAll(async () => {
    await idp.start();
  });
  afterAll(async () => {
    await idp.stop();
  });

  beforeEach(async () => {
    idp.idToken = {};
    idp.signWith = 'rs256';
    idp.failDiscovery = false;
    idp.denyAuthorize = false;
    h = new SsoHarness(idp);
    h.seedCompany();
    h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'alice@corp.com', employeeNo: 'E001', fullName: '王小美' });
    await h.start();
  });
  afterEach(async () => {
    await h.close();
  });

  const alice = { sub: 'sub-alice', email: 'alice@corp.com', email_verified: true, name: 'Alice' };

  it('跑通 start → IdP → callback → exchange（web），callback 回應不洩漏 ticket', async () => {
    const verifier = newVerifier();
    const start = await h.start302('web', challengeOf(verifier));
    expect(start.status).toBe(302);
    const authorize = new URL(start.location);
    expect(authorize.origin + authorize.pathname).toBe(`${idp.issuer}authorize/`);
    expect(authorize.searchParams.get('client_id')).toBe(idp.clientId);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toBe('openid email profile');
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    // 給 IdP 的 PKCE challenge 是後端自己的，不是 App 的 app_challenge
    expect(authorize.searchParams.get('code_challenge')).not.toBe(challengeOf(verifier));
    expect(start.location).not.toContain(idp.clientSecret);

    const cb = await h.callback(await h.toIdpCallback('web', verifier, alice));
    expect(cb.error).toBeUndefined();
    expect(cb.location.startsWith('https://app.example/auth/callback#ticket=')).toBe(true);
    expect(new URL(cb.location).search).toBe('');
    expect(cb.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    expect(cb.headers.get('cache-control')).toBe('no-store');

    // token endpoint 收到的是 client_secret_basic + PKCE verifier
    const tokenReq = idp.tokenRequests.at(-1)!;
    expect(tokenReq.get('code_verifier')).toBeTruthy();
    expect(tokenReq.get('client_secret')).toBeNull();

    const ex = await h.exchange(cb.ticket!, verifier);
    expect(ex.status).toBe(201);
    expect(Object.keys(ex.body).sort()).toEqual(['accessToken', 'refreshToken', 'user']);
    const user = h.prisma.users.find((u) => u.email === 'alice@corp.com')!;
    expect(ex.body.user).toEqual({ id: user.id, email: 'alice@corp.com' });
    expect(ex.headers.get('cache-control')).toBe('no-store');

    // refresh token 是正常的一組（可換發）
    const refreshed = await h.post('/auth/refresh', { refreshToken: ex.body.refreshToken });
    expect(refreshed.status).toBe(201);
    expect(h.audits('auth.login')).toEqual([
      expect.objectContaining({ actorId: user.id, metadata: { method: 'sso' } }),
    ]);
  });

  it('mobile：302 到 oidea://auth?ticket=…，exchange 成功', async () => {
    const res = await h.login(alice, 'mobile');
    expect(res.callback.location.startsWith('oidea://auth?ticket=')).toBe(true);
    expect(new URL(res.callback.location).hash).toBe('');
    expect(res.exchange!.status).toBe(201);
  });

  it('mobile 的錯誤走 ?error=', async () => {
    const res = await h.login({ ...alice, email: 'nobody@corp.com', sub: 'sub-nobody' }, 'mobile');
    expect(res.callback.location).toBe('oidea://auth?error=not_employee');
  });

  describe('start 的參數與開關', () => {
    it.each([
      ['client 缺少', `app_challenge=${'a'.repeat(43)}`],
      ['client 不認得', `client=desktop&app_challenge=${'a'.repeat(43)}`],
      ['app_challenge 缺少', 'client=web'],
      ['app_challenge 太短', `client=web&app_challenge=${'a'.repeat(42)}`],
      ['app_challenge 有 padding', `client=web&app_challenge=${'a'.repeat(42)}=`],
      ['app_challenge 不是 base64url', `client=web&app_challenge=${'a'.repeat(42)}+`],
    ])('%s → 400', async (_name, qs) => {
      const res = await h.get(`/auth/oidc/start?${qs}`);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_request');
      expect(h.redis.store.size).toBe(0);
    });

    it('state 存 Redis 10 分鐘，綁 client 與 app_challenge', async () => {
      const challenge = challengeOf(newVerifier());
      await h.start302('mobile', challenge);
      const [key] = [...h.redis.store.keys()];
      expect(key).toMatch(/^oidc:state:/);
      expect(h.redis.set).toHaveBeenCalledWith(key, expect.any(String), 600);
      const stored = JSON.parse(h.redis.store.get(key)!);
      expect(stored).toMatchObject({ client: 'mobile', appChallenge: challenge });
    });

    it('IdP discovery 失敗 → 302 回 App，error=server_error（不 crash）', async () => {
      idp.failDiscovery = true;
      const res = await h.start302('web', challengeOf(newVerifier()));
      expect(res.status).toBe(302);
      expect(res.location).toBe('https://app.example/auth/callback#error=server_error');
    });

    it('GET /auth/config 帶 IdP 的 end_session_endpoint', async () => {
      const body = await (await h.get('/auth/config')).json();
      expect(body).toEqual({ sso: true, passwordLogin: true, endSessionUrl: idp.endSessionEndpoint });
    });
  });

  describe('id_token 與 state 的驗證（每一條都要被拒）', () => {
    const expectRejected = async (expected: string, logDetail?: string) => {
      const before = h.prisma.counts();
      const res = await h.login(alice);
      expect(res.callback.error).toBe(expected);
      if (logDetail) expect(h.allLogs()).toContain(logDetail);
      expect(res.callback.ticket).toBeUndefined();
      expect(h.prisma.counts()).toEqual(before);
      expect([...h.redis.store.keys()].filter((k) => k.startsWith('oidc:ticket:'))).toHaveLength(0);
    };

    it('竄改 state → invalid_state（回 web callback）', async () => {
      const verifier = newVerifier();
      const back = new URL(await h.toIdpCallback('web', verifier, alice));
      const state = back.searchParams.get('state')!;
      back.searchParams.set('state', state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA'));
      const cb = await h.callback(back.toString());
      expect(cb.location).toBe('https://app.example/auth/callback#error=invalid_state');
      expect(h.prisma.users.some((u) => u.email === 'alice@corp.com')).toBe(false);
    });

    it('state 只能用一次（重送同一個 callback → invalid_state）', async () => {
      const back = await h.toIdpCallback('web', newVerifier(), alice);
      expect((await h.callback(back)).ticket).toBeDefined();
      expect((await h.callback(back)).error).toBe('invalid_state');
    });

    it('state 超過 10 分鐘 → expired', async () => {
      const back = await h.toIdpCallback('mobile', newVerifier(), alice);
      h.clock.advance(10 * 60_000 + 1);
      expect((await h.callback(back)).location).toBe('oidea://auth?error=expired');
    });

    it('nonce 不符 → server_error', async () => {
      idp.idToken = { nonce: 'not-the-nonce' };
      await expectRejected('server_error', 'claim=nonce');
    });

    it('id_token 沒有 nonce → server_error', async () => {
      idp.idToken = { nonce: undefined };
      await expectRejected('server_error', '"nonce" (nonce) claim missing');
    });

    it('aud 錯誤 → server_error', async () => {
      idp.idToken = { aud: 'some-other-client' };
      await expectRejected('server_error', 'claim=aud');
    });

    it('iss 錯誤 → server_error', async () => {
      idp.idToken = { iss: 'https://evil.example/' };
      await expectRejected('server_error', 'claim=iss');
    });

    it('HS256 簽的 id_token（用 client secret 簽）→ server_error', async () => {
      idp.signWith = 'hs256';
      await expectRejected('server_error', 'unexpected JWT "alg" header parameter');
    });

    it('alg=none 的 id_token → server_error', async () => {
      idp.signWith = 'none';
      await expectRejected('server_error', 'unexpected JWT "alg" header parameter');
    });

    it('簽章金鑰不在 JWKS（RS256 但別把金鑰簽的）→ server_error', async () => {
      idp.signWith = 'foreign-rs256';
      await expectRejected('server_error', 'JWT signature verification failed');
    });

    it('id_token 過期 → server_error', async () => {
      const now = Math.floor(Date.now() / 1000);
      idp.idToken = { exp: now - 600, iat: now - 1200, auth_time: now - 1200 };
      await expectRejected('server_error', 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED');
    });

    it('email_verified=false → email_unverified', async () => {
      const before = h.prisma.counts();
      const res = await h.login({ ...alice, email_verified: false });
      expect(res.callback.error).toBe('email_unverified');
      expect(h.prisma.counts()).toEqual(before);
    });

    it('email_verified 是字串 "true"（不是 boolean）→ email_unverified', async () => {
      const res = await h.login({ ...alice, email_verified: 'true' });
      expect(res.callback.error).toBe('email_unverified');
    });

    it('IdP 回 error=access_denied → server_error', async () => {
      idp.denyAuthorize = true;
      const res = await h.login(alice);
      expect(res.callback.error).toBe('server_error');
    });
  });

  describe('ticket', () => {
    const getTicket = async () => {
      const verifier = newVerifier();
      const cb = await h.callback(await h.toIdpCallback('web', verifier, alice));
      expect(cb.ticket).toBeDefined();
      return { ticket: cb.ticket!, verifier };
    };

    it('存 Redis 60 秒、key 不含 ticket 明文', async () => {
      const { ticket } = await getTicket();
      const keys = [...h.redis.store.keys()].filter((k) => k.startsWith('oidc:ticket:'));
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain(ticket);
      expect(h.redis.set).toHaveBeenCalledWith(keys[0], expect.any(String), OIDC_TICKET_TTL_SECONDS);
      expect(h.redis.store.get(keys[0])).not.toContain(ticket);
    });

    it('重複使用 → 第二次 401 invalid_ticket', async () => {
      const { ticket, verifier } = await getTicket();
      expect((await h.exchange(ticket, verifier)).status).toBe(201);
      const again = await h.exchange(ticket, verifier);
      expect(again.status).toBe(401);
      expect(again.body.code).toBe('invalid_ticket');
      expect(again.body.accessToken).toBeUndefined();
    });

    it('超過 60 秒 → 401 expired', async () => {
      const { ticket, verifier } = await getTicket();
      h.clock.advance(OIDC_TICKET_TTL_SECONDS * 1000 + 1);
      const res = await h.exchange(ticket, verifier);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('expired');
    });

    it('剛好 60 秒內仍可換', async () => {
      const { ticket, verifier } = await getTicket();
      h.clock.advance(OIDC_TICKET_TTL_SECONDS * 1000 - 1);
      expect((await h.exchange(ticket, verifier)).status).toBe(201);
    });

    it('app_verifier 不符 → 401 invalid_ticket，而且 ticket 已作廢', async () => {
      const { ticket, verifier } = await getTicket();
      const res = await h.exchange(ticket, newVerifier());
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_ticket');
      expect((await h.exchange(ticket, verifier)).status).toBe(401);
    });

    it('別的 client 的 ticket 不能用自己的 verifier 換（challenge 綁在 ticket 上）', async () => {
      const a = await getTicket();
      const b = await getTicket();
      expect((await h.exchange(a.ticket, b.verifier)).status).toBe(401);
      expect((await h.exchange(b.ticket, b.verifier)).status).toBe(201);
    });

    it.each([
      ['ticket 格式錯', { ticket: 'short', app_verifier: 'v'.repeat(43) }],
      ['verifier 太短', { ticket: 'a'.repeat(43), app_verifier: 'v'.repeat(42) }],
      ['少欄位', { ticket: 'a'.repeat(43) }],
      ['型別錯', { ticket: 123, app_verifier: ['x'] }],
    ])('%s → 400 invalid_ticket', async (_n, body) => {
      const res = await h.post('/auth/oidc/exchange', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_ticket');
    });

    it('同一個 ticket 同時送兩次 exchange → 只有一次成功', async () => {
      const { ticket, verifier } = await getTicket();
      const results = await Promise.all([h.exchange(ticket, verifier), h.exchange(ticket, verifier)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
      expect(h.prisma.refreshRows).toHaveLength(1);
    });

    it('callback 之後、exchange 之前被停用 → 401 disabled', async () => {
      const { ticket, verifier } = await getTicket();
      h.prisma.users.find((u) => u.email === 'alice@corp.com')!.disabledAt = new Date();
      const res = await h.exchange(ticket, verifier);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('disabled');
    });
  });

  describe('Redis 停掉時拒絕登入', () => {
    it('start：302 回 App，error=server_error，不轉到 IdP', async () => {
      h.redis.mode = 'throw';
      const res = await h.start302('mobile', challengeOf(newVerifier()));
      expect(res.status).toBe(302);
      expect(res.location).toBe('oidea://auth?error=server_error');
    });

    it('callback：state 讀不到 → server_error，不建 User、不發 ticket', async () => {
      const back = await h.toIdpCallback('web', newVerifier(), alice);
      const before = h.prisma.counts();
      h.redis.mode = 'throw';
      const cb = await h.callback(back);
      expect(cb.location).toBe('https://app.example/auth/callback#error=server_error');
      expect(h.prisma.counts()).toEqual(before);
    });

    it('callback：ticket 寫不進 Redis → server_error', async () => {
      const back = await h.toIdpCallback('mobile', newVerifier(), alice);
      h.redis.failOnly.add('set');
      const cb = await h.callback(back);
      expect(cb.location).toBe('oidea://auth?error=server_error');
    });

    it('exchange：503 server_error，不發 token', async () => {
      const verifier = newVerifier();
      const cb = await h.callback(await h.toIdpCallback('web', verifier, alice));
      h.redis.mode = 'throw';
      const res = await h.exchange(cb.ticket!, verifier);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('server_error');
      expect(res.body.accessToken).toBeUndefined();
      expect(h.prisma.refreshRows).toHaveLength(0);
    });
  });
});

describe('SSO 沒開或設定不完整', () => {
  const idp = new FakeIdp();
  beforeAll(() => idp.start());
  afterAll(() => idp.stop());

  it('沒設 OIDC_ISSUER：start／callback／exchange 都 404，/auth/config 的 sso=false', async () => {
    const h = await new SsoHarness(idp, { OIDC_ISSUER: undefined }).start();
    try {
      expect((await h.get(`/auth/oidc/start?client=web&app_challenge=${'a'.repeat(43)}`)).status).toBe(404);
      expect((await h.get('/auth/oidc/callback?code=x&state=y')).status).toBe(404);
      expect((await h.post('/auth/oidc/exchange', { ticket: 'a'.repeat(43), app_verifier: 'b'.repeat(43) })).status).toBe(404);
      const cfg = await (await h.get('/auth/config')).json();
      expect(cfg).toEqual({ sso: false, passwordLogin: true, endSessionUrl: null });
      expect(idp.discoveryHits).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('有 OIDC_ISSUER 但缺 client secret：start 回 503 server_error，log 只寫變數名稱', async () => {
    const h = await new SsoHarness(idp, { OIDC_CLIENT_SECRET: undefined }).start();
    try {
      const res = await h.get(`/auth/oidc/start?client=web&app_challenge=${'a'.repeat(43)}`);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('server_error');
      expect(h.allLogs()).toContain('OIDC_CLIENT_SECRET');
    } finally {
      await h.close();
    }
  });
});
