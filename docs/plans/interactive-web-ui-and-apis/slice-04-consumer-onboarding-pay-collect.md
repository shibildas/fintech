# Slice 04 — Consumer UPI App (`:3003`): Onboarding, Ed25519 Device Binding, 4 Pay Paths & Collects

**Back to:** [Overall Plan](PLAN.md)

## 1. Vertical Feature Scope
Build `ConsumerHttpServer` (`projects/project3-consumer-app/src/consumer-server.ts`) and a mobile-framed Consumer UPI App dashboard at `/` on `:3003`, enforcing real **Ed25519 asymmetric device request signing**, 2nd-device takeover + 24h cooling cap, salted nonce PIN verification + 5-strike lock, all 4 Pay Paths (QR, VPA, Mobile, Bank+IFSC), Airplane Mode **Honest Pending UX**, and Collect request fan-out abuse controls.

## 2. Model & Persistent DB Layer (`.data/`)
- **File**: `.data/p3-consumer.sqlite` (`ConsumerPspBackend` + `ConsumerPayEngine` + `CollectRequestEngine` + `PspLimitProfileEngine`) plus local seeded Switch/Banks in `.data/p3-switch.sqlite` (isolated microservice state).
- **Browser Local Storage**: `localStorage["fintech_p3_pending_txns"]` persists `PENDING` transactions *before* calling `POST /api/pay` so refreshing the browser tab after enabling Airplane Mode demonstrates true **Honest Pending UX** recovery via `GET /api/transactions/:clientTxnId`!

## 3. API & Security Layer (`projects/project3-consumer-app/src/consumer-server.ts`)
- **Onboarding & Auth Endpoints**:
  - `POST /api/signup` -> Issues mock SMS OTP (printed to server stdout & returned in dev mode for manual entry).
  - `POST /api/otp/verify` -> Marks mobile verified.
  - `POST /api/devices/bind` -> Registers customer's Ed25519 SPKI PEM public key; retires previous device (`401`) and activates 24h ₹5,000 cooling cap on takeover.
  - `POST /api/pin/set` & `POST /api/pin/challenge` -> Sets salted PIN hash; issues per-txn `txnNonce`.
  - `POST /api/accounts/discover`, `POST /api/accounts/link`, `POST /api/vpas`.
- **Device-Signed Payment & Collect Endpoints** (require `X-Device-Id`, `X-Device-Timestamp`, `X-Device-Nonce`, `X-Device-Signature` verified via `psp.verifyDeviceSignedRequest(...)`):
  - `POST /api/pay` -> Executes `QR`, `VPA`, `MOBILE`, or `BANK_IFSC` with `clientTxnId` + nonce PIN proof.
  - `GET /api/transactions/:clientTxnId` -> Reconciles Honest Pending status.
  - `PUT /api/chaos/airplane-mode` -> Toggles `payEngine.simulateAirplaneMode` for live network-drop demo.
  - `POST /api/collects`, `POST /api/collects/:id/approve`, `POST /api/collects/:id/decline`, `POST /api/collects/block`.

## 4. Interactive Web UI (`GET /` — Tab 1: Consumer UPI App)
- **Step-by-Step Security Flow**: Manual mobile signup -> enter SMS OTP -> click **Generate Browser Ed25519 Keypair (`crypto.subtle`) & Bind Device** (private key stays in browser memory, never sent to server!) -> set 4-digit PIN -> link `BANKA` account & create VPA.
- **4 Pay Paths & NPCI QR Scanner/Generator**: Switch between QR (`upi://pay?...`), VPA, Mobile, and Bank+IFSC; toggle **Airplane Mode** to trigger Honest Pending banner, reload page, turn off Airplane Mode, and click **Sync Pending**.
- **Collect & Fan-Out Tester**: Send/approve/decline collects, block a requester, or fire a 15-payer fan-out burst to watch `HTTP 429` trigger.

## 5. Tests & Orchestrator Integration
- **Test File**: `projects/project3-consumer-app/test/slice04-consumer-http.test.ts`
  - Verifies unsigned/tampered Ed25519 request returns `401`, replayed nonce returns `401`, 2nd device retires 1st device (`401`) and enforces 24h cap (`403`), QR pay succeeds (`200`), Airplane Mode leaves `PENDING` and syncs cleanly, and 15-payer fan-out returns `429`.
- **Orchestrator**: Replace stub in `scripts/orchestrate.ts` `startConsumerAppServer` with `ConsumerHttpServer`.
