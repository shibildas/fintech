# About This Project & Author

## About the Repository
**`fintech-infrastructure-stack`** is an end-to-end engineering build of core payments and financial infrastructure systems, modeled after real-world production architectures (NPCI UPI, ISO 8583 switches, Razorpay/Stripe/Juspay gateways, and real-time fraud/risk engines).

Rather than building thin CRUD wrappers around third-party APIs, every component is implemented from first principles with strict financial invariants:

- **Exact Money Math**: All amounts are stored and settled in integer `paise` — never IEEE-754 floats.
- **Append-Only Double-Entry Accounting**: Every movement of funds is recorded as balanced `DEBIT`/`CREDIT` postings summing to `0`, with derived balances and holds.
- **Distributed Failure Honesty**: Explicit state machines, `SingleFlight` request coalescing, `CHK` status probes on unknown outcomes, `0420` auto-reversals, Deemed-Approved conflict detection, and crash recovery.
- **Security & Isolation**: HMAC-SHA256 service-to-service signing with replay windows and key rotation overlap, asymmetric Ed25519 device-bound signing, and isolated AES-256-GCM PCI-DSS tokenization verified by automated grep checks.
- **Applied Fintech DSA**: Production data structures and algorithms embedded directly into the payment paths (TTL-LRU caches, BIN/IFSC routing tries, Dijkstra corridor routing, multilateral netting, 3-way sorted merge-join reconciliation, token-bucket rate limiters, sliding-window distinct counters, two-heaps streaming medians, and safe AST rule evaluation).

---

## Engineering Stack
- **Runtime**: Node.js 24 (native TypeScript execution, `node:sqlite`, `node:crypto`, `node:test`)
- **Architecture**: npm workspaces monorepo (`@fintech/core`, `@fintech/project1-switch`, `@fintech/project2-gateway`, `@fintech/project3-consumer-app`)
- **CI**: GitHub Actions (`.github/workflows/test.yml`) running full automated verification on `main`

---

## Author
Built by **Shibil Das** as part of a 30-day deep-systems build focused on high-reliability payments infrastructure, distributed systems, and backend engineering.
