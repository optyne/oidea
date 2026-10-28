import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { Clock } from '../common/clock';
import { apiError } from '../common/api-error';
import { LOCKED_TX_OPTIONS, lockEmployeeProfile, lockUser } from '../common/identity-lock';
import { AuditRequestContext, AuditService } from '../audit/audit.service';
import { CompanyService } from '../company/company.service';
import { parseIsoDate } from '../employees/employees.service';
import { LeaveRange, halfDaysOverlap, isoDate, leaveDaysOrThrow, leaveErrors, toNumber } from './leave-days';
import { AnnualPeriod, annualPeriodOn, periodStartFor, previousPeriod, taipeiToday } from './leave-entitlement';
import { lockLeavePolicy } from './leave-lock';

type Db = PrismaService | Prisma.TransactionClient;

/** 特休餘額（`annual`）：preview、GET balance、後台 current／previous 共用的形狀。日期是 'YYYY-MM-DD'。 */
export interface AnnualBalanceDto {
  /** 期間第一天；未滿 6 個月（沒有期間）時為 null（只會出現在 preview） */
  periodStart: string | null;
  /** 期間最後一天（含） */
  periodEnd: string | null;
  entitled: number;
  adjusted: number;
  used: number;
  remaining: number;
}

export interface LeaveEvaluation {
  days: number;
  /** 只有公司工作空間的特休才有 */
  annual: AnnualBalanceDto | null;
}

export const HOLIDAY_MAX_ITEMS = 60;
export const HOLIDAY_NAME_MAX = 50;
export const ADJUSTMENT_REASON_MAX = 200;
export const ADJUSTMENT_MAX_ABS_DAYS = 365;
/** 這些狀態佔用日期與特休餘額；rejected／cancelled 不佔 */
export const ACTIVE_LEAVE_STATUSES = ['pending', 'approved'];

const cannotEditSelf = () =>
  apiError(HttpStatus.FORBIDDEN, 'cannot_edit_self', '不能在後台修改自己的員工資料，請由其他管理者處理');

/**
 * H3 請假規則（notes/h3-design.md）：天數、重疊、特休餘額、假日與餘額調整的後台。
 * 「今天」一律是 Clock 的 Asia/Taipei 日期。
 */
