import { FakeIdp } from './testing/fake-idp';
import { COMPANY_WS, SsoHarness } from './testing/sso-harness';
import { JwtService } from '@nestjs/jwt';
import { USERNAME_MAX, USERNAME_MIN, usernameBase, usernameCandidate } from './sso-login.service';
import { UserStatusService } from '../user-status.service';
import { RefreshTokenService } from '../refresh-token.service';
import { SocketRegistry } from '../socket-registry';
import { CompanyService } from '../../company/company.service';
import { extractMentionTokens } from '../../common/mentions.util';

/**
 * H1 驗收：員工對應（spec §4.3「員工對應」1–4），全部走真的 start → callback → exchange。
 */
describe('SSO 員工對應', () => {
  const idp = new FakeIdp();
  let h: SsoHarness;

  beforeAll(() => idp.start());
  afterAll(() => idp.stop());

  const boot = async (seed: (h: SsoHarness) => void = () => undefined, pendingOwnerEmail?: string) => {
    h = new SsoHarness(idp);
    h.seedCompany({ pendingOwnerEmail });
    seed(h);
    await h.start();
    return h;
  };
  afterEach(async () => {
    await h?.close();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const deniedAudits = () => h.audits('auth.sso_denied');

  it('預建員工第一次登入：回填 profile.userId、建 Account、加入公司工作空間（member），立刻能打 /attendance/today', async () => {
    await boot((h) =>
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'alice@corp.com', employeeNo: 'E001', fullName: '王小美' }),
    );
    const res = await h.login({ sub: 'sub-alice', email: 'alice@corp.com' });
    expect(res.exchange!.status).toBe(201);

    const user = h.prisma.users.find((u) => u.email === 'alice@corp.com')!;
    expect(user).toMatchObject({ username: 'alice', displayName: '王小美', passwordHash: null });
    expect(h.prisma.profiles.find((p) => p.employeeNo === 'E001')!.userId).toBe(user.id);
    expect(h.prisma.accounts).toEqual([
      expect.objectContaining({ userId: user.id, provider: 'authentik', providerId: 'sub-alice' }),
    ]);
    expect(h.prisma.members.find((m) => m.workspaceId === COMPANY_WS && m.userId === user.id)?.role).toBe('member');
    expect(h.audits('employee.sso_bind')).toHaveLength(1);
    expect(h.prisma.transactions).toBeGreaterThanOrEqual(1);

    const today = await h.get(`/attendance/today?workspaceId=${COMPANY_WS}`, bearer(res.exchange!.body.accessToken));
    expect(today.status).toBe(200);

    // 第二次登入（同一個 sub）：同一個 User，不重建，不重複加入
    const again = await h.login({ sub: 'sub-alice', email: 'alice@corp.com' });
    expect(again.exchange!.body.user.id).toBe(user.id);
    expect(h.prisma.users.filter((u) => u.email === 'alice@corp.com')).toHaveLength(1);
    expect(h.prisma.members.filter((m) => m.userId === user.id)).toHaveLength(1);
    expect(h.audits('employee.sso_bind')).toHaveLength(1);
  });

  it('email 大小寫不同（Foo@ 與 foo@）對應到同一位員工', async () => {
    await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'foo@corp.com', employeeNo: 'E002' }));
    const first = await h.login({ sub: 'sub-foo', email: 'Foo@Corp.com' });
    expect(first.exchange!.status).toBe(201);
    const profile = h.prisma.profiles.find((p) => p.employeeNo === 'E002')!;
    expect(profile.userId).toBe(first.exchange!.body.user.id);
    expect(first.exchange!.body.user.email).toBe('foo@corp.com');

    const second = await h.login({ sub: 'sub-foo', email: 'foo@corp.com' });
    expect(second.exchange!.body.user.id).toBe(first.exchange!.body.user.id);
  });

  it('已有帳密 User（email 大小寫不同）第一次 SSO：綁定、passwordHash=null、舊 refresh token 失效、他建的 bot 撤銷、其他 Account 刪除', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-bob', email: 'Bob@corp.com', username: 'bob', passwordHash: 'hash:old' });
      h.prisma.addAccount('u-bob', 'google', 'g-123');
      h.prisma.bots.push({
        id: 'bot-1',
        workspaceId: 'ws-side',
        userId: 'u-botuser',
        tokenPrefix: 'bot_abcdef',
        tokenHash: 'x',
        createdById: 'u-bob',
        revokedAt: null,
      });
      h.prisma.bots.push({
        id: 'bot-2',
        workspaceId: 'ws-side',
        userId: 'u-botuser-2',
        tokenPrefix: 'bot_zzzzzz',
        tokenHash: 'x',
        createdById: 'u-someone-else',
        revokedAt: null,
      });
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'bob@corp.com', employeeNo: 'E003' });
    });
    const oldRefresh = await h.app.get(RefreshTokenService).issueNewFamily('u-bob');
    h.secrets.push(oldRefresh);

    const res = await h.login({ sub: 'sub-bob', email: 'bob@corp.com' });
    expect(res.exchange!.status).toBe(201);
    expect(res.exchange!.body.user.id).toBe('u-bob');

    const bob = h.prisma.users.find((u) => u.id === 'u-bob')!;
    expect(bob.passwordHash).toBeNull();
    expect(h.prisma.users.filter((u) => u.email.toLowerCase() === 'bob@corp.com')).toHaveLength(1);
    expect((await h.post('/auth/refresh', { refreshToken: oldRefresh })).status).toBe(401);
    expect((await h.post('/auth/refresh', { refreshToken: res.exchange!.body.refreshToken })).status).toBe(201);
    expect(h.prisma.bots.find((b) => b.id === 'bot-1')!.revokedAt).not.toBeNull();
    expect(h.prisma.bots.find((b) => b.id === 'bot-2')!.revokedAt).toBeNull();
    expect(h.prisma.accounts.filter((a) => a.userId === 'u-bob')).toEqual([
      expect.objectContaining({ provider: 'authentik', providerId: 'sub-bob' }),
    ]);
    expect(h.audits('employee.sso_bind')[0].metadata).toMatchObject({ boundExistingUser: true, revokedBots: 1 });
  });

  it('username 撞名時加 _2', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-other-alice', email: 'alice@elsewhere.com', username: 'alice' });
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'Alice+Ops@corp.com'.toLowerCase(), employeeNo: 'E010' });
    });
    expect(usernameBase('Alice+Ops@corp.com')).toBe('aliceops');
    h.prisma.addUser({ id: 'u-aliceops', email: 'x@y.com', username: 'aliceops' });
    const res = await h.login({ sub: 'sub-a', email: 'alice+ops@corp.com' });
    expect(res.exchange!.status).toBe(201);
    expect(h.prisma.users.find((u) => u.id === res.exchange!.body.user.id)!.username).toBe('aliceops_2');
  });

  it('產生的 username 照註冊規則（3–30 字）而且 @提及安全（只有 [a-z0-9_]）', () => {
    expect(usernameBase('John.Doe-X@corp.com')).toBe('john_doe_x');
    expect(usernameBase('ab@corp.com')).toBe('ab_user');
    expect(usernameBase('+++@corp.com')).toBe('user');
    const long = usernameBase(`${'a'.repeat(45)}@corp.com`);
    expect(long).toHaveLength(USERNAME_MAX);
    expect(usernameCandidate(long, 12)).toHaveLength(USERNAME_MAX);
    expect(usernameCandidate(long, 12).endsWith('_12')).toBe(true);
    for (const email of ['john.doe@corp.com', 'mary-jane@corp.com', `${'x.'.repeat(30)}@corp.com`, 'ab@corp.com']) {
      for (const n of [1, 2, 123]) {
        const name = usernameCandidate(usernameBase(email), n);
        expect(name.length).toBeGreaterThanOrEqual(USERNAME_MIN);
        expect(name.length).toBeLessThanOrEqual(USERNAME_MAX);
        expect(name).toMatch(/^[a-z0-9_]+$/);
        // 純文字 @username 會整個被解析出來（不會截成別人的 username）
        expect(extractMentionTokens(`hi @${name} !`).usernames).toEqual([name]);
      }
    }
  });

  it('review S2：綁定既有帳號後，他綁定前拿到的 access token 立刻失效、socket 被斷開；新 token 可用', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-sq', email: 'sq@corp.com', username: 'sq', passwordHash: 'hash:squatter' });
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'sq@corp.com', employeeNo: 'E060' });
    });
    // 搶先註冊的人手上的 access token（跟 AuthService 一樣用注入的時鐘簽 iat）
    const oldAccess = h.app
      .get(JwtService)
      .sign({ sub: 'u-sq', email: 'sq@corp.com', typ: 'access', iat: Math.floor(h.clock.now().getTime() / 1000) });
    h.secrets.push(oldAccess);
    const sock = { id: 'sock-sq', disconnect: jest.fn() };
    const registry = h.app.get(SocketRegistry);
    registry.add('u-sq', sock);

    const path = `/attendance/today?workspaceId=${COMPANY_WS}`;
    expect((await h.get(path, bearer(oldAccess))).status).toBe(403); // 已登入，但還不是公司成員

    h.clock.advance(2_000);
    const res = await h.login({ sub: 'sub-sq', email: 'sq@corp.com' });
    expect(res.exchange!.status).toBe(201);
    expect(res.exchange!.body.user.id).toBe('u-sq');
    expect(h.prisma.users.find((u) => u.id === 'u-sq')!.sessionsValidAfter).toEqual(h.clock.now());

    // 現在他是公司成員了：舊 token 不能拿來用
    expect((await h.get(path, bearer(oldAccess))).status).toBe(401);
    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(registry.count('u-sq')).toBe(0);
    // SSO 換到的新 token 正常
    expect((await h.get(path, bearer(res.exchange!.body.accessToken))).status).toBe(200);
  });

  it('review M32：從 Account 找到的 profile 不在公司工作空間 → not_employee（沒有任何寫入）', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-x', email: 'x@corp.com' });
      h.prisma.addAccount('u-x', 'authentik', 'sub-x');
      h.prisma.addProfile({ workspaceId: 'ws-other', email: 'x@corp.com', employeeNo: 'E070', userId: 'u-x' });
    });
    const before = h.prisma.counts();
    const res = await h.login({ sub: 'sub-x', email: 'x@corp.com' });
    expect(res.callback.error).toBe('not_employee');
    expect(h.prisma.counts()).toEqual(before);
    expect(deniedAudits()).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'not_in_roster', via: 'account' }) }),
    ]);
  });

  describe('拒絕（寫 audit auth.sso_denied，而且完全沒有新增 User、Account、WorkspaceMember）', () => {
    const expectDenied = async (user: { sub: string; email: string }, code: string, reason: string) => {
      const before = h.prisma.counts();
      const res = await h.login(user);
      expect(res.callback.error).toBe(code);
      expect(res.exchange).toBeNull();
      expect(h.prisma.counts()).toEqual(before);
      const denied = deniedAudits();
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({ workspaceId: COMPANY_WS, metadata: expect.objectContaining({ reason }) });
    };

    it('不在員工主檔 → not_employee', async () => {
      await boot();
      await expectDenied({ sub: 'sub-x', email: 'stranger@corp.com' }, 'not_employee', 'not_in_roster');
    });

    it('不在員工主檔、但已有帳密 User → not_employee，User 不被改', async () => {
      await boot((h) => h.prisma.addUser({ id: 'u-ext', email: 'ext@corp.com', passwordHash: 'hash:keep' }));
      await expectDenied({ sub: 'sub-ext', email: 'ext@corp.com' }, 'not_employee', 'not_in_roster');
      expect(h.prisma.users.find((u) => u.id === 'u-ext')!.passwordHash).toBe('hash:keep');
    });

    it('terminated → terminated', async () => {
      await boot((h) =>
        h.prisma.addProfile({
          workspaceId: COMPANY_WS,
          email: 'gone@corp.com',
          employeeNo: 'E004',
          employmentStatus: 'terminated',
        }),
      );
      await expectDenied({ sub: 'sub-gone', email: 'gone@corp.com' }, 'terminated', 'terminated');
    });

    it('已綁定的員工之後被 terminated（同一個 sub）→ terminated', async () => {
      await boot((h) => {
        h.prisma.addUser({ id: 'u-t', email: 't@corp.com' });
        h.prisma.addAccount('u-t', 'authentik', 'sub-t');
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 't@corp.com', employeeNo: 'E005', userId: 'u-t', employmentStatus: 'terminated' });
      });
      await expectDenied({ sub: 'sub-t', email: 't@corp.com' }, 'terminated', 'terminated');
    });

    it('User 已停用（disabledAt）→ disabled', async () => {
      await boot((h) => {
        h.prisma.addUser({ id: 'u-d', email: 'd@corp.com', disabledAt: new Date() });
        h.prisma.addAccount('u-d', 'authentik', 'sub-d');
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'd@corp.com', employeeNo: 'E006', userId: 'u-d' });
      });
      await expectDenied({ sub: 'sub-d', email: 'd@corp.com' }, 'disabled', 'user_disabled');
    });

    it('同 email 的既有 User 已停用（還沒綁）→ disabled，不清他的密碼', async () => {
      await boot((h) => {
        h.prisma.addUser({ id: 'u-d2', email: 'd2@corp.com', disabledAt: new Date(), passwordHash: 'hash:keep' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'd2@corp.com', employeeNo: 'E007' });
      });
      await expectDenied({ sub: 'sub-d2', email: 'd2@corp.com' }, 'disabled', 'user_disabled');
      expect(h.prisma.users.find((u) => u.id === 'u-d2')!.passwordHash).toBe('hash:keep');
    });

    it('profile 已綁了別的 User，用新的 sub 登入 → profile_bound', async () => {
      await boot((h) => {
        h.prisma.addUser({ id: 'u-carol', email: 'carol@corp.com' });
        h.prisma.addAccount('u-carol', 'authentik', 'sub-carol-old');
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'carol@corp.com', employeeNo: 'E008', userId: 'u-carol' });
      });
      await expectDenied({ sub: 'sub-carol-new', email: 'carol@corp.com' }, 'profile_bound', 'profile_bound_to_other_user');
    });

    it('還沒建公司工作空間 → not_employee', async () => {
      h = new SsoHarness(idp);
      await h.start();
      const res = await h.login({ sub: 's', email: 'a@corp.com' });
      expect(res.callback.error).toBe('not_employee');
      expect(h.prisma.users).toHaveLength(0);
      expect(deniedAudits()[0]).toMatchObject({ workspaceId: null, metadata: expect.objectContaining({ reason: 'no_company_workspace' }) });
    });
  });

  it('pending owner：第一次 SSO 登入時移交 owner（只發生一次），原執行者降為 admin（review S3）', async () => {
    await boot(
      (h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'boss@corp.com', employeeNo: 'E000' }),
      'boss@corp.com',
    );
    const first = await h.login({ sub: 'sub-boss', email: 'Boss@corp.com' });
    expect(first.exchange!.status).toBe(201);
    const bossId = first.exchange!.body.user.id;
    const ws = h.prisma.workspaces.find((w) => w.id === COMPANY_WS)!;
    expect(ws.ownerId).toBe(bossId);
    expect(ws.pendingOwnerEmail).toBeNull();
    expect(h.prisma.members.find((m) => m.userId === bossId)!.role).toBe('owner');
    expect(h.prisma.members.find((m) => m.userId === 'u-founder')!.role).toBe('admin');
    expect(await h.app.get(CompanyService).isCompanyOwner('u-founder')).toBe(false);
    expect(h.audits('owner.transfer')).toEqual([
      expect.objectContaining({
        workspaceId: COMPANY_WS,
        metadata: expect.objectContaining({ fromUserId: 'u-founder', toUserId: bossId, previousOwnerDemotedTo: 'admin' }),
      }),
    ]);

    await h.login({ sub: 'sub-boss', email: 'boss@corp.com' });
    expect(h.audits('owner.transfer')).toHaveLength(1);
    expect(ws.ownerId).toBe(bossId);
  });

  it('review B1：company:init 留下的 pending owner 有既有帳密 User → 第一次 SSO 時經綁定清理（密碼清掉）才成為 owner', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-ceo', email: 'CEO@corp.com', username: 'ceo', passwordHash: 'hash:squatter' });
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'ceo@corp.com', employeeNo: 'E000' });
    }, 'ceo@corp.com');
    // 綁定之前：他不是公司 owner
    expect(await h.app.get(CompanyService).isCompanyOwner('u-ceo')).toBe(false);
    const res = await h.login({ sub: 'sub-ceo', email: 'ceo@corp.com' });
    expect(res.exchange!.body.user.id).toBe('u-ceo');
    expect(h.prisma.users.find((u) => u.id === 'u-ceo')!.passwordHash).toBeNull();
    expect(h.prisma.workspaces.find((w) => w.id === COMPANY_WS)!.ownerId).toBe('u-ceo');
    expect(await h.app.get(CompanyService).isCompanyOwner('u-ceo')).toBe(true);
    expect(h.prisma.members.find((m) => m.userId === 'u-founder')!.role).toBe('admin');
  });

  it('pending owner 就是執行者本人（綁定他自己的帳號）：成為 owner，不被降級', async () => {
    await boot(
      (h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'founder@corp.com', employeeNo: 'E001' }),
      'founder@corp.com',
    );
    const res = await h.login({ sub: 'sub-founder', email: 'founder@corp.com' });
    expect(res.exchange!.body.user.id).toBe('u-founder');
    const ws = h.prisma.workspaces.find((w) => w.id === COMPANY_WS)!;
    expect(ws).toMatchObject({ ownerId: 'u-founder', pendingOwnerEmail: null });
    expect(h.prisma.members.filter((m) => m.userId === 'u-founder')).toEqual([expect.objectContaining({ role: 'owner' })]);
    expect(h.audits('owner.transfer')[0].metadata).toMatchObject({ previousOwnerDemotedTo: null });
  });

  it('pending owner 是別人時，一般員工登入不會拿到 owner', async () => {
    await boot(
      (h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'emp@corp.com', employeeNo: 'E020' }),
      'boss@corp.com',
    );
    const res = await h.login({ sub: 'sub-emp', email: 'emp@corp.com' });
    const ws = h.prisma.workspaces.find((w) => w.id === COMPANY_WS)!;
    expect(ws.ownerId).toBe('u-founder');
    expect(ws.pendingOwnerEmail).toBe('boss@corp.com');
    expect(h.prisma.members.find((m) => m.userId === res.exchange!.body.user.id)!.role).toBe('member');
    expect(h.audits('owner.transfer')).toHaveLength(0);
  });

  it('已有角色的成員再登入：不改角色', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-hr', email: 'hr@corp.com' });
      h.prisma.addAccount('u-hr', 'authentik', 'sub-hr');
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'hr@corp.com', employeeNo: 'E030', userId: 'u-hr' });
      h.prisma.addMember(COMPANY_WS, 'u-hr', 'hr');
    });
    await h.login({ sub: 'sub-hr', email: 'hr@corp.com' });
    expect(h.prisma.members.filter((m) => m.userId === 'u-hr')).toEqual([expect.objectContaining({ role: 'hr' })]);
  });

  it('復職的員工（之前被移出公司工作空間）登入後回到公司工作空間；殘留的「停用」快取被清掉', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-back', email: 'back@corp.com' });
      h.prisma.addAccount('u-back', 'authentik', 'sub-back');
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'back@corp.com', employeeNo: 'E040', userId: 'u-back' });
    });
    // 離職時留下的快取（30 秒內）
    h.redis.store.set(UserStatusService.cacheKey('u-back'), '1');
    const res = await h.login({ sub: 'sub-back', email: 'back@corp.com' });
    expect(res.exchange!.status).toBe(201);
    expect(h.prisma.members.find((m) => m.userId === 'u-back' && m.workspaceId === COMPANY_WS)?.role).toBe('member');
    const today = await h.get(`/attendance/today?workspaceId=${COMPANY_WS}`, bearer(res.exchange!.body.accessToken));
    expect(today.status).toBe(200);
  });

  it('hr 解除綁定後（profile.userId=null）同一個 sub 再登入：重新綁回原本的 User', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-re', email: 're@corp.com' });
      h.prisma.addAccount('u-re', 'authentik', 'sub-re');
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 're@corp.com', employeeNo: 'E050' });
    });
    const res = await h.login({ sub: 'sub-re', email: 're@corp.com' });
    expect(res.exchange!.body.user.id).toBe('u-re');
    expect(h.prisma.profiles.find((p) => p.employeeNo === 'E050')!.userId).toBe('u-re');
    expect(h.prisma.accounts.filter((a) => a.userId === 'u-re')).toHaveLength(1);
  });
});
