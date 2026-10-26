import { CsvRecord, parseCsv } from './csv';
import { EmployeeImportRow } from './employees.service';

/**
 * CSV 的欄位（檔頭必須有前四個；後兩個可省略）。比對時不分大小寫、忽略前後空白。
 * 省略的欄位在更新既有員工時不會被動到；有這一欄但留白 = 清掉（review S10）。
 */
export const EMPLOYEE_CSV_REQUIRED = ['employeeNo', 'email', 'fullName', 'hireDate'] as const;
export const EMPLOYEE_CSV_OPTIONAL = ['departmentName', 'jobTitle'] as const;
const ALL_COLUMNS = [...EMPLOYEE_CSV_REQUIRED, ...EMPLOYEE_CSV_OPTIONAL] as const;
type Column = (typeof ALL_COLUMNS)[number];

export class EmployeeCsvHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeCsvHeaderError';
  }
}

export interface ParsedEmployeeCsv {
  rows: EmployeeImportRow[];
  /** 欄位數跟檔頭不同的資料行；不送進匯入，直接當失敗列。 */
  malformed: { line: number; reason: string }[];
}

/**
 * 解析員工 CSV：第一行一定是檔頭。CSV 格式錯誤丟 CsvParseError，檔頭錯誤丟 EmployeeCsvHeaderError。
 */
export function parseEmployeeCsv(text: string): ParsedEmployeeCsv {
  const records = parseCsv(text);
  if (records.length === 0) throw new EmployeeCsvHeaderError('CSV 是空的，第一行必須是檔頭');
  const [header, ...data] = records;
  const index = mapHeader(header);

  const rows: EmployeeImportRow[] = [];
  const malformed: { line: number; reason: string }[] = [];
  for (const rec of data) {
    if (rec.fields.length !== header.fields.length) {
      malformed.push({
        line: rec.line,
        reason: `欄位數 ${rec.fields.length} 與檔頭的 ${header.fields.length} 不同`,
      });
      continue;
    }
    const get = (col: Column) => (index[col] === undefined ? '' : rec.fields[index[col]!]);
    // 可省略的欄位：檔頭沒有 → undefined（更新時不動），不要變成空字串（那會清掉資料）
    const optional = (col: Column) => (index[col] === undefined ? undefined : rec.fields[index[col]!]);
    rows.push({
      line: rec.line,
      employeeNo: get('employeeNo'),
      email: get('email'),
      fullName: get('fullName'),
      hireDate: get('hireDate'),
      departmentName: optional('departmentName'),
      jobTitle: optional('jobTitle'),
    });
  }
  return { rows, malformed };
}

function mapHeader(header: CsvRecord): Partial<Record<Column, number>> {
  const index: Partial<Record<Column, number>> = {};
  header.fields.forEach((raw, i) => {
    const name = raw.trim().toLowerCase();
    const col = ALL_COLUMNS.find((c) => c.toLowerCase() === name);
    if (!col) {
      throw new EmployeeCsvHeaderError(
        `不認得的欄位「${raw.trim()}」；可用的欄位：${ALL_COLUMNS.join(', ')}`,
      );
    }
    if (index[col] !== undefined) throw new EmployeeCsvHeaderError(`欄位「${col}」重複`);
    index[col] = i;
  });
  const missing = EMPLOYEE_CSV_REQUIRED.filter((c) => index[c] === undefined);
  if (missing.length > 0) {
    throw new EmployeeCsvHeaderError(`檔頭缺少必要欄位：${missing.join(', ')}`);
  }
  return index;
}
