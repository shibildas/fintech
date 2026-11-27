import { assertPaiseInteger } from "./money.ts";

/**
 * Day 23 Fintech DSA — Anchor-Day Calendar Arithmetic, Timezone Normalization,
 * Injectable Fake Clock & Exact Integer Rational Proration Math
 */

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export class InjectableFakeClock implements Clock {
  private currentMs: number;

  constructor(initialIso = "2026-01-31T04:30:00.000Z") {
    this.currentMs = Date.parse(initialIso);
  }

  public now(): Date {
    return new Date(this.currentMs);
  }

  public nowMs(): number {
    return this.currentMs;
  }

  public setTime(isoOrDate: string | Date): void {
    this.currentMs = typeof isoOrDate === "string" ? Date.parse(isoOrDate) : isoOrDate.getTime();
  }

  public advanceByMs(deltaMs: number): Date {
    this.currentMs += deltaMs;
    return this.now();
  }

  public advanceByHours(hours: number): Date {
    return this.advanceByMs(hours * 60 * 60 * 1000);
  }

  public advanceByDays(days: number): Date {
    return this.advanceByMs(days * 24 * 60 * 60 * 1000);
  }
}

export function daysInMonth(year: number, month1Based: number): number {
  // Day 0 of next month gives exact last day of `month1Based` (handles leap years accurately)
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

/**
 * Computes the next anchored billing date in the customer's timezone without drifting:
 * - Anchor day 31 in Jan -> snaps to Feb 28 (or Feb 29 in leap year 2028) -> snaps BACK to Mar 31!
 * - `tzOffsetMinutes` defaults to `+330` (Asia/Kolkata IST).
 */
export function computeAnchoredBillingDateUtc(params: {
  anchorDay: number; // 1..31
  targetYear: number;
  targetMonth1Based: number; // 1..12
  localHour?: number; // Default 10:00 AM customer local time (inside 06:00-22:00 execution window)
  tzOffsetMinutes?: number; // Default +330 (IST)
}): Date {
  const maxDay = daysInMonth(params.targetYear, params.targetMonth1Based);
  const clampedDay = Math.min(params.anchorDay, maxDay);
  const localHour = params.localHour ?? 10;
  const tzOffsetMs = (params.tzOffsetMinutes ?? 330) * 60 * 1000;

  const localAsUtcMs = Date.UTC(
    params.targetYear,
    params.targetMonth1Based - 1,
    clampedDay,
    localHour,
    0,
    0,
    0
  );
  return new Date(localAsUtcMs - tzOffsetMs);
}

export function advanceAnchoredMonths(params: {
  anchorDay: number;
  fromYear: number;
  fromMonth1Based: number;
  monthsToAdd: number;
  localHour?: number;
  tzOffsetMinutes?: number;
}): { year: number; month1Based: number; billingDateUtc: Date; localDateIso: string } {
  const zeroBasedTotal = params.fromYear * 12 + (params.fromMonth1Based - 1) + params.monthsToAdd;
  const targetYear = Math.floor(zeroBasedTotal / 12);
  const targetMonth1Based = (zeroBasedTotal % 12) + 1;
  const maxDay = daysInMonth(targetYear, targetMonth1Based);
  const clampedDay = Math.min(params.anchorDay, maxDay);

  const billingDateUtc = computeAnchoredBillingDateUtc({
    anchorDay: params.anchorDay,
    targetYear,
    targetMonth1Based,
    localHour: params.localHour,
    tzOffsetMinutes: params.tzOffsetMinutes,
  });

  const localDateIso = `${targetYear}-${String(targetMonth1Based).padStart(2, "0")}-${String(
    clampedDay
  ).padStart(2, "0")}`;

  return { year: targetYear, month1Based: targetMonth1Based, billingDateUtc, localDateIso };
}

/**
 * Exact integer rational mid-cycle proration using half-up integer division (zero float drift):
 * - `unusedCreditPaise = round((oldPlanPaise * remainingDays) / totalCycleDays)`
 * - `newPlanChargePaise = round((newPlanPaise * remainingDays) / totalCycleDays)`
 * - `netDeltaPaise = newPlanChargePaise - unusedCreditPaise` (>0 = immediate charge, <0 = credit note)
 */
export function computeMidCycleProrationPaise(params: {
  oldPlanPaise: number;
  newPlanPaise: number;
  remainingDays: number;
  totalCycleDays: number;
}): {
  unusedCreditPaise: number;
  newPlanChargePaise: number;
  netDeltaPaise: number;
} {
  assertPaiseInteger(params.oldPlanPaise, "oldPlanPaise");
  assertPaiseInteger(params.newPlanPaise, "newPlanPaise");
  if (
    !Number.isInteger(params.totalCycleDays) ||
    params.totalCycleDays <= 0 ||
    !Number.isInteger(params.remainingDays) ||
    params.remainingDays < 0 ||
    params.remainingDays > params.totalCycleDays
  ) {
    throw new Error("Invalid remainingDays / totalCycleDays for proration");
  }

  const divRoundHalfUp = (num: number, den: number): number =>
    Math.floor((num + Math.floor(den / 2)) / den);

  const unusedCreditPaise = divRoundHalfUp(
    params.oldPlanPaise * params.remainingDays,
    params.totalCycleDays
  );
  const newPlanChargePaise = divRoundHalfUp(
    params.newPlanPaise * params.remainingDays,
    params.totalCycleDays
  );

  return {
    unusedCreditPaise,
    newPlanChargePaise,
    netDeltaPaise: newPlanChargePaise - unusedCreditPaise,
  };
}
