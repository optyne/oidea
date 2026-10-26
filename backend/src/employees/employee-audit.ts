/**
 * `employee.update` audit 的 `changes`（H2 review S7）：每個改過的欄位記 `{ from, to }`，PATCH 與 CSV 匯入共用。
 *
 * 個資最小化（H2 re-verify）：姓名、電話只記 `{ changed: true }`；email 是身分對應（誰登入會拿到這筆
 * profile），記前後值。日期記 `YYYY-MM-DD`。
 */
export type AuditChange = { from: unknown; to: unknown } | { changed: true };

/** 只記「有改」、不記值的欄位 */
export const AUDIT_VALUELESS_FIELDS: ReadonlySet<string> = new Set(['fullName', 'phone']);

const auditValue = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null));

export function profileAuditChanges(
  fields: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, AuditChange> {
  const out: Record<string, AuditChange> = {};
  for (const f of fields) {
    out[f] = AUDIT_VALUELESS_FIELDS.has(f) ? { changed: true } : { from: auditValue(before[f]), to: auditValue(after[f]) };
  }
  return out;
}
