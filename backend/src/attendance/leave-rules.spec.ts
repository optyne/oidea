import { HttpException } from '@nestjs/common';
import {
  countLeaveDays,
  halfDaysOverlap,
  isoDate,
  leaveDaysOrThrow,
  parseLeaveRange,
} from './leave-days';
import {
  addMonthsClamped,
  annualPeriodOn,
  entitlementOn,
  isPeriodStart,
  previousPeriod,
  taipeiToday,
} from './leave-entitlement';

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const range = (startDate: string, endDate: string, startPart = 'full', endPart = 'full') =>
  parseLeaveRange({ startDate, endDate, startPart, endPart });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return ((e as HttpException).getResponse() as { code?: string }).code;
  }
  return undefined;
};
const none = new Set<string>();

describe('H3 day counting', () => {
  // 2026-10-30 is a Friday, 2026-11-02 a Monday
  it('a range across a weekend counts only Mon–Fri', () => {
    expect(countLeaveDays(range('2026-10-29', '2026-11-03'), none)).toBe(4); // Thu Fri | Mon Tue
  });

  it('a holiday inside the range does not count', () => {
    expect(countLeaveDays(range('2026-10-08', '2026-10-12'), new Set(['2026-10-09']))).toBe(2); // Thu, (Fri hol), Mon
  });

  it('half day at the start (pm) and at the end (am)', () => {
    expect(countLeaveDays(range('2026-11-02', '2026-11-04', 'pm', 'full'), none)).toBe(2.5);
    expect(countLeaveDays(range('2026-11-02', '2026-11-04', 'full', 'am'), none)).toBe(2.5);
    expect(countLeaveDays(range('2026-11-02', '2026-11-04', 'pm', 'am'), none)).toBe(2);
  });

  it('half-day deduction only when that end day is a workday', () => {
    // starts Saturday pm, ends Monday am → only Monday morning
    expect(countLeaveDays(range('2026-10-31', '2026-11-02', 'pm', 'am'), none)).toBe(0.5);
  });

  it('single day: morning only, afternoon only, whole day', () => {
    expect(countLeaveDays(range('2026-11-02', '2026-11-02', 'full', 'am'), none)).toBe(0.5);
    expect(countLeaveDays(range('2026-11-02', '2026-11-02', 'pm', 'full'), none)).toBe(0.5);
    expect(countLeaveDays(range('2026-11-02', '2026-11-02'), none)).toBe(1);
  });

  it('both halves on one day is rejected', () => {
    expect(codeOf(() => range('2026-11-02', '2026-11-02', 'pm', 'am'))).toBe('leave_invalid_range');
  });

  it('end before start, bad dates and bad parts are rejected', () => {
    expect(codeOf(() => range('2026-11-03', '2026-11-02'))).toBe('leave_invalid_range');
    expect(codeOf(() => range('2026-02-30', '2026-03-02'))).toBe('leave_invalid_range');
    expect(codeOf(() => range('2026-11-02', '2026-11-02', 'am', 'full'))).toBe('leave_invalid_range');
    expect(codeOf(() => range('2026-01-01', '2027-01-03'))).toBe('leave_invalid_range'); // > 366 days
  });

  it('a range entirely on a weekend or holiday is rejected', () => {
    expect(codeOf(() => leaveDaysOrThrow(range('2026-10-31', '2026-11-01'), none))).toBe('leave_no_workdays');
    expect(codeOf(() => leaveDaysOrThrow(range('2026-10-09', '2026-10-11'), new Set(['2026-10-09'])))).toBe(
      'leave_no_workdays',
    );
  });

  it('across a year boundary with holidays in both years', () => {
    // 2026-12-30 Wed … 2027-01-05 Tue; holidays 2026-12-31 and 2027-01-01
    const hol = new Set(['2026-12-31', '2027-01-01']);
    // Wed 30, (Thu 31 hol), (Fri 1 hol), Sat, Sun, Mon 4, Tue 5
    expect(countLeaveDays(range('2026-12-30', '2027-01-05'), hol)).toBe(3);
    expect(countLeaveDays(range('2026-12-30', '2027-01-05'), none)).toBe(5);
  });

  it('weekday uses UTC date parts', () => {
    // 2026-11-02 is Monday in UTC whatever the machine timezone is
    expect(D('2026-11-02').getUTCDay()).toBe(1);
  });
});

describe('H3 overlap in half days', () => {
  const r = (s: string, e: string, sp = 'full', ep = 'full') => ({ start: D(s), end: D(e), startPart: sp, endPart: ep });
  it('morning-only and afternoon-only on the same day do not overlap', () => {
    expect(halfDaysOverlap(r('2026-11-02', '2026-11-02', 'full', 'am'), r('2026-11-02', '2026-11-02', 'pm'))).toBe(false);
  });
  it('morning-only overlaps a whole day on that day', () => {
    expect(halfDaysOverlap(r('2026-11-02', '2026-11-02', 'full', 'am'), r('2026-11-02', '2026-11-02'))).toBe(true);
  });
  it('a range ending at noon does not overlap one starting that afternoon', () => {
    expect(halfDaysOverlap(r('2026-11-02', '2026-11-04', 'full', 'am'), r('2026-11-04', '2026-11-05', 'pm'))).toBe(false);
    expect(halfDaysOverlap(r('2026-11-02', '2026-11-04'), r('2026-11-04', '2026-11-05', 'pm'))).toBe(true);
  });
  it('disjoint days do not overlap', () => {
    expect(halfDaysOverlap(r('2026-11-02', '2026-11-03'), r('2026-11-04', '2026-11-05'))).toBe(false);
  });
});

