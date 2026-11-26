# Slice 01 — UPI Switch (`:3001`): 6-Hop Pay, Chaos Injection, T+1 Settlement & 3-Way Recon

**Back to:** [Overall Plan](PLAN.md)

## 1. Vertical Feature Scope
Upgrade Project 1's existing [`SwitchAdminApp`](../../../projects/project1-switch/src/admin-server.ts) into a persistent, CORS-enabled, strictly authenticated microservice on `:3001` with a live interactive dashboard at `/` that lets an interviewer watch 6-hop ISO 8583 payments, inject bank chaos (`debitThenHang`, `forceDown`), run T+1 multilateral settlement, and trigger 3-way reconciliation.

## 2. Shared Foundation (Bootstrapped in Slice 01)
- **File**: `packages/core/src/http-ui-helpers.ts` (exported from `packages/core/src/index.ts`):
  - `applyCorsHeaders(res)` + `OPTIONS` preflight handler (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type, X-Role, X-Actor-Id, X-Admin-Token, X-Key-Id, X-Timestamp, X-Signature, X-Device-Id, X-Device-Timestamp, X-Device-Nonce, X-Device-Signature, X-Ops-Token`).
  - `readJsonBody(req, maxBytes = 1_048_576)` returning parsed JSON or throwing `400`/`413`.
  - `renderFintechShellHtml({ title, activePort, bodyHtml, scriptJs })`: Shared dark-mode fintech layout with top navbar linking `:3001` Switch, `:3002` Gateway, `:3003` Consumer App, `:3004` Mandates.
- **`.gitignore`**: Add `.data/` directory explicitly.

## 3. Model & Persistent DB Layer (`.data/`)
- **Files**:
  - `.data/p1-switch.sqlite` (`CentralSwitch` — `participants`, `switch_transactions`, `message_logs`, `state_history`, `settlement_cycles`, `reconciliation_runs`)
  - `.data/p1-bankA.sqlite`, `.data/p1-bankB.sqlite`, `.data/p1-bankC.sqlite` (`BankCoreSimulator` — `accounts`, `postings`, `rrn_operations`)
- **Idempotent Seeding**: Update `createSeededTopology(options?: { dataDir?: string })` in [`projects/project1-switch/src/seed.ts`](../../../projects/project1-switch/src/seed.ts) so `seedCustomerAccount` and `registerVpa` skip silently (`INSERT OR IGNORE` / existence check) when reopening an existing `.data/` DB across server restarts!

## 4. API & Security Layer (`projects/project1-switch/src/admin-server.ts`)
- **Strict Manual Auth**:
  - Add configurable `adminToken` (e.g., `process.env.P1_ADMIN_TOKEN ?? "p1_dev_admin_token_2026"`).
  - Print `adminToken`, seeded VPAs (`anita@psp1`, `rahul@psp1`, `shop@psp2`, `coffee@psp2`), and PINs (`1234`, `5678`) to **stdout only** on server boot.
  - Enforce `X-Admin-Token` + `X-Role: operator | admin` on `/transactions`, `/api/balances`, `/participants/:id/chaos`, `/cycles/:id/run`, `/reconcile`, and `POST /api/pay-demo`. Reject missing/bad token with `HTTP 401`, insufficient role (`operator` calling `chaos`) with `HTTP 403`.
- **New/Enhanced Endpoints**:
  - `OPTIONS *` -> `204 No Content` with CORS headers.
  - `GET /api/balances` (`operator+`) -> live derived balances (`ledger_balance_paise`, `available_balance_paise`, `masked`) for all seeded accounts across `BANKA`, `BANKB`, `BANKC`.
  - `POST /api/pay-demo` (`operator+`) -> accepts `{ payerVpa, payeeVpa, amountPaise, rawPin, transactionId }`, signs the `0200 PAY` envelope server-side with the PSP's secret, executes `sw.handlePay()`, and returns `{ transaction, hops, state_history }`.
  - Existing routes preserved: `GET /health`, `GET /metrics`, `GET /vpa/:handle`, `POST /pay`, `GET /transactions`, `GET /transactions/:rrn`, `PUT /participants/:id/chaos`, `POST /cycles/:id/run`, `POST /reconcile`.

## 5. Interactive Web UI (`GET /`)
- **Auth Panel (Top Bar)**: Manual inputs for `X-Admin-Token` and `X-Role` (`operator` / `admin`) — stored only in page memory (never pre-filled from HTML).
- **Card 1 — Live Bank Balances**: Displays `BANKA`, `BANKB`, `BANKC` accounts with refresh button.
- **Card 2 — Execute 6-Hop UPI Pay**: Form (`payerVpa`, `payeeVpa`, `amountPaise`, `rawPin`) -> renders interactive 6-hop ISO 8583 timeline (`0200` -> `0210` / `0100 CHK` / `0420 Reversal`).
- **Card 3 — Chaos Control (`admin` only)**: Toggle `debitThenHang`, `forceDown`, `latencyMs` per bank (`BANKA`/`BANKB`/`BANKC`) to demonstrate `403` for `operator` vs `200` for `admin`.
- **Card 4 — T+1 Settlement & 3-Way Recon**: Buttons to run settlement cycle (shows zero-sum net positions & SHA-256 trailer) and 3-way reconciliation report.

## 6. Tests & Orchestrator Integration
- **Test File**: `projects/project1-switch/test/slice01-switch-http-ui.test.ts`
  - Spins up `SwitchAdminApp` on an ephemeral port (`0`) backed by a temp directory `.sqlite` DB.
  - Verifies: `GET /` returns HTML (`200`), `OPTIONS` CORS headers, missing `X-Admin-Token` returns `401`, `operator` calling `/participants/BANKA/chaos` returns `403`, `admin` succeeds (`200`), `POST /api/pay-demo` moves balances, and restarting a second `SwitchAdminApp` against the same `.sqlite` directory preserves transactions & balances!
- **Orchestrator**: Update `startSwitchServer` in `scripts/orchestrate.ts` to use `.data/` and print dev credentials to stdout.
