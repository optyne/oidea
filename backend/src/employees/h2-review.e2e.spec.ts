import { FakeIdp } from '../auth/oidc/testing/fake-idp';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ORG_LOCK_KEY } from './org-lock';
import { AdminHarness, COMPANY_WS } from './testing/admin-harness';

/**
 * H2 獨立審查（notes/h2-review.md）的回歸測試。P1–P6 是審查者的探針（原本證明 bug 存在），
 * 這裡改成斷言修好之後的行為；S2、S3、S6 的項目各有一條讓「把修正拿掉」會失敗的測試。
 */
describe('H2 review regressions', () => {
  const idp = new FakeIdp();
  let h: AdminHarness;
  beforeAll(() => idp.start());
  afterAll(() => idp.stop());
  afterEach(async () => {
    await h?.close();
  });

  /** 公司（u-founder = Workspace.ownerId、role owner）＋ hr ＋ 一般成員。 */
  const boot = async (seed: (h: AdminHarness) => unknown = () => undefined, opts: { pendingOwnerEmail?: string } = {}) => {
    h = new AdminHarness(idp);
    h.seedCompany(opts);
    h.addEmployee({ id: 'u-hr', role: 'hr', employeeNo: 'H001', fullName: 'hr' });
    h.addEmployee({ id: 'u-member', role: 'member', employeeNo: 'M001', fullName: 'member' });
    await seed(h);
    await h.start();
    return h;
  };
  const hr = () => h.token('u-hr');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const profileOf = (userId: string) => h.prisma.profiles.find((p) => p.userId === userId)!;

  // ─────────────── B1：owner／待移交 owner／admin 的身分對應 ───────────────

  describe('B1 owner protection', () => {
    it('P1: hr cannot unbind the owner or repoint his email; the owner can still log in', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'founder@corp.com', employeeNo: 'F001', id: 'p-founder' }));
      const first = await h.login({ sub: 'sub-founder', email: 'founder@corp.com' });
      expect(first.exchange!.body.user.id).toBe('u-founder');

      const unbind = await h.call('POST', '/admin/employees/p-founder/unbind', hr());
      expect(unbind.status).toBe(403);
      expect(unbind.body.code).toBe('owner_protected');
      expect((await h.call('GET', '/company/me', first.exchange!.body.accessToken)).status).toBe(200); // session intact

      const patch = await h.call('PATCH', '/admin/employees/p-founder', hr(), { email: 'hr-alt@corp.com' });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('owner_protected');
      expect(h.prisma.profiles.find((p) => p.id === 'p-founder')).toMatchObject({ userId: 'u-founder', email: 'founder@corp.com' });
      expect(h.audits('employee.unbind')).toEqual([]);

      const again = await h.login({ sub: 'sub-founder', email: 'founder@corp.com' });
      expect(again.exchange!.status).toBe(201);
    });

    it('a company admin is refused too; another company owner may unbind the owner, but nobody may unbind himself', async () => {
      await boot((h) => {
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'founder@corp.com', employeeNo: 'F001', id: 'p-founder', userId: 'u-founder' });
        h.addEmployee({ id: 'u-admin', role: 'admin', employeeNo: 'A001' });
        h.addEmployee({ id: 'u-co', role: 'owner', employeeNo: 'C001' });
      });
      expect((await h.call('POST', '/admin/employees/p-founder/unbind', h.token('u-admin'))).body.code).toBe('owner_protected');
      expect((await h.call('POST', '/admin/employees/p-founder/unbind', h.token('u-founder'))).body.code).toBe('cannot_edit_self');
      expect((await h.call('POST', `/admin/employees/${profileOf('u-co').id}/unbind`, h.token('u-co'))).body.code).toBe('cannot_edit_self');

      const byCoOwner = await h.call('POST', '/admin/employees/p-founder/unbind', h.token('u-co'));
      expect(byCoOwner.status).toBe(200);
      expect(byCoOwner.body.userId).toBeNull();
      // 解除綁定後還沒重新登入：email 仍對應到那位 owner 的 User，hr 照樣不能改
      const patch = await h.call('PATCH', '/admin/employees/p-founder', hr(), { email: 'hr-alt@corp.com' });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('owner_protected');
    });

    it('P6: the pending owner profile email cannot be changed through the API (not even by the owner); other fields can', async () => {
      await boot(
        (h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'boss@corp.com', employeeNo: 'B1', id: 'p-boss' }),
        { pendingOwnerEmail: 'Boss@Corp.com' },
      );
      const byHr = await h.call('PATCH', '/admin/employees/p-boss', hr(), { email: 'x@corp.com' });
      expect(byHr.status).toBe(403);
      expect(byHr.body.code).toBe('owner_protected');
      const byOwner = await h.call('PATCH', '/admin/employees/p-boss', h.token('u-founder'), { email: 'x@corp.com' });
      expect(byOwner.body.code).toBe('owner_protected');
      expect((await h.call('PATCH', '/admin/employees/p-boss', hr(), { jobTitle: '總經理' })).status).toBe(200);

      const l = await h.login({ sub: 'sub-boss', email: 'boss@corp.com' });
      expect(l.exchange!.status).toBe(201);
      expect(h.prisma.workspaces.find((w) => w.id === COMPANY_WS)!.ownerId).toBe(l.exchange!.body.user.id);
    });

    it('CSV import: hr cannot repoint the pending owner or an (unbound) owner email; a normal row still imports', async () => {
      await boot(
        (h) => {
          h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'boss@corp.com', employeeNo: 'B1' });
          h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'founder@corp.com', employeeNo: 'F001' }); // unbound, but founder@ owns the company
          h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'plain@corp.com', employeeNo: 'P1' });
        },
        { pendingOwnerEmail: 'boss@corp.com' },
      );
      const csv = [
        'employeeNo,email,fullName,hireDate',
        'B1,evil1@corp.com,B1,2024-01-01',
        'F001,evil2@corp.com,F001,2024-01-01',
        'P1,plain2@corp.com,P1,2024-01-01',
      ].join('\n');
      const r = await h.call('POST', '/admin/employees/import', hr(), { csv });
      expect(r.status).toBe(200);
      expect(r.body.updated).toBe(1);
      expect(r.body.errors.map((e: any) => e.line)).toEqual([2, 3]);
      expect(h.prisma.profiles.map((p) => p.email).sort()).toEqual(
        ['boss@corp.com', 'founder@corp.com', 'plain2@corp.com', 'u-hr@corp.com', 'u-member@corp.com'].sort(),
      );
      // 每一列一個交易＋組織結構鎖（review N2）
      expect(h.prisma.lockLog.filter((k) => k === ORG_LOCK_KEY).length).toBeGreaterThanOrEqual(3);
    });

    it('P5: hr cannot terminate, unbind or repoint a company admin; an admin can terminate an admin', async () => {
      await boot((h) => {
        h.addEmployee({ id: 'u-admin', role: 'admin', employeeNo: 'A1' });
        h.addEmployee({ id: 'u-admin2', role: 'admin', employeeNo: 'A2' });
      });
      const id = profileOf('u-admin').id;
      const term = await h.call('POST', `/admin/employees/${id}/terminate`, hr(), { terminationDate: '2026-10-31' });
      expect(term.status).toBe(403);
      expect(term.body.code).toBe('admin_protected');
      expect((await h.call('POST', `/admin/employees/${id}/unbind`, hr())).body.code).toBe('admin_protected');
      expect((await h.call('PATCH', `/admin/employees/${id}`, hr(), { email: 'a@corp.com' })).body.code).toBe('admin_protected');
      expect(h.prisma.users.find((u) => u.id === 'u-admin')!.disabledAt).toBeNull();

      const byAdmin = await h.call('POST', `/admin/employees/${id}/terminate`, h.token('u-admin2'), { terminationDate: '2026-10-31' });
      expect(byAdmin.status).toBe(200);
    });
  });

  // ─────────────── S1 ───────────────

  it('P2/S1: a terminated profile cannot be unbound (reinstate first), so reinstate always re-enables the User', async () => {
    await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'alice@corp.com', employeeNo: 'E1', id: 'p-a' }));
    const l = await h.login({ sub: 'sub-a', email: 'alice@corp.com' });
    const userId = l.exchange!.body.user.id;
    expect((await h.call('POST', '/admin/employees/p-a/terminate', hr(), { terminationDate: '2026-10-31' })).status).toBe(200);
    const unbind = await h.call('POST', '/admin/employees/p-a/unbind', hr());
    expect(unbind.status).toBe(400);
    expect(unbind.body.code).toBe('already_terminated');
    expect(h.prisma.profiles.find((p) => p.id === 'p-a')!.userId).toBe(userId);

    expect((await h.call('POST', '/admin/employees/p-a/reinstate', hr())).status).toBe(200);
    const again = await h.login({ sub: 'sub-a', email: 'alice@corp.com' });
    expect(again.exchange!.status).toBe(201);
  });

  // ─────────────── S7 ───────────────

  describe('S7 self edit and audit values', () => {
    it('P4: hr cannot edit his own profile through the admin API', async () => {
      await boot();
      const self = profileOf('u-hr').id;
      const r = await h.call('PATCH', `/admin/employees/${self}`, hr(), { hireDate: '2000-01-01' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('cannot_edit_self');
      expect(profileOf('u-hr').hireDate.toISOString().slice(0, 10)).toBe('2024-01-01');
      expect(h.audits('employee.update')).toEqual([]);
    });

    it('employee.update audit records before/after per changed field', async () => {
      await boot((h) => {
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'x@corp.com', employeeNo: 'X1', id: 'p-x' });
      });
      const mgr = profileOf('u-member').id;
      const r = await h.call('PATCH', '/admin/employees/p-x', hr(), {
        email: 'new@corp.com',
        hireDate: '2025-02-03',
        employmentType: 'contractor',
        managerProfileId: mgr,
      });
      expect(r.status).toBe(200);
      expect(h.audits('employee.update')[0].metadata).toMatchObject({
        fields: ['email', 'hireDate', 'employmentType', 'managerProfileId'],
        changes: {
          email: { from: 'x@corp.com', to: 'new@corp.com' },
          hireDate: { from: '2024-01-01', to: '2025-02-03' },
          employmentType: { from: 'full_time', to: 'contractor' },
          managerProfileId: { from: null, to: mgr },
        },
      });
    });
  });

  // ─────────────── S2 ───────────────

  it('S2: terminate removes channel memberships, cancels pending scheduled messages and disables automation rules', async () => {
    await boot((h) => {
      h.prisma.channelMembers.push(
        { id: 'cm1', channelId: 'c1', userId: 'u-member' },
        { id: 'cm2', channelId: 'c2', userId: 'u-member' },
        { id: 'cm3', channelId: 'c1', userId: 'u-hr' },
      );
      h.prisma.scheduledMessages.push(
        { id: 'sm1', createdBy: 'u-member', status: 'pending', deletedAt: null },
        { id: 'sm2', createdBy: 'u-member', status: 'sent', deletedAt: null },
        { id: 'sm3', createdBy: 'u-hr', status: 'pending', deletedAt: null },
      );
      h.prisma.automationRules.push(
        { id: 'ar1', createdBy: 'u-member', enabled: true, deletedAt: null },
        { id: 'ar2', createdBy: 'u-hr', enabled: true, deletedAt: null },
      );
    });
    const r = await h.call('POST', `/admin/employees/${profileOf('u-member').id}/terminate`, hr(), { terminationDate: '2026-10-31' });
    expect(r.status).toBe(200);
    expect(h.prisma.channelMembers.map((m) => m.id)).toEqual(['cm3']);
    expect(h.prisma.scheduledMessages.map((m) => [m.id, m.status])).toEqual([
      ['sm1', 'canceled'],
      ['sm2', 'sent'],
      ['sm3', 'pending'],
    ]);
    expect(h.prisma.automationRules.map((a) => [a.id, a.enabled])).toEqual([
      ['ar1', false],
      ['ar2', true],
    ]);
    expect(h.audits('employee.terminate')[0].metadata).toMatchObject({
      removedChannelMemberships: 2,
      canceledScheduledMessages: 1,
      disabledAutomationRules: 1,
    });
  });

  // ─────────────── S3：併發 ───────────────

  describe('S3 serialization', () => {
    it('P3: SSO first-login bind racing a terminate ends consistent (terminated profile never bound to a live User)', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'bob@corp.com', employeeNo: 'E2', id: 'p-b' }));
      const t = hr();
      const prisma: any = h.prisma;
      const orig = prisma.employeeProfile.updateMany;
      let terminate: Promise<any> | null = null;
      prisma.employeeProfile.updateMany = async (args: any) => {
        if (!terminate && args?.data?.userId && args?.where?.id === 'p-b') {
          // SSO 已經讀到「在職、沒綁定」、正要綁定時，hr 按下離職
          terminate = h.call('POST', '/admin/employees/p-b/terminate', t, { terminationDate: '2026-10-31' });
          await sleep(150);
        }
        return orig(args);
      };
      const l = await h.login({ sub: 'sub-b', email: 'bob@corp.com' });
      prisma.employeeProfile.updateMany = orig;
      expect(terminate).not.toBeNull();
      expect((await terminate!).status).toBe(200);

      const p = h.prisma.profiles.find((x) => x.id === 'p-b')!;
      expect(p.employmentStatus).toBe('terminated');
      if (p.userId) {
        const u = h.prisma.users.find((x) => x.id === p.userId)!;
        expect(u.disabledAt).toBeTruthy();
        expect(h.prisma.members.some((m) => m.userId === u.id)).toBe(false);
      }
      if (l.exchange) expect(l.exchange.status).toBe(401);
      // 之後再登入：帳號路徑看到停用（disabled），或 email 路徑看到離職（terminated）
      expect((await h.login({ sub: 'sub-b', email: 'bob@corp.com' })).callback.ticket).toBeUndefined();
    });

    it('P3 (state injected without a concurrent request): the bind never attaches a terminated profile', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'bob@corp.com', employeeNo: 'E2', id: 'p-b' }));
      const prisma: any = h.prisma;
      const orig = prisma.employeeProfile.updateMany;
      const realTx = prisma.$transaction.bind(prisma);
      let fired = false;
      // 另一個交易（沒拿鎖的寫入）在 SSO 讀完之後、綁定之前 commit 了離職
      const terminateCommitted = () => {
        const row = prisma.profiles.find((x: any) => x.id === 'p-b');
        row.employmentStatus = 'terminated';
        row.terminationDate = new Date('2026-10-31');
      };
      prisma.employeeProfile.updateMany = async (args: any) => {
        if (!fired && args?.data?.userId && args?.where?.id === 'p-b') {
          fired = true;
          terminateCommitted();
        }
        return orig(args);
      };
      // fake 的 rollback 會把上面的寫入一起還原；它是別的交易 commit 的，rollback 之後補回去
      prisma.$transaction = async (fn: any, ...rest: any[]) => {
        try {
          return await realTx(fn, ...rest);
        } catch (e) {
          if (fired) terminateCommitted();
          throw e;
        }
      };
      const l = await h.login({ sub: 'sub-b', email: 'bob@corp.com' });
      prisma.employeeProfile.updateMany = orig;
      prisma.$transaction = realTx;
      expect(fired).toBe(true);
      expect(l.callback.ticket).toBeUndefined();
      expect(l.callback.error).toBe('terminated');
      expect(h.prisma.profiles.find((x) => x.id === 'p-b')!.userId).toBeNull();
      expect(h.prisma.members.filter((m) => m.workspaceId === COMPANY_WS).map((m) => m.userId).sort()).toEqual(['u-founder', 'u-hr', 'u-member']);
    });

    it('owner transfer racing a terminate never leaves a workspace owned by a disabled user', async () => {
      await boot((h) => {
        h.addEmployee({ id: 'u-t', role: 'member', employeeNo: 'T1' });
        h.prisma.addUser({ id: 'u-own', email: 'own@corp.com' });
        h.prisma.addWorkspace({ id: 'ws-x', ownerId: 'u-own', name: 'X' });
        h.prisma.addMember('ws-x', 'u-own', 'owner');
        h.prisma.addMember('ws-x', 'u-t', 'member');
      });
      const prisma: any = h.prisma;
      const orig = prisma.workspace.findMany;
      let transfer: Promise<unknown> | null = null;
      prisma.workspace.findMany = async (args: any) => {
        const res = await orig(args);
        if (!transfer && args?.where?.ownerId === 'u-t') {
          // 離職的 owner 檢查剛讀完（他不是 owner），owner 這時把 ws-x 移交給他
          transfer = h.app.get(WorkspacesService).transferOwnership('u-own', 'ws-x', 'u-t').catch((e: Error) => e);
          await sleep(150);
        }
        return res;
      };
      const term = await h.call('POST', `/admin/employees/${profileOf('u-t').id}/terminate`, hr(), { terminationDate: '2026-10-31' });
      prisma.workspace.findMany = orig;
      const transferResult = await transfer;
      expect(transfer).not.toBeNull();

      const ws = h.prisma.workspaces.find((w) => w.id === 'ws-x')!;
      const owner = h.prisma.users.find((u) => u.id === ws.ownerId)!;
      expect(owner.disabledAt).toBeFalsy();
      expect(h.prisma.members.some((m) => m.workspaceId === 'ws-x' && m.userId === ws.ownerId && m.role === 'owner')).toBe(true);
      // 鎖讓它們排隊：離職先做完，移交看到停用而被拒
      expect(term.status).toBe(200);
      expect(transferResult).toBeInstanceOf(Error);
      expect(h.prisma.lockLog).toEqual(expect.arrayContaining(['7301:u-t']));
    });

    it('SSO account path re-checks the User under the user lock (terminated while the login waited → refused)', async () => {
      await boot((h) => {
        h.addEmployee({ id: 'u-acc', role: 'member', employeeNo: 'K1', email: 'acc@corp.com' });
        h.prisma.addAccount('u-acc', 'authentik', 'sub-acc');
      });
      const prisma: any = h.prisma;
      const orig = prisma.$executeRaw;
      let fired = false;
      prisma.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const res = await orig(strings, ...values);
        if (!fired && values[0] === 'u-acc' && strings.join('?').includes('7301')) {
          // 拿到鎖的時候，排在前面的離職交易剛 commit
          fired = true;
          prisma.users.find((u: any) => u.id === 'u-acc').disabledAt = new Date();
        }
        return res;
      };
      const l = await h.login({ sub: 'sub-acc', email: 'acc@corp.com' });
      prisma.$executeRaw = orig;
      expect(fired).toBe(true);
      expect(l.callback.ticket).toBeUndefined();
      expect(l.callback.error).toBe('disabled');
    });

    it('the SSO exchange re-check and department archive run under their locks', async () => {
      await boot((h) => {
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'ex@corp.com', employeeNo: 'X9', id: 'p-ex' });
        h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '封存部', id: 'd-arc' });
      });
      const l = await h.login({ sub: 'sub-ex', email: 'ex@corp.com' });
      expect(l.exchange!.status).toBe(201);
      const userId = l.exchange!.body.user.id;
      // 新建的 User 在綁定時還不存在，user 鎖只會來自 exchange 的重新檢查（離職交易進行中時 exchange 會等它 commit）
      expect(h.prisma.lockLog).toContain(`7302:p-ex`);
      expect(h.prisma.lockLog).toContain(`7301:${userId}`);

      h.prisma.lockLog.length = 0;
      expect((await h.call('POST', '/admin/departments/d-arc/archive', hr())).status).toBe(200);
      expect(h.prisma.lockLog).toEqual([ORG_LOCK_KEY]);
    });

    it('memberships written during the terminate transaction by a path without the lock are swept after commit', async () => {
      await boot((h) => {
        h.prisma.addUser({ id: 'u-own', email: 'own@corp.com' });
        h.prisma.addWorkspace({ id: 'ws-y', ownerId: 'u-own', name: 'Y' });
      });
      const prisma: any = h.prisma;
      const orig = prisma.workspaceMember.deleteMany;
      let injected = false;
      prisma.workspaceMember.deleteMany = async (args: any) => {
        const res = await orig(args);
        if (!injected && args?.where?.userId === 'u-member') {
          injected = true;
          prisma.members.push({ id: 'late', workspaceId: 'ws-y', userId: 'u-member', role: 'member' });
          prisma.channelMembers.push({ id: 'late-cm', channelId: 'c9', userId: 'u-member' });
        }
        return res;
      };
      const r = await h.call('POST', `/admin/employees/${profileOf('u-member').id}/terminate`, hr(), { terminationDate: '2026-10-31' });
      prisma.workspaceMember.deleteMany = orig;
      expect(r.status).toBe(200);
      expect(injected).toBe(true);
      expect(h.prisma.members.some((m) => m.userId === 'u-member')).toBe(false);
      expect(h.prisma.channelMembers.some((m) => m.userId === 'u-member')).toBe(false);
    });
  });

  // ─────────────── S6：存活的 mutation ───────────────

  describe('S6 mutation killers', () => {
    it('I3: dryRun on an existing employee reports updated but writes nothing', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'e@corp.com', employeeNo: 'E9', fullName: 'Old' }));
      const csv = 'employeeNo,email,fullName,hireDate\nE9,e@corp.com,New Name,2024-01-01\n';
      const r = await h.call('POST', '/admin/employees/import', hr(), { csv, dryRun: true });
      expect(r.body).toMatchObject({ updated: 1, created: 0, dryRun: true });
      expect(h.prisma.profiles.find((p) => p.employeeNo === 'E9')!.fullName).toBe('Old');
      expect(h.audits('employee.import')).toEqual([]);
    });

    it('U4/U5: unbind revokes the old user’s refresh tokens and bots', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'u@corp.com', employeeNo: 'U1', id: 'p-u' }));
      const l = await h.login({ sub: 'sub-u', email: 'u@corp.com' });
      const userId = l.exchange!.body.user.id;
      await h.addBot({ id: 'ubot', createdById: userId, workspaceId: 'ws-side-u' });
      expect(h.prisma.refreshRows.filter((r) => r.userId === userId && !r.revokedAt).length).toBeGreaterThan(0);
      expect((await h.call('POST', '/admin/employees/p-u/unbind', hr())).status).toBe(200);
      expect(h.prisma.refreshRows.filter((r) => r.userId === userId).every((r) => r.revokedAt)).toBe(true);
      expect(h.prisma.bots.find((b) => b.id === 'ubot')!.revokedAt).toBeTruthy();
    });

    it('G2: a bot token is refused on /admin even when the bot user holds a company role', async () => {
      await boot((h) => {
        h.prisma.addWorkspace({ id: 'ws-b', ownerId: 'u-member' });
        h.prisma.addMember('ws-b', 'u-member', 'owner');
      });
      const token = await h.addBot({ id: 'gbot', createdById: 'u-member', workspaceId: 'ws-b' });
      h.prisma.addMember(COMPANY_WS, 'u-gbot', 'hr');
      expect((await h.call('GET', '/bot/me', token)).status).toBe(200);
      expect((await h.call('GET', '/admin/employees', token)).status).toBe(403);
    });

    it('C2: a manager whose User is disabled (profile still active) is skipped', async () => {
      await boot((h) => {
        const mgr = h.addEmployee({ id: 'u-mgr', role: 'member', fullName: '停用主管' });
        mgr.user.disabledAt = new Date();
        (h.prisma.profiles.find((p) => p.userId === 'u-member') as any).managerProfileId = mgr.profile.id;
      });
      const res = await h.call('GET', '/company/me', h.token('u-member'));
      expect(res.status).toBe(200);
      expect(res.body.profile.manager).toBeNull();
    });

    it('E6: POST with a terminated manager → 400 manager_not_found', async () => {
      await boot((h) => h.addEmployee({ id: 'u-gone', role: null, employmentStatus: 'terminated', employeeNo: 'G1' }));
      const r = await h.call('POST', '/admin/employees', hr(), {
        employeeNo: 'N1',
        email: 'n1@corp.com',
        fullName: 'N',
        hireDate: '2026-01-01',
        managerProfileId: profileOf('u-gone').id,
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('manager_not_found');
    });

    it('D4/D7: department name clashes are refused by the app check before any write', async () => {
      await boot((h) => {
        h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '研發部', id: 'd-rd' });
        h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '業務部', id: 'd-sales' });
      });
      const prisma: any = h.prisma;
      const creates = prisma.department.create.mock.calls.length;
      const updates = prisma.department.update.mock.calls.length;
      const c = await h.call('POST', '/admin/departments', hr(), { name: '研發部' });
      expect(c.status).toBe(409);
      const u = await h.call('PATCH', '/admin/departments/d-sales', hr(), { name: '研發部' });
      expect(u.status).toBe(409);
      expect(u.body.code).toBe('department_name_taken');
      expect(prisma.department.create.mock.calls.length).toBe(creates);
      expect(prisma.department.update.mock.calls.length).toBe(updates);
    });

    it('A1/A2/A6/N3: audit action pattern, prefix semantics, cursor tie-break, zone-less times', async () => {
      await boot();
      const base = Date.UTC(2026, 9, 1);
      const push = (id: string, action: string, t: number) =>
        h.prisma.auditLogs.push({ id, actorId: null, workspaceId: COMPANY_WS, action, createdAt: new Date(base + t) } as any);
      push('a1', 'employee.update', 0);
      push('a2', 'auth.employee_sync', 1000);
      push('b8', 'employee.create', 2000);
      push('b9', 'employee.create', 2000);
      const owner = h.token('u-founder');
      const url = (q: string) => `/audit/workspaces/${COMPANY_WS}?${q}`;

      expect((await h.call('GET', url('action=employee.%25'), owner)).status).toBe(400);
      expect((await h.call('GET', url('action=Employee.*'), owner)).status).toBe(400);
      const prefix = await h.call('GET', url('action=employee.*'), owner);
      expect(prefix.body.items.map((i: any) => i.id)).toEqual(['b9', 'b8', 'a1']);

      const p1 = await h.call('GET', url('limit=1'), owner);
      expect(p1.body.items.map((i: any) => i.id)).toEqual(['b9']);
      const p2 = await h.call('GET', url(`limit=1&cursor=${p1.body.nextCursor}`), owner);
      expect(p2.body.items.map((i: any) => i.id)).toEqual(['b8']);

      expect((await h.call('GET', url('from=2026-10-01T00:00:00'), owner)).body.code).toBe('invalid_date');
      expect((await h.call('GET', url(`from=${encodeURIComponent('2026-10-01T00:00:00+08:00')}`), owner)).status).toBe(200);
      expect((await h.call('GET', url('from=2026-10-01'), owner)).status).toBe(200);
    });
  });
});
