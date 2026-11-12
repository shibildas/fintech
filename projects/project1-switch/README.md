# Project 1 — UPI-Style Central Switch, Bank Cores, T+1 Settlement & Three-Way Reconciliation

## What This Proves
This system implements the central payment switch sitting between Payment Service Providers (`PSP1`, `PSP2`) and Bank Cores (`BANKA`, `BANKB`, `BANKC`). It demonstrates:
- **ISO 8583-modelled message routing** (`MTI 0200/0210` financial pay, `0420/0430` reversal, `0100/0110` balance & status check `CHK`) with `STAN`, 12-digit Switch-minted `RRN`, and service-to-service HMAC-SHA256 signing (`<5m` replay window).
- **Exactly-once debit** under concurrent duplicate bursts (`SingleFlightIdempotencyCache` + SQLite `rrn_operations` & `BEGIN IMMEDIATE` atomic double-entry ledger transactions in integer `paise`).
- **Honest distributed failure handling**: Remitter timeout $\rightarrow$ `DEBIT_UNKNOWN` $\rightarrow$ `CHK` status probe; Beneficiary failure $\rightarrow$ `CREDIT_PENDING` retry schedule $\rightarrow$ `MTI 0420` auto-reversal; late `0210 ("00")` after reversal $\rightarrow$ **Deemed-Approved** conflict detection; mid-flight crash recovery on startup.
- **T+1 Multilateral Net Settlement**: Generates immutable, versioned per-bank summary CSVs, RRN detail CSVs, and a cycle manifest whose net positions sum to `0` across all banks and whose `TRL` trailer lines carry row counts and SHA-256 body hashes.
- **Three-Way Reconciliation & Exception Resolution**: Matches Switch Log vs. Remitter EOD Report vs. Beneficiary EOD Report across all 6 classification classes (`MATCHED`, `MISSING_AT_REMITTER`, `MISSING_AT_BENEFICIARY`, `MISSING_AT_SWITCH`, `AMOUNT_MISMATCH`, `STATUS_MISMATCH`) and posts double-entry compensating entries carrying `exception_id`.

---

## Architecture Diagram

```mermaid
flowchart TD
    Client["Test Client / Burst Generator"] --> PSP1["Payer PSP (PSP1)<br/>VPA Directory (@psp1)"]
    PSP2["Payee PSP (PSP2)<br/>VPA Directory (@psp2)"]
    Admin["Web Admin Console<br/>(RBAC: operator / admin)"]

    subgraph SwitchCore["Central UPI Switch"]
        Router["6-Hop ISO 8583 Router<br/>+ State Machine + SingleFlight"]
        Settle["T+1 Net Settlement Engine<br/>(Immutable CSVs + SHA-256 Trailer)"]
        Recon["3-Way Reconciliation Engine<br/>(6 Exception Classes + Resolution Queue)"]
    end

    subgraph Banks["Bank Core Simulators (Same Code, 3 Configs)"]
        BA["BANKA (Remitter)<br/>Double-Entry Ledger + PIN + Chaos"]
        BB["BANKB<br/>Double-Entry Ledger + PIN + Chaos"]
        BC["BANKC (Beneficiary)<br/>Double-Entry Ledger + PIN + Chaos"]
    end

    PSP1 -->|1. POST /pay (MTI 0200)| Router
    Router -->|GET /vpa/anita@psp1| PSP1
    Router -->|GET /vpa/shop@psp2| PSP2
    Router -->|2. POST /debit, /check, /reversal| BA
    Router -->|4. POST /credit| BC
    Admin -->|Chaos / Settlement / Recon| SwitchCore
    BA -->|Independent EOD Report| Recon
    BB -->|Independent EOD Report| Recon
    BC -->|Independent EOD Report| Recon
```

---

## ISO 8583 Message Specification

| Field | Meaning | Example |
| :--- | :--- | :--- |
| `mti` | `0200` financial req, `0210` financial resp, `0420` reversal req, `0430` reversal resp, `0100` enquiry, `0110` enquiry resp | `"0200"` |
| `transaction_id` | Globally unique idempotency key minted by originating PSP | `"TXN-2026110700001"` |
| `stan` | System trace audit number (6 digits, unique per sender per day) | `"004512"` |
| `rrn` | Retrieval reference number (12 digits `YDDDHHSSSSSS`, minted by Switch) | `"631110004512"` |
| `processing_code` | Operation (`PAY`, `BAL`, `CHK`, `REV`) | `"PAY"` |
| `amount` | Integer paise (never floating-point) | `150000` (`= ₹1,500.00`) |
| `currency` | ISO 4217 numeric code for INR | `"356"` |
| `transmission_time` | ISO 8601 timestamp with timezone | `"2026-11-07T10:15:30.000Z"` |
| `payer_vpa`, `payee_vpa` | VPA handles | `"anita@psp1"`, `"shop@psp2"` |
| `payer_psp_id`, `payee_psp_id` | Resolved from VPA suffix | `"PSP1"`, `"PSP2"` |
| `remitter_bank_id`, `beneficiary_bank_id` | Resolved from PSP VPA directory | `"BANKA"`, `"BANKC"` |
| `account_reference` | Masked to last 4 digits outside bank core (Rule 10) | `"XXXX4521"` |
| `response_code` | `00` approved, `51` insufficient funds, `91` bank down, `68` timeout, `12` invalid txn, `14` invalid VPA, `55` wrong PIN, `61` limit exceeded | `"00"` |
| `signature` | `HMAC-SHA256(timestamp + "." + body, shared_secret)` | `"a94f..."` |

---

## Transaction State Diagram

```mermaid
stateDiagram-v2
    [*] --> RECEIVED
    RECEIVED --> DEBIT_REQUESTED
    DEBIT_REQUESTED --> DEBITED : 0210 ("00")
    DEBIT_REQUESTED --> FAILED : Decline (51 / 55 / 61 / 14)
    DEBIT_REQUESTED --> DEBIT_UNKNOWN : Remitter Timeout
    DEBIT_UNKNOWN --> DEBITED : CHK 0110 ("00")
    DEBIT_UNKNOWN --> FAILED : CHK Not Found ("68")
    DEBITED --> CREDIT_REQUESTED
    CREDIT_REQUESTED --> SUCCESS : 0210 ("00")
    CREDIT_REQUESTED --> CREDIT_PENDING : Beneficiary Down ("91")
    CREDIT_PENDING --> SUCCESS : Retry Succeeds ("00")
    CREDIT_PENDING --> REVERSAL_REQUESTED : Retries Exhausted -> MTI 0420
    REVERSAL_REQUESTED --> REVERSED : 0430 ("00")
```

---

## Load Test Benchmark (Laptop — Node.js v24 + SQLite Double-Entry Ledger across 3 Banks)

| Metric | Target Requirement | Achieved Result |
| :--- | :--- | :--- |
| **Sustained Throughput** | $\ge 100\text{ TPS}$ end-to-end across 3 banks | **`1,270 TPS`** |
| **p95 End-to-End Latency** | $< 1,000\text{ ms}$ (no injected latency) | **`1.05 ms`** |
| **Settlement Net Position Sum** | `0 paise` across `BANKA`, `BANKB`, `BANKC` | **`0 paise` (100% verified)** |

---

## How to Run Tests & Verify All 10 Acceptance Scenarios
```bash
npm test
```
Sample settlement CSVs and the reconciliation JSON report are checked into [`projects/project1-switch/samples/`](./samples/).
