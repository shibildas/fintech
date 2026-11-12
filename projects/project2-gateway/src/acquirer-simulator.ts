import crypto from "node:crypto";

/**
 * Project 2 — Acquirer Simulators (3 instances, same code, different behaviour, Pages 12, 14, 15, 17)
 *
 * Responsibilities:
 * - Simulates card, net-banking, and wallet authorization, capture, and refund (`POST /authorize`,
 *   `POST /capture`, `POST /refund`, `GET /otp/{id}`).
 * - Distinguishes clearly between:
 *   1. Technical Failures (`ACQUIRER_DOWN`, `TIMEOUT`, `HTTP_500`) -> Gateway retries ONCE on next acquirer (Req 12)
 *   2. Business Declines (`INSUFFICIENT_FUNDS`, `WRONG_OTP`, `DO_NOT_HONOUR`) -> Gateway NEVER retries (Req 12)
 * - Supports failing refunds on command so the `FAILED` refund path is demonstrable (Req 23).
 */

export type PaymentMethod = "CARD" | "UPI" | "NETBANKING" | "WALLET";

export type AcquirerResponseCategory = "SUCCESS" | "TECHNICAL_FAILURE" | "BUSINESS_DECLINE";

export type AcquirerResponseCode =
  | "00_APPROVED"
  | "51_INSUFFICIENT_FUNDS"
  | "55_WRONG_OTP"
  | "05_DO_NOT_HONOUR"
  | "91_ACQUIRER_DOWN"
  | "68_TIMEOUT"
  | "96_TECHNICAL_500";

export interface AcquirerChaosConfig {
  latencyMs: number;
  technicalFailureRatePercent: number;
  forceDown: boolean;
  forceRefundFail: boolean;
}

export interface AcquirerConfig {
  acquirerId: string; // e.g., "ACQ_ALPHA", "ACQ_BETA", "ACQ_GAMMA"
  name: string;
  supportedMethods: PaymentMethod[];
  baseLatencyMs: number;
  expectedOtp?: string; // Default "123456" for simulated 3DS OTP page
}

export interface AcquirerAuthorizeResult {
  acquirer_id: string;
  acquirer_reference: string;
  category: AcquirerResponseCategory;
  response_code: AcquirerResponseCode;
  latency_ms: number;
}

export class AcquirerSimulator {
  public readonly config: AcquirerConfig;
  private chaos: AcquirerChaosConfig;
  private readonly expectedOtp: string;

  constructor(config: AcquirerConfig) {
    this.config = config;
    this.expectedOtp = config.expectedOtp ?? "123456";
    this.chaos = {
      latencyMs: config.baseLatencyMs,
      technicalFailureRatePercent: 0,
      forceDown: false,
      forceRefundFail: false,
    };
  }

  public setChaos(update: Partial<AcquirerChaosConfig>): AcquirerChaosConfig {
    this.chaos = { ...this.chaos, ...update };
    return { ...this.chaos };
  }

  public getChaos(): AcquirerChaosConfig {
    return { ...this.chaos };
  }

  /**
   * Interface: `GET /otp/{id}` (Simulated 3-D Secure OTP Challenge Page)
   */
  public renderOtpChallengePage(paymentAttemptId: string, amountPaise: number): string {
    return `<!DOCTYPE html>
<html>
<head><title>3-D Secure OTP Challenge (${this.config.name})</title></head>
<body>
  <h2>${this.config.name} — 3D Secure Verification</h2>
  <p>Attempt: <code>${paymentAttemptId}</code> | Amount: <strong>${amountPaise} paise</strong></p>
  <p>Enter Demo OTP (<code>${this.expectedOtp}</code> to approve, <code>000000</code> for wrong OTP):</p>
</body>
</html>`;
  }

