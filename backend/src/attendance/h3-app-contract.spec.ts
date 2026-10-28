import * as fs from 'fs';
import * as path from 'path';
import { getMetadataStorage } from 'class-validator';
import { FakeIdp } from '../auth/oidc/testing/fake-idp';
import { CreateLeaveDto, LeaveAdjustmentDto, LeavePreviewQuery, ReplaceHolidaysDto } from './dto/leave-request.dto';
import { LeaveHarness, COMPANY_WS } from './testing/leave-harness';

/**
 * 防止後端與 Flutter App 的 H3（請假規則）契約漂移（notes/h3-design.md「As built」）。跟
 * `employees/h2-app-contract.spec.ts` 同樣的做法，直接讀 App 的原始碼：
 *
 * 1. 錯誤碼：後端 `src/attendance` 裡每一個 `apiError(HttpStatus.X, '<code>', …)` 都要在 `admin_errors.dart`
 *    的 `_fallbackByCode` 有對照（少一個，使用者就只會看到「操作失敗（code）」）。
 * 2. 回應欄位：App 的 `fromJson` 讀的每一個鍵，真的 HTTP 回應裡都有；假列表資料的鍵跟後端相同。
 * 3. 請求欄位：App 送出的 body／query 鍵都是 DTO 宣告過的（全域 ValidationPipe 是 forbidNonWhitelisted）；
 *    而且用這些鍵組出來的請求真的被後端接受。
 * 4. App 測試的假資料（`annualJson`／`adjustmentJson`／`leaveJson`）跟後端回應鍵一致。
 */
const SRC = path.resolve(__dirname, '..');
const APP = path.resolve(SRC, '../../app');
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8');

const APP_FILES = {
  errors: 'lib/features/admin/admin_errors.dart',
  models: 'lib/features/erp/models/leave_models.dart',
  api: 'lib/core/network/api_client.dart',
  leaveDialog: 'lib/features/erp/presentation/widgets/leave_request_dialog.dart',
  leavesPage: 'lib/features/erp/presentation/pages/leaves_page.dart',
  holidaysPage: 'lib/features/admin/presentation/pages/holidays_page.dart',
  fakes: 'test/support/admin_fakes.dart',
};

// ─────────────── Dart 原始碼的小工具（同 h2-app-contract.spec.ts） ───────────────

/** 從 `start` 開始，到第一個符合 `end` 的位置為止（Dart 檔是 CRLF 或 LF 都可以）。 */
function block(text: string, start: string | RegExp, end: RegExp): string {
  const at = typeof start === 'string' ? text.indexOf(start) : text.search(start);
  if (at < 0) throw new Error(`not found in Dart source: ${start}`);
  const rest = text.slice(at);
  const stop = end.exec(rest);
  return stop ? rest.slice(0, stop.index) : rest;
}
/** class 成員結束（`  }`）或 class 結束（`}`）：箭頭函式的 factory 沒有自己的 `}` */
const MEMBER_END = /\r?\n {0,2}\}/;
/** 頂層函式／方法的 `}` 單獨一行（避開 `  }) async {` 這種具名參數的結尾） */
const METHOD_END = /\r?\n  \}\r?\n/;
/** 箭頭函式回傳 map literal：`=> { … };` */
const MAP_END = /\r?\n\s*\};/;

const keysOf = (src: string, re: RegExp) => new Set([...src.matchAll(re)].map((m) => m[1]));
/** `j['x']` 讀取的鍵 */
const jsonReads = (src: string) => keysOf(src, /\bj\['(\w+)'\]/g);
/** map literal 的 `'x':` 鍵 */
const literalKeys = (src: string) => keysOf(src, /'(\w+)'\s*:/g);
const fromJson = (cls: string) => jsonReads(block(read(APP_FILES.models), `factory ${cls}.fromJson(`, MEMBER_END));
const apiMethod = (name: string) => block(read(APP_FILES.api), new RegExp(`Future<[^\\n]*>\\s+${name}\\(`), METHOD_END);

const missing = (wanted: Iterable<string>, have: Iterable<string>) => {
  const h = new Set(have);
  return [...wanted].filter((k) => !h.has(k)).sort();
};

/** DTO class 宣告過（有 class-validator 裝飾器）的屬性 */
const dtoProps = (cls: new () => object) =>
  new Set(getMetadataStorage().getTargetValidationMetadatas(cls, '', true, false).map((m) => m.propertyName));

// ─────────────── 1. 錯誤碼 ───────────────

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'testing' ? [] : walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [p] : [];
  });
}

