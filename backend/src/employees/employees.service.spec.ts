import { BadRequestException } from '@nestjs/common';
import { EmployeeImportRow, EmployeesService, normalizeEmployeeRow, parseIsoDate } from './employees.service';
import { CompanyService } from '../company/company.service';
import { FakeCompanyPrisma } from '../company/testing/company-fakes';

const row = (p: Partial<EmployeeImportRow> = {}): EmployeeImportRow => ({
  employeeNo: 'E001',
  email: 'alice@corp.com',
  fullName: '王愛麗',
  hireDate: '2024-03-01',
  departmentName: '研發部',
  jobTitle: '工程師',
  ...p,
});

describe('EmployeesService.importRows', () => {
  let prisma: FakeCompanyPrisma;
  let audit: { record: jest.Mock };
  let service: EmployeesService;

  beforeEach(() => {
    prisma = new FakeCompanyPrisma();
    prisma.addWorkspace({ id: 'ws-co', ownerId: 'u-owner', isCompany: true });
    prisma.addWorkspace({ id: 'ws-other', ownerId: 'u-owner' });
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new EmployeesService(prisma as any, audit as any, new CompanyService(prisma as any));
  });

  it('沒有公司工作空間 → BadRequest（請先 company:init）', async () => {
    prisma.workspaces[0].isCompany = false;
    await expect(service.importRows([row()])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('指定的 workspaceId 不是公司工作空間 → BadRequest', async () => {
    await expect(service.importRows([row()], { workspaceId: 'ws-other' })).rejects.toThrow('只能匯入公司工作空間');
  });

  it('新增：email 存小寫去空白、hireDate 存 UTC 午夜、建立根部門', async () => {
    const res = await service.importRows([row({ email: '  Alice@Corp.COM ' })]);
    expect(res).toMatchObject({ workspaceId: 'ws-co', created: 1, updated: 0, failed: 0 });
    expect(prisma.profiles).toHaveLength(1);
    const p = prisma.profiles[0];
    expect(p).toMatchObject({ workspaceId: 'ws-co', employeeNo: 'E001', email: 'alice@corp.com', jobTitle: '工程師' });
    expect(p.hireDate.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(prisma.departments).toEqual([expect.objectContaining({ workspaceId: 'ws-co', name: '研發部', parentId: null })]);
    expect(p.departmentId).toBe(prisma.departments[0].id);
  });

  it('再匯入同一個 employeeNo → updated（不新增第二筆）', async () => {
    await service.importRows([row()]);
    const res = await service.importRows([row({ fullName: '王愛麗（改名）', jobTitle: '資深工程師' })]);
    expect(res.results).toEqual([expect.objectContaining({ employeeNo: 'E001', status: 'updated' })]);
    expect(prisma.profiles).toHaveLength(1);
    expect(prisma.profiles[0]).toMatchObject({ fullName: '王愛麗（改名）', jobTitle: '資深工程師' });
  });

  it('部門名稱不分大小寫比對既有根部門，不重複建立', async () => {
    const res = await service.importRows([
      row({ employeeNo: 'E1', email: 'a@corp.com', departmentName: 'Sales' }),
      row({ employeeNo: 'E2', email: 'b@corp.com', departmentName: 'SALES' }),
    ]);
    expect(res.created).toBe(2);
    expect(prisma.departments).toHaveLength(1);
    // 下一次匯入（新的快取）也沿用同一個部門
    await service.importRows([row({ employeeNo: 'E3', email: 'c@corp.com', departmentName: 'sales' })]);
    expect(prisma.departments).toHaveLength(1);
    expect(new Set(prisma.profiles.map((p) => p.departmentId))).toEqual(new Set([prisma.departments[0].id]));
  });

  it('departmentName 空白 → 不指定部門', async () => {
    await service.importRows([row({ departmentName: '  ' })]);
    expect(prisma.profiles[0].departmentId).toBeNull();
    expect(prisma.departments).toHaveLength(0);
  });

  it('同一個 email（大小寫不同）屬於另一個 employeeNo → 該列失敗，其他列照常', async () => {
    await service.importRows([row({ employeeNo: 'E001', email: 'alice@corp.com' })]);
    const res = await service.importRows([
      row({ line: 2, employeeNo: 'E999', email: 'ALICE@corp.com' }),
      row({ line: 3, employeeNo: 'E002', email: 'bob@corp.com' }),
    ]);
    expect(res.results).toEqual([
      expect.objectContaining({ line: 2, employeeNo: 'E999', status: 'error', reason: expect.stringContaining('E001') }),
      expect.objectContaining({ line: 3, employeeNo: 'E002', status: 'created' }),
    ]);
    expect(prisma.profiles.find((p) => p.employeeNo === 'E999')).toBeUndefined();
    expect(prisma.profiles.find((p) => p.employeeNo === 'E001')!.email).toBe('alice@corp.com');
  });

  it('驗證：缺欄位、email 格式、日期格式與不存在的日期 → error 列，不寫入', async () => {
    const res = await service.importRows([
      row({ line: 2, employeeNo: '' }),
      row({ line: 3, employeeNo: 'E2', email: 'not-an-email' }),
      row({ line: 4, employeeNo: 'E3', email: 'c@corp.com', hireDate: '2024/03/01' }),
      row({ line: 5, employeeNo: 'E4', email: 'd@corp.com', hireDate: '2024-02-30' }),
      row({ line: 6, employeeNo: 'E5', email: 'e@corp.com', fullName: '   ' }),
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['error', 'error', 'error', 'error', 'error']);
    expect(res.results[0].reason).toContain('employeeNo');
    expect(res.results[1].reason).toContain('email');
    expect(res.results[2].reason).toContain('YYYY-MM-DD');
    expect(res.results[3].reason).toContain('YYYY-MM-DD');
    expect(res.results[4].reason).toContain('fullName');
    expect(prisma.profiles).toHaveLength(0);
    expect(prisma.departments).toHaveLength(0);
  });

  it('同一批裡 employeeNo 重複 → 第二筆失敗', async () => {
    const res = await service.importRows([row(), row({ email: 'other@corp.com' })]);
    expect(res.results.map((r) => r.status)).toEqual(['created', 'error']);
    expect(res.results[1].reason).toContain('重複');
    expect(prisma.profiles[0].email).toBe('alice@corp.com');
  });

  it('已封存的同名根部門 → 該列失敗', async () => {
    prisma.departments.push({ id: 'd-old', workspaceId: 'ws-co', name: '研發部', parentId: null, archivedAt: new Date() });
    const res = await service.importRows([row()]);
    expect(res.results[0]).toMatchObject({ status: 'error', reason: expect.stringContaining('封存') });
  });

  it('建立部門時撞到同時建立的同名部門（P2002）→ 重查後沿用', async () => {
    const realCreate = prisma.department.create.getMockImplementation()!;
    prisma.department.create.mockImplementationOnce(async (args: any) => {
      // 模擬另一個請求搶先建立
      prisma.departments.push({ id: 'd-race', workspaceId: 'ws-co', name: '研發部', parentId: null, archivedAt: null });
      return realCreate(args);
    });
    const res = await service.importRows([row()]);
    expect(res.created).toBe(1);
    expect(prisma.profiles[0].departmentId).toBe('d-race');
  });

  it('audit employee.import 只有數量，不含 email／姓名', async () => {
    await service.importRows([row(), row({ employeeNo: 'E2', email: 'bad' })], { actorId: 'u-hr' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const call = audit.record.mock.calls[0][0];
    expect(call).toMatchObject({
      actorId: 'u-hr',
      workspaceId: 'ws-co',
      action: 'employee.import',
      metadata: { total: 2, created: 1, updated: 0, failed: 1 },
    });
    const dumped = JSON.stringify(call);
    expect(dumped).not.toContain('alice@corp.com');
    expect(dumped).not.toContain('王愛麗');
  });
});

describe('normalizeEmployeeRow / parseIsoDate', () => {
  it('parseIsoDate 只收真的日期', () => {
    expect(parseIsoDate('2024-02-29')!.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(parseIsoDate('2023-02-29')).toBeNull();
    expect(parseIsoDate('2024-1-01')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });

  it('欄位太長 → error', () => {
    const r = normalizeEmployeeRow(row({ employeeNo: 'x'.repeat(65) }));
    expect('error' in r && r.error).toContain('employeeNo');
  });
});
