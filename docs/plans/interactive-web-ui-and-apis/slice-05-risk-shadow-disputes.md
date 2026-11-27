# Slice 05 — Consumer App Ops (`:3003`): `<100ms` Risk Engine, Shadow Mode Diff & Dispute Desk

**Back to:** [Overall Plan](PLAN.md)

## 1. Vertical Feature Scope
Extend `ConsumerHttpServer` (`:3003`) with the **Risk & Ops Console** workflows: live `<100ms p95` payment risk scoring with fired-rule breakdown, Timeout Fallback toggle, Shadow Mode 100-Payment Diff Runner + `SHADOW -> ACTIVE` promotion, and Switch-linked Dispute Desk with `0420` reversal auto-resolution and printable NPCI Escalated Case Files.

## 2. Model & Persistent DB Layer (`.data/`)
- `.data/p3-risk.sqlite` (`RealTimeRiskEngine` `risk_decisions` + `VersionedShadowRiskEngine` `risk_feature_snapshots`, `shadow_comparisons`)
- `.data/p3-disputes.sqlite` (`ConsumerDisputeDesk` `disputes`, `inbox_notifications`)

## 3. API & Security Layer (Added to `projects/project3-consumer-app/src/consumer-server.ts`)
- **Strict Manual Ops Auth**: Requires `X-Ops-Token` (printed to server stdout on startup, e.g. `p3_dev_ops_token_2026`; missing/invalid returns `HTTP 401`).
- **Endpoints**:
  - `POST /api/risk/score` -> Scores a payment input against all 7+ starter rules, returns `{ decision, total_score, step_up_method, fired_rules, latency_ms, fallback_used }`.
  - `POST /api/risk/blacklist` -> Adds a VPA or device to the live blacklist.
  - `PUT /api/risk/timeout-fallback` -> Toggles `risk.simulateTimeoutFallback` to demo deterministic fallback (`ALLOW <= ₹2,000`, `STEP_UP > ₹2,000`).
  - `POST /api/risk/shadow/run-100` -> Evaluates 100 mixed payments against `ACTIVE (v1.0)` and `SHADOW (v2.0-strict)` AST rulesets and returns the `ShadowDiffReport` (`agreementRatePercent`, `ALLOW->STEP_UP`, etc.).
  - `POST /api/risk/shadow/promote` -> Promotes `v2.0-strict` from `SHADOW` to `ACTIVE`.
  - `POST /api/disputes` -> Opens a customer dispute linked to a `switch_rrn` (assigns 24h/72h/120h SLA).
  - `POST /api/disputes/switch-reversal` -> Simulates Project 1 Switch `0420` reversal landing -> auto-resolves matching disputes to `RESOLVED_CREDITED` and writes customer inbox notification.
  - `POST /api/disputes/:id/escalate` & `GET /api/disputes/:id/case-file` -> Escalates and returns downloadable Markdown Case File.

## 4. Interactive Web UI (Tabs 2 & 3 on `GET /` at `:3003`)
- **Tab 2 — Real-Time Risk & Shadow Mode**: Manual `X-Ops-Token` input; live payment scorer showing badge (`ALLOW` green / `STEP_UP` amber / `DECLINE` red), `latency_ms`, and fired rules list; 1-click **Run 100-Payment Shadow Diff** rendering the transition matrix + **Promote Shadow to Active** button.
- **Tab 3 — Dispute Desk & SLA Monitor**: Open a dispute by RRN, simulate a Switch `0420` reversal to watch instant `RESOLVED_CREDITED` + Inbox notification, or escalate to view/copy the NPCI Case File.

## 5. Tests & Integration
- **Test File**: `projects/project3-consumer-app/test/slice05-risk-disputes-http.test.ts`
  - Verifies missing `X-Ops-Token` returns `401`, blacklist hit returns `DECLINE`, timeout fallback splits small vs large, `POST /api/risk/shadow/run-100` returns exact 100-payment diff report, and Switch reversal auto-resolves open dispute + populates inbox.
