/**
 * H3 特休（勞基法第 38 條，週年制）：純函式。設計：notes/h3-design.md「Rules」。
 *
 * 年資從 hireDate 起算，期間以週年日切開：
 * - [到職 + 6 個月, 到職 + 1 年)：3 天
 * - 第 1→2 年：7；2→3：10；3→5：14；5→10：15；第 10 年起每年 +1（第 10 年 16 天），上限 30。
 * - 未滿 6 個月：沒有期間（回 null），特休 0。
 * 加月份時遇到月底就截在月底（8/31 + 6 個月 = 2/28 或 2/29；2/29 到職，平年的週年日是 2/28）。
 * 每個週年日都從 hireDate 直接加，不是一年一年累加（2/29 到職的人閏年的週年日回到 2/29）。
 */
import { addDays, isoDate } from './leave-days';

export interface AnnualPeriod {
  /** 期間第一天 */
  periodStart: Date;
  /** 期間最後一天（含） */
  periodEnd: Date;
  entitled: number;
  /** 0 = 6 個月到 1 年那一段；n ≥ 1 = 第 n 個週年起的那一年 */
  index: number;
}

/** UTC 日期加 n 個月，日子超過該月天數就截在月底。 */
export function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)));
}

/** 第 index 個期間的特休天數（index 同 AnnualPeriod.index） */
export function entitlementForPeriod(index: number): number {
  if (index <= 0) return 3;
  if (index === 1) return 7;
  if (index === 2) return 10;
  if (index <= 4) return 14;
  if (index <= 9) return 15;
  return Math.min(30, 15 + (index - 9));
}

/** 第 index 個期間的起始日（index 0 = 到職 + 6 個月） */
export function periodStartFor(hireDate: Date, index: number): Date {
  return index <= 0 ? addMonthsClamped(hireDate, 6) : addMonthsClamped(hireDate, 12 * index);
}

export function periodByIndex(hireDate: Date, index: number): AnnualPeriod {
  const periodStart = periodStartFor(hireDate, index);
  const next = periodStartFor(hireDate, index <= 0 ? 1 : index + 1);
  return { periodStart, periodEnd: addDays(next, -1), entitled: entitlementForPeriod(index), index };
}

/** 包含 date 的特休期間；未滿 6 個月（或在到職日之前）回 null。 */
export function annualPeriodOn(hireDate: Date, date: Date): AnnualPeriod | null {
  const t = date.getTime();
  if (t < periodStartFor(hireDate, 0).getTime()) return null;
  if (t < periodStartFor(hireDate, 1).getTime()) return periodByIndex(hireDate, 0);
  let n = Math.max(1, date.getUTCFullYear() - hireDate.getUTCFullYear());
  while (n > 1 && periodStartFor(hireDate, n).getTime() > t) n--;
  while (periodStartFor(hireDate, n + 1).getTime() <= t) n++;
  return periodByIndex(hireDate, n);
}

/** date 當天適用的特休天數（沒有期間 → 0） */
export function entitlementOn(hireDate: Date, date: Date): number {
  return annualPeriodOn(hireDate, date)?.entitled ?? 0;
}

/** 前一個期間（index 0 之前沒有 → null） */
export function previousPeriod(hireDate: Date, period: AnnualPeriod): AnnualPeriod | null {
  return period.index <= 0 ? null : periodByIndex(hireDate, period.index - 1);
}

/** periodStart 是不是這位員工某個期間的第一天 */
export function isPeriodStart(hireDate: Date, periodStart: Date): boolean {
  const p = annualPeriodOn(hireDate, periodStart);
  return !!p && isoDate(p.periodStart) === isoDate(periodStart);
}

/** 「今天」= Asia/Taipei（UTC+8，無日光節約）的日曆日，回傳該日的 UTC 午夜。 */
export function taipeiToday(now: Date): Date {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}
