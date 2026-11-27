import crypto from "node:crypto";
import {
  assertPositivePaise,
  SlidingWindowDistinctCounter,
  TokenBucketRateLimiter,
} from "@fintech/core";
import type { CentralSwitch, PspSimulator } from "@fintech/project1-switch";
import type { ConsumerPspBackend } from "./psp-backend.ts";

/**
 * Project 3 (Day 17) — Collect (Pull) Requests, Fan-Out Abuse Controls & Pre-Switch PSP Limits
 */

export const DEFAULT_COLLECT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_COLLECT_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface PspLimitProfile {
  perTxnMaxPaise: number;
  dailyAmountMaxPaise: number;
  dailyCountMax: number;
  newCounterpartyCapPaise: number;
}

export interface CollectRequestRecord {
  id: string;
  requester_vpa: string;
  payer_vpa: string;
  amount_paise: number;
  note: string | null;
  status: "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED";
  switch_rrn: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export class PspLimitProfileEngine {
  private readonly pspBackend: ConsumerPspBackend;
  private readonly profile: PspLimitProfile;

  constructor(pspBackend: ConsumerPspBackend, profile?: Partial<PspLimitProfile>) {
    this.pspBackend = pspBackend;
    this.profile = {
      perTxnMaxPaise: profile?.perTxnMaxPaise ?? 10_000_000, // ₹1,00,000
      dailyAmountMaxPaise: profile?.dailyAmountMaxPaise ?? 10_000_000, // ₹1,00,000
      dailyCountMax: profile?.dailyCountMax ?? 20,
      newCounterpartyCapPaise: profile?.newCounterpartyCapPaise ?? 200_000, // ₹2,000 for 1st-time payee
    };
    this.initSchema();
  }

  private initSchema(): void {
    this.pspBackend.db.exec(`
      CREATE TABLE IF NOT EXISTS psp_limit_usage (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        counterparty_vpa TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  public checkAndRecordPreSwitchLimits(params: {
    customerId: string;
    counterpartyVpa: string;
    amountPaise: number;
    now?: Date;
  }): void {
    const now = params.now ?? new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const cleanTarget = params.counterpartyVpa.trim().toLowerCase();

    // 1. 24h new-device cooling cap
    this.pspBackend.checkNewDeviceCoolingLimit(params.customerId, params.amountPaise, now);

    // 2. Per-transaction max
    if (params.amountPaise > this.profile.perTxnMaxPaise) {
      throw Object.assign(
        new Error(
          `PSP Limit Exceeded: amount ${params.amountPaise} > per-txn max ${this.profile.perTxnMaxPaise}`
        ),
        { statusCode: 403 }
      );
    }

    // 3. Daily count & daily amount
    const dailyAgg = this.pspBackend.db
      .prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_paise), 0) AS total_paise
         FROM psp_limit_usage WHERE customer_id = ? AND day_key = ?`
      )
      .get(params.customerId, dayKey) as { cnt: number; total_paise: number };

    if (dailyAgg.cnt + 1 > this.profile.dailyCountMax) {
      throw Object.assign(
        new Error(`PSP Daily Count Limit (${this.profile.dailyCountMax}) exceeded`),
        { statusCode: 403 }
      );
    }
    if (dailyAgg.total_paise + params.amountPaise > this.profile.dailyAmountMaxPaise) {
      throw Object.assign(
        new Error(`PSP Daily Amount Limit (${this.profile.dailyAmountMaxPaise}) exceeded`),
        { statusCode: 403 }
      );
    }

    // 4. New-counterparty cap (first time paying this VPA)
    const priorToTarget = this.pspBackend.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM psp_limit_usage WHERE customer_id = ? AND counterparty_vpa = ?`
      )
      .get(params.customerId, cleanTarget) as { cnt: number };

    if (priorToTarget.cnt === 0 && params.amountPaise > this.profile.newCounterpartyCapPaise) {
      throw Object.assign(
        new Error(
          `PSP New-Counterparty Cap: first payment to "${cleanTarget}" capped at ${this.profile.newCounterpartyCapPaise} paise`
        ),
        { statusCode: 403 }
      );
    }

    this.pspBackend.db
      .prepare(
        `INSERT INTO psp_limit_usage (id, customer_id, day_key, counterparty_vpa, amount_paise, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `lim_${crypto.randomUUID().slice(0, 10)}`,
        params.customerId,
        dayKey,
        cleanTarget,
        params.amountPaise,
        now.toISOString()
      );
  }
}

export class CollectRequestEngine {
  private readonly pspBackend: ConsumerPspBackend;
  private readonly p1Switch: CentralSwitch;
  private readonly p1Psp: PspSimulator;
  private readonly limits: PspLimitProfileEngine;
  private readonly fanOutCounter = new SlidingWindowDistinctCounter(60 * 60 * 1000);
  private readonly perPayerLimiter: TokenBucketRateLimiter;
  public fanOutThreshold = 15; // Flag if >= 15 distinct payers targeted in 1h

