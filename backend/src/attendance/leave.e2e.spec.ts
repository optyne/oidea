import { FakeIdp } from '../auth/oidc/testing/fake-idp';
import { LeaveHarness, COMPANY_WS } from './testing/leave-harness';

/**
 * H3 驗收：基本請假規則（notes/h3-design.md）。真的 Nest HTTP，Prisma 用記憶體版。
 *
 * 時鐘固定在 2026-10-28（Asia/Taipei）。u-mem 2024-03-01 到職 → 目前期間 [2026-03-01, 2027-02-28]，特休 10 天。
 * 2026-11-02 是星期一。
 */
describe('H3 請假規則（端到端）', () => {
  const idp = new FakeIdp();
  let h: LeaveHarness;

  beforeAll(() => idp.start());
  afterAll(() => idp.stop());
  afterEach(async () => {
    await h?.close();
  });

  const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const boot = async (seed: (h: LeaveHarness) => unknown = () => undefined) => {
    h = new LeaveHarness(idp);
    h.clock.set(Date.UTC(2026, 9, 28, 2)); // 2026-10-28 10:00 Asia/Taipei
    h.seedCompany();
    h.addEmployee({ id: 'u-hr', role: 'hr', employeeNo: 'H001', hireDate: D('2020-01-01') });
    h.addEmployee({ id: 'u-admin', role: 'admin', employeeNo: 'A001', hireDate: D('2020-01-01') });
    h.addEmployee({ id: 'u-mem', role: 'member', employeeNo: 'M001', hireDate: D('2024-03-01') });
    await seed(h);
    await h.start();
    return h;
  };
  const tok = (id: string) => h.token(id);
  const apply = (body: Record<string, unknown>, as = 'u-mem') =>
    h.call('POST', '/attendance/leaves', tok(as), { workspaceId: COMPANY_WS, type: 'annual', ...body });
  const balance = async (as = 'u-mem') => (await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok(as))).body;
  const profileId = (userId: string) => h.prisma.profiles.find((p) => p.userId === userId)!.id;

  describe('天數與回應欄位', () => {
    it('建立回 days（number）、startPart、endPart；週末與假日不算', async () => {
      await boot((h) => h.prisma.holidays.push({ id: 'hol-1', workspaceId: COMPANY_WS, date: D('2026-11-04'), name: '測試假日' }));
      const res = await apply({ startDate: '2026-11-02', endDate: '2026-11-09', startPart: 'pm' });
      // Mon 2 (pm 0.5), Tue 3, (Wed 4 holiday), Thu 5, Fri 6, (Sat, Sun), Mon 9 → 4.5
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ days: 4.5, startPart: 'pm', endPart: 'full', status: 'pending' });
      expect(typeof res.body.days).toBe('number');
      const list = await h.call('GET', `/attendance/leaves/workspace/${COMPANY_WS}`, tok('u-mem'));
      expect(list.body[0]).toMatchObject({ days: 4.5, startPart: 'pm', endPart: 'full' });
      expect(h.notifications.create).toHaveBeenCalled();
    });

    it('只落在週末 → 400 leave_no_workdays；結束早於起始、同一天上午＋下午 → 400 leave_invalid_range', async () => {
      await boot();
      const weekend = await apply({ startDate: '2026-10-31', endDate: '2026-11-01' });
      expect([weekend.status, weekend.body.code]).toEqual([400, 'leave_no_workdays']);
      const backwards = await apply({ startDate: '2026-11-03', endDate: '2026-11-02' });
      expect([backwards.status, backwards.body.code]).toEqual([400, 'leave_invalid_range']);
      const both = await apply({ startDate: '2026-11-02', endDate: '2026-11-02', startPart: 'pm', endPart: 'am' });
      expect([both.status, both.body.code]).toEqual([400, 'leave_invalid_range']);
      expect(h.prisma.leaveRequests).toHaveLength(0);
    });

    it('preview：天數＋特休；餘額不足時照樣回 remaining、不寫入', async () => {
      await boot();
      const q = (s: string, e: string, type = 'annual') =>
        h.call('GET', `/attendance/leaves/preview?workspaceId=${COMPANY_WS}&type=${type}&startDate=${s}&endDate=${e}`, tok('u-mem'));
      const ok = await q('2026-11-02', '2026-11-03');
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        days: 2,
        annual: { periodStart: '2026-03-01', periodEnd: '2027-02-28', entitled: 10, adjusted: 0, used: 0, remaining: 10 },
      });
      const tooMuch = await q('2026-11-02', '2026-11-20');
      expect(tooMuch.body).toMatchObject({ days: 15, annual: { remaining: 10 } });
      const sick = await q('2026-11-02', '2026-11-03', 'sick');
      expect(sick.body).toEqual({ days: 2, annual: null });
      expect(h.prisma.leaveRequests).toHaveLength(0);
    });
  });

  describe('不能跟自己的假單重疊 → 409 leave_overlap', () => {
    it('跟 pending 重疊、跟 approved 重疊都擋；rejected／cancelled 不擋', async () => {
      await boot();
      const first = await apply({ startDate: '2026-11-02', endDate: '2026-11-03', type: 'personal' });
      expect(first.status).toBe(201);
      const vsPending = await apply({ startDate: '2026-11-03', endDate: '2026-11-04', type: 'sick' });
      expect([vsPending.status, vsPending.body.code]).toEqual([409, 'leave_overlap']);

      expect((await h.call('PUT', `/attendance/leaves/${first.body.id}/approve`, tok('u-hr'))).status).toBe(200);
      const vsApproved = await apply({ startDate: '2026-11-02', endDate: '2026-11-02', type: 'sick' });
      expect([vsApproved.status, vsApproved.body.code]).toEqual([409, 'leave_overlap']);

      const second = await apply({ startDate: '2026-11-10', endDate: '2026-11-10', type: 'personal' });
      expect((await h.call('PUT', `/attendance/leaves/${second.body.id}/reject`, tok('u-hr'), { reason: 'no' })).status).toBe(200);
      const third = await apply({ startDate: '2026-11-11', endDate: '2026-11-11', type: 'personal' });
      expect((await h.call('DELETE', `/attendance/leaves/${third.body.id}`, tok('u-mem'))).status).toBe(200);

      const overRejected = await apply({ startDate: '2026-11-10', endDate: '2026-11-11', type: 'personal' });
      expect(overRejected.status).toBe(201);
    });

    it('同一天上午一張、下午一張都可以；再請整天就重疊', async () => {
      await boot();
      const am = await apply({ startDate: '2026-11-02', endDate: '2026-11-02', endPart: 'am' });
      const pm = await apply({ startDate: '2026-11-02', endDate: '2026-11-02', startPart: 'pm' });
      expect([am.status, am.body.days, pm.status, pm.body.days]).toEqual([201, 0.5, 201, 0.5]);
      const full = await apply({ startDate: '2026-11-02', endDate: '2026-11-02', type: 'sick' });
      expect([full.status, full.body.code]).toEqual([409, 'leave_overlap']);
    });

    it('別人的假單不算重疊', async () => {
      await boot();
      expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-02' }, 'u-mem')).status).toBe(201);
      expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-02' }, 'u-hr')).status).toBe(201);
    });
  });

  describe('特休餘額', () => {
    it('餘額不足 → 400 leave_insufficient_balance，不寫入', async () => {
      await boot();
      const res = await apply({ startDate: '2026-11-02', endDate: '2026-11-16' }); // 11 workdays > 10
      expect([res.status, res.body.code, res.body.remaining]).toEqual([400, 'leave_insufficient_balance', 10]);
      expect(h.prisma.leaveRequests).toHaveLength(0);
    });

    it('pending 的特休算已用；剛好用完可以，再多半天就不行', async () => {
      await boot();
      expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-13', endPart: 'am' })).body.days).toBe(9.5);
      expect(await balance()).toMatchObject({ entitled: 10, used: 9.5, remaining: 0.5 });
      const tooMuch = await apply({ startDate: '2026-11-16', endDate: '2026-11-16' });
      expect([tooMuch.status, tooMuch.body.code, tooMuch.body.remaining]).toEqual([400, 'leave_insufficient_balance', 0.5]);
      expect((await apply({ startDate: '2026-11-16', endDate: '2026-11-16', endPart: 'am' })).status).toBe(201);
      expect(await balance()).toMatchObject({ used: 10, remaining: 0 });
    });

    it('核准不改變餘額；取消（或退回）就把天數還回來', async () => {
      await boot();
      const a = await apply({ startDate: '2026-11-02', endDate: '2026-11-06' }); // 5
      const b = await apply({ startDate: '2026-11-09', endDate: '2026-11-13' }); // 5
      expect((await h.call('PUT', `/attendance/leaves/${a.body.id}/approve`, tok('u-hr'))).status).toBe(200);
      expect(await balance()).toMatchObject({ used: 10, remaining: 0 });
      expect((await apply({ startDate: '2026-11-16', endDate: '2026-11-16' })).body.code).toBe('leave_insufficient_balance');
      expect((await h.call('DELETE', `/attendance/leaves/${b.body.id}`, tok('u-mem'))).status).toBe(200);
      expect(await balance()).toMatchObject({ used: 5, remaining: 5 });
      expect((await apply({ startDate: '2026-11-16', endDate: '2026-11-16' })).status).toBe(201);
    });

    it('hr 加的調整提高餘額', async () => {
      await boot();
      expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-16' })).status).toBe(400); // 11 > 10
      const adj = await h.call('POST', `/admin/employees/${profileId('u-mem')}/leave-balance/adjustments`, tok('u-hr'), {
        periodStart: '2026-03-01',
        days: 1.5,
        reason: '補發去年未休',
      });
      expect(adj.status).toBe(201);
      expect(adj.body).toMatchObject({ periodStart: '2026-03-01', days: 1.5, reason: '補發去年未休', createdById: 'u-hr' });
      expect(await balance()).toMatchObject({ entitled: 10, adjusted: 1.5, remaining: 11.5 });
      expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-16' })).status).toBe(201);
    });

    it('跨越週年日 → 400 leave_spans_period', async () => {
      await boot();
      const res = await apply({ startDate: '2027-02-26', endDate: '2027-03-01' });
      expect([res.status, res.body.code]).toEqual([400, 'leave_spans_period']);
      // 拆開就可以：下一個期間 [2027-03-01, …) 是 14 天
      expect((await apply({ startDate: '2027-02-26', endDate: '2027-02-26' })).status).toBe(201);
      const next = await apply({ startDate: '2027-03-01', endDate: '2027-03-01' });
      expect(next.status).toBe(201);
    });

    it('公司工作空間沒有員工資料 → 400 no_employee_profile（特休）', async () => {
      await boot((h) => {
        h.prisma.addUser({ id: 'u-nop', email: 'nop@corp.com', username: 'nop' });
        h.prisma.addMember(COMPANY_WS, 'u-nop', 'member');
      });
      const res = await apply({ startDate: '2026-11-02', endDate: '2026-11-02' }, 'u-nop');
      expect([res.status, res.body.code]).toEqual([400, 'no_employee_profile']);
      const bal = await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok('u-nop'));
      expect([bal.status, bal.body.code]).toEqual([400, 'no_employee_profile']);
      // 非特休不需要員工資料
      expect((await apply({ startDate: '2026-11-02', endDate: '2026-11-02', type: 'sick' }, 'u-nop')).status).toBe(201);
    });

    it('非特休的假別從不檢查餘額', async () => {
      await boot((h) => h.addEmployee({ id: 'u-new', role: 'member', employeeNo: 'N001', hireDate: D('2026-10-01') }));
      for (const type of ['sick', 'personal', 'unpaid', 'other']) {
        h.prisma.leaveRequests.length = 0;
        const res = await apply({ startDate: '2026-11-02', endDate: '2026-11-30', type }, 'u-new'); // 21 workdays, 0 entitled
        expect([type, res.status]).toEqual([type, 201]);
      }
      h.prisma.leaveRequests.length = 0;
      const annual = await apply({ startDate: '2026-11-02', endDate: '2026-11-02' }, 'u-new');
      expect([annual.status, annual.body.code, annual.body.remaining]).toEqual([400, 'leave_insufficient_balance', 0]);
    });

    it('其他工作空間的特休不檢查餘額、balance 回 null', async () => {
      await boot((h) => {
        h.prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-founder' });
        h.prisma.addMember('ws-side', 'u-mem', 'member');
      });
      const res = await h.call('POST', '/attendance/leaves', tok('u-mem'), {
        workspaceId: 'ws-side',
        type: 'annual',
        startDate: '2026-11-02',
        endDate: '2026-11-30',
      });
      expect(res.status).toBe(201);
      const bal = await h.call('GET', '/attendance/leaves/balance?workspaceId=ws-side', tok('u-mem'));
      expect([bal.status, bal.body]).toEqual([200, null]);
    });

    it('同時送出兩張合計超過餘額的特休：剛好一張成功（requester 的 user 鎖）', async () => {
      await boot();
      h.prisma.latencyMs = 5; // 讓兩個請求在 DB 這一步交錯；沒有鎖的話兩張都會通過餘額檢查
      const [x, y] = await Promise.all([
        apply({ startDate: '2026-11-02', endDate: '2026-11-09' }), // 6
        apply({ startDate: '2026-11-16', endDate: '2026-11-23' }), // 6
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 400]);
      expect([x.body.code, y.body.code]).toContain('leave_insufficient_balance');
      expect(h.prisma.leaveRequests).toHaveLength(1);
      expect(h.prisma.lockLog.filter((k) => k === '7301:u-mem').length).toBe(2);
    });

    it('同時送出兩張重疊的假單：剛好一張成功', async () => {
      await boot();
      h.prisma.latencyMs = 5;
      const [x, y] = await Promise.all([
        apply({ startDate: '2026-11-02', endDate: '2026-11-03', type: 'sick' }),
        apply({ startDate: '2026-11-03', endDate: '2026-11-04', type: 'personal' }),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      expect(h.prisma.leaveRequests).toHaveLength(1);
    });
  });

  describe('核准規則不變', () => {
    it('不能審核自己的假單（hr 也一樣）', async () => {
      await boot();
      const mine = await apply({ startDate: '2026-11-02', endDate: '2026-11-02' }, 'u-hr');
      const res = await h.call('PUT', `/attendance/leaves/${mine.body.id}/approve`, tok('u-hr'));
      expect(res.status).toBe(403);
      expect(h.prisma.leaveRequests[0].status).toBe('pending');
    });
  });

  describe('後台：假日（leave.policy.manage）', () => {
    const put = (year: number | string, items: unknown, as = 'u-hr') => h.call('PUT', `/admin/holidays/${year}`, tok(as), { items });
    const get = (year: number | string, as = 'u-hr') => h.call('GET', `/admin/holidays?year=${year}`, tok(as));

    it('整年取代：其他年份不動、依日期排序、寫 audit', async () => {
      await boot((h) => {
        h.prisma.holidays.push({ id: 'old-1', workspaceId: COMPANY_WS, date: D('2027-01-01'), name: '舊的 2027' });
        h.prisma.holidays.push({ id: 'old-2', workspaceId: COMPANY_WS, date: D('2026-02-17'), name: '舊的 2026' });
      });
      const res = await put(2027, [
        { date: '2027-10-11', name: '國慶日補假' },
        { date: '2027-01-01', name: '元旦' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        year: 2027,
        items: [
          { date: '2027-01-01', name: '元旦' },
          { date: '2027-10-11', name: '國慶日補假' },
        ],
      });
      expect((await get(2026)).body).toEqual({ year: 2026, items: [{ date: '2026-02-17', name: '舊的 2026' }] });
      const audit = h.audits('holiday.replace');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: 'u-hr', workspaceId: COMPANY_WS, targetId: '2027', metadata: { year: 2027, before: 1, after: 2 } });
      // 空清單 = 清空那一年
      expect((await put(2027, [])).body).toEqual({ year: 2027, items: [] });
    });

    it('取代在同一個交易：寫到一半失敗，那一年原本的清單還在', async () => {
      await boot((h) => h.prisma.holidays.push({ id: 'old-1', workspaceId: COMPANY_WS, date: D('2027-01-01'), name: '元旦' }));
      const inner = h.prisma.holiday.create.getMockImplementation()!;
      let n = 0;
      h.prisma.holiday.create.mockImplementation(async (args: any) => {
        if (++n === 2) throw new Error('boom');
        return inner(args);
      });
      const res = await put(2027, [
        { date: '2027-02-01', name: 'A' },
        { date: '2027-02-02', name: 'B' },
      ]);
      expect(res.status).toBe(500);
      expect(h.prisma.holidays.map((x) => x.name)).toEqual(['元旦']);
      expect(h.audits('holiday.replace')).toEqual([]);
    });

    it('日期不在那一年、重複、名稱不合法、超過 60 筆、年份不合法 → 400 holiday_invalid', async () => {
      await boot();
      const cases: unknown[] = [
        [{ date: '2026-12-31', name: 'x' }],
        [{ date: '2027-01-01', name: 'a' }, { date: '2027-01-01', name: 'b' }],
        [{ date: '2027-01-01', name: '' }],
        [{ date: '2027-01-01', name: '   ' }],
        [{ date: '2027-01-01', name: 'x'.repeat(51) }],
        [{ date: '2027-02-30', name: 'x' }],
        [{ name: 'x' }],
        Array.from({ length: 61 }, (_, i) => ({ date: `2027-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, name: 'x' })),
      ];
      for (const items of cases) {
        const res = await put(2027, items);
        expect([res.status, res.body.code]).toEqual([400, 'holiday_invalid']);
      }
      expect((await put('abcd', [])).body.code).toBe('holiday_invalid');
      expect((await get('20x7')).body.code).toBe('holiday_invalid');
      expect(h.prisma.holidays).toHaveLength(0);
      expect(h.audits('holiday.replace')).toEqual([]);
      // 名稱剛好 50 字可以
      expect((await put(2027, [{ date: '2027-01-01', name: 'x'.repeat(50) }])).status).toBe(200);
    });

    it('member、admin（沒有 leave.policy.manage）→ 403；owner 可以', async () => {
      await boot();
      for (const as of ['u-mem', 'u-admin']) {
        expect((await get(2027, as)).status).toBe(403);
        expect((await put(2027, [{ date: '2027-01-01', name: '元旦' }], as)).status).toBe(403);
      }
      expect(h.prisma.holidays).toHaveLength(0);
      expect((await put(2027, [{ date: '2027-01-01', name: '元旦' }], 'u-founder')).status).toBe(200);
    });

    it('假日影響之後建立的假單天數', async () => {
      await boot();
      await put(2026, [{ date: '2026-11-03', name: '公司假日' }]);
      const res = await apply({ startDate: '2026-11-02', endDate: '2026-11-04' });
      expect(res.body.days).toBe(2);
    });
  });

  describe('後台：員工特休餘額（leave.policy.manage）', () => {
    const url = (userId: string) => `/admin/employees/${profileId(userId)}/leave-balance`;

    it('GET：目前與上一個期間、所有調整', async () => {
      await boot();
      await apply({ startDate: '2026-11-02', endDate: '2026-11-03' });
      await h.call('POST', `${url('u-mem')}/adjustments`, tok('u-hr'), { periodStart: '2025-03-01', days: -2, reason: '扣回' });
      const res = await h.call('GET', url('u-mem'), tok('u-hr'));
      expect(res.status).toBe(200);
      expect(res.body.current).toEqual({ periodStart: '2026-03-01', periodEnd: '2027-02-28', entitled: 10, adjusted: 0, used: 2, remaining: 8 });
      expect(res.body.previous).toEqual({ periodStart: '2025-03-01', periodEnd: '2026-02-28', entitled: 7, adjusted: -2, used: 0, remaining: 5 });
      expect(res.body.adjustments).toEqual([
        expect.objectContaining({ periodStart: '2025-03-01', days: -2, reason: '扣回', createdById: 'u-hr' }),
      ]);
    });

    it('還沒滿 6 個月：current、previous 都是 null；未綁定 User 的員工 used 為 0', async () => {
      await boot((h) => {
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'pre@corp.com', employeeNo: 'P001', id: 'p-pre', hireDate: D('2026-06-01') });
        h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'old@corp.com', employeeNo: 'P002', id: 'p-old', hireDate: D('2025-01-01') });
      });
      expect((await h.call('GET', '/admin/employees/p-pre/leave-balance', tok('u-hr'))).body).toEqual({ current: null, previous: null, adjustments: [] });
      const old = await h.call('GET', '/admin/employees/p-old/leave-balance', tok('u-hr'));
      expect(old.body.current).toEqual({ periodStart: '2026-01-01', periodEnd: '2026-12-31', entitled: 7, adjusted: 0, used: 0, remaining: 7 });
      expect(old.body.previous).toMatchObject({ periodStart: '2025-07-01', periodEnd: '2025-12-31', entitled: 3 });
    });

    it('periodStart 不是期間起始日、days 為 0 或不是 0.5 的倍數、reason 空 → 400 leave_adjustment_invalid', async () => {
      await boot();
      for (const body of [
        { periodStart: '2026-03-02', days: 1, reason: 'x' },
        { periodStart: '2024-03-01', days: 1, reason: 'x' }, // 到職日：還沒有期間
        { periodStart: '2026-03-01', days: 0, reason: 'x' },
        { periodStart: '2026-03-01', days: 0.3, reason: 'x' },
        { periodStart: '2026-03-01', days: 1, reason: '  ' },
      ]) {
        const res = await h.call('POST', `${url('u-mem')}/adjustments`, tok('u-hr'), body);
        expect([res.status, res.body.code]).toEqual([400, 'leave_adjustment_invalid']);
      }
      expect(h.prisma.leaveAdjustments).toHaveLength(0);
      expect(h.audits('leave.balance.adjust')).toEqual([]);
    });

    it('寫 audit；不能調整自己的；member、admin → 403；不存在的員工 → 404', async () => {
      await boot();
      const ok = await h.call('POST', `${url('u-mem')}/adjustments`, tok('u-hr'), { periodStart: '2026-03-01', days: 2, reason: '獎勵' });
      expect(ok.status).toBe(201);
      const audit = h.audits('leave.balance.adjust');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: 'u-hr',
        workspaceId: COMPANY_WS,
        targetType: 'employee_profile',
        targetId: profileId('u-mem'),
        metadata: { adjustmentId: ok.body.id, periodStart: '2026-03-01', days: 2 },
      });

      const self = await h.call('POST', `${url('u-hr')}/adjustments`, tok('u-hr'), { periodStart: '2026-01-01', days: 2, reason: 'x' });
      expect([self.status, self.body.code]).toEqual([403, 'cannot_edit_self']);

      for (const as of ['u-mem', 'u-admin']) {
        expect((await h.call('GET', url('u-mem'), tok(as))).status).toBe(403);
        expect(
          (await h.call('POST', `${url('u-mem')}/adjustments`, tok(as), { periodStart: '2026-03-01', days: 2, reason: 'x' })).status,
        ).toBe(403);
      }
      expect((await h.call('GET', '/admin/employees/nope/leave-balance', tok('u-hr'))).status).toBe(404);
      expect(h.prisma.leaveAdjustments).toHaveLength(1);
      expect(h.audits('leave.balance.adjust')).toHaveLength(1);
    });
  });
});
