# Payments & Fintech Infrastructure Stack

A production-grade, zero-external-runtime-dependency TypeScript monorepo implementing all four core rails of modern Indian payments infrastructure — **UPI Central Switch**, **Merchant Payment Gateway & PCI Token Vault**, **Consumer UPI App + Real-Time Risk Engine**, and **RBI Mandates (AutoPay & e-NACH) & Subscriptions** — built on **Node.js 24** (`node:sqlite`, `node:crypto`, `node:test`, native TypeScript execution).

> **Test & Quality Gates:** `85 / 85` tests passing across `28` suites (`npm test`), plus strict TypeScript (`npm run typecheck`) and ESLint (`npm run lint`) enforced in CI via [`.github/workflows/test.yml`](.github/workflows/test.yml).
> **Architecture & Interview Defense:** See [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) for the _Three Hardest Decisions & What We Rejected_ across all 4 projects and verified load benchmarks.

---

## Monorepo Architecture

```text
fintech/
├── packages/
│   └── core/                     # @fintech/core — 19 Common Payment Rules & 19 Fintech DSA modules
├── projects/
│   ├── project1-switch/          # @fintech/project1-switch — UPI Switch, Bank Cores, T+1 Settlement & 3-Way Recon
│   ├── project2-gateway/         # @fintech/project2-gateway — Payment Gateway, Smart Router, PCI Vault & Webhooks
│   ├── project3-consumer-app/    # @fintech/project3-consumer-app — Consumer UPI App, Collects, Limits, Risk & Disputes
│   └── project4-mandates/        # @fintech/project4-mandates — AutoPay/e-NACH Mandates, Subscriptions, Dunning & Invoices
├── docs/
│   └── ARCHITECTURE_DECISIONS.md # ADRs, benchmarks & Product-Tier Fintech interview defense
├── scripts/
│   └── orchestrate.ts            # Unified 1-command local runner for all 4 projects
├── .github/workflows/
│   └── test.yml                  # CI workflow running `npm ci` + `npm test` on push/PR to `main`
├── ROADMAP.md                    # 30-day build roadmap (Nov 5 – Dec 4, 2026)
└── package.json                  # npm workspaces root
```

---

## Implemented Projects & Modules

### 1. Shared Core (`@fintech/core`)

- **Money, Ledgers & Protocol**: Strict integer `paise` arithmetic, append-only double-entry ledger (`BEFORE UPDATE`/`BEFORE DELETE` SQLite triggers), HMAC-SHA256 signing (`<5m` replay + overlap key rotation), ISO 8583 validation, idempotency store (`409` on mismatch), explicit state machines, and immutable audit logs.
- **19 Fintech DSA Modules**: TTL-LRU + Single-Flight Cache, Routing Prefix Trie (BIN/IFSC), Payment Corridor Graph (BFS/Dijkstra), Multilateral Netting, 3-Pointer Streaming Reconciliation Join, $O(1)$ Token-Bucket Rate Limiter, CAS/Mutex/RWLock Concurrency, Merkle Audit Tree, DP Subset-Sum Payout Matcher, Ed25519 Monotonic Replay Guard, NPCI QR Parser, Sliding-Window Distinct Counter (Collect Fan-Out), Two-Heaps Running Median, Safe JSON AST Rule Evaluator, SLA Min-Heap, Sweep-Line Interval Capacity Checker, Anchor-Day Calendar + Rational Proration, Distributed Lease Manager (Fencing Tokens), Batch SHA-256 Set-Difference, Dunning Backoff Planner, and $O(1)$ Revenue Prefix-Sum Index.

### 2. Project 1 — UPI-Style Central Switch ([`projects/project1-switch/README.md`](projects/project1-switch/README.md))

- 6-hop ISO 8583 pay flow (`1,270 TPS`, `p95 = 1.05ms`), exactly-once debit under concurrency, `DEBIT_UNKNOWN -> CHK` probes, `0420` auto-reversals, Deemed-Approved conflict detection, T+1 zero-sum settlement CSVs, and 6-class 3-way reconciliation.

### 3. Project 2 — Merchant Payment Gateway & PCI Vault ([`projects/project2-gateway/README.md`](projects/project2-gateway/README.md))

- Onboarding state machine, overlap API key rotation, 10x concurrent idempotent `/orders`, Juspay-style Smart Acquirer Router (failover on technical `5xx`/timeouts, never on business declines), isolated AES-256-GCM Token Vault (`0` raw PAN leaks in 100-payment Grep Test), at-least-once signed webhooks (`1m–24h` backoff), partial refunds, rolling reserves, and T+1 payouts.

### 4. Project 3 — Consumer UPI App & Real-Time Risk Engine ([`projects/project3-consumer-app/README.md`](projects/project3-consumer-app/README.md))

- Ed25519 device binding + 2nd-device takeover 24h cooling cap, salted per-transaction PIN nonces + 5-strike lock, 4 pay paths + NPCI QR parser + Honest Pending UX surviving airplane mode/restart, collect fan-out abuse controls, `<100ms` Real-Time Risk Engine (7 rules, deterministic fallback, Shadow Mode 100-payment Diff Report, AST rules), and Dispute Desk auto-resolved by Project 1 Switch reversals.

### 5. Project 4 — Recurring Payments, RBI Mandates & Subscriptions ([`projects/project4-mandates/README.md`](projects/project4-mandates/README.md))

- `UPI_AUTOPAY` & `E_NACH` mandates with UMRN minting and mandatory `PENDING_REAUTH` on cap increases, Jan 31 -> Feb 28/29 -> Mar 31 anchor calendar math + mid-cycle proration + Injectable Fake Clock, RBI 24h pre-debit notice gate, kill-safe `execution_key` executor (**10,000 due cycles in `14.6ms`, 0 duplicates**), 500-subscription e-NACH batch presentment + missing-record exceptions, Day 1/3/7 dunning + Project 2 Pay-Now recovery, and printable invoices with MRR-to-paid-invoice parity.

---

## Getting Started

### Prerequisites

- **Node.js `24+`**

### Run All 4 Services

```bash
# Start all 4 interactive Web UIs & live HTTP APIs (dev credentials printed to stdout; SQLite persisted in .data/)
npm start

# Start individual services
npm run start:p1   # Switch & Admin Console (http://127.0.0.1:3001)
npm run start:p2   # Payment Gateway & Vault (http://127.0.0.1:3002)
npm run start:p3   # Consumer App & Risk    (http://127.0.0.1:3003)
npm run start:p4   # Mandates & Fake Clock  (http://127.0.0.1:3004)

# Reset local .data/ SQLite databases for a fresh demo
npm run reset:data
```

### Run Quality Gates & Tests

```bash
npm ci
npm run typecheck  # Strict TypeScript check (tsc --noEmit)
npm run lint       # ESLint check
npm run format     # Prettier auto-format
npm test           # All 85 tests across Core + P1 + P2 + P3 + P4
npm run test:core
npm run test:p1
npm run test:p2
npm run test:p3
npm run test:p4
```

---

## License

[MIT](LICENSE) © 2026 Shibil Das
