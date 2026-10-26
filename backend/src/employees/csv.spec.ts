import { CsvParseError, parseCsv } from './csv';
import { EmployeeCsvHeaderError, parseEmployeeCsv } from './employee-csv';

const fields = (text: string) => parseCsv(text).map((r) => r.fields);

describe('parseCsv（RFC 4180）', () => {
  it('基本：逗號分隔、LF 換行、結尾換行不多出空記錄', () => {
    expect(fields('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('CRLF 與單獨的 CR 都算換行', () => {
    expect(fields('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(fields('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('移除 UTF-8 BOM（第一個欄位名稱不會帶 \\uFEFF）', () => {
    const recs = fields('﻿employeeNo,email\nE1,a@x.com');
    expect(recs[0][0]).toBe('employeeNo');
    expect(recs[0][0].charCodeAt(0)).not.toBe(0xfeff);
  });

  it('引號欄位可以含逗號、換行（CRLF 正規化成 \\n）與 "" 跳脫', () => {
    expect(fields('name,note\r\n"Wang, Xiao","say ""hi""\r\nline2"\r\n')).toEqual([
      ['name', 'note'],
      ['Wang, Xiao', 'say "hi"\nline2'],
    ]);
  });

  it('空欄位與空的引號欄位', () => {
    expect(fields('a,,c\n"",x,\n')).toEqual([
      ['a', '', 'c'],
      ['', 'x', ''],
    ]);
  });

  it('完全空白的行略過；行號包含引號欄位內的換行', () => {
    const recs = parseCsv('h1,h2\n\n"a\nb",c\nd,e\n');
    expect(recs.map((r) => r.line)).toEqual([1, 3, 5]);
    expect(recs[1].fields).toEqual(['a\nb', 'c']);
  });

  it('最後一筆沒有換行（含以引號欄位結尾）', () => {
    expect(fields('a,b\n1,"2"')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('沒有引號的欄位中間的 " 照字面保留；中文照常', () => {
    expect(fields('a"b,王小明')).toEqual([['a"b', '王小明']]);
  });

  it('引號沒有關閉 → CsvParseError（帶行號）', () => {
    expect(() => parseCsv('a,b\n"oops,c\n')).toThrow(CsvParseError);
    try {
      parseCsv('a,b\n"oops,c\n');
    } catch (e) {
      expect((e as CsvParseError).line).toBe(2);
    }
  });

  it('引號欄位後面接了多餘字元 → CsvParseError', () => {
    expect(() => parseCsv('"a"b,c')).toThrow(CsvParseError);
  });

  it('空字串 → 沒有記錄', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('﻿')).toEqual([]);
  });
});

describe('parseEmployeeCsv', () => {
  it('檔頭不分大小寫、可調換順序；選填欄位可省略', () => {
    const { rows, malformed } = parseEmployeeCsv(
      '﻿Email, EMPLOYEENO ,fullName,hireDate\r\nA@x.com,E1,王小明,2024-01-02\r\n',
    );
    expect(malformed).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        employeeNo: 'E1',
        email: 'A@x.com',
        fullName: '王小明',
        hireDate: '2024-01-02',
        departmentName: '',
        jobTitle: '',
      },
    ]);
  });

  it('缺必要欄位、不認得的欄位、重複欄位、空檔案 → EmployeeCsvHeaderError', () => {
    expect(() => parseEmployeeCsv('employeeNo,email,fullName\n')).toThrow(/hireDate/);
    expect(() => parseEmployeeCsv('employeeNo,email,fullName,hireDate,salary\n')).toThrow(EmployeeCsvHeaderError);
    expect(() => parseEmployeeCsv('employeeNo,email,email,fullName,hireDate\n')).toThrow(/重複/);
    expect(() => parseEmployeeCsv('')).toThrow(EmployeeCsvHeaderError);
  });

  it('欄位數跟檔頭不同的列放進 malformed，不送去匯入', () => {
    const { rows, malformed } = parseEmployeeCsv(
      'employeeNo,email,fullName,hireDate\nE1,a@x.com,A,2024-01-01\nE2,b@x.com\n',
    );
    expect(rows.map((r) => r.employeeNo)).toEqual(['E1']);
    expect(malformed).toEqual([{ line: 3, reason: expect.stringContaining('欄位數') }]);
  });
});
