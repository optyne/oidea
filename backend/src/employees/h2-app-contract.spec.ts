import * as fs from 'fs';
import * as path from 'path';
import { getMetadataStorage } from 'class-validator';
import { FakeIdp } from '../auth/oidc/testing/fake-idp';
import { COMPANY_NOT_CONFIGURED } from '../company/company-permission.guard';
import { CreateDepartmentDto, ListDepartmentsQuery, UpdateDepartmentDto } from './dto/department.dto';
import {
  CreateEmployeeDto,
  ImportEmployeesDto,
  ListEmployeesQuery,
  TerminateEmployeeDto,
  UpdateEmployeeDto,
} from './dto/employee-admin.dto';
import { toDepartmentDto } from './departments.service';
import { toEmployeeDto } from './employee-admin.service';
import { AdminHarness, COMPANY_WS } from './testing/admin-harness';

/**
 * 防止後端與 Flutter App 的 H2 契約漂移（notes/h2-api-contract.md）。這裡直接讀 App 的原始碼：
 *
 * 1. 錯誤碼：後端 H2 程式裡每一個 `apiError(HttpStatus.X, '<code>', …)` ↔ `admin_errors.dart` 的對照表，
 *    兩邊必須完全相同（後端多 → App 沒訊息；App 多 → 後端不會送，打錯字或已移除）。
 * 2. 回應欄位：App 的 `fromJson` 讀的每一個鍵，真的 HTTP 回應裡都有。
 * 3. 請求欄位：App 送出的 body／query 鍵都是 DTO 宣告過的（全域 ValidationPipe 是 forbidNonWhitelisted，
 *    多一個鍵就 400）。
 * 4. 測試假資料：App 測試的 `employeeJson`／`deptJson` 跟後端 DTO 的鍵完全相同，不是自己編的。
 */
const SRC = path.resolve(__dirname, '..');
const APP = path.resolve(SRC, '../../app');
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8');

const APP_FILES = {
  errors: 'lib/features/admin/admin_errors.dart',
  models: 'lib/features/admin/models/admin_models.dart',
  api: 'lib/core/network/api_client.dart',
  form: 'lib/features/admin/presentation/widgets/employee_form_dialog.dart',
  departments: 'lib/features/admin/presentation/pages/departments_page.dart',
  fakes: 'test/support/admin_fakes.dart',
};

// ─────────────── Dart 原始碼的小工具 ───────────────

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

const keysOf = (src: string, re: RegExp) => new Set([...src.matchAll(re)].map((m) => m[1]));
/** `j['x']` 讀取的鍵 */
const jsonReads = (src: string) => keysOf(src, /\bj\['(\w+)'\]/g);
/** map literal 的 `'x':` 鍵 */
const literalKeys = (src: string) => keysOf(src, /'(\w+)'\s*:/g);
const fromJson = (cls: string) => jsonReads(block(read(APP_FILES.models), `factory ${cls}.fromJson(`, MEMBER_END));

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

