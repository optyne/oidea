import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { readSecret, SecretInputCancelled } from './read-secret';
import { runEmployeesImport } from './employees-import.command';
import { runCompanyInit } from './company-init.command';
import { CompanyInitError } from '../company/company-init.service';
import { EmployeesService } from '../employees/employees.service';
import { CompanyService } from '../company/company.service';
import { FakeCompanyPrisma } from '../company/testing/company-fakes';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('readSecret', () => {
  it('管線輸入：讀到 EOF，取第一行（去掉 \\r\\n），不寫任何東西到輸出', async () => {
    const input = new PassThrough();
    const output = { write: jest.fn() };
    const p = readSecret('密碼：', input as any, output);
    input.end('s3cret-from-pipe\r\nsecond line\n');
    await expect(p).resolves.toBe('s3cret-from-pipe');
    expect(output.write).not.toHaveBeenCalled();
  });

  it('終端機：raw mode、不回顯（輸出只有提示與換行）、Backspace 可刪字', async () => {
    const input: any = new EventEmitter();
    input.isTTY = true;
    input.setRawMode = jest.fn();
    input.setEncoding = jest.fn();
    input.resume = jest.fn();
    input.pause = jest.fn();
    const output = { write: jest.fn() };
    const p = readSecret('密碼：', input, output);
    input.emit('data', 'abcx');
    input.emit('data', '\u007f');
    input.emit('data', 'd\r');
    await expect(p).resolves.toBe('abcd');
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(output.write.mock.calls.map((c: any[]) => c[0])).toEqual(['密碼：', '\n']);
  });

  it('終端機 Ctrl-C → SecretInputCancelled', async () => {
    const input: any = new EventEmitter();
    input.isTTY = true;
    input.setRawMode = jest.fn();
    const p = readSecret('>', input, { write: () => undefined });
    input.emit('data', 'ab\u0003');
    await expect(p).rejects.toBeInstanceOf(SecretInputCancelled);
  });
});

describe('npm run employees:import', () => {
  let prisma: FakeCompanyPrisma;
  let service: EmployeesService;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    prisma = new FakeCompanyPrisma();
    prisma.addWorkspace({ id: 'ws-co', ownerId: 'u-1', isCompany: true });
    service = new EmployeesService(prisma as any, { record: jest.fn() } as any, new CompanyService(prisma as any));
    out = [];
    err = [];
  });

  const run = (argv: string[], file: Uint8Array | Error) =>
    runEmployeesImport(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      importRows: (rows) => service.importRows(rows),
      readFile: async () => {
        if (file instanceof Error) throw file;
        return file;
      },
    });

  it('UTF-8 含 BOM、CRLF：全部成功 → exit 0，印摘要', async () => {
    const csv =
      '﻿employeeNo,email,fullName,hireDate,departmentName,jobTitle\r\n' +
      'E1,A@corp.com,"王, 小明",2024-01-02,研發部,工程師\r\n' +
      'E2,b@corp.com,李四,2024-01-03,,\r\n';
    expect(await run(['emp.csv'], utf8(csv))).toBe(0);
    expect(out.join('\n')).toContain('新增 2、更新 0、失敗 0');
    expect(prisma.profiles.map((p) => [p.employeeNo, p.email, p.fullName])).toEqual([
      ['E1', 'a@corp.com', '王, 小明'],
      ['E2', 'b@corp.com', '李四'],
    ]);
    expect(err).toEqual([]);
  });

  it('有任何一列失敗（含欄位數錯誤的列）→ exit 1，逐列列出行號與原因，不印 email', async () => {
    const csv =
      'employeeNo,email,fullName,hireDate\n' +
      'E1,a@corp.com,A,2024-01-02\n' +
      'E2,secret-mail@corp.com,B,2024-13-01\n' +
      'E3,c@corp.com\n';
    expect(await run(['emp.csv'], utf8(csv))).toBe(1);
    expect(err).toEqual([
      expect.stringMatching(/^第 3 行（員工編號 E2）：.*YYYY-MM-DD/),
      expect.stringMatching(/^第 4 行：欄位數/),
    ]);
    expect([...out, ...err].join('\n')).not.toContain('secret-mail');
    expect(out.join('\n')).toContain('新增 1、更新 0、失敗 2');
  });

  it('不是 UTF-8（例如 Big5）→ exit 1，提示另存 UTF-8', async () => {
    expect(await run(['emp.csv'], new Uint8Array([0x65, 0x2c, 0xa4, 0xa4, 0xff]))).toBe(1);
    expect(err.join('\n')).toContain('UTF-8');
  });

  it('沒給檔名、檔頭錯誤、檔案不存在 → exit 1', async () => {
    expect(await run([], utf8(''))).toBe(1);
    expect(await run(['x.csv'], utf8('foo,bar\n1,2\n'))).toBe(1);
    expect(err.join('\n')).toContain('不認得的欄位');
    expect(await run(['x.csv'], new Error('ENOENT'))).toBe(1);
  });

  it('只有檔頭 → exit 1', async () => {
    expect(await run(['x.csv'], utf8('employeeNo,email,fullName,hireDate\n'))).toBe(1);
  });
});

describe('npm run company:init（參數解析）', () => {
  it('把旗標對應到 CompanyInitService.init 的選項', async () => {
    const init = jest.fn(async () => ({
      workspaceId: 'ws-1',
      workspaceCreated: false,
      ownerUserId: null,
      pendingOwnerEmail: 'boss@corp.com',
      profile: 'created' as const,
      profileId: 'p-1',
    }));
    const out: string[] = [];
    const code = await runCompanyInit(
      [
        '--workspace',
        'ws-1',
        '--owner-email',
        'boss@corp.com',
        '--employee-no',
        'E0',
        '--full-name',
        '老闆',
        '--hire-date',
        '2020-01-01',
      ],
      { out: (l) => out.push(l), err: () => undefined, init },
    );
    expect(code).toBe(0);
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        ownerEmail: 'boss@corp.com',
        employeeNo: 'E0',
        fullName: '老闆',
        hireDate: '2020-01-01',
        createName: undefined,
      }),
    );
    expect(out.join('\n')).toContain('待移交');
  });

  it('未知旗標、缺 --owner-email → exit 1 並印用法；CompanyInitError → exit 1', async () => {
    const err: string[] = [];
    const io = { out: () => undefined, err: (l: string) => err.push(l) };
    const init = jest.fn(async () => {
      throw new CompanyInitError('已經有公司工作空間');
    });
    expect(await runCompanyInit(['--bogus', 'x', '--owner-email', 'a@b.com'], { ...io, init })).toBe(1);
    expect(await runCompanyInit(['--workspace', 'ws-1'], { ...io, init })).toBe(1);
    expect(init).not.toHaveBeenCalled();
    expect(await runCompanyInit(['--create', 'Co', '--owner-email', 'a@b.com'], { ...io, init })).toBe(1);
    expect(err.join('\n')).toContain('已經有公司工作空間');
  });
});
