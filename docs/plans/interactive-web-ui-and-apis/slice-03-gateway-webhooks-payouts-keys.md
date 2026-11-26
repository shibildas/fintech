# Slice 03 — Payment Gateway (`:3002`): Partial Refunds, Signed Webhooks, T+1 Payouts & Key Rotation

**Back to:** [Overall Plan](PLAN.md)

## 1. Vertical Feature Scope
Extend `GatewayHttpServer` (`:3002`) with the complete **Merchant Post-Payment & Operations** workflows: idempotent partial/full refunds (`422` over-refund guard), signed webhook outbox + `500` outage simulator + manual resend, T+1 payout CSV settlement with MDR/18% GST ledger parity, and zero-downtime dual-secret API key rotation.

## 2. Model & DB Layer
- Reuses `.data/p2-gateway.sqlite` tables (`refunds`, `gateway_ledger_postings`, `merchant_settlements`, `webhook_endpoints`, `webhook_deliveries`, `api_keys`).
- Wires an in-process `DemoStoreWebhookReceiver` endpoint (`https://demo.acmebooks.in/webhooks/gateway`) registered on first boot so interviewers can toggle "Simulate Merchant 500 Outage" directly in the UI and watch retries schedule and recover!

## 3. API & Security Layer (Added to `projects/project2-gateway/src/gateway-server.ts`)
All endpoints strictly require HMAC-SHA256 auth (`X-Key-Id`, `X-Timestamp`, `X-Signature`):
- `POST /api/refunds` -> Calls `gateway.createRefund(...)`; returns `422` when `refunded + amount > captured`.
- `GET /api/ledger/parity` -> Calls `gateway.getMerchantLedgerBalances()` + `gateway.verifyDashboardMatchesLedger()`.
- `POST /api/payouts/run` -> Calls `gateway.runMerchantPayout(...)`, returning `{ settlement, report_csv }`.
- `GET /api/webhooks/deliveries` -> Lists all webhook deliveries (`status`, `attempt`, `http_status_code`, `next_retry_at`, `signature_header`) + endpoint state (`ACTIVE` / `FAILING`).
- `PUT /api/webhooks/demo-receiver` -> Toggles `demoStore.simulateServer500 = true | false`.
- `POST /api/webhooks/deliveries/:id/resend` -> Calls `gateway.webhooks.resendDelivery(...)`.
- `POST /api/keys/rotate` -> Calls `gateway.rotateApiKey({ overlapWindowMs })`, returning `{ keyId, newSecret, previousSecretExpiresAt }` (old secret continues authenticating until overlap expires!).

## 4. Interactive Web UI (New Tabs on `GET /` at `:3002`)
- **Tab 2 — Refunds & Ledger Parity**: Select a captured `payment_id`, issue partial refunds, watch `MERCHANT_PAYABLE`, `GATEWAY_REVENUE` (MDR), and `GATEWAY_TAX_GST` update live, and see `HTTP 422` on excess refund.
- **Tab 3 — Signed Webhooks & Outage Recovery**: Toggle Demo Store `500` mode, trigger a payment, inspect scheduled backoff retries, restore `200` mode, and click **Manual Resend**.
- **Tab 4 — T+1 Payouts & Overlap Key Rotation**: Run T+1 payout and preview/download CSV; rotate API secret with a configurable overlap window and test signing with both the old and new secrets live.

## 5. Tests & Integration
- **Test File**: `projects/project2-gateway/test/slice03-gateway-ops-http.test.ts`
  - Verifies partial refunds + `422` excess rejection, `GET /api/ledger/parity` exact match, webhook `500` -> `RETRY_SCHEDULED` -> `resend` -> `DELIVERED`, T+1 payout CSV net == ledger balance, and key rotation allowing old secret during overlap and rejecting (`401`) after expiry.
