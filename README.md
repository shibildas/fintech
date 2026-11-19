# Payments & Fintech Infrastructure Stack

A production-grade, zero-external-runtime-dependency TypeScript monorepo implementing the core rails of modern Indian payments infrastructure — **UPI Central Switch**, **Merchant Payment Gateway & PCI Token Vault**, and **Consumer UPI App + Real-Time Risk Engine** — built on **Node.js 24** (`node:sqlite`, `node:crypto`, `node:test`, native TypeScript execution).

> **Test Status:** `61 / 61` tests passing across `14` test suites (`npm test`), verified in CI via [`.github/workflows/test.yml`](.github/workflows/test.yml).

---

## Monorepo Architecture

```text
fintech/
├── packages/
│   └── core/                     # @fintech/core — Shared fintech primitives & DSA modules
├── projects/
│   ├── project1-switch/          # @fintech/project1-switch — UPI Switch, Bank Cores, T+1 Settlement & 3-Way Recon
│   ├── project2-gateway/         # @fintech/project2-gateway — Payment Gateway, Smart Router, PCI Vault & Webhooks
│   └── project3-consumer-app/    # @fintech/project3-consumer-app — Consumer UPI App, Collects, Limits & Risk Engine
├── .github/workflows/
│   └── test.yml                  # CI workflow running `npm ci` + `npm test` on merge/push to `main`
├── ROADMAP.md                    # 30-day build roadmap (Nov 5 – Dec 4, 2026)
└── package.json                  # npm workspaces root
```

---

## Implemented Modules

### 1. Shared Core (`@fintech/core`)
- **Money & Ledger (`money.ts`, `ledger.ts`)**: Strict integer `paise` arithmetic (no floating-point currency), append-only double-entry ledger (`DEBIT`/`CREDIT` summing to `0`), holds/available balance derivation, and MDR + 18% GST splits.
- **Security & Protocol (`security.ts`, `iso8583.ts`, `idempotency.ts`, `state-machine.ts`, `audit.ts`)**: HMAC-SHA256 service signing with `<5m` replay window and key overlap, ISO 8583 envelope validation (`MTI`, `STAN`, `RRN`), idempotency store (`409` on payload mismatch), explicit state machines, and immutable audit logs.
- **Fintech DSA Library**:
  - `dsa-lru-cache.ts` — O(1) TTL-LRU cache & single-flight request coalescing
  - `dsa-trie.ts` — Longest-prefix-match Routing Trie (Card BINs & IFSC prefixes)
  - `dsa-payment-graph.ts` — BFS min-hop & Dijkstra lowest-cost corridor routing
  - `dsa-settlement-netting.ts` — Multilateral settlement netting (`<= B - 1` transfers)
  - `dsa-reconciliation-join.ts` — O(N) 3-pointer streaming full outer join
  - `dsa-rate-limiter.ts` — O(1) Token-Bucket rate limiter
  - `dsa-concurrency-cas.ts` — `KeyedAsyncMutex`, `ReadWriteLock`, `Atomics` CAS counter, optimistic versioning
  - `dsa-tree-traversal.ts` — Merkle audit tree inclusion proofs & hierarchical MDR/GMV policy tree
  - `dsa-fee-rounding-dp.ts` — Dynamic Programming subset-sum payout matching & fee-rounding invariants
  - `dsa-device-auth.ts` — Monotonic timestamp & nonce replay guard
  - `dsa-qr-parser.ts` — NPCI UPI QR URI parser & builder
  - `dsa-distinct-window.ts` — O(1) amortized sliding-window distinct-counter (collect fan-out detection)
  - `dsa-running-median.ts` — Two-heaps streaming median tracker for anomaly scoring
  - `dsa-rule-ast.ts` — Safe schema-validated AST expression evaluator for risk rules

