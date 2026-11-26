# Slice 06 — Mandates & Subscriptions (`:3004`): UMRN, Fake Clock, Pre-Debit Gate, Dunning & Invoices

**Back to:** [Overall Plan](PLAN.md)

## 1. Vertical Feature Scope
Build `MandatesHttpServer` (`projects/project4-mandates/src/mandates-server.ts`) and an interactive **Recurring Billing & Fake Clock Control Center** at `/` on `:3004`, exposing RBI Mandate UMRN registration & cap re-authorization, Subscription anchor-day scheduling (`Jan 31 -> Feb 28 -> Mar 31`), live **Injectable Fake Clock** fast-forwarding, 24h Pre-Debit Notice gating, Kill-Safe Cycle execution, e-NACH batching, Day 1/3/7 Dunning + Pay-Now recovery, and Printable Invoices + MRR parity.

## 2. Model & Persistent DB Layer (`.data/`)
- **File**: `.data/p4-mandates.sqlite` (shared by `MandateService`, `SubscriptionService`, `RecurringCycleExecutor`, `EnachPresentmentEngine`, `DunningEngine`, `InvoiceAndMrrService`, plus a `fake_clock_state(id, current_iso)` table so advancing the Fake Clock also persists across restarts!).
- Embedded isolated Switch + Bank + Gateway instances for standalone microservice operation on `:3004`.

## 3. API & Security Layer (`projects/project4-mandates/src/mandates-server.ts`)
- **Strict Manual Auth**: Requires `X-Merchant-Token` (printed to server stdout on startup, e.g. `p4_dev_merchant_token_2026`; missing/invalid returns `HTTP 401`), plus explicit customer PIN/OTP credentials on `/authorize` and `/reauth`!
- **Endpoints**:
  - `GET /` & `GET /health`
  - `GET /api/clock` & `POST /api/clock/advance` (`{ hours?, days?, setIso? }`) -> Advances and persists `InjectableFakeClock`.
  - `POST /api/mandates`, `POST /api/mandates/:id/authorize` (requires PIN/OTP -> mints UMRN), `POST /api/mandates/:id/cap` (increase -> `PENDING_REAUTH`), `POST /api/mandates/:id/reauth`, `POST /api/mandates/:id/revoke` (propagates `HALTED` to linked subscriptions).
  - `POST /api/plans`, `POST /api/subscriptions`, `POST /api/subscriptions/:id/activate`, `POST /api/subscriptions/:id/advance-anchor` (demos `Jan 31 -> Feb 28 -> Mar 31`), `POST /api/subscriptions/:id/change-plan` (mid-cycle proration).
  - `POST /api/cycles/pre-debit` & `POST /api/cycles/execute` (enforces 24h pre-debit gate + `06:00–22:00` local window + kill-safe `execution_key`).
  - `POST /api/enach/run-sample` -> Runs a multi-bank e-NACH batch with 1 dropped record to showcase `MISSING_FROM_BANK_RESPONSE`.
  - `POST /api/dunning/fail`, `POST /api/dunning/:id/pay-now`, `POST /api/dunning/process-due`.
  - `POST /api/invoices`, `GET /api/invoices/:id/printable`, `GET /api/invoices/mrr-parity`.

## 4. Interactive Web UI (`GET /` at `:3004`)
- **Sticky Fake Clock Toolbar**: Displays current simulated IST & UTC time with buttons **`+10h`**, **`+24h`**, **`+1d`**, **`+3d`**, **`+7d`**, and **`Set Jan 31`** so you can demo a full month of billing in 60 seconds!
- **Manual Auth Bar**: `X-Merchant-Token` input (never pre-filled).
- **4 Interactive Cards**:
  1. **Mandate UMRN & Cap Re-Auth**: Create `UPI_AUTOPAY`/`E_NACH`, authorize with PIN/OTP, request cap increase (`PENDING_REAUTH`), re-authorize, or revoke (watch subscription auto-HALT).
  2. **Subscription & 24h Pre-Debit Executor**: Send pre-debit notice -> try executing immediately (`403` blocked!) -> click **`+24h`** on Fake Clock -> execute (`200 SUCCEEDED`).
  3. **Dunning & Pay-Now Recovery**: Trigger `51_INSUFFICIENT_FUNDS` (`PAST_DUE` + Day 1/3/7 retries) -> click **Pay-Now with Card** -> restores `ACTIVE` and cancels pending retries.
  4. **Printable Tax Invoice & MRR Parity**: Render formatted Tax Invoice + UMRN receipt and verify `MRR + one-time === sum(PAID invoices)`.

## 5. Tests & Orchestrator Integration
- **Test File**: `projects/project4-mandates/test/slice06-mandates-http.test.ts`
  - Verifies missing `X-Merchant-Token` returns `401`, wrong PIN on mandate authorize returns `401`, early cycle debit returns `403` until `POST /api/clock/advance { hours: 24 }`, soft failure -> Pay-Now restores `ACTIVE`, MRR parity matches, and Fake Clock + mandate state persist across server restart.
- **Orchestrator**: Replace stub in `scripts/orchestrate.ts` `startMandatesServer` with `MandatesHttpServer`.
