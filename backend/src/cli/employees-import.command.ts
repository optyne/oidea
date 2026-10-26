import { CsvParseError } from '../employees/csv';
import { EmployeeCsvHeaderError, parseEmployeeCsv } from '../employees/employee-csv';
import { EmployeeImportResult, EmployeeImportRow } from '../employees/employees.service';
import { CliIo } from './run-cli';

export interface EmployeesImportDeps extends CliIo {
  importRows: (rows: EmployeeImportRow[]) => Promise<EmployeeImportResult>;
  readFile: (path: string) => Promise<Uint8Array>;
}

export const EMPLOYEES_IMPORT_USAGE =
  '用法：npm run employees:import -- <員工.csv>（UTF-8，第一行為檔頭：employeeNo,email,fullName,hireDate,departmentName,jobTitle）\n' +
  'departmentName、jobTitle 可省略：檔頭沒有的欄位不會改到既有員工；有這一欄但留白 = 清掉。已綁定帳號的員工不能用匯入改 email。';

/**
 * `npm run employees:import -- <csv>`。回傳 exit code：全部成功 0，有任何一列失敗或檔案錯誤 1。
 * 輸出只有行號、員工編號與原因，不印 email／姓名。
 */
export async function runEmployeesImport(argv: string[], deps: EmployeesImportDeps): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional.length !== 1 || argv.some((a) => a === '-h' || a === '--help')) {
    deps.err(EMPLOYEES_IMPORT_USAGE);
    return 1;
  }
  const path = positional[0];

  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(path);
  } catch (err) {
    deps.err(`讀不到檔案 ${path}：${(err as Error).message}`);
    return 1;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    deps.err('檔案不是 UTF-8 編碼（Excel 請用「CSV UTF-8」另存）');
    return 1;
  }

  let parsed: ReturnType<typeof parseEmployeeCsv>;
  try {
    parsed = parseEmployeeCsv(text);
  } catch (err) {
    if (err instanceof CsvParseError || err instanceof EmployeeCsvHeaderError) {
      deps.err(err.message);
      return 1;
    }
    throw err;
  }

  if (parsed.rows.length === 0 && parsed.malformed.length === 0) {
    deps.err('CSV 沒有任何資料列');
    return 1;
  }

  const result = await deps.importRows(parsed.rows);
  const failures = [
    ...parsed.malformed.map((m) => ({ line: m.line, employeeNo: '', reason: m.reason })),
    ...result.results
      .filter((r) => r.status === 'error')
      .map((r) => ({ line: r.line, employeeNo: r.employeeNo, reason: r.reason ?? '' })),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  for (const f of failures) {
    const who = f.employeeNo ? `（員工編號 ${f.employeeNo}）` : '';
    deps.err(`第 ${f.line ?? '?'} 行${who}：${f.reason}`);
  }
  deps.out(
    `匯入完成：新增 ${result.created}、更新 ${result.updated}、失敗 ${failures.length}、未變更 ${result.unchanged ?? 0}（共 ${parsed.rows.length + parsed.malformed.length} 列）`,
  );
  return failures.length > 0 ? 1 : 0;
}