### 2. Project 1 — UPI-Style Central Switch ([`projects/project1-switch/README.md`](projects/project1-switch/README.md))
- **Central Switch (`MTI 0200/0210`, `0420/0430`, `0100/0110`)**: 6-hop pay flow, exactly-once debit under concurrent bursts, `CHK` status probes on remitter timeouts, async credit retries, `0420` auto-reversals, Deemed-Approved conflict detection, and mid-flight crash recovery.
- **3 Bank Core Simulators & 2 PSP Directories**: Double-entry bank ledgers, hashed UPI PIN with 3-strike freeze, VPA resolution, and chaos injection.
- **T+1 Settlement & 3-Way Reconciliation**: Zero-sum multilateral netting, immutable versioned CSVs with SHA-256 trailers, 6-class 3-way recon engine, and RBAC-protected Admin Console.

### 3. Project 2 — Merchant Payment Gateway ([`projects/project2-gateway/README.md`](projects/project2-gateway/README.md))
- **Merchant Onboarding, Orders & Multi-Attempt Lifecycle**: Key rotation with overlap windows, idempotent `/orders`, manual/auto capture, and partial/full refunds.
- **Smart Acquirer Router**: Dynamic success-rate/latency/cost scoring, half-open circuit breaker, single session-level failover on technical `5xx`/timeouts (never retrying business declines like insufficient funds).
- **Isolated PCI-DSS Token Vault**: Separate SQLite DB (`AES-256-GCM` encrypted PANs, zero CVV persistence, verified by the 100-payment Grep Test).
- **At-Least-Once Signed Webhooks & T+1 Payouts**: Exponential backoff retries (`1m` to `24h`), `FAILING` circuit breaker, rolling reserves, and MDR/GST double-entry ledger parity.

### 4. Project 3 — Consumer UPI App & Real-Time Risk Engine (`projects/project3-consumer-app`)
- **Device Binding & Auth (Day 15)**: SMS OTP onboarding, asymmetric **Ed25519** per-device request signing, device takeover retirement with 24-hour cooling cap, salted per-transaction PIN nonces, and 5-wrong-PIN lockout.
- **4 Pay Paths & Honest Pending UX (Day 16)**: QR scan, VPA, mobile lookup, and bank account + IFSC flows through Project 1 Switch, plus local `PENDING` state convergence after network loss/restart.
- **Collect Requests & Pre-Switch Limits (Day 17)**: Collect create/approve/decline/expiry, payer blocklists, per-payer rate limits, `15+` distinct-payer fan-out abuse detection, and PSP limit profiles.
- **Real-Time Risk Engine & Shadow Mode (Days 18–19)**: `<100ms` p95 scoring across 7 rules (`ALLOW` / `STEP_UP` / `DECLINE`), two-heaps running median anomaly detection, deterministic timeout fallback, safe AST rule evaluator, versioned rulesets, 100-payment Shadow Mode diff reporting, and historical replay.

*(Project 4 — Mandates / UPI AutoPay & Subscriptions is planned in [`ROADMAP.md`](ROADMAP.md).)*

---

## Getting Started

### Prerequisites
- **Node.js `24+`** (uses built-in TypeScript type-stripping, `node:sqlite`, `node:crypto`, and `node:test`)

### Run & Dev Orchestration

```bash
# Start all 3 services (Switch Admin Console, Gateway, Consumer App)
npm start

# Development mode with Node 24 file-watch auto-restart
npm run dev

# Start individual services
npm run start:p1   # Switch & Admin Console (default: http://127.0.0.1:3001)
npm run start:p2   # Payment Gateway      (default: http://127.0.0.1:3002)
npm run start:p3   # Consumer App & Risk  (default: http://127.0.0.1:3003)
```

Ports can be overridden via `SWITCH_PORT`, `GATEWAY_PORT`, and `CONSUMER_PORT`.

### Install & Run Tests

```bash
# Install dev types and verify lockfile
npm ci

# Run the entire test suite (Core + Project 1 + Project 2 + Project 3)
npm test

# Run individual workspace suites
npm run test:core
npm run test:p1
npm run test:p2
npm run test:p3
```

---

## CI/CD

- [`.github/workflows/test.yml`](.github/workflows/test.yml) automatically runs `npm ci` and `npm test` on Node `24` whenever code is pushed or merged to `main`.
- All tests run self-contained using in-memory / local `node:sqlite` databases — no external services, `.env` files, or GitHub Secrets are required.

---

## License

[MIT](LICENSE) © 2026 Shibil Das
