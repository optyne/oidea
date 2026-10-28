import { FakeIdp } from '../auth/oidc/testing/fake-idp';
import { LeaveHarness, COMPANY_WS } from './testing/leave-harness';
import { annualPeriodOn, entitlementForPeriod, isPeriodStart } from './leave-entitlement';

/**
 * H3 獨立審查補的測試（原本是審查者的 probe，現在固定下來）。涵蓋作者測試沒碰到的地方：
 * 假日整年取代的鎖、注入的 Clock 與 Asia/Taipei 換日、preview／balance 的 assertMember、期間邊界、
 * 改到職日之後的調整、跨工作空間的重疊。每個標題保留原本的 probe 名稱。
 */
describe('H3 leave review (independent review probes)', () => {
  const idp = new FakeIdp();
  let h: LeaveHarness;
  beforeAll(() => idp.start());
  afterAll(() => idp.stop());
  afterEach(async () => {
    await h?.close();
  });

  const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const boot = async (clockMs: number, seed: (h: LeaveHarness) => unknown = () => undefined) => {
    h = new LeaveHarness(idp);
    h.clock.set(clockMs);
    h.seedCompany();
    h.addEmployee({ id: 'u-hr', role: 'hr', employeeNo: 'H001', hireDate: D('2020-01-01') });
    h.addEmployee({ id: 'u-hr2', role: 'hr', employeeNo: 'H002', hireDate: D('2020-01-01') });
    h.addEmployee({ id: 'u-mem', role: 'member', employeeNo: 'M001', hireDate: D('2024-03-01') });
    await seed(h);
    await h.start();
    return h;
  };
  const tok = (id: string) => h.token(id);
  const apply = (body: Record<string, unknown>, as = 'u-mem') =>
    h.call('POST', '/attendance/leaves', tok(as), { workspaceId: COMPANY_WS, type: 'annual', ...body });
  const profileId = (userId: string) => h.prisma.profiles.find((p) => p.userId === userId)!.id;

  it('probe_taipei_today_uses_clock_at_anniversary: 2026-02-28 17:00Z is 2026-03-01 in Taipei → new period', async () => {
    await boot(Date.UTC(2026, 1, 28, 17));
    const bal = await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok('u-mem'));
    expect(bal.body).toMatchObject({ periodStart: '2026-03-01', entitled: 10 });
    const admin = await h.call('GET', `/admin/employees/${profileId('u-mem')}/leave-balance`, tok('u-hr'));
    expect(admin.body.current).toMatchObject({ periodStart: '2026-03-01', entitled: 10 });
    expect(admin.body.previous).toMatchObject({ periodStart: '2025-03-01', entitled: 7 });
  });

  it('probe_taipei_today_before_midnight: 2026-02-28 15:59Z is still 2026-02-28 in Taipei → old period', async () => {
    await boot(Date.UTC(2026, 1, 28, 15, 59));
    const bal = await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok('u-mem'));
    expect(bal.body).toMatchObject({ periodStart: '2025-03-01', entitled: 7 });
  });

  it('probe_leave_on_period_last_day: last day of period belongs to that period; next day starts new one', async () => {
    // hire 2023-11-03 → period [2025-11-03, 2026-11-02] (10 days); 2026-11-02 is a Monday
    await boot(Date.UTC(2026, 9, 28, 2), (h) =>
      h.addEmployee({ id: 'u-p', role: 'member', employeeNo: 'P001', hireDate: D('2023-11-03') }),
    );
    const last = await h.call(
      'GET',
      `/attendance/leaves/preview?workspaceId=${COMPANY_WS}&type=annual&startDate=2026-11-02&endDate=2026-11-02`,
      tok('u-p'),
    );
    expect(last.body).toEqual({
      days: 1,
      annual: { periodStart: '2025-11-03', periodEnd: '2026-11-02', entitled: 10, adjusted: 0, used: 0, remaining: 10 },
    });
    const span = await apply({ startDate: '2026-11-02', endDate: '2026-11-03' }, 'u-p');
    expect([span.status, span.body.code]).toEqual([400, 'leave_spans_period']);
    const next = await h.call(
      'GET',
      `/attendance/leaves/preview?workspaceId=${COMPANY_WS}&type=annual&startDate=2026-11-03&endDate=2026-11-03`,
      tok('u-p'),
    );
    expect(next.body.annual).toMatchObject({ periodStart: '2026-11-03', entitled: 14 });
    // a pm-only start on the last day is still that period
    const pm = await apply({ startDate: '2026-11-02', endDate: '2026-11-02', startPart: 'pm' }, 'u-p');
    expect([pm.status, pm.body.days]).toEqual([201, 0.5]);
  });

  it('probe_holiday_change_does_not_recompute_used: stored days stay after a holiday is added', async () => {
    await boot(Date.UTC(2026, 9, 28, 2));
    expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-03' })).body.days).toBe(2);
    const put = await h.call('PUT', '/admin/holidays/2026', tok('u-hr'), { items: [{ date: '2026-11-03', name: 'x' }] });
    expect(put.status).toBe(200);
    const bal = await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok('u-mem'));
    expect(bal.body).toMatchObject({ used: 2, remaining: 8 });
  });

  it('probe_concurrent_holiday_replace: two PUTs of the same year both succeed, final list is one of them', async () => {
    await boot(Date.UTC(2026, 9, 28, 2));
    h.prisma.latencyMs = 5;
    const a = { items: [{ date: '2026-01-01', name: 'A1' }, { date: '2026-02-01', name: 'A2' }] };
    const b = { items: [{ date: '2026-01-01', name: 'B1' }, { date: '2026-03-01', name: 'B2' }] };
    const [ra, rb] = await Promise.all([
      h.call('PUT', '/admin/holidays/2026', tok('u-hr'), a),
      h.call('PUT', '/admin/holidays/2026', tok('u-hr2'), b),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const names = h.prisma.holidays.map((x) => x.name).sort();
    expect([['A1', 'A2'], ['B1', 'B2']]).toContainEqual(names);
  });

  it('probe_cross_workspace_profile: hr cannot read/adjust a profile of a non-company workspace (404)', async () => {
    await boot(Date.UTC(2026, 9, 28, 2), (h) => {
      h.prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-founder' });
      h.prisma.addProfile({ workspaceId: 'ws-side', email: 'side@corp.com', employeeNo: 'S001', id: 'p-side', hireDate: D('2020-01-01') });
    });
    expect((await h.call('GET', '/admin/employees/p-side/leave-balance', tok('u-hr'))).status).toBe(404);
    const adj = await h.call('POST', '/admin/employees/p-side/leave-balance/adjustments', tok('u-hr'), {
      periodStart: '2026-01-01',
      days: 1,
      reason: 'x',
    });
    expect(adj.status).toBe(404);
    expect(h.prisma.leaveAdjustments).toHaveLength(0);
  });

  it('probe_non_member_workspace: preview/balance/create for a workspace the user is not in → 403', async () => {
    await boot(Date.UTC(2026, 9, 28, 2), (h) => h.prisma.addWorkspace({ id: 'ws-other', ownerId: 'u-founder' }));
    const q = `workspaceId=ws-other&type=sick&startDate=2026-11-02&endDate=2026-11-02`;
    expect((await h.call('GET', `/attendance/leaves/preview?${q}`, tok('u-mem'))).status).toBe(403);
    expect((await h.call('GET', `/attendance/leaves/balance?workspaceId=ws-other`, tok('u-mem'))).status).toBe(403);
    const c = await h.call('POST', '/attendance/leaves', tok('u-mem'), {
      workspaceId: 'ws-other',
      type: 'sick',
      startDate: '2026-11-02',
      endDate: '2026-11-02',
    });
    expect(c.status).toBe(403);
  });

  it('probe_invalid_inputs: 2026-02-30, 367-day span, bad part, datetime string', async () => {
    await boot(Date.UTC(2026, 9, 28, 2));
    const bad = await apply({ startDate: '2026-02-30', endDate: '2026-03-02', type: 'sick' });
    expect(bad.status).toBe(400);
    const long = await apply({ startDate: '2026-01-01', endDate: '2027-01-02', type: 'sick' });
    expect([long.status, long.body.code]).toEqual([400, 'leave_invalid_range']);
    const part = await apply({ startDate: '2026-11-02', endDate: '2026-11-02', startPart: 'am', type: 'sick' });
    expect(part.status).toBe(400);
    expect(h.prisma.leaveRequests).toHaveLength(0);
  });

  it('probe_overlap_across_workspaces: own pending/approved requests in any workspace block the dates → 409', async () => {
    await boot(Date.UTC(2026, 9, 28, 2), (h) => {
      h.prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-founder' });
      h.prisma.addMember('ws-side', 'u-mem', 'member');
    });
    expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-03', type: 'sick' })).status).toBe(201);
    const sideBody = { workspaceId: 'ws-side', type: 'sick', startDate: '2026-11-03', endDate: '2026-11-04' };
    const side = await h.call('POST', '/attendance/leaves', tok('u-mem'), sideBody);
    expect([side.status, side.body.code]).toEqual([409, 'leave_overlap']);
    const q = `workspaceId=ws-side&type=sick&startDate=2026-11-03&endDate=2026-11-04`;
    const preview = await h.call('GET', `/attendance/leaves/preview?${q}`, tok('u-mem'));
    expect([preview.status, preview.body.code]).toEqual([409, 'leave_overlap']);
    // the next day is free in either workspace
    const free = await h.call('POST', '/attendance/leaves', tok('u-mem'), { ...sideBody, startDate: '2026-11-04' });
    expect(free.status).toBe(201);
    expect(h.prisma.leaveRequests).toHaveLength(2);
  });

  it('overlap across workspaces is serialized: two concurrent overlapping requests in different workspaces → one wins', async () => {
    await boot(Date.UTC(2026, 9, 28, 2), (h) => {
      h.prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-founder' });
      h.prisma.addMember('ws-side', 'u-mem', 'member');
    });
    h.prisma.latencyMs = 5;
    const [x, y] = await Promise.all([
      apply({ startDate: '2026-11-02', endDate: '2026-11-03', type: 'sick' }),
      h.call('POST', '/attendance/leaves', tok('u-mem'), {
        workspaceId: 'ws-side',
        type: 'sick',
        startDate: '2026-11-03',
        endDate: '2026-11-04',
      }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(h.prisma.leaveRequests).toHaveLength(1);
    expect(h.prisma.lockLog.filter((k) => k === '7301:u-mem')).toHaveLength(2);
  });

  it('probe_hr_adjust_after_hire_date_change_orphans_adjustment: the adjustment follows its service period', async () => {
    await boot(Date.UTC(2026, 9, 28, 2));
    const adj = await h.call('POST', `/admin/employees/${profileId('u-mem')}/leave-balance/adjustments`, tok('u-hr'), {
      periodStart: '2026-03-01',
      days: 3,
      reason: 'x',
    });
    expect(adj.status).toBe(201);
    expect(h.prisma.leaveAdjustments).toEqual([expect.objectContaining({ periodIndex: 2 })]);
    // HR corrects the hire date by one day (H2 PATCH)
    const patch = await h.call('PATCH', `/admin/employees/${profileId('u-mem')}`, tok('u-hr'), { hireDate: '2024-03-02' });
    expect(patch.status).toBe(200);
    // The +3 stays with the year 2→3 period, which now starts 2026-03-02
    const bal = await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok('u-mem'));
    expect(bal.body).toMatchObject({ periodStart: '2026-03-02', entitled: 10, adjusted: 3, remaining: 13 });
    const admin = await h.call('GET', `/admin/employees/${profileId('u-mem')}/leave-balance`, tok('u-hr'));
    expect(admin.body.current).toMatchObject({ periodStart: '2026-03-02', adjusted: 3 });
    expect(admin.body.adjustments).toEqual([expect.objectContaining({ id: adj.body.id, periodStart: '2026-03-02', days: 3 })]);
    // The old date is no longer a period start; the new one is
    const old = await h.call('POST', `/admin/employees/${profileId('u-mem')}/leave-balance/adjustments`, tok('u-hr'), {
      periodStart: '2026-03-01',
      days: 1,
      reason: 'x',
    });
    expect([old.status, old.body.code]).toEqual([400, 'leave_adjustment_invalid']);
    const moved = await h.call('POST', `/admin/employees/${profileId('u-mem')}/leave-balance/adjustments`, tok('u-hr'), {
      periodStart: '2026-03-02',
      days: -1,
      reason: 'x',
    });
    expect([moved.status, moved.body.periodStart]).toEqual([201, '2026-03-02']);
  });

  it('annual leave and a hire-date change are serialized by the profile lock (create reads hireDate under the lock)', async () => {
    // u-mem hired 2024-03-01: 2026-11-02..04 lies inside [2026-03-01, 2027-02-28].
    // HR moves the hire date to 2024-11-04, so the anniversary 2026-11-04 splits that range → leave_spans_period.
    await boot(Date.UTC(2026, 9, 28, 2));
    h.prisma.latencyMs = 5;
    const pid = profileId('u-mem');
    // Hold the PATCH inside its transaction (profile lock taken, update not yet written) until the create
    // has finished, or 300 ms at most. With the profile lock the create waits for the PATCH and then sees
    // the new hire date; without it the create reads the old hire date and commits.
    let createDone!: () => void;
    const createFinished = new Promise<void>((r) => (createDone = r));
    let patchHolding!: () => void;
    const patchInside = new Promise<void>((r) => (patchHolding = r));
    const realUpdate = h.prisma.employeeProfile.update;
    h.prisma.employeeProfile.update = jest.fn(async (args: unknown) => {
      patchHolding();
      await Promise.race([createFinished, new Promise((r) => setTimeout(r, 300))]);
      return realUpdate(args);
    });

    const patch = h.call('PATCH', `/admin/employees/${pid}`, tok('u-hr'), { hireDate: '2024-11-04' });
    await patchInside;
    const create = await apply({ startDate: '2026-11-02', endDate: '2026-11-04' });
    createDone();
    expect((await patch).status).toBe(200);

    expect([create.status, create.body.code]).toEqual([400, 'leave_spans_period']);
    expect(h.prisma.leaveRequests).toHaveLength(0);
    // lock order: profile before user
    const order = h.prisma.lockLog.filter((k) => k === `7302:${pid}` || k === '7301:u-mem');
    expect(order).toEqual([`7302:${pid}`, `7302:${pid}`, '7301:u-mem']);
  });

  describe('pure entitlement boundaries', () => {
    it('probe_art38_table_index_1_to_30: Art. 38 entitlement for period index 0..26', () => {
      const expected = [3, 7, 10, 14, 14, 15, 15, 15, 15, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 30, 30];
      expect(expected.map((_, i) => entitlementForPeriod(i))).toEqual(expected);
    });

    it('probe_feb29_hire_and_31st_hire: month-end clamping for Feb 29 and 31st hire dates', () => {
      const hire = D('2024-02-29');
      expect(annualPeriodOn(hire, D('2024-08-28'))).toBeNull();
      expect(annualPeriodOn(hire, D('2024-08-29'))).toMatchObject({ index: 0, entitled: 3 });
      expect(annualPeriodOn(hire, D('2025-02-27'))).toMatchObject({ index: 0, periodEnd: D('2025-02-27') });
      expect(annualPeriodOn(hire, D('2025-02-28'))).toMatchObject({ index: 1, entitled: 7 });
      expect(annualPeriodOn(hire, D('2028-02-28'))).toMatchObject({ index: 3, periodStart: D('2027-02-28'), periodEnd: D('2028-02-28') });
      expect(annualPeriodOn(hire, D('2028-02-29'))).toMatchObject({ index: 4, entitled: 14 });
      expect(annualPeriodOn(hire, D('2034-02-28'))).toMatchObject({ index: 10, entitled: 16 });
      const h31 = D('2024-03-31');
      expect(annualPeriodOn(h31, D('2024-09-30'))).toMatchObject({ index: 0, periodStart: D('2024-09-30'), periodEnd: D('2025-03-30') });
      expect(isPeriodStart(h31, D('2024-09-30'))).toBe(true);
      expect(isPeriodStart(h31, D('2025-03-31'))).toBe(true);
      expect(isPeriodStart(h31, D('2025-03-30'))).toBe(false);
    });

    it('probe_anniversary_exact_day_and_far_future: anniversary day starts the new period; cap at 30', () => {
      const hire = D('2016-10-28');
      expect(annualPeriodOn(hire, D('2026-10-27'))).toMatchObject({ index: 9, entitled: 15 });
      expect(annualPeriodOn(hire, D('2026-10-28'))).toMatchObject({ index: 10, entitled: 16 });
      expect(annualPeriodOn(hire, D('2056-10-28'))).toMatchObject({ index: 40, entitled: 30 });
      expect(annualPeriodOn(hire, D('2016-10-27'))).toBeNull();
    });
  });
});
