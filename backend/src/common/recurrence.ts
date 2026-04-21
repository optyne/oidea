export const RECURRENCE_RULES = [
  'none',
  'daily',
  'weekly',
  'monthly',
  'yearly',
] as const;
export type RecurrenceRule = (typeof RECURRENCE_RULES)[number];

/**
 * 將 `from` 依 rule + interval 推進一次。
 *
 * 月 / 年推進採「日期 clamp 到目標月份最後一天」策略：
 *   - Jan 31 + 1 month → Feb 28 (平年) / Feb 29 (閏年)
 *   - 2024-02-29 + 1 year → 2025-02-28
 *
 * `none` → 回傳原時間；呼叫端需自行把 status 設為 completed。
 */
export function addRecurrence(
  from: Date,
  rule: RecurrenceRule,
  interval: number,
): Date {
  if (interval < 1) {
    throw new Error('recurrenceInterval 必須 >= 1');
  }
  const d = new Date(from.getTime());
  switch (rule) {
    case 'none':
      return d;
    case 'daily':
      d.setUTCDate(d.getUTCDate() + interval);
      return d;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7 * interval);
      return d;
    case 'monthly':
      return clampDay(d, d.getUTCFullYear(), d.getUTCMonth() + interval);
    case 'yearly':
      return clampDay(d, d.getUTCFullYear() + interval, d.getUTCMonth());
  }
}

/**
 * 保留 `from` 的日 / 時 / 分 / 秒，但月份與年份依指定覆蓋；
 * 若目標月份天數不足 (例如 2/30)，則 clamp 到該月最後一日。
 */
function clampDay(from: Date, targetYear: number, targetMonth: number): Date {
  const originalDay = from.getUTCDate();
  const hour = from.getUTCHours();
  const minute = from.getUTCMinutes();
  const second = from.getUTCSeconds();
  const ms = from.getUTCMilliseconds();

  // 正規化 targetMonth 超出 0-11 的情況（setUTCMonth 其實會自動換年，
  // 但因為我們已經自己算好 year / month，所以不依賴自動行為）。
  const year = targetYear + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;

  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(originalDay, lastDayOfMonth);

  return new Date(Date.UTC(year, month, day, hour, minute, second, ms));
}