describe('H3 annual entitlement (anniversary method)', () => {
  const hire = D('2020-03-15');
  const at = (s: string) => entitlementOn(hire, D(s));

  it('before 6 months → 0 and no period', () => {
    expect(at('2020-09-14')).toBe(0); // 5 months 30 days
    expect(entitlementOn(D('2020-03-15'), D('2020-09-13'))).toBe(0); // 5 months 29 days
    expect(annualPeriodOn(hire, D('2020-09-14'))).toBeNull();
    expect(annualPeriodOn(hire, D('2019-01-01'))).toBeNull();
  });

  it('exactly 6 months → 3, period [6m, 1y)', () => {
    expect(at('2020-09-15')).toBe(3);
    const p = annualPeriodOn(hire, D('2020-09-15'))!;
    expect([isoDate(p.periodStart), isoDate(p.periodEnd)]).toEqual(['2020-09-15', '2021-03-14']);
    expect(at('2021-03-14')).toBe(3);
  });

  it('1y → 7, 2y → 10, 3y and 4y → 14', () => {
    expect(at('2021-03-15')).toBe(7);
    expect(at('2022-03-15')).toBe(10);
    expect(at('2023-03-15')).toBe(14);
    expect(at('2024-03-15')).toBe(14);
    expect(at('2025-03-14')).toBe(14);
  });

  it('5y and 9y → 15, 10y → 16, 24y → 30, 30y → 30', () => {
    expect(at('2025-03-15')).toBe(15);
    expect(at('2029-03-15')).toBe(15);
    expect(at('2030-03-15')).toBe(16);
    expect(at('2031-03-15')).toBe(17);
    expect(at('2044-03-15')).toBe(30);
    expect(at('2050-03-15')).toBe(30);
  });

  it('period start and end for a yearly period', () => {
    const p = annualPeriodOn(hire, D('2026-10-28'))!;
    expect([isoDate(p.periodStart), isoDate(p.periodEnd), p.entitled]).toEqual(['2026-03-15', '2027-03-14', 15]);
    const prev = previousPeriod(hire, p)!;
    expect([isoDate(prev.periodStart), isoDate(prev.periodEnd)]).toEqual(['2025-03-15', '2026-03-14']);
    expect(previousPeriod(hire, annualPeriodOn(hire, D('2020-10-01'))!)).toBeNull();
    expect(isoDate(previousPeriod(hire, annualPeriodOn(hire, D('2021-04-01'))!)!.periodStart)).toBe('2020-09-15');
  });

  it('Aug 31 hire: +6 months clamps to Feb 28 / Feb 29', () => {
    expect(isoDate(addMonthsClamped(D('2025-08-31'), 6))).toBe('2026-02-28');
    expect(isoDate(addMonthsClamped(D('2023-08-31'), 6))).toBe('2024-02-29');
    const h = D('2025-08-31');
    expect(entitlementOn(h, D('2026-02-27'))).toBe(0);
    expect(entitlementOn(h, D('2026-02-28'))).toBe(3);
    const p = annualPeriodOn(h, D('2026-02-28'))!;
    expect([isoDate(p.periodStart), isoDate(p.periodEnd)]).toEqual(['2026-02-28', '2026-08-30']);
  });

  it('Feb 29 hire: anniversary is Feb 28 in non-leap years, Feb 29 in leap years', () => {
    const h = D('2024-02-29');
    expect(isoDate(addMonthsClamped(h, 12))).toBe('2025-02-28');
    expect(entitlementOn(h, D('2025-02-27'))).toBe(3);
    expect(entitlementOn(h, D('2025-02-28'))).toBe(7);
    const p = annualPeriodOn(h, D('2027-06-01'))!;
    expect([isoDate(p.periodStart), isoDate(p.periodEnd)]).toEqual(['2027-02-28', '2028-02-28']);
    expect(isoDate(annualPeriodOn(h, D('2028-02-29'))!.periodStart)).toBe('2028-02-29');
  });

  it('isPeriodStart only accepts real period starts', () => {
    expect(isPeriodStart(hire, D('2020-09-15'))).toBe(true);
    expect(isPeriodStart(hire, D('2026-03-15'))).toBe(true);
    expect(isPeriodStart(hire, D('2026-03-16'))).toBe(false);
    expect(isPeriodStart(hire, D('2020-03-15'))).toBe(false); // hire date itself: no period yet
  });

  it('today is the Asia/Taipei calendar date', () => {
    expect(isoDate(taipeiToday(new Date('2026-10-28T15:59:59Z')))).toBe('2026-10-28');
    expect(isoDate(taipeiToday(new Date('2026-10-28T16:00:00Z')))).toBe('2026-10-29');
  });
});
