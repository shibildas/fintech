/**
 * Shared Fintech Product App Shell — Login Gate (scrypt DB auth + HttpOnly session cookie),
 * Left Sidebar Navigation, KPI Strip, Data Tables, Collapsible API Inspector,
 * Tactile 320ms Loading Spinners & Toasts. Zero external dependencies.
 */

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getConfiguredPorts() {
  return {
    p1: Number(process.env.SWITCH_PORT ?? 3001),
    p2: Number(process.env.GATEWAY_PORT ?? 3002),
    p3: Number(process.env.CONSUMER_PORT ?? 3003),
    p4: Number(process.env.MANDATES_PORT ?? 3004),
  };
}

export interface ShellNavTab {
  id: string;
  label: string;
  adminOnly?: boolean;
}

export interface LoginAccountHint {
  username: string;
  role: "user" | "admin";
  label: string;
}

export function renderFintechShellHtml(params: {
  title: string;
  subtitle: string;
  activePort: 3001 | 3002 | 3003 | 3004;
  tabs?: ShellNavTab[];
  loginAccounts?: LoginAccountHint[];
  bodyHtml: string;
  scriptJs: string;
}): string {
  const { p1, p2, p3, p4 } = getConfiguredPorts();
  const isCloud = process.env.CLOUD_SINGLE_PORT === "true";
  const services: Array<{ slot: 3001 | 3002 | 3003 | 3004; href: string; label: string }> = [
    {
      slot: 3001,
      href: isCloud ? "/p1/" : `http://127.0.0.1:${p1}/`,
      label: isCloud ? "P1 Switch" : `Switch :${p1}`,
    },
    {
      slot: 3002,
      href: isCloud ? "/p2/" : `http://127.0.0.1:${p2}/`,
      label: isCloud ? "P2 Gateway" : `Gateway :${p2}`,
    },
    {
      slot: 3003,
      href: isCloud ? "/p3/" : `http://127.0.0.1:${p3}/`,
      label: isCloud ? "P3 Consumer" : `Consumer :${p3}`,
    },
    {
      slot: 3004,
      href: isCloud ? "/p4/" : `http://127.0.0.1:${p4}/`,
      label: isCloud ? "P4 Mandates" : `Mandates :${p4}`,
    },
  ];

  const serviceLinksHtml = services
    .map((s) => {
      const cls = s.slot === params.activePort ? "svc-link active" : "svc-link";
      return `<a class="${cls}" href="${s.href}">${escapeHtml(s.label)}</a>`;
    })
    .join("");

  const tabsHtml = (params.tabs ?? [])
    .map(
      (t, idx) =>
        `<button class="side-tab${idx === 0 ? " active" : ""}" data-tab="${escapeHtml(t.id)}" onclick="switchTab('${escapeHtml(t.id)}', this)">${escapeHtml(t.label)}${t.adminOnly ? ' <span class="mini-tag">Admin</span>' : ""}</button>`
    )
    .join("");

  const hintsHtml = (params.loginAccounts ?? [])
    .map(
      (a) =>
        `<button type="button" class="acct-chip" onclick="document.getElementById('loginUser').value='${escapeHtml(a.username)}';document.getElementById('loginPass').focus();">
          <strong>${escapeHtml(a.username)}</strong>
          <span class="badge ${a.role === "admin" ? "warn" : "neutral"}">${a.role.toUpperCase()}</span>
          <small>${escapeHtml(a.label)}</small>
        </button>`
    )
    .join("");

  const safeTitle = escapeHtml(params.title);
  const safeSubtitle = escapeHtml(params.subtitle);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --subtle: #f1f5f9;
      --border: #e2e8f0;
      --border-strong: #cbd5e1;
      --ink: #0f172a;
      --ink-2: #334155;
      --muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-soft: #eff6ff;
      --ok-ink: #15803d; --ok-bg: #dcfce7;
      --warn-ink: #b45309; --warn-bg: #fef3c7;
      --err-ink: #b91c1c; --err-bg: #fee2e2;
      --danger: #dc2626; --danger-hover: #b91c1c;
      --radius: 12px;
      --shadow: 0 1px 3px rgba(15, 23, 42, 0.05), 0 1px 2px rgba(15, 23, 42, 0.03);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.5; -webkit-font-smoothing: antialiased; }
    .hidden { display: none !important; }

    /* Login Gate */
    #authGate { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: linear-gradient(145deg, #0f172a 0%, #1e293b 48%, #f8fafc 48.2%, #f8fafc 100%); }
    .login-card { width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 32px; box-shadow: 0 20px 40px rgba(15, 23, 42, 0.14); }
    .brand-mark { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; color: var(--primary); background: var(--primary-soft); padding: 4px 10px; border-radius: 999px; margin-bottom: 14px; }
    .login-card h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -0.02em; }
    .login-card .sub { margin: 0 0 20px; font-size: 13px; color: var(--muted); }
    .acct-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 14px 0 18px; }
    .acct-chip { background: var(--subtle); color: var(--ink); border: 1px solid var(--border); border-radius: 10px; padding: 10px; text-align: left; display: flex; flex-direction: column; gap: 4px; cursor: pointer; }
    .acct-chip:hover { border-color: var(--primary); background: var(--primary-soft); }
    .acct-chip strong { font-size: 12.5px; }
    .acct-chip small { font-size: 11px; color: var(--muted); font-weight: 400; }
    .login-foot { margin-top: 14px; font-size: 11.5px; color: var(--muted); text-align: center; }

    /* Authenticated App Shell */
    #appShell { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
    @media (max-width: 860px) { #appShell { grid-template-columns: 1fr; } aside.sidebar { position: static; height: auto; } }
    aside.sidebar { background: #0f172a; color: #e2e8f0; padding: 20px 14px; display: flex; flex-direction: column; gap: 18px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
    .side-brand { padding: 0 8px; }
    .side-brand h1 { margin: 0; font-size: 15px; font-weight: 700; color: #ffffff; }
    .side-brand .sub { font-size: 11.5px; color: #94a3b8; margin-top: 3px; }
    .side-section-title { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; padding: 0 10px; margin-bottom: 6px; }
    .side-nav { display: flex; flex-direction: column; gap: 4px; }
    .side-tab, .svc-link { display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left; background: transparent; color: #cbd5e1; border: none; border-radius: 8px; padding: 9px 11px; font-size: 13px; font-weight: 500; text-decoration: none; cursor: pointer; }
    .side-tab:hover, .svc-link:hover { background: rgba(255, 255, 255, 0.07); color: #ffffff; }
    .side-tab.active, .svc-link.active { background: var(--primary); color: #ffffff; font-weight: 600; }
    .mini-tag { font-size: 10px; background: rgba(245, 158, 11, 0.2); color: #fcd34d; padding: 1px 6px; border-radius: 999px; }
    .user-box { margin-top: auto; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .user-box-top { display: flex; align-items: center; gap: 10px; }
    .avatar { width: 32px; height: 32px; border-radius: 999px; background: var(--primary); color: #fff; font-weight: 700; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .user-meta { min-width: 0; }
    .user-meta .name { font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .user-meta .uname { font-size: 11px; color: #94a3b8; }

    /* Main Content */
    .main-area { display: flex; flex-direction: column; min-width: 0; }
    .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 28px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
    .topbar h2 { margin: 0; font-size: 17px; font-weight: 650; }
    .content { max-width: 1120px; width: 100%; margin: 22px auto; padding: 0 24px 48px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .kpi-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow); }
    .kpi-label { font-size: 12px; color: var(--muted); font-weight: 500; }
    .kpi-value { font-size: 22px; font-weight: 700; color: var(--ink); margin-top: 4px; letter-spacing: -0.02em; }
    .kpi-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 18px; }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; box-shadow: var(--shadow); margin-bottom: 18px; }
    .card h3 { margin: 0 0 4px; font-size: 15px; font-weight: 650; color: var(--ink); }
    .hint { margin: 0 0 14px; font-size: 12.5px; color: var(--muted); }
    .row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; align-items: flex-end; }
    label { display: flex; flex-direction: column; font-size: 12px; font-weight: 500; color: var(--ink-2); gap: 5px; flex: 1; min-width: 140px; }
    input, select { background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong); border-radius: 8px; padding: 9px 11px; font-size: 13.5px; }
    input:focus, select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); }
    input.input-invalid, select.input-invalid { border-color: var(--danger); box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.12); }
    .field-err { font-size: 11px; color: var(--err-ink); font-weight: 500; margin-top: 2px; }
    button { background: var(--primary); color: #ffffff; border: 1px solid transparent; border-radius: 8px; padding: 9px 14px; font-size: 13px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; transition: background 140ms ease, opacity 140ms ease; white-space: nowrap; }
    button:hover:not(:disabled) { background: var(--primary-hover); }
    button:disabled { opacity: 0.6; cursor: wait; }
    button.secondary { background: var(--subtle); color: var(--ink-2); border-color: var(--border-strong); }
    button.secondary:hover:not(:disabled) { background: #e2e8f0; color: var(--ink); }
    button.danger { background: var(--danger); color: #ffffff; }
    button.danger:hover:not(:disabled) { background: var(--danger-hover); }
    button.ghost-dark { background: rgba(255,255,255,0.08); color: #e2e8f0; width: 100%; font-size: 12px; padding: 7px 10px; }
    button.ghost-dark:hover { background: rgba(255,255,255,0.16); }

    /* Tables */
    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; background: var(--subtle); color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--ink); }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f8fafc; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

    /* Badges, Spinner, Inspector, Toasts */
    .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
    .badge.ok { background: var(--ok-bg); color: var(--ok-ink); }
    .badge.warn { background: var(--warn-bg); color: var(--warn-ink); }
    .badge.err { background: var(--err-bg); color: var(--err-ink); }
    .badge.neutral { background: var(--subtle); color: var(--ink-2); }
    .spinner { width: 13px; height: 13px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 650ms linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }

    details.inspector { margin-top: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; }
    details.inspector summary { cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--muted); display: flex; align-items: center; justify-content: space-between; }
    pre.out { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; overflow-x: auto; max-height: 280px; margin: 10px 0 0; }
    pre.out.loading { opacity: 0.55; }
    .out-meta { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--muted); }
    #toast-root { position: fixed; bottom: 24px; right: 24px; z-index: 50; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast { background: #0f172a; color: #ffffff; padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 500; box-shadow: 0 10px 26px rgba(15, 23, 42, 0.22); border-left: 4px solid var(--primary); opacity: 0; transform: translateY(6px); transition: opacity 180ms ease, transform 180ms ease; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.ok { border-left-color: #22c55e; }
    .toast.err { border-left-color: #ef4444; }
  </style>
</head>
<body>
  <div id="authGate">
    <form class="login-card" onsubmit="handleUiLogin(event)">
      <div class="brand-mark">Fintech Infrastructure Stack</div>
      <h1>${safeTitle}</h1>
      <p class="sub">${safeSubtitle}</p>
      ${hintsHtml ? `<div class="acct-list">${hintsHtml}</div>` : ""}
      <div class="row">
        <label>Username<input id="loginUser" autocomplete="username" placeholder="Enter username" required /></label>
      </div>
      <div class="row">
        <label>Password<input id="loginPass" type="password" autocomplete="current-password" placeholder="Enter password" required /></label>
      </div>
      <div id="loginErr" class="badge err hidden" style="margin-bottom:12px;width:100%;justify-content:center;padding:8px;"></div>
      <button id="loginBtn" type="submit" style="width:100%;padding:11px;">Sign In</button>
      <div class="login-foot">Protected workspace authentication. Select an account above or enter your credentials.</div>
    </form>
  </div>

  <div id="appShell" class="hidden">
    <aside class="sidebar">
      <div class="side-brand">
        <h1>${safeTitle}</h1>
        <div class="sub">${safeSubtitle}</div>
      </div>
      ${tabsHtml ? `<div><div class="side-section-title">Workspace</div><nav class="side-nav">${tabsHtml}</nav></div>` : ""}
      <div>
        <div class="side-section-title">Microservices</div>
        <nav class="side-nav">${serviceLinksHtml}</nav>
      </div>
      <div class="user-box">
        <div class="user-box-top">
          <div id="uAvatar" class="avatar">U</div>
          <div class="user-meta">
            <div id="uDisplay" class="name">Signed In</div>
            <div id="uName" class="uname"></div>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span id="uRoleBadge" class="badge neutral">USER</span>
        </div>
        <button class="ghost-dark" onclick="handleUiLogout(this)">Sign Out</button>
      </div>
    </aside>

    <div class="main-area">
      <div class="topbar">
        <h2 id="viewTitle">${safeTitle}</h2>
        <div id="topbarRight" class="out-meta"></div>
      </div>
      <div class="content">
        ${params.bodyHtml}
        <details class="inspector" id="devInspector">
          <summary>
            <span>Developer API &amp; Telemetry Inspector</span>
            <span id="inspectorMeta" class="out-meta"></span>
          </summary>
          <pre id="inspectorOut" class="out">API responses &amp; audit traces will appear here.</pre>
        </details>
      </div>
    </div>
  </div>

  <div id="toast-root" aria-live="polite"></div>

  <script>
    (function () {
      const m = location.pathname.match(/^\\/(p[1-4])(\\/|$)/);
      if (!m) return;
      const prefix = "/" + m[1];
      const origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        if (typeof input === "string" && input.startsWith("/") && !input.startsWith(prefix + "/")) {
          return origFetch(prefix + input, init);
        }
        return origFetch(input, init);
      };
    })();

    const MIN_UX_DELAY_MS = 320;
    let currentUser = null;
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function formatInr(paise) {
      const n = Number(paise || 0) / 100;
      return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function esc(s) {
      return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    }
    function clearFieldErrors(ids) {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.remove("input-invalid");
        const next = el.parentElement?.querySelector(".field-err");
        if (next) next.remove();
      }
    }
    function setFieldError(id, msg) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add("input-invalid");
      let err = el.parentElement?.querySelector(".field-err");
      if (!err) {
        err = document.createElement("span");
        err.className = "field-err";
        el.parentElement?.appendChild(err);
      }
      err.textContent = msg;
      el.addEventListener("input", () => clearFieldErrors([id]), { once: true });
    }
    function validateFields(rules) {
      clearFieldErrors(rules.map(r => r.id));
      let firstBad = null;
      for (const r of rules) {
        const el = document.getElementById(r.id);
        const val = el ? el.value.trim() : "";
        const err = r.check(val);
        if (err) {
          setFieldError(r.id, err);
          if (!firstBad) firstBad = el;
        }
      }
      if (firstBad) {
        firstBad.focus();
        toast("Please fix the highlighted fields", "err");
        return false;
      }
      return true;
    }
    const V = {
      vpa: v => /^[a-z0-9._-]{2,64}@[a-z0-9]{2,32}$/i.test(v) ? "" : "Valid VPA required (e.g. anita@psp1)",
      posInt: v => (/^\\d+$/.test(v) && Number(v) > 0) ? "" : "Must be a positive integer in paise",
      pin: v => /^\\d{4,6}$/.test(v) ? "" : "Must be 4–6 numeric digits",
      mobile: v => /^[6-9]\\d{9}$/.test(v.replace(/[\\s-]/g, "")) ? "" : "10-digit mobile starting with 6–9",
      nonEmpty: v => v.length > 0 ? "" : "This field is required",
      luhn: v => {
        const d = v.replace(/[\\s-]/g, "");
        if (!/^\\d{13,19}$/.test(d)) return "Card must be 13–19 digits";
        let sum = 0, dbl = false;
        for (let i = d.length - 1; i >= 0; i--) { let n = Number(d[i]); if (dbl) { n *= 2; if (n > 9) n -= 9; } sum += n; dbl = !dbl; }
        return sum % 10 === 0 ? "" : "Invalid card number (Luhn check failed)";
      }
    };
    function toast(message, kind = "info") {
      const root = document.getElementById("toast-root");
      if (!root) return;
      const el = document.createElement("div");
      el.className = "toast " + kind;
      el.textContent = message;
      root.appendChild(el);
      requestAnimationFrame(() => el.classList.add("show"));
      setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 200); }, 2800);
    }
    function show(id, data, meta) {
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      const el = id ? document.getElementById(id) : null;
      if (el) { el.classList.remove("loading"); el.textContent = text; }
      const insp = document.getElementById("inspectorOut");
      if (insp) { insp.classList.remove("loading"); insp.textContent = text; }
      const metaEl = document.getElementById("inspectorMeta");
      if (metaEl && meta) {
        const cls = meta.status >= 200 && meta.status < 300 ? "ok" : meta.status >= 400 ? "err" : "neutral";
        metaEl.innerHTML = '<span class="badge ' + cls + '">HTTP ' + (meta.status || "-") + '</span><span>' + (meta.elapsedMs ?? 0) + ' ms</span>';
      }
    }
    async function runAction(btn, outId, loadingText, fn) {
      const started = performance.now();
      const origHtml = btn ? btn.innerHTML : "";
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span><span>' + loadingText + '</span>'; }
      try {
        const [result] = await Promise.all([fn(), sleep(MIN_UX_DELAY_MS)]);
        const elapsedMs = Math.round(performance.now() - started);
        if (result && typeof result === "object" && "status" in result) {
          show(outId, result.display ?? result.body ?? result, { status: result.status, elapsedMs });
          toast((result.toastLabel || loadingText) + " — HTTP " + result.status, result.status >= 200 && result.status < 300 ? "ok" : "err");
        }
        return result;
      } catch (err) {
        const elapsedMs = Math.round(performance.now() - started);
        show(outId, { error: err?.message || String(err) }, { status: 500, elapsedMs });
        toast(err?.message || "Request failed", "err");
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
      }
    }
    function switchTab(tabId, btn) {
      document.querySelectorAll(".view-pane").forEach(p => p.classList.add("hidden"));
      const target = document.getElementById("view-" + tabId);
      if (target) target.classList.remove("hidden");
      document.querySelectorAll(".side-tab").forEach(b => b.classList.remove("active"));
      if (btn) {
        btn.classList.add("active");
        const vt = document.getElementById("viewTitle");
        if (vt) vt.textContent = btn.textContent.replace("Admin", "").trim();
      }
    }
    function applySignedInUser(user) {
      currentUser = user;
      document.getElementById("authGate").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      document.getElementById("uDisplay").textContent = user.displayName || user.username;
      document.getElementById("uName").textContent = "@" + user.username;
      document.getElementById("uAvatar").textContent = (user.displayName || user.username).slice(0, 2).toUpperCase();
      const rb = document.getElementById("uRoleBadge");
      rb.className = "badge " + (user.role === "admin" ? "warn" : "ok");
      rb.textContent = user.role.toUpperCase();
      if (typeof window.onAppAuthenticated === "function") window.onAppAuthenticated(user);
    }
    async function handleUiLogin(e) {
      e.preventDefault();
      if (!validateFields([
        { id: "loginUser", check: v => /^[a-z0-9._-]{3,64}$/i.test(v) ? "" : "Username must be 3–64 characters" },
        { id: "loginPass", check: v => v.length >= 8 ? "" : "Password must be at least 8 characters" }
      ])) return;
      const btn = document.getElementById("loginBtn");
      const errEl = document.getElementById("loginErr");
      errEl.classList.add("hidden");
      const username = document.getElementById("loginUser").value.trim();
      const password = document.getElementById("loginPass").value;
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span><span>Signing in...</span>';
      try {
        const [r] = await Promise.all([
          fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }),
          sleep(MIN_UX_DELAY_MS)
        ]);
        const data = await r.json();
        if (!r.ok) {
          errEl.textContent = data.error || "Invalid username or password";
          errEl.classList.remove("hidden");
          return;
        }
        toast("Welcome, " + data.user.displayName, "ok");
        applySignedInUser(data.user);
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    }
    async function handleUiLogout(btn) {
      await runAction(btn, null, "Signing out", async () => {
        const r = await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        return { status: r.status, body: await r.json(), toastLabel: "Signed out" };
      });
      currentUser = null;
      document.getElementById("appShell").classList.add("hidden");
      document.getElementById("authGate").classList.remove("hidden");
      document.getElementById("loginPass").value = "";
    }
    (async function bootAuth() {
      try {
        const r = await fetch("/api/auth/me");
        const data = await r.json();
        if (r.ok && data.authenticated && data.user) applySignedInUser(data.user);
      } catch {}
    })();
    ${params.scriptJs}
  </script>
</body>
</html>`;
}
