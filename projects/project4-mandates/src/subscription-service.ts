import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLogger,
  assertPositivePaise,
  assertValidTransition,
  SUBSCRIPTION_TRANSITIONS,
  advanceAnchoredMonths,
  computeMidCycleProrationPaise,
  type SubscriptionState,
  type Clock,
} from "@fintech/core";
import type { MandateService } from "./mandate-service.ts";

/**
 * Project 4 (Day 23) — Plans & Subscriptions Service
 *
 * - Plans (`MONTHLY` | `YEARLY`) priced in integer paise.
 * - Subscriptions State Machine (`CREATED -> AUTHENTICATED -> ACTIVE -> PAST_DUE | PAUSED | HALTED | CANCELLED | COMPLETED`).
 * - Anchor-day calendar engine (Jan 31 -> Feb 28/29 -> Mar 31) with Injectable Fake Clock.
 * - Mid-cycle plan upgrade/downgrade proration line items.
 * - Automatic HALT when linked Mandate is REVOKED in `MandateService`.
 */

export interface PlanRecord {
  id: string;
  merchant_id: string;
  name: string;
  interval: "MONTHLY" | "YEARLY";
  amount_paise: number;
  created_at: string;
}

export interface SubscriptionRecord {
  id: string;
  merchant_id: string;
  customer_id: string;
  plan_id: string;
  mandate_id: string;
  state: SubscriptionState;
  anchor_day: number;
  tz_offset_minutes: number;
  current_cycle_number: number;
  total_cycles: number;
  current_year: number;
  current_month: number;
  next_billing_at: string;
  created_at: string;
  updated_at: string;
}

export interface ProrationLineItem {
  id: string;
  subscription_id: string;
  old_plan_id: string;
  new_plan_id: string;
  remaining_days: number;
  total_cycle_days: number;
  unused_credit_paise: number;
  new_plan_charge_paise: number;
  net_delta_paise: number;
  created_at: string;
}

export class SubscriptionService {
  public readonly db: DatabaseSync;
  public readonly audit: AuditLogger;
  private readonly mandates: MandateService;
  private readonly clock: Clock;

