/**
 * Shared Fintech UI Shell — Clean Slate/Blue Palette, Tactile Loading States,
 * Perceptible Click Delay (320ms min) & Toast Feedback. Zero external dependencies.
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

export function renderFintechShellHtml(params: {
  title: string;
  subtitle: string;
  activePort: 3001 | 3002 | 3003 | 3004;
  bodyHtml: string;
  scriptJs: string;
}): string {
  const { p1, p2, p3, p4 } = getConfiguredPorts();
  const isCloudSinglePort = process.env.CLOUD_SINGLE_PORT === "true";
  const navItems: Array<{ slot: 3001 | 3002 | 3003 | 3004; href: string; label: string }> = [
    {
      slot: 3001,
      href: isCloudSinglePort ? "/p1/" : `http://127.0.0.1:${p1}/`,
      label: isCloudSinglePort ? "P1 Switch" : `Switch :${p1}`,
    },
    {
      slot: 3002,
      href: isCloudSinglePort ? "/p2/" : `http://127.0.0.1:${p2}/`,
      label: isCloudSinglePort ? "P2 Gateway" : `Gateway :${p2}`,
    },
    {
      slot: 3003,
      href: isCloudSinglePort ? "/p3/" : `http://127.0.0.1:${p3}/`,
      label: isCloudSinglePort ? "P3 Consumer" : `Consumer :${p3}`,
    },
    {
      slot: 3004,
      href: isCloudSinglePort ? "/p4/" : `http://127.0.0.1:${p4}/`,
      label: isCloudSinglePort ? "P4 Mandates" : `Mandates :${p4}`,
    },
  ];

  const navHtml = navItems
    .map((item) => {
      const cls = item.slot === params.activePort ? "nav-link active" : "nav-link";
      return `<a class="${cls}" href="${item.href}">${escapeHtml(item.label)}</a>`;
    })
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
      --surface-subtle: #f1f5f9;
      --border: #e2e8f0;
      --border-strong: #cbd5e1;
      --ink: #0f172a;
      --ink-2: #334155;
      --muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-soft: #eff6ff;
      --ok-ink: #15803d;
      --ok-bg: #dcfce7;
      --warn-ink: #b45309;
      --warn-bg: #fef3c7;
      --err-ink: #b91c1c;
      --err-bg: #fee2e2;
      --danger: #dc2626;
      --danger-hover: #b91c1c;
      --radius: 12px;
      --shadow: 0 1px 3px rgba(15, 23, 42, 0.05), 0 1px 2px rgba(15, 23, 42, 0.03);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    header {
      background: #0f172a;
      color: #ffffff;
      padding: 13px 24px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      position: sticky;
      top: 0;
      z-index: 20;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
    }
    header h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
    header .sub { color: #94a3b8; font-size: 12px; margin-top: 2px; }
    nav { display: flex; flex-wrap: wrap; gap: 6px; }
    .nav-link {
      color: #cbd5e1;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      padding: 7px 12px;
      border-radius: 8px;
      transition: background 150ms ease, color 150ms ease;
    }
    .nav-link:hover { background: rgba(255, 255, 255, 0.08); color: #ffffff; }
    .nav-link.active { background: var(--primary); color: #ffffff; font-weight: 600; }
    main { max-width: 1220px; margin: 24px auto; padding: 0 20px 56px; }
    .auth-bar {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 18px;
      margin-bottom: 20px;
      box-shadow: var(--shadow);
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: flex-end;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
      gap: 20px;
    }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
    }
    .card-head { margin-bottom: 14px; }
    .card h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
      color: var(--ink);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .step-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: var(--primary-soft);
      color: var(--primary);
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .hint { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }
    .row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; align-items: flex-end; }
    label {
      display: flex;
      flex-direction: column;
      font-size: 12px;
      font-weight: 500;
      color: var(--ink-2);
      gap: 5px;
      flex: 1;
      min-width: 140px;
    }
    input, select {
      background: var(--surface);
      color: var(--ink);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      padding: 8px 11px;
      font-size: 13.5px;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
    }
    button {
      background: var(--primary);
      color: #ffffff;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 9px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      transition: background 140ms ease, transform 80ms ease, opacity 140ms ease;
      white-space: nowrap;
    }
    button:hover:not(:disabled) { background: var(--primary-hover); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:disabled { opacity: 0.65; cursor: wait; }
    button.secondary {
      background: var(--surface-subtle);
      color: var(--ink-2);
      border-color: var(--border-strong);
    }
    button.secondary:hover:not(:disabled) { background: #e2e8f0; color: var(--ink); }
    button.danger { background: var(--danger); color: #ffffff; }
    button.danger:hover:not(:disabled) { background: var(--danger-hover); }
    .spinner {
      width: 13px;
      height: 13px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 650ms linear infinite;
      display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .out-wrap { margin-top: auto; padding-top: 6px; }
    .out-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      color: var(--muted);
      margin-bottom: 6px;
      min-height: 20px;
    }
    pre.out {
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 8px;
      padding: 12px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
      max-height: 250px;
      margin: 0;
      transition: opacity 160ms ease;
    }
    pre.out.loading { opacity: 0.55; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
    }
    .badge.ok { background: var(--ok-bg); color: var(--ok-ink); }
    .badge.warn { background: var(--warn-bg); color: var(--warn-ink); }
    .badge.err { background: var(--err-bg); color: var(--err-ink); }
    .badge.neutral { background: var(--surface-subtle); color: var(--ink-2); }
    #toast-root {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 50;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      background: #0f172a;
      color: #ffffff;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
      border-left: 4px solid var(--primary);
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.ok { border-left-color: #22c55e; }
    .toast.err { border-left-color: #ef4444; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${safeTitle}</h1>
      <div class="sub">${safeSubtitle}</div>
    </div>
    <nav>${navHtml}</nav>
  </header>
  <div id="toast-root" aria-live="polite"></div>
  <main>
    ${params.bodyHtml}
  </main>
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
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function toast(message, kind = "info") {
      const root = document.getElementById("toast-root");
      if (!root) return;
      const el = document.createElement("div");
      el.className = "toast " + kind;
      el.textContent = message;
      root.appendChild(el);
      requestAnimationFrame(() => el.classList.add("show"));
      setTimeout(() => {
        el.classList.remove("show");
        setTimeout(() => el.remove(), 200);
      }, 2800);
    }
    function show(id, data, meta) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove("loading");
        el.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      }
      const metaEl = document.getElementById(id + "Meta");
      if (metaEl && meta) {
        const cls = meta.status >= 200 && meta.status < 300 ? "ok" : meta.status >= 400 ? "err" : "neutral";
        metaEl.innerHTML = "";
        const pill = document.createElement("span");
        pill.className = "badge " + cls;
        pill.textContent = meta.status ? ("HTTP " + meta.status) : (meta.label || "Done");
        const dur = document.createElement("span");
        dur.textContent = meta.elapsedMs !== undefined ? (meta.elapsedMs + " ms") : "";
        metaEl.appendChild(pill);
        metaEl.appendChild(dur);
      }
    }
    async function runAction(btn, outId, loadingText, fn) {
      const started = performance.now();
      const origHtml = btn ? btn.innerHTML : "";
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span><span>' + loadingText + '</span>';
      }
      const outEl = outId ? document.getElementById(outId) : null;
      if (outEl) {
        outEl.classList.add("loading");
        outEl.textContent = loadingText + "...";
      }
      try {
        const [result] = await Promise.all([fn(), sleep(MIN_UX_DELAY_MS)]);
        const elapsedMs = Math.round(performance.now() - started);
        if (result && typeof result === "object" && "status" in result) {
          show(outId, result.display ?? result, { status: result.status, elapsedMs });
          toast(
            (result.toastLabel || loadingText) + " — HTTP " + result.status,
            result.status >= 200 && result.status < 300 ? "ok" : "err"
          );
        }
        return result;
      } catch (err) {
        const elapsedMs = Math.round(performance.now() - started);
        show(outId, { error: err?.message || String(err) }, { status: 0, label: "Error", elapsedMs });
        toast(err?.message || "Request failed", "err");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = origHtml;
        }
      }
    }
    ${params.scriptJs}
  </script>
</body>
</html>`;
}
