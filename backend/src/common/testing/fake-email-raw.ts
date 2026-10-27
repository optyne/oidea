/**
 * 測試用：模擬 `email-lookup.ts` 送出的那兩條 `$queryRaw`（`lower("email") = lower($1)`，可選
 * `"deletedAt" IS NULL`）。只認得這個形狀，其他 SQL 一律丟錯，避免測試默默通過。只給 *.spec.ts 使用。
 *
 * 比對是「整串小寫後相等」，不把 `_`／`%` 當萬用字元（跟 Postgres 的 `lower(a) = lower(b)` 一樣）。
 */
export interface RawEmailRow {
  id: string;
  email: string;
  deletedAt?: Date | null;
}

export function sqlText(strings: TemplateStringsArray | readonly string[]): string {
  return Array.from(strings).join('$?');
}

export function fakeEmailQueryRaw(rows: () => RawEmailRow[]) {
  return jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = sqlText(strings);
    if (!/^SELECT "id", "email" FROM "users" WHERE lower\("email"\) = lower\(\$\?\)/.test(sql)) {
      throw new Error(`fakeEmailQueryRaw: unsupported SQL ${sql}`);
    }
    const needle = String(values[0]).toLowerCase();
    const liveOnly = sql.includes('"deletedAt" IS NULL');
    return rows()
      .filter((r) => r.email.toLowerCase() === needle && (!liveOnly || r.deletedAt == null))
      .slice(0, 5)
      .map((r) => ({ id: r.id, email: r.email }));
  });
}