function backendCodes(): Set<string> {
  const files = [
    ...walk(path.join(SRC, 'employees')),
    ...walk(path.join(SRC, 'audit')),
    path.join(SRC, 'company/company-permission.guard.ts'),
  ];
  const codes = new Set<string>();
  const unparsed: string[] = [];
  for (const file of files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/apiError\(([^)]*)/g)) {
      const args = m[1];
      const literal = /^\s*HttpStatus\.[A-Z_]+\s*,\s*'([a-z_]+)'/.exec(args);
      if (literal) codes.add(literal[1]);
      else if (/^\s*HttpStatus\.[A-Z_]+\s*,\s*COMPANY_NOT_CONFIGURED\b/.test(args)) codes.add(COMPANY_NOT_CONFIGURED);
      else unparsed.push(`${path.relative(SRC, file)}: apiError(${args.slice(0, 60)}`);
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

describe('H2 contract: backend ↔ Flutter app source', () => {
  describe('error codes (admin_errors.dart)', () => {
    it('finds both sides', () => {
      expect(backendCodes().size).toBeGreaterThanOrEqual(15);
      expect(appCodes().has('owner_transfer_required')).toBe(true);
    });

    it('every code the backend can emit for H2 has an app message', () => {
      expect(missing(backendCodes(), appCodes())).toEqual([]);
    });

    it('every code the app maps is one the backend can emit', () => {
      expect(missing(appCodes(), backendCodes())).toEqual([]);
    });
  });

  // ─────────────── 2. 回應欄位（真的 HTTP 回應） ───────────────

  describe('response fields the app parses exist in real responses', () => {
    const idp = new FakeIdp();
    let h: AdminHarness;
    beforeAll(async () => {
      await idp.start();
      h = new AdminHarness(idp);
      h.seedCompany();
      const boss = h.addEmployee({ id: 'u-boss', role: 'member', fullName: '李主管' });
      const dept = h.prisma.addDepartment({ workspaceId: COMPANY_WS, name: '研發部', managerProfileId: boss.profile.id });
      h.addEmployee({ id: 'u-hr', role: 'hr', fullName: '人資', departmentId: dept.id, managerProfileId: boss.profile.id });
      h.prisma.addProfile({ workspaceId: COMPANY_WS, email: 'pre@corp.com', employeeNo: 'P1' });
      await h.start();
      // 先有一筆 audit
      expect((await h.call('POST', '/admin/departments', h.token('u-hr'), { name: '業務部' })).status).toBe(201);
    });
    afterAll(async () => {
      await h?.close();
      await idp.stop();
    });

    it('GET /company/me → CompanyMe, MyProfile', async () => {
      const res = await h.call('GET', '/company/me', h.token('u-hr'));
      expect(res.status).toBe(200);
      expect(missing(fromJson('CompanyMe'), Object.keys(res.body))).toEqual([]);
      expect(missing(fromJson('MyProfile'), Object.keys(res.body.profile))).toEqual([]);
      expect(Object.keys(res.body.profile.department)).toEqual(expect.arrayContaining(['name']));
      expect(Object.keys(res.body.profile.manager)).toEqual(expect.arrayContaining(['fullName']));
    });

    it('GET /admin/employees → EmployeePage, EmployeeDto', async () => {
      const res = await h.call('GET', '/admin/employees', h.token('u-hr'));
      expect(res.status).toBe(200);
      // 解析器真的抓到了 fromJson 的鍵（不是空集合而「通過」）
      expect([fromJson('EmployeeDto').size, fromJson('EmployeePage').size]).toEqual([16, 4]);
      expect(missing(fromJson('EmployeePage'), Object.keys(res.body))).toEqual([]);
      for (const item of res.body.items) expect(missing(fromJson('EmployeeDto'), Object.keys(item))).toEqual([]);
    });

    it('GET /admin/departments → DepartmentDto', async () => {
      const res = await h.call('GET', '/admin/departments', h.token('u-hr'));
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(fromJson('DepartmentDto').size).toBe(9);
      for (const d of res.body) expect(missing(fromJson('DepartmentDto'), Object.keys(d))).toEqual([]);
    });

    it('GET /audit/workspaces/:id → AuditResponse, AuditEntry', async () => {
      const res = await h.call('GET', `/audit/workspaces/${COMPANY_WS}`, h.token('u-founder'));
      expect(res.status).toBe(200);
      expect(missing(fromJson('AuditResponse'), Object.keys(res.body))).toEqual([]);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const e of res.body.items) expect(missing(fromJson('AuditEntry'), Object.keys(e))).toEqual([]);
    });

    it('POST /admin/employees/import → ImportResult (incl. dryRun)', async () => {
      const csv = 'employeeNo,email,fullName,hireDate\nN1,n1@corp.com,新人,2026-11-01\n';
      const res = await h.call('POST', '/admin/employees/import', h.token('u-hr'), { csv, dryRun: true });
      expect(res.status).toBe(200);
      expect(fromJson('ImportResult').has('dryRun')).toBe(true);
      expect(missing(fromJson('ImportResult'), Object.keys(res.body))).toEqual([]);
    });
  });

  // ─────────────── 3. 請求欄位 ───────────────

  describe('request keys the app sends are declared by the DTOs', () => {
    const apiMethod = (name: string) => block(read(APP_FILES.api), new RegExp(`Future<[^>]*>+\\s+${name}\\(`), METHOD_END);

    it('employee form: create body ⊆ CreateEmployeeDto, edit body ⊆ UpdateEmployeeDto', () => {
      const build = block(read(APP_FILES.form), 'Map<String, dynamic> _buildBody()', METHOD_END);
      const create = literalKeys(block(build, 'if (e == null)', /\r?\n    \}/));
      const update = keysOf(build, /body\['(\w+)'\]/g);
      expect(create.size).toBeGreaterThanOrEqual(4);
      expect(update.size).toBeGreaterThanOrEqual(8);
      expect(missing(create, dtoProps(CreateEmployeeDto))).toEqual([]);
      expect(missing(update, dtoProps(UpdateEmployeeDto))).toEqual([]);
    });

    it('departments page: create ⊆ CreateDepartmentDto, every update ⊆ UpdateDepartmentDto', () => {
      const page = read(APP_FILES.departments);
      const create = literalKeys(block(page, 'createDepartment({', /\r?\n    \}/));
      const updates = new Set([...page.matchAll(/updateDepartment\([^,]+,\s*\{([^}]*)\}/g)].flatMap((m) => [...literalKeys(m[1])]));
      expect(create.has('name')).toBe(true);
      expect(updates).toEqual(new Set(['name', 'parentId', 'managerProfileId']));
      expect(missing(create, dtoProps(CreateDepartmentDto))).toEqual([]);
      expect(missing(updates, dtoProps(UpdateDepartmentDto))).toEqual([]);
    });

    it.each([
      ['getAdminEmployees', ListEmployeesQuery],
      ['getAdminDepartments', ListDepartmentsQuery],
      ['terminateEmployee', TerminateEmployeeDto],
      ['importEmployees', ImportEmployeesDto],
    ] as const)('api_client.%s keys ⊆ DTO', (method, dto) => {
      const keys = literalKeys(apiMethod(method));
      expect(keys.size).toBeGreaterThan(0);
      expect(missing(keys, dtoProps(dto))).toEqual([]);
    });

    it('api_client.getAuditLogs query ⊆ the @Query names of AuditController', () => {
      const controller = fs.readFileSync(path.join(SRC, 'audit/audit.controller.ts'), 'utf8');
      const accepted = keysOf(controller, /@Query\('(\w+)'\)/g);
      const sent = literalKeys(apiMethod('getAuditLogs'));
      expect(sent).toEqual(new Set(['from', 'to', 'action', 'actorId', 'cursor', 'limit']));
      expect(missing(sent, accepted)).toEqual([]);
    });
  });

  // ─────────────── 4. App 測試的假資料 ───────────────

  describe('app test fakes use the real DTO shapes', () => {
    const fakes = () => read(APP_FILES.fakes);
    const EMPLOYEE_KEYS = [
      'id', 'employeeNo', 'email', 'fullName', 'departmentId', 'departmentName', 'jobTitle', 'managerProfileId',
      'managerName', 'employmentType', 'employmentStatus', 'hireDate', 'terminationDate', 'phone', 'userId',
      'disabled', 'createdAt', 'updatedAt',
    ];
    const DEPARTMENT_KEYS = [
      'id', 'name', 'parentId', 'managerProfileId', 'managerName', 'sortOrder', 'archivedAt', 'memberCount', 'childCount',
    ];

    it('the key lists above are exactly what the backend mappers return', () => {
      const now = new Date();
      const emp = toEmployeeDto({
        id: 'p', workspaceId: 'w', employeeNo: 'E', email: 'e@x.com', fullName: 'n', departmentId: null, jobTitle: '',
        managerProfileId: null, employmentType: 'full_time', employmentStatus: 'active', hireDate: now,
        terminationDate: null, phone: '', userId: null, createdAt: now, updatedAt: now, department: null, manager: null,
        user: null,
      });
      const dept = toDepartmentDto({
        id: 'd', name: 'n', parentId: null, managerProfileId: null, sortOrder: 0, archivedAt: null, manager: null,
        _count: { employees: 0, children: 0 },
      });
      expect(Object.keys(emp).sort()).toEqual([...EMPLOYEE_KEYS].sort());
      expect(Object.keys(dept).sort()).toEqual([...DEPARTMENT_KEYS].sort());
    });

    it('employeeJson / deptJson in app/test/support/admin_fakes.dart have exactly those keys', () => {
      // 兩個都是 `=> { … };` 的箭頭函式
      const emp = literalKeys(block(fakes(), 'Map<String, dynamic> employeeJson(', /\r?\n\s*\};/));
      const dept = literalKeys(block(fakes(), 'Map<String, dynamic> deptJson(', /\r?\n\s*\};/));
      expect([...emp].sort()).toEqual([...EMPLOYEE_KEYS].sort());
      expect([...dept].sort()).toEqual([...DEPARTMENT_KEYS].sort());
    });
  });
});
