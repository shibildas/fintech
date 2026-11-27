import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 4 — RBI Mandates (AutoPay & e-NACH), Subscriptions & Fake Clock Product UI.
 */
export function renderMandatesUiHtml(): string {
  return renderFintechShellHtml({
    title: "RBI Mandates & Billing",
    subtitle: "Fake Clock • UMRN & Cap Re-Auth • 24h Pre-Debit Gate • Dunning & Invoices",
    activePort: 3004,
    tabs: [
      { id: "mandates", label: "Mandates & Clock" },
      { id: "subs", label: "Subscriptions & Pre-Debit" },
      { id: "dunning", label: "Dunning & Pay-Now" },
      { id: "invoices", label: "e-NACH & Tax Invoices" },
    ],
    loginAccounts: [
      { username: "billing.user", role: "user", label: "Billing User (View & Auth)" },
      { username: "billing.admin", role: "admin", label: "Billing Admin (Fake Clock)" },
    ],
    bodyHtml: `
      <div class="card" style="margin-bottom:18px;">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div><h3>Time Machine (Persisted Fake Clock)</h3><span id="clockBadge" class="badge neutral">Loading clock...</span></div>
          <div class="row" style="margin:0;">
            <button class="secondary" onclick="refreshClock(this)">Refresh</button>
            <button class="secondary" onclick="advanceClock(this, { hours: 10 })">+10h</button>
            <button onclick="advanceClock(this, { hours: 24 })">+24h (Pre-Debit)</button>
            <button class="secondary" onclick="advanceClock(this, { days: 1 })">+1d</button>
            <button class="secondary" onclick="advanceClock(this, { days: 3 })">+3d</button>
            <button class="secondary" onclick="advanceClock(this, { days: 7 })">+7d</button>
            <button class="secondary" onclick="advanceClock(this, { setIso: '2026-01-31T04:30:00.000Z' })">Reset Jan 31</button>
          </div>
        </div>
      </div>

      <section id="view-mandates" class="view-pane">
        <div class="card">
          <h3>RBI Mandate Authorization &amp; Cap Re-Auth</h3>
          <p class="hint">Authorize UPI AutoPay (PIN 1234) or e-NACH (OTP 654321) to mint a UMRN. Cap increases require re-auth.</p>
          <div class="row">
            <label>Rail<select id="mRail"><option value="UPI_AUTOPAY">UPI_AUTOPAY</option><option value="E_NACH">E_NACH</option></select></label>
            <label>Auth PIN / OTP<input id="mCred" type="password" placeholder="Enter PIN or OTP" /></label>
          </div>
          <div class="row">
            <button onclick="createAndAuthMandate(this)">Create &amp; Authorize</button>
            <button class="secondary" onclick="increaseCap(this)">Increase Cap</button>
            <button onclick="confirmCapReauth(this)">Confirm Cap Re-Auth</button>
            <button class="danger" onclick="revokeMandate(this)">Revoke Mandate</button>
            <button class="secondary" onclick="loadSavedState(this)">Refresh List</button>
          </div>
          <div class="table-wrap" style="margin-top:14px;">
            <table>
              <thead><tr><th>Mandate ID</th><th>Rail</th><th>UMRN</th><th>Max Debit</th><th>State</th></tr></thead>
              <tbody id="mandateTableBody"><tr><td colspan="5" style="color:var(--muted);">Loading mandates...</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="view-subs" class="view-pane hidden">
        <div class="card">
          <h3>Subscriptions (Jan 31 → Feb 28 → Mar 31) &amp; 24h Pre-Debit Gate</h3>
          <p class="hint">Try Execute Cycle before advancing the Fake Clock by +24h to observe the RBI 403 Pre-Debit Gate.</p>
          <div class="row">
            <button onclick="createSub(this)">Create &amp; Activate Sub</button>
            <button class="secondary" onclick="advanceAnchor(this)">Next Anchor Month</button>
            <button onclick="sendPreDebit(this)">1. Send 24h Pre-Debit Notice</button>
            <button class="secondary" onclick="execCycle(this)">2. Execute Cycle</button>
          </div>
          <div class="table-wrap" style="margin-top:14px;">
            <table>
              <thead><tr><th>Subscription ID</th><th>Anchor Day</th><th>Next Billing (UTC)</th><th>State</th></tr></thead>
              <tbody id="subTableBody"><tr><td colspan="4" style="color:var(--muted);">Loading subscriptions...</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="view-dunning" class="view-pane hidden">
        <div class="card">
          <h3>Dunning (Day 1 / 3 / 7 Retries) &amp; Pay-Now Recovery</h3>
          <p class="hint">Soft failure transitions subscription to PAST_DUE with a Pay-Now Card recovery link.</p>
          <div class="row">
            <button class="danger" onclick="triggerSoftFail(this)">Simulate 51_INSUFFICIENT_FUNDS</button>
            <button class="secondary" onclick="processDueRetries(this)">Process Due Retries</button>
            <button onclick="payNowRecover(this)">Pay-Now Recovery (Card)</button>
          </div>
        </div>
      </section>

      <section id="view-invoices" class="view-pane hidden">
        <div class="card">
          <h3>e-NACH Batch Presentment, Printable Tax Invoice &amp; MRR Parity</h3>
          <p class="hint">Detects dropped bank records in e-NACH response CSVs and guarantees MRR equals paid invoices.</p>
          <div class="row">
            <button onclick="runEnachSample(this)">Run e-NACH Batch (1 Dropped Row)</button>
            <button class="secondary" onclick="createPaidInvoice(this)">Issue &amp; Pay Tax Invoice</button>
            <button class="secondary" onclick="checkMrrParity(this)">Check MRR Parity</button>
          </div>
          <pre id="printableBox" class="out" style="margin-top:14px;">Click "Issue & Pay Tax Invoice" to preview a printable GST receipt.</pre>
        </div>
      </section>`,
    scriptJs: `
      let p4State = { mandateId: "", umrn: "", subId: "", dunningCaseId: "" };
      window.onAppAuthenticated = () => { refreshClock(null); loadSavedState(null); };
      function updateClockBadge(data) {
        const el = document.getElementById("clockBadge");
        if (el) { el.className = "badge ok"; el.textContent = "IST: " + data.ist + " | UTC: " + data.utc; }
      }
      async function refreshClock(btn) {
        return runAction(btn, null, "Refreshing clock", async () => {
          const r = await fetch("/api/clock");
          const data = await r.json();
          if (r.ok) updateClockBadge(data);
          return { status: r.status, body: data, toastLabel: "Fake Clock" };
        });
      }
      async function advanceClock(btn, body) {
        return runAction(btn, null, "Advancing clock", async () => {
          const r = await fetch("/api/clock/advance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const data = await r.json();
          if (r.ok) updateClockBadge(data);
          return { status: r.status, body: data, toastLabel: "Clock Advance" };
        });
      }
      async function loadSavedState(btn) {
        const res = await runAction(btn, null, "Loading records", async () => {
          const [mr, sr] = await Promise.all([fetch("/api/mandates"), fetch("/api/subscriptions")]);
          return { status: mr.ok ? 200 : mr.status, body: { mandates: (await mr.json()).mandates || [], subscriptions: (await sr.json()).subscriptions || [] }, toastLabel: "Mandates & Subs" };
        });
        if (res && res.status === 200) {
          const mList = res.body.mandates;
          const sList = res.body.subscriptions;
          if (mList[0]) { p4State.mandateId = mList[0].id; p4State.umrn = mList[0].umrn || ""; }
          if (sList[0]) p4State.subId = sList[0].id;
          document.getElementById("mandateTableBody").innerHTML = mList.length
            ? mList.slice(0, 10).map(m => '<tr><td class="mono">' + esc(m.id) + '</td><td>' + esc(m.rail) + '</td><td class="mono">' + esc(m.umrn || "-") + '</td><td>' + formatInr(m.max_amount_paise) + '</td><td><span class="badge ' + (m.state === "ACTIVE" ? "ok" : m.state === "PENDING_REAUTH" ? "warn" : "err") + '">' + esc(m.state) + '</span></td></tr>').join("")
            : '<tr><td colspan="5" style="color:var(--muted);">No mandates yet. Create &amp; authorize one above.</td></tr>';
          document.getElementById("subTableBody").innerHTML = sList.length
            ? sList.slice(0, 10).map(s => '<tr><td class="mono">' + esc(s.id) + '</td><td>Day ' + esc(s.anchor_day) + '</td><td class="mono">' + esc(s.next_billing_at) + '</td><td><span class="badge ' + (s.state === "ACTIVE" ? "ok" : s.state === "PAST_DUE" ? "warn" : "err") + '">' + esc(s.state) + '</span></td></tr>').join("")
            : '<tr><td colspan="4" style="color:var(--muted);">No subscriptions yet.</td></tr>';
        }
      }
      async function createAndAuthMandate(btn) {
        if (!validateFields([{ id: "mCred", check: V.pin }])) return;
        const cred = document.getElementById("mCred").value.trim();
        const res = await runAction(btn, null, "Authorizing", async () => {
          const m1 = await fetch("/api/mandates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rail: document.getElementById("mRail").value }) });
          const mData = await m1.json();
          if (!m1.ok) return { status: m1.status, body: mData, toastLabel: "Create Mandate" };
          p4State.mandateId = mData.id;
          const m2 = await fetch("/api/mandates/" + encodeURIComponent(mData.id) + "/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authCredential: cred }) });
          const aData = await m2.json();
          if (aData.umrn) p4State.umrn = aData.umrn;
          return { status: m2.status, body: aData, toastLabel: "Authorize Mandate" };
        });
        if (res && res.status === 200) loadSavedState(null);
      }
      async function increaseCap(btn) {
        if (!p4State.mandateId) { toast("Create a mandate first", "err"); return; }
        const res = await runAction(btn, null, "Requesting cap", async () => {
          const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/cap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newMaxAmountPaise: 200000, newMonthlyAggregateCapPaise: 400000 }) });
          return { status: r.status, body: await r.json(), toastLabel: "Cap Increase" };
        });
        if (res && res.status === 200) loadSavedState(null);
      }
      async function confirmCapReauth(btn) {
        const cred = document.getElementById("mCred").value.trim();
        if (!p4State.mandateId || !cred) { toast("Enter PIN/OTP and mandate first", "err"); return; }
        const res = await runAction(btn, null, "Confirming re-auth", async () => {
          const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/reauth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authCredential: cred }) });
          return { status: r.status, body: await r.json(), toastLabel: "Cap Re-Auth" };
        });
        if (res && res.status === 200) loadSavedState(null);
      }
      async function revokeMandate(btn) {
        if (!p4State.mandateId) { toast("Create a mandate first", "err"); return; }
        const res = await runAction(btn, null, "Revoking", async () => {
          const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Revoke Mandate" };
        });
        if (res && res.status === 200) loadSavedState(null);
      }
      async function createSub(btn) {
        if (!p4State.mandateId) { toast("Authorize a mandate first", "err"); return; }
        const res = await runAction(btn, null, "Creating sub", async () => {
          const pr = await fetch("/api/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Pro Monthly", amountPaise: 49900 }) });
          const plan = await pr.json();
          if (!pr.ok) return { status: pr.status, body: plan, toastLabel: "Create Plan" };
          const sr = await fetch("/api/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, mandateId: p4State.mandateId, anchorDay: 31, startYear: 2026, startMonth1Based: 1 }) });
          const sub = await sr.json();
          if (sub.id) p4State.subId = sub.id;
          return { status: sr.status, body: sub, toastLabel: "Subscription" };
        });
        if (res && res.status === 201) loadSavedState(null);
      }
      async function advanceAnchor(btn) {
        if (!p4State.subId) { toast("Create a subscription first", "err"); return; }
        const res = await runAction(btn, null, "Advancing anchor", async () => {
          const r = await fetch("/api/subscriptions/" + encodeURIComponent(p4State.subId) + "/advance-anchor", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Anchor Advance" };
        });
        if (res && res.status === 200) loadSavedState(null);
      }
      async function sendPreDebit(btn) {
        if (!p4State.subId) { toast("Create a subscription first", "err"); return; }
        return runAction(btn, null, "Sending pre-debit", async () => {
          const r = await fetch("/api/cycles/pre-debit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
          return { status: r.status, body: await r.json(), toastLabel: "Pre-Debit Notice" };
        });
      }
      async function execCycle(btn) {
        if (!p4State.subId) { toast("Create a subscription first", "err"); return; }
        return runAction(btn, null, "Executing cycle", async () => {
          const r = await fetch("/api/cycles/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
          return { status: r.status, body: await r.json(), toastLabel: "Cycle Execute" };
        });
      }
      async function triggerSoftFail(btn) {
        if (!p4State.subId) { toast("Create a subscription first", "err"); return; }
        const res = await runAction(btn, null, "Simulating failure", async () => {
          const r = await fetch("/api/dunning/fail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptionId: p4State.subId, executionKey: p4State.subId + ":cycle:" + Date.now(), amountPaise: 49900, failureCode: "51_INSUFFICIENT_FUNDS" }) });
          const data = await r.json();
          if (data.dunningCase?.id) p4State.dunningCaseId = data.dunningCase.id;
          return { status: r.status, body: data, toastLabel: "Dunning Soft Fail" };
        });
        if (res && res.status === 200) loadSavedState(null);
      }
      async function processDueRetries(btn) {
        return runAction(btn, null, "Processing retries", async () => {
          const r = await fetch("/api/dunning/process-due", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ simulateSuccess: false }) });
          return { status: r.status, body: await r.json(), toastLabel: "Process Retries" };
        });
      }
      async function payNowRecover(btn) {
        if (!p4State.dunningCaseId) { toast("Trigger a soft failure first", "err"); return; }
        const res = await runAction(btn, null, "Recovering", async () => {
          const r = await fetch("/api/dunning/" + encodeURIComponent(p4State.dunningCaseId) + "/pay-now", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardNumber: "4242424242424242", expiry: "12/29" }) });
          return { status: r.status, body: await r.json(), toastLabel: "Pay-Now Recovery" };
        });
        if (res && res.status === 200) loadSavedState(null);
      }
      async function runEnachSample(btn) {
        return runAction(btn, null, "Running e-NACH", async () => {
          const r = await fetch("/api/enach/run-sample", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "e-NACH Batch" };
        });
      }
      async function createPaidInvoice(btn) {
        const res = await runAction(btn, "printableBox", "Generating invoice", async () => {
          const r = await fetch("/api/invoices/demo-paid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptionId: p4State.subId || "sub_demo", umrn: p4State.umrn || "UMRNBANKA000001", amountPaise: 49900 }) });
          const data = await r.json();
          return { status: r.status, display: r.ok ? data.printable + "\\n\\nMRR Parity: " + JSON.stringify(data.mrrParity) : data, body: data, toastLabel: "Tax Invoice" };
        });
        return res;
      }
      async function checkMrrParity(btn) {
        return runAction(btn, "printableBox", "Checking MRR", async () => {
          const r = await fetch("/api/invoices/mrr-parity");
          return { status: r.status, body: await r.json(), toastLabel: "MRR Parity" };
        });
      }
    `,
  });
}
