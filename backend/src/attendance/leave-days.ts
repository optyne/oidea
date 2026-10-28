/**
 * H3 請假天數與重疊（純函式，設計：notes/h3-design.md「Rules」）。
 *
 * 日期一律是 `@db.Date` 的 UTC 午夜 Date，只用 UTC 的年月日，不碰本地時間。
 */
import { HttpStatus } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { parseIsoDate } from '../employees/employees.service';

export type StartPart = 'full' | 'pm';
export type EndPart = 'full' | 'am';
export const START_PARTS: readonly StartPart[] = ['full', 'pm'];
export const END_PARTS: readonly EndPart[] = ['full', 'am'];

/** 一張假單最長的日曆天數（擋掉一次請好幾年、讓逐日計算跑很久的輸入） */
export const MAX_LEAVE_SPAN_DAYS = 366;

const DAY_MS = 86_400_000;

export const leaveErrors = {
  invalidRange: (message = '請假日期範圍不正確') => apiError(HttpStatus.BAD_REQUEST, 'leave_invalid_range', message),
  noWorkdays: () => apiError(HttpStatus.BAD_REQUEST, 'leave_no_workdays', '這段期間沒有需要請假的工作日'),
  overlap: () => apiError(HttpStatus.CONFLICT, 'leave_overlap', '這段期間跟你另一張待審核或已核准的假單重疊'),
  spansPeriod: () =>
    apiError(HttpStatus.BAD_REQUEST, 'leave_spans_period', '特休跨越了週年期間，請以週年日為界拆成兩張假單'),
  insufficientBalance: (remaining: number) =>
    apiError(HttpStatus.BAD_REQUEST, 'leave_insufficient_balance', '特休餘額不足', { remaining }),
  noEmployeeProfile: () =>
    apiError(HttpStatus.BAD_REQUEST, 'no_employee_profile', '公司工作空間裡找不到你的員工資料，無法計算特休'),
  holidayInvalid: (message: string) => apiError(HttpStatus.BAD_REQUEST, 'holiday_invalid', message),
  adjustmentInvalid: (message: string) => apiError(HttpStatus.BAD_REQUEST, 'leave_adjustment_invalid', message),
};

/** 'YYYY-MM-DD' 的 UTC 日期字串 */
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** 1970-01-01 起算的日序號 */
export const dayNumber = (d: Date): number => Math.floor(d.getTime() / DAY_MS);

export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);

/** 週六、週日（UTC 的星期） */
export const isWeekend = (d: Date): boolean => {
  const w = d.getUTCDay();
  return w === 0 || w === 6;
};

export interface LeaveRange {
  start: Date;
  end: Date;
  startPart: StartPart;
  endPart: EndPart;
}

/** 字串輸入 → 驗證過的範圍。日期不合法、結束早於起始、同一天上午＋下午、超過上限 → `leave_invalid_range`。 */
export function parseLeaveRange(input: {
  startDate: string;
  endDate: string;
  startPart?: string | null;
  endPart?: string | null;
}): LeaveRange {
  const start = parseIsoDate(input.startDate);
  const end = parseIsoDate(input.endDate);
  if (!start || !end) throw leaveErrors.invalidRange('日期必須是有效的 YYYY-MM-DD');
  const startPart = (input.startPart ?? 'full') as StartPart;
  const endPart = (input.endPart ?? 'full') as EndPart;
  if (!START_PARTS.includes(startPart) || !END_PARTS.includes(endPart)) {
    throw leaveErrors.invalidRange('startPart 只能是 full／pm，endPart 只能是 full／am');
  }
  if (end.getTime() < start.getTime()) throw leaveErrors.invalidRange('結束日不可早於起始日');
  if (dayNumber(end) - dayNumber(start) + 1 > MAX_LEAVE_SPAN_DAYS) {
    throw leaveErrors.invalidRange(`一張假單最多 ${MAX_LEAVE_SPAN_DAYS} 天`);
  }
  if (dayNumber(start) === dayNumber(end) && startPart === 'pm' && endPart === 'am') {
    throw leaveErrors.invalidRange('同一天不能同時只請下午又只請上午');
  }
  return { start, end, startPart, endPart };
}

/**
 * 請假天數：範圍內的工作日（不是週末、不在 holidays）− 起始日只請下午的 0.5 − 結束日只請上午的 0.5
 * （扣半天只在那天是工作日時）。`holidays` 是 'YYYY-MM-DD' 的集合。
 */
export function countLeaveDays(range: LeaveRange, holidays: ReadonlySet<string>): number {
  const isWorkday = (d: Date) => !isWeekend(d) && !holidays.has(isoDate(d));
  let halves = 0;
  for (let n = dayNumber(range.start); n <= dayNumber(range.end); n++) {
    if (isWorkday(new Date(n * DAY_MS))) halves += 2;
  }
  if (range.startPart === 'pm' && isWorkday(range.start)) halves -= 1;
  if (range.endPart === 'am' && isWorkday(range.end)) halves -= 1;
  return halves / 2;
}

/** 驗證＋計算；0 天 → `leave_no_workdays`。 */
export function leaveDaysOrThrow(range: LeaveRange, holidays: ReadonlySet<string>): number {
  const days = countLeaveDays(range, holidays);
  if (days <= 0) throw leaveErrors.noWorkdays();
  return days;
}

/** 半天為單位的閉區間：起點 2·日 (+1 下午)，終點 2·日 (+1 除非只請上午)。 */
export function halfDayInterval(r: { start: Date; end: Date; startPart: string; endPart: string }): [number, number] {
  return [2 * dayNumber(r.start) + (r.startPart === 'pm' ? 1 : 0), 2 * dayNumber(r.end) + (r.endPart === 'am' ? 0 : 1)];
}

export function halfDaysOverlap(
  a: { start: Date; end: Date; startPart: string; endPart: string },
  b: { start: Date; end: Date; startPart: string; endPart: string },
): boolean {
  const [a0, a1] = halfDayInterval(a);
  const [b0, b1] = halfDayInterval(b);
  return a0 <= b1 && b0 <= a1;
}

/** Prisma Decimal／number／string → number（回應裡 `days` 一律是 number） */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  return Number(String(v));
}
