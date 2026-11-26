# Slice 02 — Payment Gateway (`:3002`): Orders, Isolated PCI Token Vault Checkout & Acquirer Failover

**Back to:** [Overall Plan](PLAN.md)

## 1. Vertical Feature Scope
Build the live HTTP server (`projects/project2-gateway/src/gateway-server.ts`) and interactive Checkout + Acquirer Routing Dashboard on `:3002`, strictly enforcing manual HMAC-SHA256 authentication (computed in the browser via `window.crypto.subtle`), isolated PCI-DSS `p2-vault.sqlite` tokenization, 3DS OTP authorization, technical-only failover (`ACQ_ALPHA -> ACQ_BETA`), and the live 100-Card PCI Grep Test.

## 2. Model & Persistent DB Layer (`.data/`)
- **Two Strictly Isolated SQLite Files**:
  - `.data/p2-gateway.sqlite` (`merchants`, `api_keys`, `orders`, `payments`, `payment_attempts`, `refunds`, `gateway_ledger_postings`, `webhook_endpoints`, `webhook_deliveries`, `acquirer_health`)
  - `.data/p2-vault.sqlite` (`TokenVaultService` — `vault_tokens` encrypted with AES-256-GCM; completely separate file from `gatewayDb`)
- **Idempotent Bootstrap**: On first boot, creates `Acme Books Store` (`ACTIVE`) and persists its `liveKey` (`keyId`, `secret`). On subsequent restarts, reads the existing merchant & key from `.data/p2-gateway.sqlite` without duplicating rows, and prints `keyId` + `active_secret` to **stdout only**.

## 3. API & Security Layer (`projects/project2-gateway/src/gateway-server.ts`)
- **Strict Manual HMAC-SHA256 Auth Middleware**:
  - Reads headers `X-Key-Id`, `X-Timestamp` (ISO-8601), and `X-Signature` (`HMAC-SHA256(secret, timestamp + "." + rawBody)`).
  - Calls `gateway.authenticateMerchantRequest(...)` (enforcing `<5m` replay window, `active_secret` + overlap `previous_secret`, and `ACTIVE` merchant state for `LIVE` keys). Rejects bad/missing signatures with `HTTP 401`.
- **Endpoints**:
  - `GET /` -> Interactive Gateway & Hosted Checkout HTML UI.
  - `GET /health` -> Service status + acquirer health snapshots.
  - `POST /api/orders` (HMAC-signed) -> Calls `gateway.createOrder(...)`, supports idempotency key (`409` on payload mismatch).
  - `POST /api/vault/tokenize` (Direct Checkout -> Vault) -> Calls `gateway.vault.tokenize(...)`, returns `{ token, network, bin6, last_four, expiry }` (raw PAN never touches `gatewayDb` or logs).
  - `POST /api/payments` (HMAC-signed) -> Calls `gateway.payOrder(...)` (`CARD` via `tokenId` + `cardOtp`, or `UPI` via embedded Switch), returns `{ payment, attempts, signedReturnUrl }`.
  - `GET /api/acquirers/health` (HMAC-signed) -> Returns rolling 60s health scores & states (`HEALTHY` / `DEMOTED` / `BLOCKED`).
  - `PUT /api/acquirers/:id/chaos` (HMAC-signed) -> Toggles `forceDown`, `technicalFailureRatePercent`, `latencyMs` on `ACQ_ALPHA` / `ACQ_BETA` / `ACQ_GAMMA`.
  - `GET /api/pci-grep-audit` (HMAC-signed) -> Runs `runPciGrepTest(...)` against `gatewayDb`, `vaultDb`, and `structuredLogs` for tracked test PANs and returns `{ passed, leaksFound }`.

## 4. Interactive Web UI (`GET /`)
- **Manual Auth Bar**: Inputs for `X-Key-Id` and `API Secret` (never pre-filled). A client-side JS helper uses `window.crypto.subtle.importKey("raw", ...)` + `crypto.subtle.sign("HMAC", ...)` to sign every request body with a fresh ISO timestamp and displays the live `X-Signature` header sent!
- **Card 1 — Create Order & Hosted Checkout**: Create an order -> tokenize a test card directly to `/api/vault/tokenize` -> enter 3DS OTP (`123456` for approve, `000000` for `55_WRONG_OTP` business decline) -> view attempt-by-attempt routing log (`ACQ_ALPHA -> ACQ_BETA`).
- **Card 2 — Acquirer Chaos & Health Scoreboard**: Toggle `ACQ_ALPHA` `forceDown = true` to demonstrate live within-session failover on technical failure vs. 1-attempt stop on wrong OTP.
- **Card 3 — Live PCI-DSS Grep Audit**: Button calling `GET /api/pci-grep-audit` proving `0` raw PANs exist in `p2-gateway.sqlite`, `p2-vault.sqlite` plaintext, or logs.

## 5. Tests & Orchestrator Integration
- **Test File**: `projects/project2-gateway/test/slice02-gateway-checkout-http.test.ts`
  - Verifies unsigned request returns `401`, signed order -> tokenize -> pay succeeds (`200`), `ACQ_ALPHA` down fails over to `ACQ_BETA` (`attempts.length === 2`), wrong OTP stops at 1 attempt, `GET /api/pci-grep-audit` passes with `0` leaks, and persistence survives server restart.
- **Orchestrator**: Replace minimal stub in `scripts/orchestrate.ts` `startGatewayServer` with `GatewayHttpServer`.