  constructor(params: {
    pspBackend: ConsumerPspBackend;
    p1Switch: CentralSwitch;
    p1Psp: PspSimulator;
    limits?: PspLimitProfileEngine;
    maxCollectsPerPayerPerHour?: number;
  }) {
    this.pspBackend = params.pspBackend;
    this.p1Switch = params.p1Switch;
    this.p1Psp = params.p1Psp;
    this.limits = params.limits ?? new PspLimitProfileEngine(params.pspBackend);
    const cap = params.maxCollectsPerPayerPerHour ?? 3;
    this.perPayerLimiter = new TokenBucketRateLimiter(cap, cap / 3600);
    this.initSchema();
  }

  private initSchema(): void {
    this.pspBackend.db.exec(`
      CREATE TABLE IF NOT EXISTS collect_requests (
        id TEXT PRIMARY KEY,
        requester_vpa TEXT NOT NULL,
        payer_vpa TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        note TEXT,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED')),
        switch_rrn TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collect_blocklist (
        payer_vpa TEXT NOT NULL,
        blocked_requester_vpa TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (payer_vpa, blocked_requester_vpa)
      );
    `);
  }

  public blockRequester(payerVpa: string, requesterVpa: string, now = new Date()): void {
    this.pspBackend.db
      .prepare(
        `INSERT OR IGNORE INTO collect_blocklist (payer_vpa, blocked_requester_vpa, created_at)
         VALUES (?, ?, ?)`
      )
      .run(payerVpa.trim().toLowerCase(), requesterVpa.trim().toLowerCase(), now.toISOString());
  }

  public createCollectRequest(params: {
    requesterVpa: string;
    payerVpa: string;
    amountPaise: number;
    note?: string;
    expiryMs?: number;
    now?: Date;
  }): { collect: CollectRequestRecord; fanOutDistinctCount: number } {
    assertPositivePaise(params.amountPaise, "collect.amountPaise");
    const now = params.now ?? new Date();
    const nowMs = now.getTime();
    const requester = params.requesterVpa.trim().toLowerCase();
    const payer = params.payerVpa.trim().toLowerCase();

    const expiryMs = params.expiryMs ?? DEFAULT_COLLECT_EXPIRY_MS;
    if (expiryMs <= 0 || expiryMs > MAX_COLLECT_EXPIRY_MS) {
      throw Object.assign(new Error("Collect expiry must be between 1ms and 48 hours"), {
        statusCode: 400,
      });
    }

    // 1. Payer blocklist check
    const blocked = this.pspBackend.db
      .prepare(`SELECT 1 FROM collect_blocklist WHERE payer_vpa = ? AND blocked_requester_vpa = ?`)
      .get(payer, requester);
    if (blocked) {
      throw Object.assign(new Error(`Requester "${requester}" is blocked by "${payer}"`), {
        statusCode: 403,
      });
    }

    // 2. Per-payer collect rate limit
    const rateRes = this.perPayerLimiter.tryConsume(`${requester}->${payer}`, 1, nowMs);
    if (!rateRes.allowed) {
      throw Object.assign(new Error(`Collect spam rate limit exceeded for "${payer}"`), {
        statusCode: 429,
      });
    }

    // 3. Fan-out abuse detection (distinct payers targeted in 1 hour)
    const distinctTargets = this.fanOutCounter.recordAndCountDistinct(requester, payer, nowMs);
    if (distinctTargets >= this.fanOutThreshold) {
      this.pspBackend.audit.record({
        actorId: requester,
        actorRole: "system",
        action: "COLLECT_FANOUT_ABUSE_FLAGGED",
        entityType: "CollectRequester",
        entityId: requester,
        newValue: { distinct_payers_1h: distinctTargets },
        requestId: `REQ-FANOUT-${nowMs}`,
        nowIso: now.toISOString(),
      });
      throw Object.assign(
        new Error(
          `Collect fan-out abuse detected: "${requester}" targeted ${distinctTargets} distinct payers in 1h`
        ),
        { statusCode: 429 }
      );
    }

    const id = `col_${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = now.toISOString();
    const expiresAtIso = new Date(nowMs + expiryMs).toISOString();

    this.pspBackend.db
      .prepare(
        `INSERT INTO collect_requests (
          id, requester_vpa, payer_vpa, amount_paise, note, status,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
      )
      .run(
        id,
        requester,
        payer,
        params.amountPaise,
        params.note ?? null,
        expiresAtIso,
        nowIso,
        nowIso
      );

    return {
      collect: this.getCollect(id)!,
      fanOutDistinctCount: distinctTargets,
    };
  }