  constructor(params: { mandates: MandateService; clock?: Clock; dbPath?: string }) {
    this.db = new DatabaseSync(params.dbPath ?? ":memory:");
    this.audit = new AuditLogger(this.db);
    this.mandates = params.mandates;
    this.clock = params.clock ?? { now: () => new Date(), nowMs: () => Date.now() };
    this.initSchema();

    // Wire automatic HALT on mandate revocation (Day 22 requirement)
    this.mandates.onMandateStateChange((ev) => {
      if (ev.newState === "REVOKED") {
        this.haltSubscriptionsForMandate(ev.mandateId, `Mandate ${ev.mandateId} revoked`);
      }
    });
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        interval TEXT NOT NULL CHECK (interval IN ('MONTHLY', 'YEARLY')),
        amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        state TEXT NOT NULL,
        anchor_day INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
        tz_offset_minutes INTEGER NOT NULL DEFAULT 330,
        current_cycle_number INTEGER NOT NULL DEFAULT 0,
        total_cycles INTEGER NOT NULL DEFAULT 12,
        current_year INTEGER NOT NULL,
        current_month INTEGER NOT NULL,
        next_billing_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proration_adjustments (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        old_plan_id TEXT NOT NULL,
        new_plan_id TEXT NOT NULL,
        remaining_days INTEGER NOT NULL,
        total_cycle_days INTEGER NOT NULL,
        unused_credit_paise INTEGER NOT NULL,
        new_plan_charge_paise INTEGER NOT NULL,
        net_delta_paise INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  public createPlan(params: {
    merchantId: string;
    name: string;
    interval: "MONTHLY" | "YEARLY";
    amountPaise: number;
  }): PlanRecord {
    assertPositivePaise(params.amountPaise, "plan.amountPaise");
    const id = `pln_${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = this.clock.now().toISOString();

    this.db
      .prepare(
        `INSERT INTO plans (id, merchant_id, name, interval, amount_paise, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, params.merchantId, params.name, params.interval, params.amountPaise, nowIso);

    return this.getPlan(id)!;
  }

  public createSubscription(params: {
    merchantId: string;
    customerId: string;
    planId: string;
    mandateId: string;
    anchorDay?: number;
    startYear?: number;
    startMonth1Based?: number;
    totalCycles?: number;
    tzOffsetMinutes?: number;
  }): SubscriptionRecord {
    const plan = this.getPlan(params.planId);
    if (!plan) {
      throw new Error(`Plan "${params.planId}" not found`);
    }
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const tz = params.tzOffsetMinutes ?? 330;
    const localNow = new Date(now.getTime() + tz * 60 * 1000);
    const startYear = params.startYear ?? localNow.getUTCFullYear();
    const startMonth = params.startMonth1Based ?? localNow.getUTCMonth() + 1;
    const anchorDay = params.anchorDay ?? localNow.getUTCDate();

    const firstBilling = advanceAnchoredMonths({
      anchorDay,
      fromYear: startYear,
      fromMonth1Based: startMonth,
      monthsToAdd: 0,
      tzOffsetMinutes: tz,
    });

    const id = `sub_${crypto.randomUUID().slice(0, 10)}`;
    this.db
      .prepare(
        `INSERT INTO subscriptions (
          id, merchant_id, customer_id, plan_id, mandate_id, state,
          anchor_day, tz_offset_minutes, current_cycle_number, total_cycles,
          current_year, current_month, next_billing_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'CREATED', ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.merchantId,
        params.customerId,
        params.planId,
        params.mandateId,
        anchorDay,
        tz,
        params.totalCycles ?? 12,
        firstBilling.year,
        firstBilling.month1Based,
        firstBilling.billingDateUtc.toISOString(),
        nowIso,
        nowIso
      );

    return this.getSubscription(id)!;
  }

  public activateSubscription(subscriptionId: string): SubscriptionRecord {
    const sub = this.getSubscription(subscriptionId);
    if (!sub) {
      throw new Error(`Subscription "${subscriptionId}" not found`);
    }
    const mandate = this.mandates.getMandate(sub.mandate_id);
    if (!mandate || mandate.state !== "ACTIVE") {
      throw Object.assign(
        new Error(`Mandate "${sub.mandate_id}" must be ACTIVE to activate subscription`),
        { statusCode: 409 }
      );
    }

    if (sub.state === "CREATED") {
      this.transitionState(subscriptionId, "AUTHENTICATED");
    }
    return this.transitionState(subscriptionId, "ACTIVE");
  }

  /**
   * Advances the subscription to its next anchored billing date (preserving anchorDay=31 across Feb 28/29 -> Mar 31!).
   */
  public advanceToNextBillingCycle(subscriptionId: string): {
    subscription: SubscriptionRecord;
    localDateIso: string;
  } {
    const sub = this.getSubscription(subscriptionId);
    if (!sub) {
      throw new Error(`Subscription "${subscriptionId}" not found`);
    }
    const plan = this.getPlan(sub.plan_id)!;
    const monthsStep = plan.interval === "YEARLY" ? 12 : 1;
    const nextCycleNumber = sub.current_cycle_number + 1;

    const next = advanceAnchoredMonths({
      anchorDay: sub.anchor_day,
      fromYear: sub.current_year,
      fromMonth1Based: sub.current_month,
      monthsToAdd: monthsStep,
      tzOffsetMinutes: sub.tz_offset_minutes,
    });

    const nowIso = this.clock.now().toISOString();
    const nextState: SubscriptionState =
      nextCycleNumber >= sub.total_cycles ? "COMPLETED" : sub.state;

    this.db
      .prepare(
        `UPDATE subscriptions
         SET current_cycle_number = ?, current_year = ?, current_month = ?,
             next_billing_at = ?, state = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextCycleNumber,
        next.year,
        next.month1Based,
        next.billingDateUtc.toISOString(),
        nextState,
        nowIso,
        sub.id
      );

    return {
      subscription: this.getSubscription(sub.id)!,
      localDateIso: next.localDateIso,
    };
  }

  /**
   * Mid-cycle plan upgrade or downgrade with exact integer rational proration line item.
   */
  public changeSubscriptionPlan(params: {
    subscriptionId: string;
    newPlanId: string;
    remainingDays: number;
    totalCycleDays: number;
  }): { subscription: SubscriptionRecord; proration: ProrationLineItem } {
    const sub = this.getSubscription(params.subscriptionId);
    if (!sub || sub.state !== "ACTIVE") {
      throw Object.assign(new Error(`Active subscription "${params.subscriptionId}" not found`), {
        statusCode: 409,
      });
    }
    const oldPlan = this.getPlan(sub.plan_id)!;
    const newPlan = this.getPlan(params.newPlanId);
    if (!newPlan) {
      throw new Error(`Plan "${params.newPlanId}" not found`);
    }

    const calc = computeMidCycleProrationPaise({
      oldPlanPaise: oldPlan.amount_paise,
      newPlanPaise: newPlan.amount_paise,
      remainingDays: params.remainingDays,
      totalCycleDays: params.totalCycleDays,
    });

    const nowIso = this.clock.now().toISOString();
    const prorationId = `pro_${crypto.randomUUID().slice(0, 10)}`;

    this.db
      .prepare(
        `INSERT INTO proration_adjustments (
          id, subscription_id, old_plan_id, new_plan_id, remaining_days, total_cycle_days,
          unused_credit_paise, new_plan_charge_paise, net_delta_paise, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        prorationId,
        sub.id,
        oldPlan.id,
        newPlan.id,
        params.remainingDays,
        params.totalCycleDays,
        calc.unusedCreditPaise,
        calc.newPlanChargePaise,
        calc.netDeltaPaise,
        nowIso
      );

    this.db
      .prepare(`UPDATE subscriptions SET plan_id = ?, updated_at = ? WHERE id = ?`)
      .run(newPlan.id, nowIso, sub.id);

    const proration = this.db
      .prepare(`SELECT * FROM proration_adjustments WHERE id = ?`)
      .get(prorationId) as unknown as ProrationLineItem;

    return {
      subscription: this.getSubscription(sub.id)!,
      proration,
    };
  }

  public transitionState(subscriptionId: string, toState: SubscriptionState): SubscriptionRecord {
    const sub = this.getSubscription(subscriptionId);
    if (!sub) {
      throw new Error(`Subscription "${subscriptionId}" not found`);
    }
    assertValidTransition("Subscription", SUBSCRIPTION_TRANSITIONS, sub.state, toState);
    const nowIso = this.clock.now().toISOString();
    this.db
      .prepare(`UPDATE subscriptions SET state = ?, updated_at = ? WHERE id = ?`)
      .run(toState, nowIso, subscriptionId);
    return this.getSubscription(subscriptionId)!;
  }

  private haltSubscriptionsForMandate(mandateId: string, reason: string): void {
    const rows = this.db
      .prepare(
        `SELECT id, state FROM subscriptions
         WHERE mandate_id = ? AND state IN ('ACTIVE', 'PAST_DUE', 'PAUSED')`
      )
      .all(mandateId) as Array<{ id: string; state: SubscriptionState }>;

    const nowIso = this.clock.now().toISOString();
    for (const r of rows) {
      this.db
        .prepare(`UPDATE subscriptions SET state = 'HALTED', updated_at = ? WHERE id = ?`)
        .run(nowIso, r.id);
      this.audit.record({
        actorId: "mandate-hook",
        actorRole: "system",
        action: "SUBSCRIPTION_HALTED_ON_REVOKE",
        entityType: "Subscription",
        entityId: r.id,
        oldValue: { state: r.state },
        newValue: { state: "HALTED", reason },
        requestId: `REQ-HALT-${r.id}`,
        nowIso,
      });
    }
  }

  public getPlan(planId: string): PlanRecord | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE id = ?`).get(planId) as unknown as
      PlanRecord | undefined;
  }

  public getSubscription(subscriptionId: string): SubscriptionRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM subscriptions WHERE id = ?`)
      .get(subscriptionId) as unknown as SubscriptionRecord | undefined;
  }
}