@Injectable()
export class LeavePolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly company: CompanyService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────── 請假單的檢查（建立與 preview 共用） ───────────────

  /**
   * 建立請假的鎖（交易的第一個動作，還沒寫入任何東西）。順序照 identity-lock.ts：org → profile → user。
   * - 公司工作空間的特休：先拿 requester 員工資料的 profile 鎖。改到職日（H2 PATCH /admin/employees/:id）
   *   拿同一把鎖，所以特休的期間與餘額檢查不會跟改到職日交錯：evaluate 在鎖底下才讀 hireDate。
   * - 再拿 requester 的 user 鎖：同一個人同時送出的假單（任何工作空間）排隊，重疊與已用特休看得到彼此。
   * profile 是在拿鎖前查的；綁定換人要拿 user 鎖，拿到 user 鎖之後 evaluate 讀到的就是同一份綁定，
   * 只有「查完、拿 user 鎖前剛好解除再綁另一份資料」這種情況會讀到沒鎖的 profile。
   */
  async lockForCreate(tx: Prisma.TransactionClient, userId: string, workspaceId: string, type: string): Promise<void> {
    if (type === 'annual' && (await this.company.isCompanyWorkspace(workspaceId))) {
      const profile = await tx.employeeProfile.findFirst({ where: { workspaceId, userId }, select: { id: true } });
      if (profile) await lockEmployeeProfile(tx, profile.id);
    }
    await lockUser(tx, userId);
  }

  /**
   * 天數 → 重疊 → 特休（公司工作空間：員工資料、跨期間、餘額）。不檢查餘額夠不夠，由呼叫端決定
   * （建立要擋，preview 只回報）。建立時在 requester 的 user 鎖底下、用交易的 tx 呼叫。
   */
  async evaluate(db: Db, userId: string, workspaceId: string, type: string, range: LeaveRange): Promise<LeaveEvaluation> {
    const holidays = await this.holidaySet(db, workspaceId, range.start, range.end);
    const days = leaveDaysOrThrow(range, holidays);

    // 重疊不分工作空間：同一個人不能同時請兩次假。建立時的 user 鎖也不分工作空間，所以照樣排隊。
    const others = await db.leaveRequest.findMany({
      where: {
        requesterId: userId,
        status: { in: ACTIVE_LEAVE_STATUSES },
        startDate: { lte: range.end },
        endDate: { gte: range.start },
      },
      select: { startDate: true, endDate: true, startPart: true, endPart: true },
    });
    if (others.some((o) => halfDaysOverlap(range, { start: o.startDate, end: o.endDate, startPart: o.startPart, endPart: o.endPart }))) {
      throw leaveErrors.overlap();
    }

    if (type !== 'annual' || !(await this.company.isCompanyWorkspace(workspaceId))) return { days, annual: null };

    const profile = await db.employeeProfile.findFirst({
      where: { workspaceId, userId },
      select: { id: true, hireDate: true },
    });
    if (!profile) throw leaveErrors.noEmployeeProfile();
    const period = annualPeriodOn(profile.hireDate, range.start);
    const endPeriod = annualPeriodOn(profile.hireDate, range.end);
    if ((period ? isoDate(period.periodStart) : null) !== (endPeriod ? isoDate(endPeriod.periodStart) : null)) {
      throw leaveErrors.spansPeriod();
    }
    const annual = period
      ? await this.balanceFor(db, workspaceId, profile.id, userId, period)
      : { periodStart: null, periodEnd: null, entitled: 0, adjusted: 0, used: 0, remaining: 0 };
    return { days, annual };
  }

  /** 我在 workspaceId 的目前特休（GET /attendance/leaves/balance）。不是公司工作空間、或還沒滿 6 個月 → null。 */
  async myCurrentBalance(userId: string, workspaceId: string): Promise<AnnualBalanceDto | null> {
    if (!(await this.company.isCompanyWorkspace(workspaceId))) return null;
    const profile = await this.prisma.employeeProfile.findFirst({
      where: { workspaceId, userId },
      select: { id: true, hireDate: true },
    });
    if (!profile) throw leaveErrors.noEmployeeProfile();
    const period = annualPeriodOn(profile.hireDate, this.today());
    return period ? this.balanceFor(this.prisma, workspaceId, profile.id, userId, period) : null;
  }

  private today(): Date {
    return taipeiToday(this.clock.now());
  }

  private async holidaySet(db: Db, workspaceId: string, start: Date, end: Date): Promise<Set<string>> {
    const rows = await db.holiday.findMany({
      where: { workspaceId, date: { gte: start, lte: end } },
      select: { date: true },
    });
    return new Set(rows.map((r) => isoDate(r.date)));
  }

  /**
   * entitled + 該期間的調整 − 該期間開始的 pending／approved 特休。
   * 調整用期間序號（periodIndex）對應，不是日期：改到職日之後調整仍屬於同一個年資期間。
   */
  private async balanceFor(
    db: Db,
    workspaceId: string,
    profileId: string,
    userId: string | null,
    period: AnnualPeriod,
  ): Promise<AnnualBalanceDto> {
    const adjustments = await db.leaveBalanceAdjustment.findMany({
      where: { profileId, periodIndex: period.index },
      select: { days: true },
    });
    const adjusted = adjustments.reduce((s, a) => s + toNumber(a.days), 0);
    let used = 0;
    if (userId) {
      const leaves = await db.leaveRequest.findMany({
        where: {
          workspaceId,
          requesterId: userId,
          type: 'annual',
          status: { in: ACTIVE_LEAVE_STATUSES },
          startDate: { gte: period.periodStart, lte: period.periodEnd },
        },
        select: { days: true },
      });
      used = leaves.reduce((s, l) => s + toNumber(l.days), 0);
    }
    return {
      periodStart: isoDate(period.periodStart),
      periodEnd: isoDate(period.periodEnd),
      entitled: period.entitled,
      adjusted,
      used,
      remaining: period.entitled + adjusted - used,
    };
  }

  // ─────────────── 後台：假日 ───────────────

  async listHolidays(workspaceId: string, yearRaw: unknown) {
    const year = parseYear(yearRaw);
    const rows = await this.prisma.holiday.findMany({
      where: { workspaceId, date: { gte: yearStart(year), lte: yearEnd(year) } },
      orderBy: { date: 'asc' },
      select: { date: true, name: true },
    });
    return { year, items: rows.map((r) => ({ date: isoDate(r.date), name: r.name })) };
  }

  /** 整年取代：驗證全部通過才在一個交易裡刪掉那年、寫入新的清單。audit `holiday.replace`。 */
  async replaceHolidays(actorId: string, workspaceId: string, yearRaw: unknown, rawItems: unknown, req?: AuditRequestContext) {
    const year = parseYear(yearRaw);
    const items = validateHolidayItems(year, rawItems);
    const before = await this.prisma.$transaction(async (tx) => {
      await lockLeavePolicy(tx, workspaceId);
      const range = { gte: yearStart(year), lte: yearEnd(year) };
      const { count } = await tx.holiday.deleteMany({ where: { workspaceId, date: range } });
      for (const item of items) {
        await tx.holiday.create({ data: { workspaceId, date: item.date, name: item.name } });
      }
      return count;
    }, LOCKED_TX_OPTIONS);
    await this.audit.record({
      actorId,
      workspaceId,
      action: 'holiday.replace',
      targetType: 'holiday_year',
      targetId: String(year),
      metadata: { year, before, after: items.length },
      req,
    });
    return this.listHolidays(workspaceId, String(year));
  }

  // ─────────────── 後台：員工特休餘額 ───────────────

  async employeeBalance(workspaceId: string, profileId: string) {
    const profile = await this.findProfile(this.prisma, workspaceId, profileId);
    const current = annualPeriodOn(profile.hireDate, this.today());
    const previous = current ? previousPeriod(profile.hireDate, current) : null;
    const adjustments = await this.prisma.leaveBalanceAdjustment.findMany({
      where: { profileId: profile.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true, periodIndex: true, days: true, reason: true, createdById: true, createdAt: true },
    });
    return {
      current: current ? await this.balanceFor(this.prisma, workspaceId, profile.id, profile.userId, current) : null,
      previous: previous ? await this.balanceFor(this.prisma, workspaceId, profile.id, profile.userId, previous) : null,
      adjustments: adjustments.map((a) => ({
        id: a.id,
        periodStart: isoDate(periodStartFor(profile.hireDate, a.periodIndex)),
        days: toNumber(a.days),
        reason: a.reason,
        createdById: a.createdById,
        createdAt: a.createdAt,
      })),
    };
  }

  /**
   * 加一筆 +/- 調整。不能調整自己的（`cannot_edit_self`）。audit `leave.balance.adjust`。
   *
   * 鎖（profile 鎖 → 綁定的 user 鎖，跟改到職日、createLeave 的特休是同一組鎖）保證的是：
   * - periodStart 換算成期間序號時用的到職日，在 commit 前不會被改掉；
   * - 同時送出的特休要嘛在這筆調整之前檢查完、要嘛之後才檢查而且看得到這筆調整（不會用半套的狀態）。
   * 不保證餘額不為負：扣回的調整可以讓餘額變成負數（hr 更正已休掉的假），這裡刻意不檢查餘額。
   */
  async addAdjustment(
    actorId: string,
    workspaceId: string,
    profileId: string,
    body: { periodStart?: unknown; days?: unknown; reason?: unknown },
    req?: AuditRequestContext,
  ) {
    const periodStart = typeof body.periodStart === 'string' ? parseIsoDate(body.periodStart) : null;
    if (!periodStart) throw leaveErrors.adjustmentInvalid('periodStart 必須是有效的 YYYY-MM-DD');
    const days = typeof body.days === 'number' ? body.days : NaN;
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > ADJUSTMENT_MAX_ABS_DAYS || !Number.isInteger(days * 2)) {
      throw leaveErrors.adjustmentInvalid(`days 必須是 0.5 的倍數、不為 0、絕對值不超過 ${ADJUSTMENT_MAX_ABS_DAYS}`);
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > ADJUSTMENT_REASON_MAX) {
      throw leaveErrors.adjustmentInvalid(`reason 必填，最多 ${ADJUSTMENT_REASON_MAX} 字`);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await lockEmployeeProfile(tx, profileId);
      const profile = await this.findProfile(tx, workspaceId, profileId);
      if (profile.userId === actorId) throw cannotEditSelf();
      if (profile.userId) await lockUser(tx, profile.userId);
      // API 收 periodStart（日期），存成期間序號：用目前的到職日換算，必須剛好是某個期間的第一天
      const period = annualPeriodOn(profile.hireDate, periodStart);
      if (!period || isoDate(period.periodStart) !== isoDate(periodStart)) {
        throw leaveErrors.adjustmentInvalid('periodStart 不是這位員工的特休期間起始日');
      }
      const row = await tx.leaveBalanceAdjustment.create({
        data: { workspaceId, profileId: profile.id, periodIndex: period.index, days, reason, createdById: actorId },
        select: { id: true, periodIndex: true, days: true, reason: true, createdById: true, createdAt: true },
      });
      return { ...row, periodStart: period.periodStart };
    }, LOCKED_TX_OPTIONS);

    await this.audit.record({
      actorId,
      workspaceId,
      action: 'leave.balance.adjust',
      targetType: 'employee_profile',
      targetId: profileId,
      metadata: { adjustmentId: created.id, periodStart: isoDate(periodStart), periodIndex: created.periodIndex, days },
      req,
    });
    return {
      id: created.id,
      periodStart: isoDate(created.periodStart),
      days: toNumber(created.days),
      reason: created.reason,
      createdById: created.createdById,
      createdAt: created.createdAt,
    };
  }

  private async findProfile(db: Db, workspaceId: string, profileId: string) {
    const profile = await db.employeeProfile.findFirst({
      where: { id: profileId, workspaceId },
      select: { id: true, userId: true, hireDate: true },
    });
    if (!profile) throw new NotFoundException('員工資料不存在');
    return profile;
  }
}

