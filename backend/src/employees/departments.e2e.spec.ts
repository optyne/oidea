import { FakeIdp } from '../auth/oidc/testing/fake-idp';
import { sqlText } from '../common/testing/fake-email-raw';
import { ORG_LOCK_KEY } from './org-lock';
import { AdminHarness, COMPANY_WS } from './testing/admin-harness';

/**
 * H2 驗收：部門（spec §5 H2「部門」、contract「Departments」）。真的 Nest HTTP，Prisma 用記憶體版
 * （照 migration 手寫的 partial unique index 擋根部門／子部門重名）。
 */
describe('H2 部門後台（端到端）', () => {
  const idp = new FakeIdp();
  let h: AdminHarness;

  beforeAll(() => idp.start());
  afterAll(() => idp.stop());
  afterEach(async () => {
    await h?.close();
  });

  const boot = async (seed: (h: AdminHarness) => unknown = () => undefined) => {
    h = new AdminHarness(idp);
    h.seedCompany();
    h.addEmployee({ id: 'u-hr', role: 'hr', employeeNo: 'H001' });
    await seed(h);
    await h.start();
    return h;
  };
  const hr = () => h.token('u-hr');
  const create = (body: Record<string, unknown>) => h.call('POST', '/admin/departments', hr(), body);
  const patch = (id: string, body: Record<string, unknown>) => h.call('PATCH', `/admin/departments/${id}`, hr(), body);

  /** 研發部 > 後端組 > 資料庫小組 */
  const seedTree = (h: AdminHarness) => {
    const root = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '研發部', id: 'd-root' });
    const child = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '後端組', id: 'd-child', parentId: root.id });
    h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '資料庫小組', id: 'd-grand', parentId: child.id });
  };

  describe('移動不能形成循環 → 400 department_cycle', () => {
    it('把自己設成自己的上層', async () => {
      await boot(seedTree);
      const res = await patch('d-child', { parentId: 'd-child' });
      expect([res.status, res.body.code]).toEqual([400, 'department_cycle']);
    });

    it('把孫節點設成上層（也包含直接子節點）', async () => {
      await boot(seedTree);
      const grand = await patch('d-root', { parentId: 'd-grand' });
      expect([grand.status, grand.body.code]).toEqual([400, 'department_cycle']);
      const child = await patch('d-root', { parentId: 'd-child' });
      expect([child.status, child.body.code]).toEqual([400, 'department_cycle']);
      expect(h.prisma.departments.find((d) => d.id === 'd-root')!.parentId).toBeNull();
      expect(h.audits('department.update')).toEqual([]);
    });

    it('合法的移動：孫節點移到根（parentId: null）、再移回去', async () => {
      await boot(seedTree);
      const toRoot = await patch('d-grand', { parentId: null });
      expect(toRoot.status).toBe(200);
      expect(toRoot.body).toMatchObject({ id: 'd-grand', parentId: null });
      const back = await patch('d-grand', { parentId: 'd-root' });
      expect(back.body.parentId).toBe('d-root');
      expect(h.audits('department.update')).toHaveLength(2);
    });

    it('同時送出兩個會互相成環的移動（A 移到 B 底下、B 移到 A 底下）：只有一個成功（組織結構鎖）', async () => {
      await boot((h) => {
        h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: 'A', id: 'd-a' });
        h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: 'B', id: 'd-b' });
      });
      h.prisma.latencyMs = 5; // 讓兩個請求在 DB 這一步交錯；沒有鎖的話兩個都會通過檢查
      const [x, y] = await Promise.all([patch('d-a', { parentId: 'd-b' }), patch('d-b', { parentId: 'd-a' })]);
      expect([x.status, y.status].sort()).toEqual([200, 400]);
      expect([x.body.code, y.body.code]).toContain('department_cycle');
      const a = h.prisma.departments.find((d) => d.id === 'd-a')!;
      const b = h.prisma.departments.find((d) => d.id === 'd-b')!;
      expect(a.parentId === 'd-b' && b.parentId === 'd-a').toBe(false);
      expect(h.prisma.executed.filter((s) => s.includes('pg_advisory_xact_lock')).length).toBeGreaterThanOrEqual(2);
      expect(h.prisma.$executeRaw.mock.calls.every((c: unknown[]) => c[1] === ORG_LOCK_KEY)).toBe(true);
    });
  });

  describe('同一層不能同名（不分大小寫）→ 409 department_name_taken', () => {
    it('根部門同名、只差大小寫 → 409', async () => {
      await boot();
      expect((await create({ name: 'Sales' })).status).toBe(201);
      const dup = await create({ name: 'SALES' });
      expect([dup.status, dup.body.code]).toEqual([409, 'department_name_taken']);
      expect(h.prisma.departments.filter((d) => d.name.toLowerCase() === 'sales')).toHaveLength(1);
    });

    it('程式裡的檢查被繞過（同時有人建立）時，手寫的 partial unique index 擋下，一樣回 409', async () => {
      await boot((h) => h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: 'Sales' }));
      // 模擬競態：程式裡的重名查詢看不到對方剛 commit 的那筆
      const original = h.prisma.$queryRaw.getMockImplementation()!;
      h.prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) =>
        sqlText(strings).includes('FROM "departments"') ? Promise.resolve([]) : original(strings, ...values),
      );
      const dup = await create({ name: 'sALES' });
      expect([dup.status, dup.body.code]).toEqual([409, 'department_name_taken']);
      expect(h.prisma.departments).toHaveLength(1);
      // 子部門的索引也一樣
      const parent = h.prisma.departments[0];
      h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: 'East', parentId: parent.id });
      const child = await create({ name: 'EAST', parentId: parent.id });
      expect([child.status, child.body.code]).toEqual([409, 'department_name_taken']);
      // 改名撞名也一樣
      const other = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: 'Ops' });
      const rename = await patch(other.id, { name: 'SALES' });
      expect([rename.status, rename.body.code]).toEqual([409, 'department_name_taken']);
    });

    it('子部門：同一個上層底下同名 → 409；不同上層、或跟根部門同名 → 可以', async () => {
      await boot(seedTree);
      const dup = await create({ name: '後端組', parentId: 'd-root' });
      expect([dup.status, dup.body.code]).toEqual([409, 'department_name_taken']);
      expect((await create({ name: '後端組', parentId: 'd-grand' })).status).toBe(201);
      expect((await create({ name: '後端組' })).status).toBe(201);
      // 移到已有同名部門的上層底下 → 409
      const move = await patch('d-grand', { parentId: null, name: '研發部' });
      expect([move.status, move.body.code]).toEqual([409, 'department_name_taken']);
      // 只改大小寫不算撞到自己
      expect((await patch('d-root', { name: '研發部' })).status).toBe(200);
      const caseOnly = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: 'Ops' });
      expect((await patch(caseOnly.id, { name: 'OPS' })).body.name).toBe('OPS');
    });
  });

  describe('刪除、封存', () => {
    it('有員工（含已離職）或子部門 → 409 department_not_empty；空的才刪得掉', async () => {
      await boot((h) => {
        seedTree(h);
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'gone@corp.com', employeeNo: 'G1', departmentId: 'd-grand', employmentStatus: 'terminated' });
      });
      const withChild = await h.call('DELETE', '/admin/departments/d-child', hr());
      expect([withChild.status, withChild.body.code]).toEqual([409, 'department_not_empty']);
      const withTerminated = await h.call('DELETE', '/admin/departments/d-grand', hr());
      expect([withTerminated.status, withTerminated.body.code]).toEqual([409, 'department_not_empty']);
      expect(h.prisma.departments).toHaveLength(3);

      const empty = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '臨時' });
      expect((await h.call('DELETE', `/admin/departments/${empty.id}`, hr())).status).toBe(200);
      expect(h.prisma.departments.find((d) => d.id === empty.id)).toBeUndefined();
      expect(h.audits('department.delete')).toHaveLength(1);
      expect((await h.call('DELETE', '/admin/departments/nope', hr())).body.code).toBe('department_not_found');
    });

    it('封存允許有成員；預設列表不含封存的，includeArchived=true 才有；取消封存', async () => {
      await boot((h) => {
        seedTree(h);
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'a@corp.com', employeeNo: 'A1', departmentId: 'd-grand' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'b@corp.com', employeeNo: 'B1', departmentId: 'd-grand', employmentStatus: 'terminated' });
      });
      const archived = await h.call('POST', '/admin/departments/d-grand/archive', hr());
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ id: 'd-grand', archivedAt: expect.any(String), memberCount: 1, childCount: 0 });
      // 再封存一次：沒有變化，不寫 audit
      await h.call('POST', '/admin/departments/d-grand/archive', hr());
      expect(h.audits('department.archive')).toHaveLength(1);

      const list = await h.call('GET', '/admin/departments', hr());
      expect(list.body.map((d: any) => d.id).sort()).toEqual(['d-child', 'd-root']);
      expect(list.body.find((d: any) => d.id === 'd-child')).toMatchObject({ childCount: 1, memberCount: 0 });
      const all = await h.call('GET', '/admin/departments?includeArchived=true', hr());
      expect(all.body.map((d: any) => d.id).sort()).toEqual(['d-child', 'd-grand', 'd-root']);

      // 封存的部門底下不能再建子部門、員工不能被指派過去
      const under = await create({ name: '新組', parentId: 'd-grand' });
      expect([under.status, under.body.code]).toEqual([400, 'department_archived']);

      const back = await h.call('POST', '/admin/departments/d-grand/unarchive', hr());
      expect(back.body.archivedAt).toBeNull();
      expect(h.audits('department.unarchive')).toHaveLength(1);
    });
  });

  describe('主管', () => {
    it('主管必須是公司工作空間裡沒離職的員工；可以指定、可以清掉', async () => {
      await boot((h) => {
        seedTree(h);
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'm@corp.com', employeeNo: 'M1', id: 'p-m', fullName: '王經理' });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 't@corp.com', employeeNo: 'T1', id: 'p-t', employmentStatus: 'terminated' });
        h.prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-hr' });
        h.prisma.addProfile({ workspaceId: 'ws-side', email: 'x@corp.com', employeeNo: 'X1', id: 'p-side' });
      });
      const ok = await patch('d-root', { managerProfileId: 'p-m' });
      expect(ok.body).toMatchObject({ managerProfileId: 'p-m', managerName: '王經理' });
      for (const bad of ['p-t', 'p-side', 'nope']) {
        const res = await patch('d-child', { managerProfileId: bad });
        expect([bad, res.status, res.body.code]).toEqual([bad, 400, 'manager_not_found']);
      }
      const created = await create({ name: '業務部', managerProfileId: 'p-side' });
      expect(created.body.code).toBe('manager_not_found');
      const cleared = await patch('d-root', { managerProfileId: null });
      expect(cleared.body).toMatchObject({ managerProfileId: null, managerName: null });
    });
  });

  it('POST：201 DepartmentDto；上層不存在 → 404 department_not_found；名稱空白 → 400', async () => {
    await boot();
    const res = await create({ name: '  研發部 ', sortOrder: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: '研發部',
      parentId: null,
      managerProfileId: null,
      managerName: null,
      sortOrder: 3,
      archivedAt: null,
      memberCount: 0,
      childCount: 0,
    });
    expect((await create({ name: 'x', parentId: 'nope' })).body.code).toBe('department_not_found');
    expect((await create({ name: '   ' })).status).toBe(400);
    expect((await create({ name: 'x', extra: 1 })).status).toBe(400);
    expect(h.audits('department.create')).toEqual([
      expect.objectContaining({ actorId: 'u-hr', workspaceId: COMPANY_WS, targetId: res.body.id }),
    ]);
  });
});
