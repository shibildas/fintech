# Architecture Decision Records (ADRs) & Product-Tier Fintech Interview Defense

This document captures the **Three Hardest Engineering Decisions & What We Rejected** across all four interconnected projects, along with the **9 Core Interview Talking Points** (Razorpay, Juspay, PhonePe, NPCI) and verified benchmarks.

---

## 1. Three Hardest Engineering Decisions & What We Rejected

### Project 1 — UPI-Style Central Switch (`@fintech/project1-switch`)
1. **Append-Only Double-Entry Postings Enforced by SQLite Triggers (vs. Mutable `UPDATE balance = balance - amount`)**
   - *Decision*: Every debit, credit, and `0420` reversal inserts balanced `DEBIT`/`CREDIT` rows summing to `0`, protected by `BEFORE UPDATE`/`BEFORE DELETE` SQLite triggers, with available balance derived dynamically as `ledger - active_holds`.
   - *Rejected*: Mutating a single `balance` column in place — loses auditability, breaks point-in-time T+1 settlement reconciliation, and makes race conditions silent.
2. **Switch-Authoritative Clock & `DEBIT_UNKNOWN -> CHK` Probe (vs. Trusting Bank Timestamps or Blind Retries)**
   - *Decision*: When a remitter bank times out after debiting (`debitThenHang`), the Switch transitions to `DEBIT_UNKNOWN` and sends an idempotent `CHK` probe keyed by `RRN` before deciding whether to credit or fail.
   - *Rejected*: Blindly retrying `0200 DEBIT` (causes double debits if the first debit actually committed) or trusting bank wall-clock times (breaks settlement cycle cutoffs across banks).
3. **Deemed-Approved Conflict Isolation (vs. Overwriting `REVERSED` on Late `0210` Approvals)**
   - *Decision*: If a late approval arrives after an `0420` reversal was already issued, the Switch preserves `REVERSED` and logs an operational reconciliation exception rather than silently mutating terminal state.
   - *Rejected*: Last-write-wins state updates — causes silent money creation/loss between Remitter and Beneficiary banks.

### Project 2 — Merchant Payment Gateway & PCI Vault (`@fintech/project2-gateway`)
1. **Separate `vaultDb` + AES-256-GCM with Random 12-Byte IVs (vs. Storing Encrypted PANs in `gatewayDb` or Hashing PANs)**
   - *Decision*: Isolated `TokenVaultService` on its own SQLite database, config-held 32-byte key, random IV + auth tag per tokenization, zero CVV storage, and merchant-scoped detokenization verified by the 100-payment `runPciGrepTest()`.
   - *Rejected*: Deterministic `SHA-256(PAN)` (brute-forceable in minutes across ~$10^9$ valid BIN+Luhn combinations) and co-locating PAN columns in `gatewayDb` (pulls the entire gateway into PCI-DSS scope).
2. **Technical Failure Failover vs. Business Decline No-Retry (vs. Retrying All Non-200 Responses)**
   - *Decision*: `AcquirerRoutingEngine` fails over once within the session on technical errors (`91_ACQUIRER_DOWN`, `68_TIMEOUT`, `96_TECHNICAL_500`) while immediately terminating on business declines (`51_INSUFFICIENT_FUNDS`, `55_WRONG_OTP`).
   - *Rejected*: Retrying business declines on a secondary acquirer — wastes acquirer fees, triggers card-network fraud velocity blocks, and degrades conversion.
3. **Fresh-Timestamp Re-Signing on Exponential Webhook Retries (vs. Reusing the Original Signature)**
   - *Decision*: `WebhookDeliveryWorker` re-signs each retry (`1m, 5m, 30m, 2h, 6h, 24h`) with the current `nowIso` timestamp while keeping the same `event_id` for merchant deduplication.
   - *Rejected*: Replaying the initial signature header — fails the merchant's 5-minute replay-attack window on every retry past 5 minutes.

### Project 3 — Consumer UPI App & `<100ms` Real-Time Risk Engine (`@fintech/project3-consumer-app`)
1. **Ed25519 Asymmetric Device Binding + 24h Cooling Cap (vs. Shared HMAC Secrets on Mobile Clients)**
   - *Decision*: Private key never leaves the device; server stores only the public key, retires the previous device immediately on 2nd-device takeover, and activates a 24h ₹5,000 cooling cap.
   - *Rejected*: Storing symmetric HMAC secrets on mobile devices — a server DB leak or APK extraction allows full request forgery.
2. **Two-Heaps Running Median + Safe JSON AST Rules in Shadow Mode (vs. `eval()` or Direct-to-Prod Rules)**
   - *Decision*: `RunningMedianTracker` ($O(\log N)$ insert, $O(1)$ median) + schema-validated AST (`ALLOWED_RISK_FEATURES`, max depth 12) staged in `SHADOW` mode for 100-payment Diff Reports before promotion.
   - *Rejected*: `eval()`-based rules (RCE/prototype probing risk) and direct-to-`ACTIVE` rule pushes (one typo blocks legitimate users).