/** `src/attendance` 裡後端會送出的所有 `apiError` 錯誤碼。 */
function backendCodes(): Set<string> {
  const codes = new Set<string>();
  const unparsed: string[] = [];
  for (const file of walk(path.join(SRC, 'attendance'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/apiError\(([^)]*)/g)) {
      const literal = /^\s*HttpStatus\.[A-Z_]+\s*,\s*'([a-z_]+)'/.exec(m[1]);
      if (literal) codes.add(literal[1]);
      else unparsed.push(`${path.relative(SRC, file)}: apiError(${m[1].slice(0, 60)}`);
    }
  }
  // code 不是字串常值的寫法會被漏掉，直接失敗，逼新寫法也要讓這個測試看得懂
  if (unparsed.length > 0) throw new Error(`apiError calls whose code is not a string literal:\n${unparsed.join('\n')}`);
  return codes;
}

function appCodes(): Set<string> {
  const text = read(APP_FILES.errors);
  const map = /_fallbackByCode\s*=\s*\{([\s\S]*?)\};/.exec(text);
  if (!map) throw new Error('_fallbackByCode not found in admin_errors.dart');
  return new Set([...literalKeys(map[1]), ...keysOf(text, /code\s*==\s*'([a-z_]+)'/g)]);
}

/** notes/h3-design.md「Error codes」逐字列出的清單。 */
const DOCUMENTED_CODES = [
  'leave_invalid_range',
  'leave_no_workdays',
  'leave_overlap',
  'leave_spans_period',
  'leave_insufficient_balance',
  'no_employee_profile',
  'holiday_invalid',
  'leave_adjustment_invalid',
  'cannot_edit_self',
];

