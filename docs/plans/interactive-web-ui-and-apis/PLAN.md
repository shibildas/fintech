# Overall Plan — Interactive Web UIs & Live HTTP APIs (`:3001–:3004`)

## 1. Locked Architectural Decisions

| Decision | Choice | Rationale |
| :--- | :--- | :--- |
| **Frontend Stack** | Zero-dependency Vanilla HTML / CSS / JS served by Node 24 | Preserves repo's zero-external-runtime-dependency architecture & instant `npm start` |
| **Service Topology** | 4 isolated HTTP servers (`:3001–:3004`) with CORS enabled | Mirrors production microservices; cross-links in top navbar |
| **UI Hosting & State** | Each service serves its own standalone interactive dashboard at `/` | Isolated state per microservice; runnable individually (`start:p1`..`start:p4`) or together (`npm start`) |
| **Persistence** | On-disk SQLite under `.data/` (gitignored) | Survives server restarts; idempotently seeded on first boot |
| **Authentication UX** | Strict manual auth forms (`X-Admin-Token`, HMAC-SHA256, Ed25519, PIN/OTP) | Zero secrets embedded in browser HTML/JS; client-side signing via Web Crypto (`crypto.subtle` on `127.0.0.1`) |
| **Credential Bootstrap** | Dev credentials printed to terminal `stdout` on startup | Easy copy-paste for live panel demos without weakening client-side security boundaries |

---

## 2. Libraries, Assets & Dependencies Inventory

- **Runtime & Backend**: Node.js `24+` built-ins only (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`, `node:path`, `node:test`, `node:assert/strict`). **Zero new npm packages.**
- **Browser Frontend**: Native ES Modules + Fetch API + Web Crypto API (`window.crypto.subtle` for `HMAC-SHA256` and `Ed25519` — `http://127.0.0.1` is a W3C Secure Context). Inline CSS design system (dark fintech palette, responsive CSS Grid, monospace telemetry logs, status badges).
- **Shared Core Helper**: `packages/core/src/http-ui-helpers.ts` (CORS middleware, JSON body parser with size cap, standardized error responder, shared dark fintech HTML/CSS shell & top navbar).
- **Persistence Directory**: `.data/` (added to `.gitignore`):
  - `.data/p1-switch.sqlite`, `.data/p1-bankA.sqlite`, `.data/p1-bankB.sqlite`, `.data/p1-bankC.sqlite`
  - `.data/p2-gateway.sqlite`, `.data/p2-vault.sqlite` (strictly separate PCI-DSS file!)
  - `.data/p3-consumer.sqlite`, `.data/p3-risk.sqlite`, `.data/p3-disputes.sqlite`
  - `.data/p4-mandates.sqlite`

---

## 3. Vertical Slices & Progress Tracker

Each slice is grouped by **feature/workflow/entity** and delivered **end-to-end** (Model/DB -> HTTP API -> Interactive UI -> Unit & HTTP Integration Tests -> Orchestrator Wiring).

| # | Slice & Detailed Spec | Service / Port | Status | Todo Checklist |
| :-: | :--- | :---: | :---: | :--- |
| **01** | [Slice 01 — UPI Switch 6-Hop Pay, Chaos, Settlement & 3-Way Recon](slice-01-switch-pay-chaos-recon.md) | `p1` (`:3001`) | `[x] Done` | `[x]` Shared HTTP/UI shell + `.data/` gitignore<br>`[x]` Persistent P1 SQLite seed + `X-Admin-Token` + CORS<br>`[x]` Interactive `/` UI (Pay, Chaos, Settlement, Recon)<br>`[x]` HTTP + Auth + Persistence tests |
| **02** | [Slice 02 — Gateway Orders, PCI Token Vault Checkout & Acquirer Failover](slice-02-gateway-checkout-vault.md) | `p2` (`:3002`) | `[x] Done` | `[x]` Persistent `p2-gateway.sqlite` + isolated `p2-vault.sqlite`<br>`[x]` HMAC-authenticated `/api/orders`, `/api/vault/tokenize`, `/api/payments`, `/api/pci-grep-audit`<br>`[x]` Hosted Checkout & Acquirer Chaos UI (`SubtleCrypto` HMAC)<br>`[x]` HTTP + 401/403 + Grep tests |
| **03** | [Slice 03 — Gateway Partial Refunds, Signed Webhooks, T+1 Payouts & Key Rotation](slice-03-gateway-webhooks-payouts-keys.md) | `p2` (`:3002`) | `[x] Done` | `[x]` Refund, Webhook Outbox, Payout & Key Rotation HTTP endpoints<br>`[x]` Merchant Ops UI tabs (Refunds, Webhook 500/Resend, CSV Payout, Key Rotation Overlap)<br>`[x]` HTTP + 422/401 overlap tests |
| **04** | [Slice 04 — Consumer UPI Onboarding, Ed25519 Device Binding, 4 Pay Paths & Collects](slice-04-consumer-onboarding-pay-collect.md) | `p3` (`:3003`) | `[x] Done` | `[x]` Persistent `p3-consumer.sqlite` + Ed25519 auth middleware<br>`[x]` `/api/signup`, `/api/devices/bind`, `/api/pay` (4 paths), `/api/collects`<br>`[x]` Mobile-frame Consumer UI (Web Crypto Ed25519, QR parser, Airplane Mode Honest Pending)<br>`[x]` HTTP + Replay/Takeover tests |
| **05** | [Slice 05 — Real-Time Risk Engine, Shadow Mode 100-Payment Diff & Dispute Desk](slice-05-risk-shadow-disputes.md) | `p3` (`:3003`) | `[x] Done` | `[x]` Persistent `p3-risk.sqlite` + `p3-disputes.sqlite` + `X-Ops-Token`<br>`[x]` `/api/risk/score`, `/api/risk/shadow/*`, `/api/disputes/*`<br>`[x]` Risk Inspector, Shadow Diff Table & Dispute Case File UI<br>`[x]` HTTP + `<100ms` latency tests |
| **06** | [Slice 06 — RBI Mandates, Subscriptions, Fake Clock, Pre-Debit Gate, Dunning & Invoices](slice-06-mandates-subscriptions-clock-dunning.md) | `p4` (`:3004`) | `[x] Done` | `[x]` Persistent `p4-mandates.sqlite` + Fake Clock HTTP controller<br>`[x]` Mandate, Subscription, 24h Pre-Debit, Executor, e-NACH, Dunning & Invoice APIs<br>`[x]` Interactive Fake Clock Toolbar, UMRN Re-Auth, Dunning/Pay-Now & Printable Invoice UI<br>`[x]` HTTP + Persistence + E2E tests |

---

## 4. Execution & Verification Workflow

1. Implement one slice at a time on a dedicated branch from `main` (linked to a GitHub Issue -> PR).
2. After each slice:
   - Run `npm test` (all existing 81 tests + new slice HTTP integration tests must pass).
   - Smoke-test live HTTP endpoints (`curl` / browser verification) and verify `.data/` persistence across restart.
   - Check off completed items in the **Progress Tracker** table above.