  public async approveCollectRequest(params: {
    collectId: string;
    payerCustomerId: string;
    rawPin: string;
    txnNonce: string;
    clientPinProofHex: string;
    now?: Date;
  }): Promise<CollectRequestRecord> {
    const now = params.now ?? new Date();
    const col = this.getCollect(params.collectId);
    if (!col) {
      throw new Error(`Collect request "${params.collectId}" not found`);
    }
    if (col.status !== "PENDING") {
      throw Object.assign(new Error(`Collect request is "${col.status}"`), {
        statusCode: 409,
      });
    }
    if (now.getTime() > Date.parse(col.expires_at)) {
      this.pspBackend.db
        .prepare(`UPDATE collect_requests SET status = 'EXPIRED', updated_at = ? WHERE id = ?`)
        .run(now.toISOString(), col.id);
      throw Object.assign(new Error(`Collect request "${col.id}" has expired`), {
        statusCode: 410,
      });
    }

    // Enforce Pre-Switch PSP Limits
    this.limits.checkAndRecordPreSwitchLimits({
      customerId: params.payerCustomerId,
      counterpartyVpa: col.requester_vpa,
      amountPaise: col.amount_paise,
      now,
    });

    // Verify salted nonce PIN
    const pinOk = this.pspBackend.verifyPinWithNonce({
      customerId: params.payerCustomerId,
      txnNonce: params.txnNonce,
      clientProofHex: params.clientPinProofHex,
      now,
    });
    if (!pinOk.valid) {
      throw Object.assign(new Error("Invalid UPI PIN"), { statusCode: 401 });
    }

    const env = this.p1Psp.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: `COL-${col.id}`,
      payerVpa: col.payer_vpa,
      payeeVpa: col.requester_vpa,
      amountPaise: col.amount_paise,
      now,
    });

    const res = await this.p1Switch.handlePay({
      envelope: env,
      rawPin: params.rawPin,
      now,
    });

    const nextStatus = res.transaction.state === "SUCCESS" ? "APPROVED" : "DECLINED";
    this.pspBackend.db
      .prepare(
        `UPDATE collect_requests SET status = ?, switch_rrn = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextStatus, res.transaction.rrn, now.toISOString(), col.id);

    return this.getCollect(col.id)!;
  }

  public declineCollectRequest(collectId: string, now = new Date()): CollectRequestRecord {
    const col = this.getCollect(collectId);
    if (!col || col.status !== "PENDING") {
      throw Object.assign(new Error(`Collect "${collectId}" cannot be declined`), {
        statusCode: 409,
      });
    }
    this.pspBackend.db
      .prepare(`UPDATE collect_requests SET status = 'DECLINED', updated_at = ? WHERE id = ?`)
      .run(now.toISOString(), collectId);
    return this.getCollect(collectId)!;
  }

  public expireDueCollectRequests(now = new Date()): number {
    const res = this.pspBackend.db
      .prepare(
        `UPDATE collect_requests
         SET status = 'EXPIRED', updated_at = ?
         WHERE status = 'PENDING' AND expires_at < ?`
      )
      .run(now.toISOString(), now.toISOString());
    return Number(res.changes);
  }

  public getCollect(collectId: string): CollectRequestRecord | undefined {
    return this.pspBackend.db
      .prepare(`SELECT * FROM collect_requests WHERE id = ?`)
      .get(collectId) as unknown as CollectRequestRecord | undefined;
  }
}