// ─────────────── 假日的驗證 ───────────────

const yearStart = (y: number) => new Date(Date.UTC(y, 0, 1));
const yearEnd = (y: number) => new Date(Date.UTC(y, 11, 31));

function parseYear(raw: unknown): number {
  const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!/^\d{4}$/.test(s)) throw leaveErrors.holidayInvalid('year 必須是四位數年份');
  const y = Number(s);
  if (y < 1970 || y > 2100) throw leaveErrors.holidayInvalid('year 超出範圍（1970–2100）');
  return y;
}

function validateHolidayItems(year: number, raw: unknown): { date: Date; name: string }[] {
  if (!Array.isArray(raw)) throw leaveErrors.holidayInvalid('items 必須是陣列');
  if (raw.length > HOLIDAY_MAX_ITEMS) throw leaveErrors.holidayInvalid(`一年最多 ${HOLIDAY_MAX_ITEMS} 個假日`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const it = (item ?? {}) as { date?: unknown; name?: unknown };
    const date = typeof it.date === 'string' ? parseIsoDate(it.date) : null;
    if (!date) throw leaveErrors.holidayInvalid(`第 ${i + 1} 筆：date 必須是有效的 YYYY-MM-DD`);
    if (date.getUTCFullYear() !== year) throw leaveErrors.holidayInvalid(`第 ${i + 1} 筆：日期不在 ${year} 年`);
    const key = isoDate(date);
    if (seen.has(key)) throw leaveErrors.holidayInvalid(`日期重複：${key}`);
    seen.add(key);
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name || name.length > HOLIDAY_NAME_MAX) {
      throw leaveErrors.holidayInvalid(`第 ${i + 1} 筆：name 必填，最多 ${HOLIDAY_NAME_MAX} 字`);
    }
    return { date, name };
  });
}