  /**
   * Interface: `POST /authorize`
   * Evaluates technical availability first, then business rules (OTP, insufficient funds trigger).
   */
  public async authorize(params: {
    method: PaymentMethod;
    amountPaise: number;
    otp?: string;
    simulateBusinessDecline?: "INSUFFICIENT_FUNDS" | "DO_NOT_HONOUR";
  }): Promise<AcquirerAuthorizeResult> {
    const startMs = performance.now();
    if (this.chaos.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.chaos.latencyMs));
    }
    const measuredLatency = Math.max(
      this.chaos.latencyMs,
      Math.round(performance.now() - startMs)
    );

    const acqRef = `${this.config.acquirerId}-${crypto.randomUUID().slice(0, 8)}`;

    // 1. Check Technical Failures first (eligible for failover retry on next acquirer)
    if (this.chaos.forceDown) {
      return {
        acquirer_id: this.config.acquirerId,
        acquirer_reference: acqRef,
        category: "TECHNICAL_FAILURE",
        response_code: "91_ACQUIRER_DOWN",
        latency_ms: measuredLatency,
      };
    }

    if (this.chaos.technicalFailureRatePercent > 0) {
      if (Math.random() * 100 < this.chaos.technicalFailureRatePercent) {
        return {
          acquirer_id: this.config.acquirerId,
          acquirer_reference: acqRef,
          category: "TECHNICAL_FAILURE",
          response_code: "96_TECHNICAL_500",
          latency_ms: measuredLatency,
        };
      }
    }

    // 2. Check Business Declines (NEVER retried on another acquirer — Req 12 & Acceptance Test 4)
    if (params.method === "CARD" && params.otp !== undefined && params.otp !== this.expectedOtp) {
      return {
        acquirer_id: this.config.acquirerId,
        acquirer_reference: acqRef,
        category: "BUSINESS_DECLINE",
        response_code: "55_WRONG_OTP",
        latency_ms: measuredLatency,
      };
    }

    if (params.simulateBusinessDecline === "INSUFFICIENT_FUNDS") {
      return {
        acquirer_id: this.config.acquirerId,
        acquirer_reference: acqRef,
        category: "BUSINESS_DECLINE",
        response_code: "51_INSUFFICIENT_FUNDS",
        latency_ms: measuredLatency,
      };
    }

    if (params.simulateBusinessDecline === "DO_NOT_HONOUR") {
      return {
        acquirer_id: this.config.acquirerId,
        acquirer_reference: acqRef,
        category: "BUSINESS_DECLINE",
        response_code: "05_DO_NOT_HONOUR",
        latency_ms: measuredLatency,
      };
    }

    return {
      acquirer_id: this.config.acquirerId,
      acquirer_reference: acqRef,
      category: "SUCCESS",
      response_code: "00_APPROVED",
      latency_ms: measuredLatency,
    };
  }

  /**
   * Interface: `POST /capture`
   */
  public async capture(acquirerReference: string): Promise<{
    acquirer_reference: string;
    status: "CAPTURED" | "FAILED";
  }> {
    if (this.chaos.forceDown) {
      return { acquirer_reference: acquirerReference, status: "FAILED" };
    }
    return { acquirer_reference: acquirerReference, status: "CAPTURED" };
  }

  /**
   * Interface: `POST /refund`
   * Requirement 23: "The acquirer simulator must be able to fail a refund so the failed path is demonstrable."
   */
  public async refund(params: {
    paymentAcquirerReference: string;
    amountPaise: number;
  }): Promise<{
    refund_acquirer_reference: string;
    status: "PROCESSED" | "FAILED";
    reason?: string;
  }> {
    const refId = `RFD-${this.config.acquirerId}-${crypto.randomUUID().slice(0, 8)}`;
    if (this.chaos.forceRefundFail || this.chaos.forceDown) {
      return {
        refund_acquirer_reference: refId,
        status: "FAILED",
        reason: "Acquirer rejected refund (simulated failure)",
      };
    }
    return {
      refund_acquirer_reference: refId,
      status: "PROCESSED",
    };
  }
}
