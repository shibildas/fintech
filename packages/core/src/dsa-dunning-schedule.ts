/**
 * Day 26 Fintech DSA — Timed Retry Backoff Graph & Dunning Schedule Planner
 *
 * Generates deterministic fresh retry execution keys (`${executionKey}:retry:${attempt}`)
 * at configurable day offsets (default Day 1, Day 3, Day 7) along with a grace-period
 * expiry timestamp so every retry is an independent, auditable mandate execution.
 */

export const DEFAULT_DUNNING_OFFSETS_DAYS = [1, 3, 7] as const;

export interface ScheduledDunningAttempt {
  attemptNumber: number;
  offsetDays: number;
  retryExecutionKey: string;
  scheduledAtIso: string;
}

export interface DunningSchedulePlan {
  baseExecutionKey: string;
  attempts: ScheduledDunningAttempt[];
  gracePeriodEndsAtIso: string;
}

export function buildDunningSchedule(params: {
  baseExecutionKey: string;
  failedAtMs: number;
  retryOffsetsDays?: readonly number[];
  gracePeriodDays?: number;
}): DunningSchedulePlan {
  const offsets = params.retryOffsetsDays ?? DEFAULT_DUNNING_OFFSETS_DAYS;
  const maxOffset = offsets.length > 0 ? Math.max(...offsets) : 0;
  const graceDays = params.gracePeriodDays ?? maxOffset + 1;

  const attempts: ScheduledDunningAttempt[] = offsets.map((offsetDays, idx) => ({
    attemptNumber: idx + 1,
    offsetDays,
    retryExecutionKey: `${params.baseExecutionKey}:retry:${idx + 1}`,
    scheduledAtIso: new Date(params.failedAtMs + offsetDays * 24 * 60 * 60 * 1000).toISOString(),
  }));

  return {
    baseExecutionKey: params.baseExecutionKey,
    attempts,
    gracePeriodEndsAtIso: new Date(
      params.failedAtMs + graceDays * 24 * 60 * 60 * 1000
    ).toISOString(),
  };
}