describe('H3 contract: backend ↔ Flutter app source', () => {
  describe('error codes (admin_errors.dart)', () => {
    it('the parser finds the documented codes on the backend', () => {
      expect(missing(DOCUMENTED_CODES, backendCodes())).toEqual([]);
    });

    it('every code the backend can emit for H3 has an app message', () => {
      expect(missing(backendCodes(), appCodes())).toEqual([]);
    });

    it('the app maps every documented H3 code', () => {
      expect(missing(DOCUMENTED_CODES, appCodes())).toEqual([]);
    });

    it('leave_insufficient_balance: the backend body carries `remaining` and the app reads it', () => {
      const errors = read(APP_FILES.errors);
      expect(errors).toMatch(/data\['remaining'\]/);
      expect(fs.readFileSync(path.join(SRC, 'common/http-exception.filter.ts'), 'utf8')).toMatch(/obj\.remaining/);
    });
  });

  // ─────────────── 2. 回應欄位（真的 HTTP 回應） ───────────────

  describe('response fields the app parses exist in real responses', () => {
    const idp = new FakeIdp();
    const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
    let h: LeaveHarness;
    let profileId: string;
    const tok = (id: string) => h.token(id);

    beforeAll(async () => {
      await idp.start();
      h = new LeaveHarness(idp);
      h.clock.set(Date.UTC(2026, 9, 28, 2)); // 2026-10-28 Asia/Taipei
      h.seedCompany();
      h.addEmployee({ id: 'u-hr', role: 'hr', employeeNo: 'H001', hireDate: D('2020-01-01') });
      h.addEmployee({ id: 'u-mem', role: 'member', employeeNo: 'M001', hireDate: D('2024-03-01') });
      await h.start();
      profileId = h.prisma.profiles.find((p) => p.userId === 'u-mem')!.id;
      // 先有一張假單、一年的假日、一筆調整
      const leave = await h.call('POST', '/attendance/leaves', tok('u-mem'), {
        workspaceId: COMPANY_WS, type: 'annual', startDate: '2026-11-02', endDate: '2026-11-03', startPart: 'pm',
      });
      expect(leave.status).toBe(201);
      const holidays = await h.call('PUT', '/admin/holidays/2026', tok('u-hr'), { items: [{ date: '2026-10-10', name: '國慶日' }] });
      expect(holidays.status).toBe(200);
      const adj = await h.call('POST', `/admin/employees/${profileId}/leave-balance/adjustments`, tok('u-hr'), {
        periodStart: '2026-03-01', days: 1, reason: '補休',
      });
      expect(adj.status).toBe(201);
    });
    afterAll(async () => {
      await h?.close();
      await idp.stop();
    });

    it('GET /attendance/leaves/preview → LeavePreview, AnnualBalance', async () => {
      const q = `workspaceId=${COMPANY_WS}&type=annual&startDate=2026-12-07&endDate=2026-12-08&startPart=full&endPart=am`;
      const res = await h.call('GET', `/attendance/leaves/preview?${q}`, tok('u-mem'));
      expect(res.status).toBe(200);
      // 解析器真的抓到了 fromJson 的鍵（不是空集合而「通過」）
      expect([fromJson('LeavePreview').size, fromJson('AnnualBalance').size]).toEqual([2, 6]);
      expect(missing(fromJson('LeavePreview'), Object.keys(res.body))).toEqual([]);
      expect(res.body.annual).not.toBeNull();
      expect(missing(fromJson('AnnualBalance'), Object.keys(res.body.annual))).toEqual([]);
      expect(typeof res.body.days).toBe('number');
    });

    it('GET /attendance/leaves/balance → AnnualBalance (a body, not an empty response)', async () => {
      const res = await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok('u-mem'));
      expect(res.status).toBe(200);
      expect(missing(fromJson('AnnualBalance'), Object.keys(res.body))).toEqual([]);
    });

    it('GET /attendance/leaves/workspace/:id → the keys leaves_page.dart reads from a leave row', async () => {
      const res = await h.call('GET', `/attendance/leaves/workspace/${COMPANY_WS}`, tok('u-mem'));
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      const page = read(APP_FILES.leavesPage);
      const rowKeys = keysOf(page, /\bleave\['(\w+)'\]/g);
      expect(rowKeys.has('days') && rowKeys.has('startPart') && rowKeys.has('endPart')).toBe(true);
      for (const row of res.body) {
        expect(missing(rowKeys, Object.keys(row))).toEqual([]);
        expect(typeof row.days).toBe('number');
        expect(missing(keysOf(page, /requester\?\['(\w+)'\]/g), Object.keys(row.requester))).toEqual([]);
      }
    });

    it('GET /admin/holidays → HolidayYear, HolidayItem', async () => {
      const res = await h.call('GET', '/admin/holidays?year=2026', tok('u-hr'));
      expect(res.status).toBe(200);
      expect([fromJson('HolidayYear').size, fromJson('HolidayItem').size]).toEqual([2, 2]);
      expect(missing(fromJson('HolidayYear'), Object.keys(res.body))).toEqual([]);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const i of res.body.items) expect(missing(fromJson('HolidayItem'), Object.keys(i))).toEqual([]);
    });

    it('GET /admin/employees/:id/leave-balance → EmployeeLeaveBalance, AnnualBalance, LeaveAdjustment', async () => {
      const res = await h.call('GET', `/admin/employees/${profileId}/leave-balance`, tok('u-hr'));
      expect(res.status).toBe(200);
      expect(fromJson('EmployeeLeaveBalance').size).toBe(3);
      expect(missing(fromJson('EmployeeLeaveBalance'), Object.keys(res.body))).toEqual([]);
      expect(res.body.current).not.toBeNull();
      expect(missing(fromJson('AnnualBalance'), Object.keys(res.body.current))).toEqual([]);
      expect(res.body.adjustments.length).toBeGreaterThan(0);
      for (const a of res.body.adjustments) expect(missing(fromJson('LeaveAdjustment'), Object.keys(a))).toEqual([]);
    });

    it('POST /admin/employees/:id/leave-balance/adjustments → LeaveAdjustment', async () => {
      const res = await h.call('POST', `/admin/employees/${profileId}/leave-balance/adjustments`, tok('u-hr'), {
        periodStart: '2026-03-01', days: -0.5, reason: '更正',
      });
      expect(res.status).toBe(201);
      expect(missing(fromJson('LeaveAdjustment'), Object.keys(res.body))).toEqual([]);
    });

    // ─────────────── 3.（續）請求真的被接受 ───────────────

    it('requests built from the keys the app sends are accepted (holidays PUT, adjustment POST)', async () => {
      // holidays_page.dart 組 items 的 literal：{'date': …, 'name': …}
      const itemKeys = literalKeys(block(read(APP_FILES.holidaysPage), 'replaceAdminHolidays(', /\r?\n {0,6}\);/));
      expect(itemKeys).toEqual(new Set(['date', 'name']));
      const put = await h.call('PUT', '/admin/holidays/2026', tok('u-hr'), {
        items: [{ date: '2026-02-17', name: '春節' }],
      });
      expect(put.status).toBe(200);
      expect(put.body.items).toEqual([{ date: '2026-02-17', name: '春節' }]);

      // adjustments：api_client.addLeaveAdjustment 的 data literal
      const adjKeys = literalKeys(block(apiMethod('addLeaveAdjustment'), 'data:', /\)/));
      expect(adjKeys).toEqual(new Set(['periodStart', 'days', 'reason']));
      const body: Record<string, unknown> = { periodStart: '2026-03-01', days: 1.0, reason: 'x' };
      expect(Object.keys(body).sort()).toEqual([...adjKeys].sort());
      expect((await h.call('POST', `/admin/employees/${profileId}/leave-balance/adjustments`, tok('u-hr'), body)).status).toBe(201);
    });
  });

  // ─────────────── 3. 請求欄位 ───────────────

  describe('request keys the app sends are declared by the DTOs / controllers', () => {
    it('create leave body (leave_request_dialog) ⊆ CreateLeaveDto', () => {
      const submit = block(read(APP_FILES.leaveDialog), 'Future<void> _submit()', METHOD_END);
      const keys = literalKeys(block(submit, 'createLeave({', /\}\);/));
      expect(keys).toEqual(new Set(['workspaceId', 'type', 'startDate', 'endDate', 'startPart', 'endPart', 'reason']));
      expect(missing(keys, dtoProps(CreateLeaveDto))).toEqual([]);
    });

    it('api_client.previewLeave query ⊆ LeavePreviewQuery', () => {
      const keys = literalKeys(apiMethod('previewLeave'));
      expect(keys).toEqual(new Set(['workspaceId', 'type', 'startDate', 'endDate', 'startPart', 'endPart']));
      expect(missing(keys, dtoProps(LeavePreviewQuery))).toEqual([]);
    });

    it('api_client.addLeaveAdjustment body ⊆ LeaveAdjustmentDto', () => {
      const keys = literalKeys(apiMethod('addLeaveAdjustment'));
      expect(keys.size).toBe(3);
      expect(missing(keys, dtoProps(LeaveAdjustmentDto))).toEqual([]);
    });

    it('api_client.replaceAdminHolidays body ⊆ ReplaceHolidaysDto', () => {
      const keys = literalKeys(apiMethod('replaceAdminHolidays'));
      expect(keys).toEqual(new Set(['items']));
      expect(missing(keys, dtoProps(ReplaceHolidaysDto))).toEqual([]);
    });

    it('api_client query names for holidays and balance match the controllers', () => {
      const attendance = fs.readFileSync(path.join(SRC, 'attendance/attendance.controller.ts'), 'utf8');
      const admin = fs.readFileSync(path.join(SRC, 'attendance/leave-admin.controllers.ts'), 'utf8');
      expect(literalKeys(apiMethod('getLeaveBalance'))).toEqual(new Set(['workspaceId']));
      expect(attendance).toMatch(/leaves\/balance[\s\S]*?@Query\('workspaceId'\)/);
      expect(literalKeys(apiMethod('getAdminHolidays'))).toEqual(new Set(['year']));
      expect(admin).toMatch(/@Query\('year'\)/);
    });
  });

  // ─────────────── 4. App 測試的假資料 ───────────────

  describe('app test fakes use the real response shapes', () => {
    const idp = new FakeIdp();
    const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
    let h: LeaveHarness;
    let profileId: string;
    const tok = (id: string) => h.token(id);
    const fakes = () => read(APP_FILES.fakes);
    const fakeKeys = (fn: string) => literalKeys(block(fakes(), `Map<String, dynamic> ${fn}(`, MAP_END));

    beforeAll(async () => {
      await idp.start();
      h = new LeaveHarness(idp);
      h.clock.set(Date.UTC(2026, 9, 28, 2));
      h.seedCompany();
      h.addEmployee({ id: 'u-hr', role: 'hr', employeeNo: 'H001', hireDate: D('2020-01-01') });
      h.addEmployee({ id: 'u-mem', role: 'member', employeeNo: 'M001', hireDate: D('2024-03-01') });
      await h.start();
      profileId = h.prisma.profiles.find((p) => p.userId === 'u-mem')!.id;
      await h.call('POST', `/admin/employees/${profileId}/leave-balance/adjustments`, tok('u-hr'), {
        periodStart: '2026-03-01', days: 1, reason: '補休',
      });
      await h.call('POST', '/attendance/leaves', tok('u-mem'), {
        workspaceId: COMPANY_WS, type: 'annual', startDate: '2026-11-02', endDate: '2026-11-03',
      });
    });
    afterAll(async () => {
      await h?.close();
      await idp.stop();
    });

    it('annualJson has exactly the keys of the backend AnnualBalance', async () => {
      const res = await h.call('GET', `/attendance/leaves/balance?workspaceId=${COMPANY_WS}`, tok('u-mem'));
      expect([...fakeKeys('annualJson')].sort()).toEqual(Object.keys(res.body).sort());
    });

    it('adjustmentJson has exactly the keys of a backend adjustment', async () => {
      const res = await h.call('GET', `/admin/employees/${profileId}/leave-balance`, tok('u-hr'));
      expect([...fakeKeys('adjustmentJson')].sort()).toEqual(Object.keys(res.body.adjustments[0]).sort());
    });

    it('leaveJson only uses keys a real leave row has (and includes the three H3 additions)', async () => {
      const res = await h.call('GET', `/attendance/leaves/workspace/${COMPANY_WS}`, tok('u-mem'));
      const row = res.body[0];
      const keys = fakeKeys('leaveJson');
      for (const k of ['days', 'startPart', 'endPart']) expect(keys.has(k)).toBe(true);
      expect(missing(keys, [...Object.keys(row), ...Object.keys(row.requester)])).toEqual([]);
    });
  });
});
