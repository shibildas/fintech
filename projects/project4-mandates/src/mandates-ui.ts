import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 4 — RBI Mandates (AutoPay & e-NACH), Subscriptions & Fake Clock HTML/JS UI.
 */
export function renderMandatesUiHtml(): string {
  return renderFintechShellHtml({
    title: "Project 4 — RBI Mandates & Subscriptions",
    subtitle: "Persisted Fake Clock • UMRN & Cap Re-Auth • 24h Pre-Debit Gate • Dunning & Invoices",
    activePort: 3004,
    bodyHtml: `
      <div class="auth-bar">
        <label>Merchant Token (see stdout)<input id="p4Token" type="password" placeholder="Paste X-Merchant-Token" /></label>
        <button onclick="refreshClock(this)">Refresh Clock</button>
        <button class="secondary" onclick="loadSavedState(this)">Load Saved State</button>
        <button class="secondary" onclick="advanceClock(this, { hours: 10 })">+10h</button>
        <button onclick="advanceClock(this, { hours: 24 })">+24h (Pre-Debit)</button>
        <button class="secondary" onclick="advanceClock(this, { days: 1 })">+1d</button>
        <button class="secondary" onclick="advanceClock(this, { days: 3 })">+3d</button>
        <button class="secondary" onclick="advanceClock(this, { days: 7 })">+7d</button>
        <button class="secondary" onclick="advanceClock(this, { setIso: '2026-01-31T04:30:00.000Z' })">Reset Jan 31</button>
        <span id="clockBadge" class="badge neutral">Clock: click Refresh Clock</span>
      </div>

      <div class="grid">
        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">1</span> RBI Mandate UMRN &amp; Cap Re-Auth</h2>
            <p class="hint">Mint UMRN via PIN/OTP, test PENDING_REAUTH on cap increases, or revoke.</p>
          </div>
          <div class="row">
            <label>Rail<select id="mRail"><option value="UPI_AUTOPAY">UPI_AUTOPAY</option><option value="E_NACH">E_NACH</option></select></label>
            <label>Auth PIN / OTP<input id="mCred" type="password" placeholder="Enter PIN or OTP (stdout)" /></label>
          </div>
          <div class="row">
            <button onclick="createAndAuthMandate(this)">Create &amp; Authorize</button>
            <button class="secondary" onclick="increaseCap(this)">Increase Cap</button>
            <button onclick="confirmCapReauth(this)">Confirm Cap Re-Auth</button>
            <button class="danger" onclick="revokeMandate(this)">Revoke</button>
          </div>
          <div class="out-wrap">
            <div id="mOutMeta" class="out-meta"></div>
            <pre id="mOut" class="out">Enter X-Merchant-Token above, then authorize a mandate.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">2</span> Subscription &amp; 24h Pre-Debit Gate</h2>
            <p class="hint">Anchor day 31 snaps Jan 31 → Feb 28 → Mar 31; debit blocked until +24h notice.</p>
          </div>
          <div class="row">
            <button onclick="createSub(this)">Create &amp; Activate Sub</button>
            <button class="secondary" onclick="advanceAnchor(this)">Next Anchor Month</button>
          </div>
          <div class="row">
            <button onclick="sendPreDebit(this)">1. Send 24h Pre-Debit</button>
            <button class="secondary" onclick="execCycle(this)">2. Execute Cycle</button>
          </div>
          <div class="out-wrap">
            <div id="subOutMeta" class="out-meta"></div>
            <pre id="subOut" class="out">Try Execute Cycle before +24h to observe the RBI 403 gate.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">3</span> Dunning (Day 1/3/7) &amp; Pay-Now Recovery</h2>
            <p class="hint">Soft failure transitions to PAST_DUE with Pay-Now card checkout recovery.</p>
          </div>
          <div class="row">
            <button class="danger" onclick="triggerSoftFail(this)">Simulate 51_INSUFFICIENT_FUNDS</button>
            <button class="secondary" onclick="processDueRetries(this)">Process Retries</button>
            <button onclick="payNowRecover(this)">Pay-Now Recovery</button>
          </div>
          <div class="out-wrap">
            <div id="dunOutMeta" class="out-meta"></div>
            <pre id="dunOut" class="out">Dunning schedule and Pay-Now recovery status.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">4</span> e-NACH Batch &amp; Tax Invoice / MRR</h2>
            <p class="hint">Detects dropped bank rows and verifies MRR-to-Paid-Invoice parity.</p>
          </div>
          <div class="row">
            <button onclick="runEnachSample(this)">Run e-NACH Batch</button>
            <button class="secondary" onclick="createPaidInvoice(this)">Issue &amp; Pay Invoice</button>
            <button class="secondary" onclick="checkMrrParity(this)">MRR Parity</button>
          </div>
          <div class="out-wrap">
            <div id="invOutMeta" class="out-meta"></div>
            <pre id="invOut" class="out">Printable tax invoice &amp; MRR parity output.</pre>
          </div>
        </div>
      </div>`,
    scriptJs: `
      let p4State = { mandateId: "", umrn: "", subId: "", dunningCaseId: "" };
      function p4Headers() {
        return { "content-type": "application/json", "x-merchant-token": document.getElementById("p4Token").value.trim() };
      }
      function updateClockBadge(data) {
        const el = document.getElementById("clockBadge");
        if (el) {
          el.className = "badge ok";
          el.textContent = "IST: " + data.ist + " | UTC: " + data.utc;
        }
      }
      async function refreshClock(btn) {
        return runAction(btn, "mOut", "Refreshing clock", async () => {
          const r = await fetch("/api/clock", { headers: p4Headers() });
          const data = await r.json();
          if (r.ok) updateClockBadge(data);
          return { status: r.status, body: data, toastLabel: "Fake Clock" };
        });
      }
      async function loadSavedState(btn) {
        return runAction(btn, "mOut", "Hydrating state", async () => {
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
          if (sr.ok && sData.subscriptions?.[0]) p4State.subId = sData.subscriptions[0].id;
          return {
            status: mr.ok ? 200 : mr.status,
            display: { hydratedState: p4State, mandatesCount: mData.mandates?.length ?? 0, subscriptionsCount: sData.subscriptions?.length ?? 0 },
            toastLabel: "Saved State"
          };
        });
      }
      async function advanceClock(btn, body) {
        return runAction(btn, "mOut", "Advancing clock", async () => {
          const r = await fetch("/api/clock/advance", { method: "POST", headers: p4Headers(), body: JSON.stringify(body) });
          const data = await r.json();
          if (r.ok) updateClockBadge(data);
          return { status: r.status, body: data, toastLabel: "Clock Advance" };
        });
      }
      async function createAndAuthMandate(btn) {
        const cred = document.getElementById("mCred").value.trim();
        if (!cred) {
          toast("Enter Auth PIN / OTP first", "err");
          return show("mOut", { error: "Please enter Auth PIN / OTP (see server stdout)" }, { status: 400 });
        }
        return runAction(btn, "mOut", "Authorizing mandate", async () => {
          const rail = document.getElementById("mRail").value;
          const m1 = await fetch("/api/mandates", { method: "POST", headers: p4Headers(), body: JSON.stringify({ rail }) });
          const mData = await m1.json();
          if (!m1.ok) return { status: m1.status, body: mData, toastLabel: "Create Mandate" };
          p4State.mandateId = mData.id;
          const m2 = await fetch("/api/mandates/" + encodeURIComponent(mData.id) + "/authorize", {
            method: "POST", headers: p4Headers(), body: JSON.stringify({ authCredential: cred })
          });
          const aData = await m2.json();
          if (aData.umrn) p4State.umrn = aData.umrn;
          return { status: m2.status, body: aData, toastLabel: "Authorize Mandate" };
        });
      }
      async function increaseCap(btn) {
        if (!p4State.mandateId) return show("mOut", { error: "Create & authorize a mandate first" }, { status: 400 });
        return runAction(btn, "mOut", "Requesting cap", async () => {
          const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/cap", {
            method: "POST", headers: p4Headers(), body: JSON.stringify({ newMaxAmountPaise: 200000, newMonthlyAggregateCapPaise: 400000 })
          });
          return { status: r.status, body: await r.json(), toastLabel: "Cap Increase" };
        });
      }
      async function confirmCapReauth(btn) {
        if (!p4State.mandateId) return show("mOut", { error: "Request a cap increase first" }, { status: 400 });
        const cred = document.getElementById("mCred").value.trim();
        if (!cred) return show("mOut", { error: "Enter Auth PIN / OTP to confirm cap re-auth" }, { status: 400 });
        return runAction(btn, "mOut", "Confirming re-auth", async () => {
          const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/reauth", {
            method: "POST", headers: p4Headers(), body: JSON.stringify({ authCredential: cred })
          });
          return { status: r.status, body: await r.json(), toastLabel: "Cap Re-Auth" };
        });
      }
      async function revokeMandate(btn) {
        if (!p4State.mandateId) return show("mOut", { error: "Create a mandate first" }, { status: 400 });
        return runAction(btn, "mOut", "Revoking mandate", async () => {
          const r = await fetch("/api/mandates/" + encodeURIComponent(p4State.mandateId) + "/revoke", { method: "POST", headers: p4Headers(), body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Revoke Mandate" };
        });
      }
      async function createSub(btn) {
        if (!p4State.mandateId) return show("subOut", { error: "Create & authorize a mandate in Step 1 first" }, { status: 400 });
        return runAction(btn, "subOut", "Creating subscription", async () => {
          const pr = await fetch("/api/plans", { method: "POST", headers: p4Headers(), body: JSON.stringify({ name: "Pro Monthly", amountPaise: 49900 }) });
          const plan = await pr.json();
          if (!pr.ok) return { status: pr.status, body: plan, toastLabel: "Create Plan" };
          const sr = await fetch("/api/subscriptions", {
            method: "POST", headers: p4Headers(),
            body: JSON.stringify({ planId: plan.id, mandateId: p4State.mandateId, anchorDay: 31, startYear: 2026, startMonth1Based: 1 })
          });
          const sub = await sr.json();
          if (sub.id) p4State.subId = sub.id;
          return { status: sr.status, body: sub, toastLabel: "Subscription" };
        });
      }
      async function advanceAnchor(btn) {
        if (!p4State.subId) return show("subOut", { error: "Create a subscription first" }, { status: 400 });
        return runAction(btn, "subOut", "Advancing anchor", async () => {
          const r = await fetch("/api/subscriptions/" + encodeURIComponent(p4State.subId) + "/advance-anchor", { method: "POST", headers: p4Headers(), body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Anchor Advance" };
        });
      }
      async function sendPreDebit(btn) {
        if (!p4State.subId) return show("subOut", { error: "Create a subscription first" }, { status: 400 });
        return runAction(btn, "subOut", "Sending pre-debit", async () => {
          const r = await fetch("/api/cycles/pre-debit", { method: "POST", headers: p4Headers(), body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
          return { status: r.status, body: await r.json(), toastLabel: "Pre-Debit Notice" };
        });
      }
      async function execCycle(btn) {
        if (!p4State.subId) return show("subOut", { error: "Create a subscription first" }, { status: 400 });
        return runAction(btn, "subOut", "Executing cycle", async () => {
          const r = await fetch("/api/cycles/execute", { method: "POST", headers: p4Headers(), body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
          return { status: r.status, body: await r.json(), toastLabel: "Cycle Execute" };
        });
      }
      async function triggerSoftFail(btn) {
        if (!p4State.subId) return show("dunOut", { error: "Create a subscription in Step 2 first" }, { status: 400 });
        return runAction(btn, "dunOut", "Simulating failure", async () => {
          const r = await fetch("/api/dunning/fail", {
            method: "POST", headers: p4Headers(),
            body: JSON.stringify({ subscriptionId: p4State.subId, executionKey: p4State.subId + ":cycle:" + Date.now(), amountPaise: 49900, failureCode: "51_INSUFFICIENT_FUNDS" })
          });
          const data = await r.json();
          if (data.dunningCase?.id) p4State.dunningCaseId = data.dunningCase.id;
          return { status: r.status, body: data, toastLabel: "Dunning Soft Fail" };
        });
      }
      async function processDueRetries(btn) {
        return runAction(btn, "dunOut", "Processing retries", async () => {
          const r = await fetch("/api/dunning/process-due", { method: "POST", headers: p4Headers(), body: JSON.stringify({ simulateSuccess: false }) });
          return { status: r.status, body: await r.json(), toastLabel: "Process Retries" };
        });
      }
      async function payNowRecover(btn) {
        if (!p4State.dunningCaseId) return show("dunOut", { error: "Trigger a soft failure first" }, { status: 400 });
        return runAction(btn, "dunOut", "Recovering via Pay-Now", async () => {
          const r = await fetch("/api/dunning/" + encodeURIComponent(p4State.dunningCaseId) + "/pay-now", {
            method: "POST", headers: p4Headers(), body: JSON.stringify({ cardNumber: "4111111111114242", expiry: "12/29" })
          });
          return { status: r.status, body: await r.json(), toastLabel: "Pay-Now Recovery" };
        });
      }
      async function runEnachSample(btn) {
        return runAction(btn, "invOut", "Running e-NACH batch", async () => {
          const r = await fetch("/api/enach/run-sample", { method: "POST", headers: p4Headers(), body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "e-NACH Batch" };
        });
      }
      async function createPaidInvoice(btn) {
        return runAction(btn, "invOut", "Generating invoice", async () => {
          const r = await fetch("/api/invoices/demo-paid", {
            method: "POST", headers: p4Headers(),
            body: JSON.stringify({ subscriptionId: p4State.subId || "sub_demo", umrn: p4State.umrn || "UMRNBANKA000001", amountPaise: 49900 })
          });
          const data = await r.json();
          return { status: r.status, display: r.ok ? data.printable + "\\n\\nMRR Parity: " + JSON.stringify(data.mrrParity) : data, toastLabel: "Tax Invoice" };
        });
      }
      async function checkMrrParity(btn) {
        return runAction(btn, "invOut", "Checking MRR parity", async () => {
          const r = await fetch("/api/invoices/mrr-parity", { headers: p4Headers() });
          return { status: r.status, body: await r.json(), toastLabel: "MRR Parity" };
        });
      }
    `,
  });
}
