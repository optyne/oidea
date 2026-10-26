import { FakeIdp } from './testing/fake-idp';
import { COMPANY_WS, SsoHarness } from './testing/sso-harness';
import { usernameBase } from './sso-login.service';
import { UserStatusService } from '../user-status.service';
import { RefreshTokenService } from '../refresh-token.service';

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

  it('username 撞名時加 -2', async () => {
    await boot((h) => {
      h.prisma.addUser({ id: 'u-other-alice', email: 'alice@elsewhere.com', username: 'alice' });
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'Alice+Ops@corp.com'.toLowerCase(), employeeNo: 'E010' });
    });
    expect(usernameBase('Alice+Ops@corp.com')).toBe('aliceops');
    h.prisma.addUser({ id: 'u-aliceops', email: 'x@y.com', username: 'aliceops' });
    const res = await h.login({ sub: 'sub-a', email: 'alice+ops@corp.com' });
    expect(res.exchange!.status).toBe(201);
    expect(h.prisma.users.find((u) => u.id === res.exchange!.body.user.id)!.username).toBe('aliceops-2');
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

  it('pending owner：第一次 SSO 登入時移交 owner（只發生一次），原執行者的角色不變', async () => {
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
    expect(h.prisma.members.find((m) => m.userId === 'u-founder')!.role).toBe('owner');
    expect(h.audits('owner.transfer')).toEqual([
      expect.objectContaining({
        workspaceId: COMPANY_WS,
        metadata: expect.objectContaining({ fromUserId: 'u-founder', toUserId: bossId }),
      }),
    ]);

    await h.login({ sub: 'sub-boss', email: 'boss@corp.com' });
    expect(h.audits('owner.transfer')).toHaveLength(1);
    expect(ws.ownerId).toBe(bossId);
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