3. **Client-Generated `client_txn_id` + Local SQLite `PENDING` Persistence (vs. In-Memory State)**
   - *Decision*: `ConsumerAppLocalStore` writes `PENDING` to disk *before* calling the network so airplane mode / force-close never fakes a failure and always reconciles cleanly via `syncPendingTransactions()`.
   - *Rejected*: Showing "Payment Failed" on socket timeout — causes customers to immediately re-pay and get double-debited.

### Project 4 — Recurring Payments, Mandates & Subscriptions (`@fintech/project4-mandates`)
1. **Deterministic `execution_key` + Distributed Fencing Leases + Switch Status Recovery (vs. Random UUIDs per Attempt)**
   - *Decision*: `execution_key = subscription_id:cycle:N` serves as both the SQLite `PRIMARY KEY` and Project 1 Switch's `transaction_id`, making mid-flight `SIGKILL` crashes recover with strictly 1 bank debit.
   - *Rejected*: Generating a fresh UUID on worker restart — guarantees double debits whenever a worker dies between Switch commit and local DB write.
2. **Separate `anchor_day` Column + `min(anchor_day, daysInMonth)` (vs. `lastBillingDate + 1 month`)**
   - *Decision*: Stores `anchor_day = 31` independently so `Jan 31 -> Feb 28/29 -> Mar 31` never drifts permanently to the 28th.
   - *Rejected*: Naive date-plus-month chaining — silently shifts every end-of-month subscriber to the 28th after their first February.
3. **Missing-Record Exceptions on e-NACH Response Files (vs. Assuming Omitted Rows Failed or Succeeded)**
   - *Decision*: `diffPresentedVsRespondedKeys` ($O(N + M)$) raises `MISSING_FROM_BANK_RESPONSE` operational exceptions for any presented key omitted by the bank's T+1 CSV.
   - *Rejected*: Treating missing rows as `FAILED_SOFT` — triggers dunning retries on debits the bank may have already settled.

---

## 2. Verified Performance & Reliability Benchmarks

| System | Benchmark | Target | Observed Result | Test File |
| :--- | :--- | :---: | :---: | :--- |
| **Project 1: Central Switch** | Sustained throughput & latency | `>100 TPS`, `p95 < 1s` | **`1,270 TPS`**, `p95 = 1.05ms` | `projects/project1-switch/test/day06-reconciliation-and-admin.test.ts` |
| **Project 2: Payment Gateway** | Mixed Card + UPI throughput | `>100 TPS`, `p95 < 100ms` | **`>500 TPS`**, `p95 < 10ms` | `projects/project2-gateway/test/day14-milestone2-benchmark.test.ts` |
| **Project 2: PCI Token Vault** | 100-Card-Payment Grep Test | `0` leaked raw PANs | **`0` leaks** across all DBs & logs | `projects/project2-gateway/test/project2-gateway.test.ts` |
| **Project 3: Risk Engine** | Live + Shadow Mode scoring | `>= 50 TPS`, `p95 < 100ms` | **`>10,000 TPS`**, `p95 < 1ms` | `projects/project3-consumer-app/test/day21-milestone3-benchmark.test.ts` |
| **Project 4: Cycle Executor** | 10,000 due cycles in 1 minute | `< 60s`, `0` duplicates | **`14.6ms`**, **`0` duplicates** | `projects/project4-mandates/test/day28-milestone4-10k-benchmark.test.ts` |
| **Full 4-Project Stack** | Automated unit + E2E suite | `100%` passing | **`81 / 81` passing** (`~1.3s`) | `npm test` |

---

## 3. Product-Tier Resume Bullets (Razorpay / Juspay / PhonePe / NPCI)

- **Built a 4-project Indian Payments Infrastructure monorepo** (UPI Central Switch, Multi-Rail Payment Gateway + PCI Token Vault, Consumer UPI App + `<100ms` Real-Time Risk Engine, and RBI Mandates/Subscriptions Engine) in strict TypeScript on Node 24 with **81/81 automated tests** and zero external runtime dependencies.
- **Engineered an ISO 8583 UPI Central Switch & Double-Entry Ledger** sustaining **1,270 TPS (`p95 = 1.05ms`)**, with SQLite trigger-enforced append-only postings, `DEBIT_UNKNOWN -> CHK` timeout recovery, `0420` auto-reversals, T+1 multilateral netting ($\le B - 1$ transfers), and $O(N)$ 3-way reconciliation.
- **Architected an isolated PCI-DSS Token Vault (`AES-256-GCM`, 0 raw PAN leaks in 100-payment Grep Test)** and Juspay-style **Smart Acquirer Router** with rolling health scores, technical-only failover, dual-secret overlap key rotation, and at-least-once signed webhooks (`1m–24h` exponential backoff).
- **Designed a `<100ms` Real-Time Fraud Engine & Kill-Safe Recurring Billing Executor** featuring Ed25519 device binding, Two-Heaps 30-day running median anomaly detection, schema-validated AST rules in Shadow Mode, RBI 24h pre-debit notice gating, Day 1/3/7 dunning with Pay-Now recovery, and **10,000 due cycles processed in `14.6ms` with zero duplicate debits**.
