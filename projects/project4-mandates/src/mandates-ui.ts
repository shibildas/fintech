import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 4 — RBI Mandates (AutoPay & e-NACH), Subscriptions & Fake Clock HTML/JS UI.
 */
export function renderMandatesUiHtml(): string {
  return renderFintechShellHtml({
    title: "Project 4 — RBI Mandates (AutoPay & e-NACH), Subscriptions & Fake Clock",
    subtitle:
      "Persisted Injectable Fake Clock • UMRN & Cap Re-Auth • 24h Pre-Debit Gate • Dunning & Pay-Now",
    activePort: 3004,
    bodyHtml: `
      <div class="auth-bar">
        <label>X-Merchant-Token (see server stdout)<input id="p4Token" type="password" placeholder="Paste X-Merchant-Token" /></label>
        <button onclick="refreshClock()">Refresh Clock</button>
        <button class="secondary" onclick="loadSavedState()">Load Saved State</button>
        <button onclick="advanceClock({ hours: 10 })">+10h</button>
        <button onclick="advanceClock({ hours: 24 })">+24h (Pre-Debit)</button>
        <button class="secondary" onclick="advanceClock({ days: 1 })">+1d</button>
        <button class="secondary" onclick="advanceClock({ days: 3 })">+3d</button>
        <button class="secondary" onclick="advanceClock({ days: 7 })">+7d</button>
        <button class="secondary" onclick="advanceClock({ setIso: '2026-01-31T04:30:00.000Z' })">Reset Jan 31</button>
        <span id="clockBadge" class="badge ok">Clock: click Refresh Clock</span>
      </div>
      <div class="grid">
        <div class="card">
          <h2>1. RBI Mandate UMRN & Cap Re-Auth</h2>
          <div class="row">
            <label>Rail<select id="mRail"><option value="UPI_AUTOPAY">UPI_AUTOPAY</option><option value="E_NACH">E_NACH</option></select></label>
            <label>Auth PIN / OTP<input id="mCred" type="password" placeholder="Enter PIN or OTP (see stdout)" /></label>
          </div>
          <div class="row">
            <button onclick="createAndAuthMandate()">Create & Authorize Mandate</button>
            <button class="secondary" onclick="increaseCap()">Request Cap Increase</button>
            <button onclick="confirmCapReauth()">Confirm Cap Re-Auth</button>
            <button class="danger" onclick="revokeMandate()">Revoke Mandate</button>
          </div>
          <pre id="mOut" class="out">Enter X-Merchant-Token above, then authorize a mandate to mint UMRN...</pre>
        </div>
        <div class="card">
          <h2>2. Subscription (Jan 31 -> Feb 28 -> Mar 31) & 24h Pre-Debit Gate</h2>
          <div class="row">
            <button onclick="createSub()">Create & Activate Sub</button>
            <button class="secondary" onclick="advanceAnchor()">Preview Next Anchor Month</button>
          </div>
          <div class="row">
            <button onclick="sendPreDebit()">1. Send 24h Pre-Debit Notice</button>
            <button class="secondary" onclick="execCycle()">2. Execute Cycle (Watch 403 -> +24h -> 200)</button>
          </div>
          <pre id="subOut" class="out">Try Execute Cycle before +24h to see the RBI 403 Pre-Debit Gate...</pre>
        </div>
        <div class="card">
          <h2>3. Dunning (Day 1/3/7) & Pay-Now Recovery</h2>
          <div class="row">
            <button class="danger" onclick="triggerSoftFail()">Simulate 51_INSUFFICIENT_FUNDS</button>
            <button class="secondary" onclick="processDueRetries()">Process Due Retries</button>
            <button onclick="payNowRecover()">Pay-Now Recovery (Card)</button>
          </div>
          <pre id="dunOut" class="out">Soft failure creates PAST_DUE + Day 1/3/7 retries + Pay-Now Order...</pre>
        </div>
        <div class="card">
          <h2>4. e-NACH Missing-Record Batch & Printable Invoice / MRR</h2>
          <div class="row">
            <button onclick="runEnachSample()">Run e-NACH Batch (1 Dropped Row)</button>
            <button class="secondary" onclick="createPaidInvoice()">Issue & Pay Tax Invoice</button>
            <button class="secondary" onclick="checkMrrParity()">MRR Parity</button>
          </div>
          <pre id="invOut" class="out">Printable Tax Invoice + MRR-to-Paid-Invoice invariant...</pre>
        </div>
      </div>`,
    scriptJs: `
      let p4State = { mandateId: "", umrn: "", subId: "", dunningCaseId: "" };
      function p4Headers() {
        return { "content-type": "application/json", "x-merchant-token": document.getElementById("p4Token").value.trim() };
      }
      function updateClockBadge(data) {
        const el = document.getElementById("clockBadge");
        if (el) el.textContent = "IST: " + data.ist + " | UTC: " + data.utc;
      }
      async function refreshClock() {
        const r = await fetch("/api/clock", { headers: p4Headers() });
        const data = await r.json();
        if (r.ok) updateClockBadge(data);
        else show("mOut", { status: r.status, body: data });
      }
      async function loadSavedState() {
        const [mr, sr] = await Promise.all([
          fetch("/api/mandates", { headers: p4Headers() }),
          fetch("/api/subscriptions", { headers: p4Headers() })
        ]);
        const mData = await mr.json();
        const sData = await sr.json();
        if (mr.ok && mData.mandates?.[0]) {
          p4State.mandateId = mData.mandates[0].id;
          p4State.umrn = mData.mandates[0].umrn || "";
        }
        if (sr.ok && sData.subscriptions?.[0]) {
          p4State.subId = sData.subscriptions[0].id;
        }
        show("mOut", { hydratedState: p4State, mandatesCount: mData.mandates?.length ?? 0, subscriptionsCount: sData.subscriptions?.length ?? 0 });
      }
      async function advanceClock(body) {
        const r = await fetch("/api/clock/advance", { method: "POST", headers: p4Headers(), body: JSON.stringify(body) });
        const data = await r.json();
        if (r.ok) updateClockBadge(data);
        else show("mOut", { status: r.status, body: data });
      }
      async function createAndAuthMandate() {
        const cred = document.getElementById("mCred").value.trim();
        if (!cred) return show("mOut", { error: "Please enter Auth PIN / OTP (see server stdout)" });
        const rail = document.getElementById("mRail").value;
        const m1 = await fetch("/api/mandates", { method: "POST", headers: p4Headers(), body: JSON.stringify({ rail }) });
        const mData = await m1.json();
        if (!m1.ok) return show("mOut", { status: m1.status, body: mData });
        p4State.mandateId = mData.id;
        const m2 = await fetch("/api/mandates/" + encodeURIComponent(mData.id) + "/authorize", {
          method: "POST",
          headers: p4Headers(),
          body: JSON.stringify({ authCredential: cred })
        });
        const aData = await m2.json();
        if (aData.umrn) p4State.umrn = aData.umrn;
        show("mOut", { status: m2.status, body: aData });
      }
      async function increaseCap() {
        if (!p4State.mandateId) return show("mOut", { error: "Create & authorize a mandate first" });
        const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/cap", {
          method: "POST",
          headers: p4Headers(),
          body: JSON.stringify({ newMaxAmountPaise: 200000, newMonthlyAggregateCapPaise: 400000 })
        });
        show("mOut", { status: r.status, body: await r.json() });
      }
      async function confirmCapReauth() {
        if (!p4State.mandateId) return show("mOut", { error: "Create & request a cap increase first" });
        const cred = document.getElementById("mCred").value.trim();
        if (!cred) return show("mOut", { error: "Please enter Auth PIN / OTP to confirm cap re-auth" });
        const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/reauth", {
          method: "POST",
          headers: p4Headers(),
          body: JSON.stringify({ authCredential: cred })
        });
        show("mOut", { status: r.status, body: await r.json() });
      }
      async function revokeMandate() {
        if (!p4State.mandateId) return show("mOut", { error: "Create a mandate first" });
        const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/revoke", { method: "POST", headers: p4Headers(), body: "{}" });
        show("mOut", { status: r.status, body: await r.json() });
      }
      async function createSub() {
        if (!p4State.mandateId) return show("subOut", { error: "Create & authorize a mandate in Card 1 first" });
        const pr = await fetch("/api/plans", { method: "POST", headers: p4Headers(), body: JSON.stringify({ name: "Pro Monthly", amountPaise: 49900 }) });
        const plan = await pr.json();
        if (!pr.ok) return show("subOut", { status: pr.status, body: plan });
        const sr = await fetch("/api/subscriptions", {
          method: "POST",
          headers: p4Headers(),
          body: JSON.stringify({ planId: plan.id, mandateId: p4State.mandateId, anchorDay: 31, startYear: 2026, startMonth1Based: 1 })
        });
        const sub = await sr.json();
        if (sub.id) p4State.subId = sub.id;
        show("subOut", { status: sr.status, body: sub });
      }
      async function advanceAnchor() {
        if (!p4State.subId) return show("subOut", { error: "Create & activate a subscription first" });
        const r = await fetch("/api/subscriptions/" + encodeURIComponent(p4State.subId) + "/advance-anchor", { method: "POST", headers: p4Headers(), body: "{}" });
        show("subOut", { status: r.status, body: await r.json() });
      }
      async function sendPreDebit() {
        if (!p4State.subId) return show("subOut", { error: "Create & activate a subscription first" });
        const r = await fetch("/api/cycles/pre-debit", { method: "POST", headers: p4Headers(), body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
        show("subOut", { status: r.status, body: await r.json() });
      }
      async function execCycle() {
        if (!p4State.subId) return show("subOut", { error: "Create & activate a subscription first" });
        const r = await fetch("/api/cycles/execute", { method: "POST", headers: p4Headers(), body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
        show("subOut", { status: r.status, body: await r.json() });
      }
      async function triggerSoftFail() {
        if (!p4State.subId) return show("dunOut", { error: "Create & activate a subscription in Card 2 first" });
        const r = await fetch("/api/dunning/fail", {
          method: "POST",
          headers: p4Headers(),
          body: JSON.stringify({ subscriptionId: p4State.subId, executionKey: p4State.subId + ":cycle:" + Date.now(), amountPaise: 49900, failureCode: "51_INSUFFICIENT_FUNDS" })
        });
        const data = await r.json();
        if (data.dunningCase?.id) p4State.dunningCaseId = data.dunningCase.id;
        show("dunOut", { status: r.status, body: data });
      }
      async function processDueRetries() {
        const r = await fetch("/api/dunning/process-due", { method: "POST", headers: p4Headers(), body: JSON.stringify({ simulateSuccess: false }) });
        show("dunOut", { status: r.status, body: await r.json() });
      }
      async function payNowRecover() {
        if (!p4State.dunningCaseId) return show("dunOut", { error: "Trigger a soft failure first to create a Pay-Now dunning case" });
        const r = await fetch("/api/dunning/" + encodeURIComponent(p4State.dunningCaseId) + "/pay-now", {
          method: "POST",
          headers: p4Headers(),
          body: JSON.stringify({ cardNumber: "4111111111114242", expiry: "12/29" })
        });
        show("dunOut", { status: r.status, body: await r.json() });
      }
      async function runEnachSample() {
        const r = await fetch("/api/enach/run-sample", { method: "POST", headers: p4Headers(), body: "{}" });
        show("invOut", { status: r.status, body: await r.json() });
      }
      async function createPaidInvoice() {
        const r = await fetch("/api/invoices/demo-paid", {
          method: "POST",
          headers: p4Headers(),
          body: JSON.stringify({ subscriptionId: p4State.subId || "sub_demo", umrn: p4State.umrn || "UMRNBANKA000001", amountPaise: 49900 })
        });
        const data = await r.json();
        show("invOut", r.ok ? data.printable + "\\n\\nMRR Parity: " + JSON.stringify(data.mrrParity) : { status: r.status, body: data });
      }
      async function checkMrrParity() {
        const r = await fetch("/api/invoices/mrr-parity", { headers: p4Headers() });
        show("invOut", { status: r.status, body: await r.json() });
      }
    `,
  });
}
