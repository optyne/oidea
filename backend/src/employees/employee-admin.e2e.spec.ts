import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { FakeIdp } from '../auth/oidc/testing/fake-idp';
import { PERMISSION_METADATA_KEY } from '../common/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions';
import { H2_AUDIT_ACTIONS } from '../audit/audit.service';
import { AdminDepartmentsController, AdminEmployeesController } from './admin.controllers';
import { AdminHarness, COMPANY_WS, connectSocket } from './testing/admin-harness';

/**
 * H2 驗收（spec §5 H2、notes/h2-api-contract.md）：真的 Nest HTTP、真的 SSO 登入、真的 socket.io，
 * Prisma／Redis 用記憶體版。
 */
describe('H2 員工主檔後台（端到端）', () => {
  const idp = new FakeIdp();
  let h: AdminHarness;

  beforeAll(() => idp.start());
  afterAll(() => idp.stop());
  afterEach(async () => {
    await h?.close();
  });

  /** 公司工作空間（u-founder = Workspace.ownerId）＋ hr、一般成員、非公司成員。 */
  const boot = async (seed: (h: AdminHarness) => unknown = () => undefined) => {
    h = new AdminHarness(idp);
    h.seedCompany();
    h.addEmployee({ id: 'u-hr', role: 'hr', employeeNo: 'H001', fullName: '人資小姐' });
    h.addEmployee({ id: 'u-member', role: 'member', employeeNo: 'M001', fullName: '一般員工' });
    h.prisma.addUser({ id: 'u-outsider', email: 'outsider@corp.com' });
    h.prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-outsider' });
    h.prisma.addMember('ws-side', 'u-outsider', 'owner');
    await seed(h);
    await h.start();
    return h;
  };
  const hr = () => h.token('u-hr');

  // ─────────────── 權限 ───────────────

  /** 從 controller 的 metadata 列出所有 /admin 路由（新增路由不會漏測）。 */
  const adminRoutes = () => {
    const out: { method: string; path: string; permission: unknown }[] = [];
    for (const ctrl of [AdminEmployeesController, AdminDepartmentsController]) {
      const base = Reflect.getMetadata(PATH_METADATA, ctrl) as string;
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        if (name === 'constructor') continue;
        const handler = (ctrl.prototype as any)[name];
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (sub === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const path = `/${base}/${sub === '/' ? '' : sub}`.replace(/\/+$/, '').replace(':id', 'some-id');
        out.push({ method, path, permission: Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) });
      }
    }
    return out;
  };

  it('每一條 /admin 路由都宣告了 @RequirePermission（共 14 條）', () => {
    const routes = adminRoutes();
    expect(routes).toHaveLength(14);
    for (const r of routes) expect(typeof r.permission).toBe('string');
  });

  it('一般成員、非公司成員、bot 打每一條 /admin 路由都回 403；沒帶 token 回 401', async () => {
    await boot();
    const botToken = await h.addBot({ id: 'botx', createdById: 'u-outsider', workspaceId: 'ws-side' });
    const callers = { member: h.token('u-member'), outsider: h.token('u-outsider'), bot: botToken };
    const routes = adminRoutes();
    for (const r of routes) {
      const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : {};
      for (const [who, token] of Object.entries(callers)) {
        const res = await h.call(r.method, r.path, token, body);
        expect({ who, route: `${r.method} ${r.path}`, status: res.status }).toEqual({
          who,
          route: `${r.method} ${r.path}`,
          status: 403,
        });
      }
      expect((await h.call(r.method, r.path, undefined, body)).status).toBe(401);
    }
    // 沒有任何寫入發生
    expect(h.audits().filter((a) => a.action.startsWith('employee.') || a.action.startsWith('department.'))).toEqual([]);
  });

  it('finance（沒有 employee.read_all）→ 403；hr → 200', async () => {
    await boot((h) => h.addEmployee({ id: 'u-fin', role: 'finance' }));
    expect((await h.call('GET', '/admin/employees', h.token('u-fin'))).status).toBe(403);
    expect((await h.call('GET', '/admin/departments', h.token('u-fin'))).status).toBe(403);
    expect((await h.call('GET', '/admin/employees', hr())).status).toBe(200);
  });

  it('沒有公司工作空間 → /company/me 與 /admin/* 回 404 company_not_configured', async () => {
    await boot();
    h.prisma.workspaces.find((w) => w.id === COMPANY_WS)!.isCompany = false;
    for (const path of ['/company/me', '/admin/employees', '/admin/departments']) {
      const res = await h.call('GET', path, hr());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('company_not_configured');
    }
  });

  // ─────────────── /company/me ───────────────

  describe('/company/me', () => {
    it('hr：角色、展開的權限、員工資料（部門與解析出的主管）', async () => {
      await boot((h) => {
        const boss = h.addEmployee({ id: 'u-boss', role: 'member', fullName: '李主管' });
        const root = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '研發部', managerProfileId: boss.profile.id });
        const hrProfile = h.prisma.profiles.find((p) => p.userId === 'u-hr') as any;
        const team = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '後端組', parentId: root.id, managerProfileId: hrProfile.id });
        hrProfile.departmentId = team.id;
        hrProfile.jobTitle = 'HRBP';
        hrProfile.hireDate = new Date(Date.UTC(2024, 2, 1));
      });
      const res = await h.call('GET', '/company/me', hr());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        workspaceId: COMPANY_WS,
        role: 'hr',
        permissions: expect.arrayContaining(['employee.read_all', 'employee.manage', 'department.manage']),
        profile: {
          employeeNo: 'H001',
          fullName: '人資小姐',
          jobTitle: 'HRBP',
          hireDate: '2024-03-01',
          employmentStatus: 'active',
          department: { name: '後端組' },
          // 後端組的主管就是他自己 → 跳過，往上找到研發部的李主管
          manager: { fullName: '李主管' },
        },
      });
      expect(res.body.permissions).not.toContain('audit.read');
    });

    it('owner 拿到全部 key；一般成員 []；非公司成員 role=null、profile=null', async () => {
      await boot();
      const owner = await h.call('GET', '/company/me', h.token('u-founder'));
      expect(owner.body.role).toBe('owner');
      expect([...owner.body.permissions].sort()).toEqual(Object.values(PERMISSIONS).sort());
      expect((await h.call('GET', '/company/me', h.token('u-member'))).body).toMatchObject({ role: 'member', permissions: [] });
      expect((await h.call('GET', '/company/me', h.token('u-outsider'))).body).toEqual({
        workspaceId: COMPANY_WS,
        role: null,
        permissions: [],
        profile: null,
      });
    });

    it('主管解析：直屬主管離職、沒有 User → 改走部門樹；都沒有 → null', async () => {
      await boot((h) => {
        const gone = h.addEmployee({ id: 'u-gone', role: null, employmentStatus: 'terminated' });
        const preloaded = h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'pre@corp.com', employeeNo: 'P001' });
        const dept = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '業務部', managerProfileId: preloaded.id });
        const parent = h.addEmployee({ id: 'u-vp', role: 'member', fullName: '副總' });
        const top = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '總部', managerProfileId: parent.profile.id });
        dept.parentId = top.id;
        const me = h.prisma.profiles.find((p) => p.userId === 'u-member') as any;
        me.managerProfileId = gone.profile.id;
        me.departmentId = dept.id;
      });
      const res = await h.call('GET', '/company/me', h.token('u-member'));
      expect(res.body.profile.manager).toEqual({ id: expect.any(String), fullName: '副總' });

      const none = await h.call('GET', '/company/me', hr());
      expect(none.body.profile.manager).toBeNull();
    });
  });

  // ─────────────── 名冊、新增、編輯 ───────────────

  describe('名冊', () => {
    it('不含 bot 使用者；依員工編號排序；可依狀態、部門、關鍵字（不分大小寫、_ 不是萬用字元）篩選與分頁', async () => {
      await boot((h) => {
        const dept = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '研發部' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'a_b@corp.com', employeeNo: 'E002', fullName: 'Amy', departmentId: dept.id });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'axb@corp.com', employeeNo: 'E001', fullName: 'Bob' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'gone@corp.com', employeeNo: 'E003', employmentStatus: 'terminated' });
        // 不該出現的 bot：profile 綁到 bot 的 User（正常流程不會發生，資料被改壞時也不能出現在名冊）
        h.prisma.addUser({ id: 'u-botuser', email: 'bot+1@oidea.system' });
        h.prisma.bots.push({ id: 'b1', workspaceId: 'ws-side', userId: 'u-botuser', tokenPrefix: 'bot_zz', tokenHash: 'x', createdById: 'u-outsider', revokedAt: null } as any);
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'bot+1@oidea.system', employeeNo: 'B001', userId: 'u-botuser' });
      });
      const all = await h.call('GET', '/admin/employees', hr());
      expect(all.status).toBe(200);
      expect(all.body.items.map((e: any) => e.employeeNo)).toEqual(['E001', 'E002', 'E003', 'H001', 'M001']);
      expect(all.body).toMatchObject({ total: 5, page: 1, pageSize: 50 });
      expect(JSON.stringify(all.body)).not.toContain('B001');

      const q = await h.call('GET', '/admin/employees?q=A_B', hr());
      expect(q.body.items.map((e: any) => e.email)).toEqual(['a_b@corp.com']);
      const terminated = await h.call('GET', '/admin/employees?status=terminated', hr());
      expect(terminated.body.items.map((e: any) => e.employeeNo)).toEqual(['E003']);
      const deptId = h.prisma.departments[0].id;
      const byDept = await h.call('GET', `/admin/employees?departmentId=${deptId}`, hr());
      expect(byDept.body.items).toEqual([expect.objectContaining({ employeeNo: 'E002', departmentName: '研發部' })]);
      const paged = await h.call('GET', '/admin/employees?page=2&pageSize=3', hr());
      expect(paged.body).toMatchObject({ total: 5, page: 2, pageSize: 3 });
      expect(paged.body.items.map((e: any) => e.employeeNo)).toEqual(['H001', 'M001']);
      expect((await h.call('GET', '/admin/employees?pageSize=201', hr())).status).toBe(400);
      expect((await h.call('GET', '/admin/employees?status=gone', hr())).status).toBe(400);
    });

    it('GET /admin/employees/:id：EmployeeDto；不在公司工作空間 → 404', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: 'ws-side', email: 'x@corp.com', employeeNo: 'X1', id: 'p-side' }));
      const id = h.prisma.profiles.find((p) => p.employeeNo === 'M001')!.id;
      const res = await h.call('GET', `/admin/employees/${id}`, hr());
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'id', 'employeeNo', 'email', 'fullName', 'departmentId', 'departmentName', 'jobTitle', 'managerProfileId',
          'managerName', 'employmentType', 'employmentStatus', 'hireDate', 'terminationDate', 'phone', 'userId',
          'disabled', 'createdAt', 'updatedAt',
        ].sort(),
      );
      expect(res.body).toMatchObject({ userId: 'u-member', disabled: false, hireDate: '2024-01-01', terminationDate: null });
      expect((await h.call('GET', '/admin/employees/p-side', hr())).status).toBe(404);
    });
  });

  describe('新增與編輯', () => {
    it('POST：201，email 存小寫；重複編號／email → 409；日期錯 → 400 invalid_date；封存部門 → 400', async () => {
      await boot((h) => h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '舊部門', archivedAt: new Date(), id: 'd-old' }));
      const ok = await h.call('POST', '/admin/employees', hr(), {
        employeeNo: 'E100',
        email: ' New@Corp.COM ',
        fullName: '新人',
        hireDate: '2026-11-01',
        employmentType: 'intern',
      });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ employeeNo: 'E100', email: 'new@corp.com', employmentType: 'intern', userId: null, disabled: false });

      const dupNo = await h.call('POST', '/admin/employees', hr(), { employeeNo: 'E100', email: 'b@corp.com', fullName: 'B', hireDate: '2026-11-01' });
      expect([dupNo.status, dupNo.body.code]).toEqual([409, 'employee_no_taken']);
      const dupEmail = await h.call('POST', '/admin/employees', hr(), { employeeNo: 'E101', email: 'NEW@corp.com', fullName: 'B', hireDate: '2026-11-01' });
      expect([dupEmail.status, dupEmail.body.code]).toEqual([409, 'email_taken']);
      const badDate = await h.call('POST', '/admin/employees', hr(), { employeeNo: 'E102', email: 'c@corp.com', fullName: 'C', hireDate: '2026-02-30' });
      expect([badDate.status, badDate.body.code]).toEqual([400, 'invalid_date']);
      const archived = await h.call('POST', '/admin/employees', hr(), {
        employeeNo: 'E103', email: 'd@corp.com', fullName: 'D', hireDate: '2026-01-01', departmentId: 'd-old',
      });
      expect([archived.status, archived.body.code]).toEqual([400, 'department_archived']);
      const noManager = await h.call('POST', '/admin/employees', hr(), {
        employeeNo: 'E104', email: 'e@corp.com', fullName: 'E', hireDate: '2026-01-01', managerProfileId: 'nope',
      });
      expect([noManager.status, noManager.body.code]).toEqual([400, 'manager_not_found']);
      const badType = await h.call('POST', '/admin/employees', hr(), { employeeNo: 'E105', email: 'f@corp.com', fullName: 'F', hireDate: '2026-01-01', employmentType: 'boss' });
      expect(badType.status).toBe(400);
      expect(h.prisma.profiles.filter((p) => ['E101', 'E102', 'E103', 'E104', 'E105'].includes(p.employeeNo))).toEqual([]);
    });

    it('PATCH：已綁定改 email → email_locked_bound；主管是自己或成環 → manager_cycle；不能用 PATCH 改成 terminated', async () => {
      await boot((h) => {
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'a@corp.com', employeeNo: 'A1', id: 'p-a' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'b@corp.com', employeeNo: 'B1', id: 'p-b', managerProfileId: 'p-a' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'c@corp.com', employeeNo: 'C1', id: 'p-c', managerProfileId: 'p-b' });
      });
      const memberId = h.prisma.profiles.find((p) => p.userId === 'u-member')!.id;
      const locked = await h.call('PATCH', `/admin/employees/${memberId}`, hr(), { email: 'changed@corp.com' });
      expect([locked.status, locked.body.code]).toEqual([400, 'email_locked_bound']);
      // 同一個 email（大小寫不同）不算改
      expect((await h.call('PATCH', `/admin/employees/${memberId}`, hr(), { email: 'U-MEMBER@corp.com' })).status).toBe(200);

      const self = await h.call('PATCH', '/admin/employees/p-a', hr(), { managerProfileId: 'p-a' });
      expect([self.status, self.body.code]).toEqual([400, 'manager_cycle']);
      // p-c → p-b → p-a；把 p-a 的主管設成 p-c 會成環（孫節點）
      const loop = await h.call('PATCH', '/admin/employees/p-a', hr(), { managerProfileId: 'p-c' });
      expect([loop.status, loop.body.code]).toEqual([400, 'manager_cycle']);
      expect(h.prisma.profiles.find((p) => p.id === 'p-a')!.managerProfileId ?? null).toBeNull();

      const toTerminated = await h.call('PATCH', '/admin/employees/p-a', hr(), { employmentStatus: 'terminated' });
      expect(toTerminated.status).toBe(400);
      const onLeave = await h.call('PATCH', '/admin/employees/p-a', hr(), { employmentStatus: 'on_leave', jobTitle: '工程師', managerProfileId: null });
      expect(onLeave.body).toMatchObject({ employmentStatus: 'on_leave', jobTitle: '工程師' });

      const dupEmail = await h.call('PATCH', '/admin/employees/p-a', hr(), { email: 'b@corp.com' });
      expect([dupEmail.status, dupEmail.body.code]).toEqual([409, 'email_taken']);
      const dupNo = await h.call('PATCH', '/admin/employees/p-a', hr(), { employeeNo: 'B1' });
      expect([dupNo.status, dupNo.body.code]).toEqual([409, 'employee_no_taken']);
      const unbound = await h.call('PATCH', '/admin/employees/p-a', hr(), { email: 'a.new@corp.com', departmentId: null });
      expect(unbound.body.email).toBe('a.new@corp.com');
    });

    it('同時把 A 的主管設成 B、B 的主管設成 A：只有一個成功（組織結構鎖）', async () => {
      await boot((h) => {
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'a@corp.com', employeeNo: 'A1', id: 'p-a' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'b@corp.com', employeeNo: 'B1', id: 'p-b' });
      });
      h.prisma.latencyMs = 5;
      const [x, y] = await Promise.all([
        h.call('PATCH', '/admin/employees/p-a', hr(), { managerProfileId: 'p-b' }),
        h.call('PATCH', '/admin/employees/p-b', hr(), { managerProfileId: 'p-a' }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 400]);
      const a = h.prisma.profiles.find((p) => p.id === 'p-a')!;
      const b = h.prisma.profiles.find((p) => p.id === 'p-b')!;
      expect(a.managerProfileId === 'p-b' && b.managerProfileId === 'p-a').toBe(false);
    });

    it('已離職的員工不能用 PATCH 改回在職（要走復職）', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'g@corp.com', employeeNo: 'G1', id: 'p-g', employmentStatus: 'terminated' }));
      const res = await h.call('PATCH', '/admin/employees/p-g', hr(), { employmentStatus: 'active' });
      expect([res.status, res.body.code]).toEqual([400, 'already_terminated']);
    });
  });

  // ─────────────── 離職、復職 ───────────────

  describe('離職（offboarding）', () => {
    const seedAlice = (h: AdminHarness) =>
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'alice@corp.com', employeeNo: 'E001', fullName: '王小美', id: 'p-alice' });

    it('依序：access token 401、socket 被斷開、他建的 bot 401、SSO 再登入被拒、員工資料仍查得到', async () => {
      await boot(seedAlice);
      // 他先用 SSO 登入（綁定、加入公司），也在別的工作空間當成員
      const login = await h.login({ sub: 'sub-alice', email: 'alice@corp.com' });
      expect(login.exchange!.status).toBe(201);
      const access = login.exchange!.body.accessToken as string;
      const refresh = login.exchange!.body.refreshToken as string;
      const aliceId = login.exchange!.body.user.id as string;
      h.prisma.addMember('ws-side', aliceId, 'member');
      expect((await h.call('GET', `/attendance/today?workspaceId=${COMPANY_WS}`, access)).status).toBe(200);

      const ws = await connectSocket(h.port(), access);
      expect((await ws.connected).startsWith('40{"sid"')).toBe(true);
      const botToken = await h.addBot({ id: 'alicebot', createdById: aliceId, workspaceId: 'ws-side' });
      expect((await h.call('GET', '/bot/me', botToken)).status).toBe(200);

      const res = await h.call('POST', '/admin/employees/p-alice/terminate', hr(), { terminationDate: '2026-10-31' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ employmentStatus: 'terminated', terminationDate: '2026-10-31', disabled: true, userId: aliceId });

      // 1. 還沒過期的 access token → 下一個請求 401
      expect((await h.call('GET', `/attendance/today?workspaceId=${COMPANY_WS}`, access)).status).toBe(401);
      expect((await h.post('/auth/refresh', { refreshToken: refresh })).status).toBe(401);
      // 2. 已連線的 socket 被伺服器斷開
      await expect(Promise.race([ws.closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('still open'), 3000))])).resolves.toBe('closed');
      // 3. 他建的 bot → 401
      expect((await h.call('GET', '/bot/me', botToken)).status).toBe(401);
      // 4. 再用 SSO 登入 → 被拒（沒有 ticket）
      const again = await h.login({ sub: 'sub-alice', email: 'alice@corp.com' });
      expect(again.callback.ticket).toBeUndefined();
      expect(['disabled', 'terminated']).toContain(again.callback.error);
      // 5. 員工資料仍然查得到
      const kept = await h.call('GET', '/admin/employees/p-alice', hr());
      expect(kept.status).toBe(200);
      expect(kept.body).toMatchObject({ employeeNo: 'E001', employmentStatus: 'terminated', disabled: true });

      // DB：停用、移出所有工作空間、refresh token 與 bot 全撤銷、資料不刪
      const user = h.prisma.users.find((u) => u.id === aliceId)!;
      expect(user.disabledAt).toBeInstanceOf(Date);
      expect(user.tokenVersion).toBe(1);
      expect(h.prisma.members.filter((m) => m.userId === aliceId)).toEqual([]);
      expect(h.prisma.refreshRows.filter((r) => r.userId === aliceId && !r.revokedAt)).toEqual([]);
      expect(h.prisma.bots.find((b) => b.id === 'alicebot')!.revokedAt).toBeInstanceOf(Date);
      const audit = h.audits('employee.terminate');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: 'u-hr',
        workspaceId: COMPANY_WS,
        targetId: 'p-alice',
        metadata: expect.objectContaining({ userId: aliceId, removedMemberships: 2, revokedBots: 1, disconnectedSockets: 1 }),
      });
      ws.sock.close();
    });

    it('復職之後再用 SSO 登入可以打 /attendance/today', async () => {
      await boot(seedAlice);
      const first = await h.login({ sub: 'sub-alice', email: 'alice@corp.com' });
      const aliceId = first.exchange!.body.user.id;
      expect((await h.call('POST', '/admin/employees/p-alice/terminate', hr(), { terminationDate: '2026-10-31' })).status).toBe(200);

      const back = await h.call('POST', '/admin/employees/p-alice/reinstate', hr());
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ employmentStatus: 'active', terminationDate: null, disabled: false });
      expect(h.prisma.users.find((u) => u.id === aliceId)!.disabledAt).toBeNull();
      // 復職不會自動加回工作空間；下一次 SSO 登入才加回公司工作空間
      expect(h.prisma.members.filter((m) => m.userId === aliceId)).toEqual([]);
      // 離職前的 access token 不會因為復職而復活（離職時 tokenVersion + 1）
      expect((await h.call('GET', `/attendance/today?workspaceId=${COMPANY_WS}`, first.exchange!.body.accessToken)).status).toBe(401);

      const again = await h.login({ sub: 'sub-alice', email: 'alice@corp.com' });
      expect(again.exchange!.status).toBe(201);
      const today = await h.call('GET', `/attendance/today?workspaceId=${COMPANY_WS}`, again.exchange!.body.accessToken);
      expect(today.status).toBe(200);
      expect(h.prisma.members.filter((m) => m.userId === aliceId)).toEqual([expect.objectContaining({ workspaceId: COMPANY_WS, role: 'member' })]);
      expect(h.audits('employee.reinstate')).toHaveLength(1);

      const notTerminated = await h.call('POST', '/admin/employees/p-alice/reinstate', hr());
      expect([notTerminated.status, notTerminated.body.code]).toEqual([400, 'not_terminated']);
    });

    it.each([
      ['Workspace.ownerId（公司工作空間的主 owner）', 'u-founder', COMPANY_WS],
      ['別的工作空間的共同 owner（成員角色 owner）', 'u-co', 'ws-side'],
    ])('離職對象是 owner（%s）、還沒移交 → 400 owner_transfer_required，而且什麼都沒寫', async (_label, userId, wsId) => {
      await boot((h) => {
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'founder@corp.com', employeeNo: 'F001', userId: 'u-founder', id: 'p-u-founder' });
        h.addEmployee({ id: 'u-co', role: 'member' });
        h.prisma.addMember('ws-side', 'u-co', 'owner');
        h.prisma.refreshRows.push({ id: 'rt', userId, familyId: 'f', tokenHash: 'h', expiresAt: new Date(Date.now() + 1e9), revokedAt: null, rotatedAt: null, tokenVersion: 0, createdAt: new Date() });
      });
      // 已刪除的工作空間不算（移交不了，也不該擋住離職）
      h.prisma.addWorkspace({ id: 'ws-deleted', ownerId: 'u-member', deletedAt: new Date() });
      const profileId = h.prisma.profiles.find((p) => p.userId === userId)!.id;
      const before = JSON.stringify({ u: h.prisma.users, p: h.prisma.profiles, m: h.prisma.members, b: h.prisma.bots, r: h.prisma.refreshRows });

      const res = await h.call('POST', `/admin/employees/${profileId}/terminate`, hr(), { terminationDate: '2026-10-31' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('owner_transfer_required');
      expect(res.body.workspaces).toEqual([expect.objectContaining({ id: wsId })]);
      expect(JSON.stringify({ u: h.prisma.users, p: h.prisma.profiles, m: h.prisma.members, b: h.prisma.bots, r: h.prisma.refreshRows })).toBe(before);
      expect(h.audits('employee.terminate')).toEqual([]);
      // 他手上的 token 照樣能用
      expect((await h.call('GET', '/company/me', h.token(userId))).status).toBe(200);

      // 已刪除工作空間的 owner 不擋
      const memberProfile = h.prisma.profiles.find((p) => p.userId === 'u-member')!.id;
      expect((await h.call('POST', `/admin/employees/${memberProfile}/terminate`, hr(), { terminationDate: '2026-10-31' })).status).toBe(200);
    });

    it('自己 → cannot_terminate_self；已離職 → already_terminated；離職日早於到職日 → invalid_date；沒有 User 的預建員工只改 profile', async () => {
      await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'pre@corp.com', employeeNo: 'P1', id: 'p-pre' }));
      const self = h.prisma.profiles.find((p) => p.userId === 'u-hr')!.id;
      const selfRes = await h.call('POST', `/admin/employees/${self}/terminate`, hr(), { terminationDate: '2026-10-31' });
      expect([selfRes.status, selfRes.body.code]).toEqual([400, 'cannot_terminate_self']);
      const early = await h.call('POST', '/admin/employees/p-pre/terminate', hr(), { terminationDate: '2023-12-31' });
      expect([early.status, early.body.code]).toEqual([400, 'invalid_date']);

      expect((await h.call('POST', '/admin/employees/p-pre/terminate', hr(), { terminationDate: '2026-10-31' })).status).toBe(200);
      expect(h.prisma.profiles.find((p) => p.id === 'p-pre')).toMatchObject({ employmentStatus: 'terminated', userId: null });
      const twice = await h.call('POST', '/admin/employees/p-pre/terminate', hr(), { terminationDate: '2026-10-31' });
      expect([twice.status, twice.body.code]).toEqual([400, 'already_terminated']);
    });
  });

  // ─────────────── 解除綁定 ───────────────

  it('解除綁定：清 userId、刪 authentik Account、舊 session 全部失效；新的 sub 再登入會重新綁定', async () => {
    await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'bob@corp.com', employeeNo: 'E009', id: 'p-bob' }));
    const login = await h.login({ sub: 'sub-old', email: 'bob@corp.com' });
    const bobId = login.exchange!.body.user.id;
    const ws = await connectSocket(h.port(), login.exchange!.body.accessToken);
    await ws.connected;

    const res = await h.call('POST', '/admin/employees/p-bob/unbind', hr());
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeNull();
    expect(h.prisma.accounts.filter((a) => a.userId === bobId && a.provider === 'authentik')).toEqual([]);
    expect((await h.call('GET', '/company/me', login.exchange!.body.accessToken)).status).toBe(401);
    expect((await h.post('/auth/refresh', { refreshToken: login.exchange!.body.refreshToken })).status).toBe(401);
    await expect(Promise.race([ws.closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 3000))])).resolves.toBe('closed');
    expect(h.audits('employee.unbind')).toHaveLength(1);

    const notBound = await h.call('POST', '/admin/employees/p-bob/unbind', hr());
    expect([notBound.status, notBound.body.code]).toEqual([400, 'not_bound']);

    const rebind = await h.login({ sub: 'sub-new', email: 'bob@corp.com' });
    expect(rebind.exchange!.status).toBe(201);
    expect(h.prisma.profiles.find((p) => p.id === 'p-bob')!.userId).toBe(bobId);
  });

  // ─────────────── 匯入 ───────────────

  describe('CSV 匯入', () => {
    const CSV = 'employeeNo,email,fullName,hireDate,departmentName\nE001,a@corp.com,甲,2024-01-01,研發部\nE002,bad,乙,2024-01-01,研發部\nE003,c@corp.com,丙,2024-01-01\n';

    it('dryRun 不寫入任何東西（也不寫 audit）；實際匯入回 created／updated／unchanged／errors', async () => {
      await boot();
      const before = JSON.stringify({ p: h.prisma.profiles, d: h.prisma.departments, a: h.prisma.auditLogs });
      const dry = await h.call('POST', '/admin/employees/import', hr(), { csv: CSV, dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ created: 1, updated: 0, unchanged: 0, dryRun: true });
      expect(dry.body.errors).toEqual([
        { line: 3, message: 'email 格式不正確' },
        { line: 4, message: expect.stringContaining('欄位數') },
      ]);
      expect(JSON.stringify({ p: h.prisma.profiles, d: h.prisma.departments, a: h.prisma.auditLogs })).toBe(before);

      const real = await h.call('POST', '/admin/employees/import', hr(), { csv: CSV });
      expect(real.body).toMatchObject({ created: 1, updated: 0, unchanged: 0, dryRun: false });
      expect(h.prisma.profiles.find((p) => p.employeeNo === 'E001')).toBeDefined();
      expect(h.audits('employee.import')).toEqual([
        expect.objectContaining({ actorId: 'u-hr', metadata: expect.objectContaining({ created: 1, failed: 1, malformed: 1, source: 'admin' }) }),
      ]);

      const again = await h.call('POST', '/admin/employees/import', hr(), { csv: 'employeeNo,email,fullName,hireDate,departmentName\nE001,a@corp.com,甲,2024-01-01,研發部\n' });
      expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 1, errors: [] });
    });

    it('超過 1 MB → 413；檔頭錯 → 400 invalid_csv', async () => {
      await boot();
      const big = 'employeeNo,email,fullName,hireDate\n' + 'x'.repeat(1024 * 1024);
      expect((await h.call('POST', '/admin/employees/import', hr(), { csv: big })).status).toBe(413);
      const bad = await h.call('POST', '/admin/employees/import', hr(), { csv: 'foo,bar\n1,2\n' });
      expect([bad.status, bad.body.code]).toEqual([400, 'invalid_csv']);
    });
  });

  // ─────────────── audit ───────────────

  it('每一個新的寫入動作都有對應的 audit 紀錄', async () => {
    await boot((h) => h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'z@corp.com', employeeNo: 'Z1', id: 'p-z', userId: null }));
    const t = hr();
    const created = await h.call('POST', '/admin/employees', t, { employeeNo: 'N1', email: 'n1@corp.com', fullName: 'N', hireDate: '2026-01-01' });
    await h.call('PATCH', `/admin/employees/${created.body.id}`, t, { jobTitle: '新職稱' });
    await h.call('POST', `/admin/employees/${created.body.id}/terminate`, t, { terminationDate: '2026-10-31' });
    await h.call('POST', `/admin/employees/${created.body.id}/reinstate`, t);
    h.prisma.profiles.find((p) => p.id === 'p-z')!.userId = 'u-outsider';
    await h.call('POST', '/admin/employees/p-z/unbind', t);
    await h.call('POST', '/admin/employees/import', t, { csv: 'employeeNo,email,fullName,hireDate\nN2,n2@corp.com,N2,2026-01-01\n' });
    const dept = await h.call('POST', '/admin/departments', t, { name: '品管部' });
    await h.call('PATCH', `/admin/departments/${dept.body.id}`, t, { name: '品保部' });
    await h.call('POST', `/admin/departments/${dept.body.id}/archive`, t);
    await h.call('POST', `/admin/departments/${dept.body.id}/unarchive`, t);
    await h.call('DELETE', `/admin/departments/${dept.body.id}`, t);

    for (const action of H2_AUDIT_ACTIONS) {
      const rows = h.audits(action);
      expect({ action, count: rows.length }).toEqual({ action, count: 1 });
      expect(rows[0]).toMatchObject({ actorId: 'u-hr', workspaceId: COMPANY_WS });
    }
    // audit 不含 email／姓名
    const dumped = JSON.stringify(h.audits().filter((a) => a.action.startsWith('employee.')));
    expect(dumped).not.toContain('n1@corp.com');
  });

  it('GET /audit/workspaces/:id：{items, nextCursor} 分頁、from/to（to 不含）、action 前綴 prefix.*；一般成員 403', async () => {
    await boot();
    const base = Date.UTC(2026, 9, 1);
    for (let i = 0; i < 5; i++) {
      h.prisma.auditLogs.push({ id: `a${i}`, actorId: 'u-hr', workspaceId: COMPANY_WS, action: i % 2 ? 'employee.update' : 'department.create', targetType: null, targetId: null, metadata: null, ipAddress: null, createdAt: new Date(base + i * 1000) } as any);
    }
    // 同一個時間點的兩筆：靠 id 排序，cursor 不會漏也不會重複
    h.prisma.auditLogs.push({ id: 'b9', actorId: null, workspaceId: COMPANY_WS, action: 'employee.create', createdAt: new Date(base + 4000) } as any);
    h.prisma.auditLogs.push({ id: 'zz', actorId: null, workspaceId: 'ws-side', action: 'employee.create', createdAt: new Date(base) } as any);
    const owner = h.token('u-founder');

    const p1 = await h.call('GET', `/audit/workspaces/${COMPANY_WS}?limit=2`, owner);
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i: any) => i.id)).toEqual(['b9', 'a4']);
    expect(p1.body.items[1]).toMatchObject({ actor: { id: 'u-hr' }, createdAt: new Date(base + 4000).toISOString() });
    const p2 = await h.call('GET', `/audit/workspaces/${COMPANY_WS}?limit=2&cursor=${p1.body.nextCursor}`, owner);
    expect(p2.body.items.map((i: any) => i.id)).toEqual(['a3', 'a2']);
    const p3 = await h.call('GET', `/audit/workspaces/${COMPANY_WS}?limit=2&cursor=${p2.body.nextCursor}`, owner);
    expect(p3.body).toEqual({ items: [expect.objectContaining({ id: 'a1' }), expect.objectContaining({ id: 'a0' })], nextCursor: null });

    const prefix = await h.call('GET', `/audit/workspaces/${COMPANY_WS}?action=employee.*`, owner);
    expect(prefix.body.items.map((i: any) => i.id)).toEqual(['b9', 'a3', 'a1']);
    const exact = await h.call('GET', `/audit/workspaces/${COMPANY_WS}?action=employee.update`, owner);
    expect(exact.body.items.map((i: any) => i.id)).toEqual(['a3', 'a1']);
    const range = await h.call(
      'GET',
      `/audit/workspaces/${COMPANY_WS}?from=${new Date(base + 1000).toISOString()}&to=${new Date(base + 3000).toISOString()}`,
      owner,
    );
    expect(range.body.items.map((i: any) => i.id)).toEqual(['a2', 'a1']);
    expect((await h.call('GET', `/audit/workspaces/${COMPANY_WS}?from=yesterday`, owner)).body.code).toBe('invalid_date');
    expect((await h.call('GET', `/audit/workspaces/${COMPANY_WS}?cursor=garbage`, owner)).status).toBe(400);
    expect((await h.call('GET', `/audit/workspaces/${COMPANY_WS}`, h.token('u-member'))).status).toBe(403);
    expect((await h.call('GET', `/audit/workspaces/${COMPANY_WS}`, hr())).status).toBe(403);
  });

  // ─────────────── bot ───────────────

  describe('bot', () => {
    it('建立者被停用 → bot 打 /bot/* 回 401（也打不了一般 API）', async () => {
      await boot();
      const token = await h.addBot({ id: 'mbot', createdById: 'u-member', workspaceId: 'ws-side' });
      expect((await h.call('GET', '/bot/me', token)).status).toBe(200);
      h.prisma.users.find((u) => u.id === 'u-member')!.disabledAt = new Date();
      await h.redis.store.clear();
      expect((await h.call('GET', '/bot/me', token)).status).toBe(401);
      expect((await h.call('GET', '/company/me', token)).status).toBe(401);
    });

    it('把 bot 加進公司工作空間 → 403；公司工作空間裡既有的 bot → 401', async () => {
      await boot();
      const res = await h.call('POST', `/workspaces/${COMPANY_WS}/bots`, h.token('u-founder'), { name: 'helper' });
      expect(res.status).toBe(403);
      expect(h.prisma.bots).toEqual([]);
      expect(h.prisma.members.filter((m) => m.workspaceId === COMPANY_WS).map((m) => m.userId).sort()).toEqual(['u-founder', 'u-hr', 'u-member']);

      const legacy = await h.addBot({ id: 'cbot', createdById: 'u-founder', workspaceId: COMPANY_WS });
      expect((await h.call('GET', '/bot/me', legacy)).status).toBe(401);
    });
  });
});
