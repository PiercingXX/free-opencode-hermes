export function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Free OpenCode &amp; Hermes by PiercingXX</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&amp;family=Space+Mono:wght@400;700&amp;display=swap" rel="stylesheet" />
  <style>
    /* Tokens from https://github.com/PiercingXX/piercingxx-branding tokens/colors.css */
    :root {
      color-scheme: dark;
      --pxx-ink: #000000;
      --pxx-signal: #FFFFFF;
      --pxx-emphasis-bg: var(--pxx-signal);
      --pxx-emphasis-fg: var(--pxx-ink);
      --pxx-ink-raised: #09090B;
      --pxx-graphite: #131316;
      --pxx-slate: #18181B;
      --pxx-line: rgba(255, 255, 255, 0.10);
      --pxx-shade: rgba(255, 255, 255, 0.25);
      --pxx-muted: rgba(255, 255, 255, 0.50);
      --pxx-strong: rgba(255, 255, 255, 0.80);
      --pxx-text: rgba(255, 255, 255, 0.90);
      --pxx-accent-blue: #82E2FF;
      --pxx-ok: var(--pxx-accent-blue);
      --pxx-warn: #FDBA74;
      --pxx-error: #FF6767;
      --pxx-info: rgba(255, 255, 255, 0.50);
      --pxx-font-display: "Space Mono", ui-monospace, monospace;
      --pxx-font-body: "JetBrains Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body { background: var(--pxx-ink); }
    body {
      margin: 0;
      font: 400 13px/1.55 var(--pxx-font-body);
      color: var(--pxx-text);
      min-height: 100vh;
    }
    header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--pxx-line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .mark {
      width: 40px;
      height: 40px;
      flex: 0 0 auto;
      display: block;
      border: 1px solid var(--pxx-line);
      border-radius: 8px;
    }
    .titles { min-width: 0; }
    h1 {
      font-family: var(--pxx-font-display);
      font-size: 16px;
      font-weight: 400;
      letter-spacing: 0;
      margin: 0;
      color: var(--pxx-text);
      line-height: 1.25;
    }
    .byline {
      margin: 2px 0 0;
      font-size: 11px;
      color: var(--pxx-muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #status { font-size: 12px; text-align: right; }
    main { display: grid; grid-template-columns: 1fr 320px; gap: 16px; padding: 16px 24px 24px; }
    section {
      background: var(--pxx-ink-raised);
      border: 1px solid var(--pxx-line);
      border-radius: 0;
      padding: 18px;
    }
    h2 {
      font-family: var(--pxx-font-display);
      font-size: 11px;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--pxx-muted);
      margin: 0 0 12px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
    .card {
      border: 1px solid var(--pxx-line);
      border-radius: 0;
      padding: 12px;
      background: var(--pxx-graphite);
    }
    .card.ready { border-color: var(--pxx-accent-blue); }
    .card.compact { cursor: pointer; padding: 10px 12px; }
    .card.compact h3 { margin: 0 0 2px; }
    .card h3 {
      margin: 0 0 6px;
      font-size: 13px;
      font-weight: 400;
      display: flex;
      gap: 8px;
      align-items: baseline;
      flex-wrap: wrap;
      color: var(--pxx-text);
    }
    a { color: var(--pxx-signal); text-decoration: underline; text-underline-offset: 2px; }
    .card a { font-size: 12px; }
    label { display: block; font-size: 11px; color: var(--pxx-muted); margin: 8px 0 4px; }
    input, select {
      width: 100%;
      background: var(--pxx-slate);
      color: var(--pxx-text);
      border: 1px solid var(--pxx-line);
      border-radius: 0;
      padding: 8px 10px;
      font: inherit;
    }
    input:focus, select:focus, button:focus-visible {
      outline: 1px solid var(--pxx-signal);
      outline-offset: 1px;
    }
    button {
      background: var(--pxx-emphasis-bg);
      color: var(--pxx-emphasis-fg);
      border: 1px solid var(--pxx-signal);
      border-radius: 0;
      padding: 8px 12px;
      cursor: pointer;
      font: 400 12px/1.2 var(--pxx-font-body);
    }
    button.secondary {
      background: transparent;
      color: var(--pxx-text);
      border-color: var(--pxx-line);
    }
    button.danger {
      background: transparent;
      color: var(--pxx-error);
      border-color: rgba(255, 103, 103, 0.35);
    }
    button:disabled { opacity: 0.45; cursor: default; }
    .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
    .ok { color: var(--pxx-ok); }
    .bad { color: var(--pxx-error); }
    .muted { color: var(--pxx-muted); }
    .probe { font-size: 12px; flex: 1; min-width: 140px; }
    footer {
      padding: 0 24px 20px;
      font-size: 11px;
      color: var(--pxx-muted);
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; padding: 16px; }
      header { align-items: flex-start; flex-wrap: wrap; }
      #status { text-align: left; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" role="img" aria-label="PiercingXX">
        <rect x="0" y="0" width="108" height="108" rx="22" fill="#000000"/>
        <path d="M40,26 L68,54 M40,54 L68,26" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round"/>
        <path d="M40,52 L68,80 M40,80 L68,52" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round"/>
        <path d="M38,88 L70,88" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round"/>
      </svg>
      <div class="titles">
        <h1>Free OpenCode &amp; Hermes</h1>
        <p class="byline">by PiercingXX</p>
      </div>
    </div>
    <div id="zen-warning" class="muted" style="display:none;font-size:12px;max-width:360px"></div>
    <div id="status" class="muted">Loading…</div>
    <div id="last-route" class="muted" style="font-size:11px;text-align:right;max-width:520px;white-space:pre-wrap"></div>
  </header>
  <main>
    <section>
      <h2>Cloud providers</h2>
      <label>Filter</label>
      <input id="provider-filter" placeholder="B.ai, bai, groq…" autocomplete="off" />
      <div id="providers" class="grid"></div>
      <h2 style="margin-top:20px">Self-hosted</h2>
      <p class="muted" style="margin:0 0 10px">Ollama, SGLang, LM Studio, llama.cpp. Autofind probes localhost, LAN neighbors, and Tailscale.</p>
      <div class="row" style="margin:0 0 12px">
        <button type="button" id="autofind" class="secondary">Autofind</button>
        <span id="autofind-status" class="muted"></span>
      </div>
      <div id="local-providers" class="grid"></div>
    </section>
    <section>
      <h2>Routing</h2>
      <label>Default model</label>
      <input id="model" placeholder="nvidia_nim/nvidia/nemotron-3-super-120b-a12b" />
      <label>Fallback models (comma-separated)</label>
      <input id="fallbacks" placeholder="open_router/openrouter/free, groq/llama-3.3-70b-versatile" />
      <div class="row">
        <button id="save">Apply</button>
        <button id="refresh" class="secondary">Refresh models</button>
      </div>
      <p id="message" class="muted"></p>
      <h2 style="margin-top:20px">Cooldown</h2>
      <p class="muted" style="margin:0 0 8px">Self-hosted is used only after free models fail or are in cooldown. A drained box is skipped until Retry-After elapses.</p>
      <div id="cooldowns" class="muted"></div>
      <h2 style="margin-top:20px">Free tool models</h2>
      <p class="muted" style="margin:0 0 8px">OpenCode Zen *-free / big-pickle, OpenRouter :free, and anything on your boxes. Use sets the default.</p>
      <div id="free-models" class="muted"></div>
      <h2 style="margin-top:20px">Ready models</h2>
      <div id="models" class="muted"></div>
      <h2 style="margin-top:20px">Recent routes</h2>
      <div id="recent-routes" class="muted"></div>
      <h2 style="margin-top:20px">Log tail</h2>
      <p class="muted" style="margin:0 0 8px">Latest records from the on-disk <code>proxy.log</code> (secrets redacted).</p>
      <div id="log-tail" class="muted" style="font-size:11px;max-height:240px;overflow:auto"></div>
    </section>
  </main>
  <footer>
    Local-first. Keys stay on this machine.
    <a href="https://github.com/PiercingXX/free-opencode-hermes">source</a>
  </footer>
  <script>
    const $ = (id) => document.getElementById(id);
    function esc(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
    }
    async function api(path, opts) {
      const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || res.statusText);
      return data;
    }
    function cardExtras(p) {
      return (p.extra || []).map((f) =>
        "<label>" + esc(f.label) + (f.required ? " (required)" : "") + "</label>" +
        '<input data-extra="' + esc(p.id) + ":" + esc(f.key) + '" placeholder="' + esc(f.placeholder) + '" value="' + esc(f.value) + '" />'
      ).join("");
    }
    // The running ready/configured sort. Kept in sync with sortAdminCatalog in
    // admin.ts (pure, unit-tested); this copy backs the live grid.
    function sortCatalog(rows) {
      const catLevel = (p) => (p.ready || p.configured ? 1 : 0);
      return rows.slice().sort((a, b) => {
        const al = catLevel(a), bl = catLevel(b);
        if (al !== bl) return bl - al;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
    function isUsed(p) { return Boolean(p.ready || p.configured); }
    function compactCard(p) {
      return '<div class="card compact" data-id="' + esc(p.id) + '" data-expand="' + esc(p.id) + '">' +
        '<h3><span>' + esc(p.name) + '</span> <span class="bad">unused</span></h3>' +
        '<div class="muted" style="font-size:11px">' + esc(p.id) + '</div>' +
        '<span class="row"><button type="button" data-expand="' + esc(p.id) + '">Connect</button></span>' +
        "</div>";
    }
    function card(p) {
      const keyField = p.local
        ? (p.notes ? '<p class="muted">' + esc(p.notes) + "</p>" : "")
        : '<label>API key</label><input type="password" data-key="' + esc(p.id) + '" placeholder="' + esc(p.env || "API key") + '" autocomplete="off" />';
      const link = p.credentialUrl ? '<a href="' + esc(p.credentialUrl) + '" target="_blank" rel="noreferrer">Get a key</a>' : "";
      const badge = p.ready
        ? '<span class="ok">' + (p.local ? "✓ connected" : "✓ configured") + "</span>"
        : '<span class="bad">' + (p.local ? "✗ not connected" : "✗ not configured") + "</span>";
      const action = '<button type="button" data-connect="' + esc(p.id) + '">Connect</button>';
      const remove = (p.ready || p.configured)
        ? '<button type="button" class="danger" data-remove="' + esc(p.id) + '">Remove</button>'
        : "";
      const found = (p.discovered || []).slice(0, 6).map((id) => '<div class="muted">' + esc(p.id) + "/" + esc(id) + "</div>").join("");
      return '<div class="card' + (p.ready ? " ready" : "") + '" data-id="' + esc(p.id) + '"><h3>' + esc(p.name) + " " + badge + "</h3>" +
        '<div class="muted" style="font-size:11px;margin:0 0 6px">' + esc(p.id) + "</div>" +
        keyField + cardExtras(p) +
        '<div class="row">' +
          action +
          remove +
          '<span class="probe muted" data-probe-status="' + esc(p.id) + '">' +
            (p.ready && p.discovered && p.discovered.length ? (p.discovered.length + " models") : "not checked") +
          "</span>" +
          link +
        "</div>" + found +
        (p.account === null && !p.local
          ? '<div class="row" style="margin-top:8px"><input data-account-id="' + esc(p.id) + '" placeholder="account name (e.g. work)" style="flex:1" /><button type="button" class="secondary" data-add-account="' + esc(p.id) + '">Add account</button></div>'
          : "") +
        "</div>";
    }
    function extraFromCard(id) {
      const extra = {};
      document.querySelectorAll('[data-extra^="' + id + ':"]').forEach((el) => {
        const field = el.getAttribute("data-extra").slice(id.length + 1);
        extra[field] = el.value.trim();
      });
      return extra;
    }
    let catalogCache = [];
    const expanded = new Set();
    function filterMatches(p, query) {
      // Only a non-empty query expands/collapses on its own. With no filter an
      // unused provider stays compact until clicked. This distinguishes "no
      // filter" (all kept, unused collapsed) from "filter matches" (expanded).
      if (!query) return false;
      return (
        String(p.name || "").toLowerCase().indexOf(query) >= 0 ||
        String(p.id || "").toLowerCase().indexOf(query) >= 0
      );
    }
    function cardFor(p, query) {
      if (filterMatches(p, query) || expanded.has(p.id)) return card(p);
      return compactCard(p);
    }
    function paintCatalog() {
      const query = ($("provider-filter").value || "").trim().toLowerCase();
      // No filter shows every provider (unused ones stay compact unless clicked);
      // a filter keeps only the matches (which then expand).
      const keepAll = !query;
      const cloud = sortCatalog(catalogCache.filter((p) => !p.local)).filter(
        (p) => keepAll || filterMatches(p, query)
      );
      const local = sortCatalog(catalogCache.filter((p) => p.local)).filter(
        (p) => keepAll || filterMatches(p, query)
      );
      $("local-providers").innerHTML = local.map((p) => cardFor(p, query)).join("");
      $("providers").innerHTML = cloud.map((p) => cardFor(p, query)).join("");
    }
    async function load() {
      const data = await api("/admin/api/state");
      catalogCache = data.catalog || [];
      $("status").textContent = "Proxy " + data.listen.host + ":" + data.listen.port;
      if (data.zenDefault) {
        $("zen-warning").style.display = "block";
        $("zen-warning").className = "bad";
        $("zen-warning").textContent = "Warning: the loaded OpenCode config still defaults to Zen. The plugin overlay fixes this once OpenCode reloads; use foc-opencode now or Apply default model in Routing.";
      } else {
        $("zen-warning").style.display = "none";
      }
      $("last-route").textContent = lastRouteHeader(data);
      const recent = data.recentRoutes || [];
      $("recent-routes").innerHTML = recent.length
        ? recent.slice(0, 20).map((r) => "<div>" + esc(formatRoute(r)) + "</div>").join("")
        : "None yet. Send a request through the :8082 catalog.";
      // The log tail reads the on-disk proxy.log (redacted server-side), not the
      // in-memory ring, so a restart/rotation and non-route records show here too.
      try {
        const logRes = await api("/admin/api/log?limit=25");
        const lines = logRes.lines || [];
        $("log-tail").innerHTML = lines.length
          ? lines.map((l) => "<div>" + esc(JSON.stringify(l)) + "</div>").join("")
          : "proxy.log is empty so far.";
      } catch (err) {
        $("log-tail").textContent = "log unavailable: " + err.message;
      }
      const cooldowns = data.cooldowns || [];
      $("cooldowns").innerHTML = cooldowns.length
        ? cooldowns.map((c) =>
            "<div>" + esc(c.slug) + " · cooldown · back " +
            (c.availableAt ? esc(new Date(c.availableAt).toLocaleTimeString()) : "later") +
            " (" + esc(c.reason || "") + ")</div>"
          ).join("")
        : "Nothing in cooldown.";
      $("model").value = data.model || "";
      $("fallbacks").value = (data.fallbacks || []).join(", ");
      paintCatalog();
      const models = data.models || [];
      const free = models.filter((m) => m.free);
      $("free-models").innerHTML = free.length
        ? free.map((m) =>
            '<div class="row" style="margin-top:6px">' +
              "<span>" + esc(m.id) + "</span>" +
              '<button type="button" class="secondary" data-use-model="' + esc(m.id) + '">Use</button>' +
            "</div>"
          ).join("")
        : "None yet. Connect OpenCode Zen or OpenRouter, or a local box.";
      const preview = models.slice(0, 12);
      const more = models.length - preview.length;
      $("models").innerHTML = preview.length
        ? preview.map((m) => "<div>" + esc(m.id) + (m.free ? " · free" : "") + "</div>").join("") +
          (more > 0 ? '<div class="muted">' + more + " more in the catalog</div>" : "")
        : "None yet. Connect a box or a cloud key.";
    }
    function catalogProvider(id) {
      return (catalogCache || []).find((p) => p.id === id);
    }
    function isLocalProvider(id) {
      return Boolean(catalogProvider(id) && catalogProvider(id).local);
    }
    function formatRoute(r) {
      const p = catalogProvider(r.providerId);
      const kind = p && p.local ? "LOCAL" : "CLOUD";
      const name = p && p.name ? " (" + p.name + ")" : "";
      const status = r.status == null ? "transport" : r.status;
      const outcome = r.ok ? "ok" : ("failed " + status);
      const fb = (r.fallback === false || r.fallback === 0) ? "" : (" · fallback#" + r.fallback);
      const tried = (r.tried && r.tried.length > 1) ? (" · tried: " + r.tried.join("→")) : "";
      return kind + " " + r.slug + name + " · " + outcome + " · " + r.latencyMs + "ms" + tried + fb;
    }
    function lastRouteHeader(data) {
      const r = data.lastRoute;
      let line = "last route: " + (r ? formatRoute(r) : "(none yet)");
      const localReady = (data.catalog || []).filter((p) => p.local && p.ready);
      const hops = (data.recentRoutes || []).slice();
      if (r) hops.push(r);
      const lastLocal = hops.reverse().find((x) => isLocalProvider(x.providerId));
      if (lastLocal && (!r || lastLocal.slug !== r.slug)) {
        line += "\\nlast local hop: " + formatRoute(lastLocal);
      } else if (r && !isLocalProvider(r.providerId) && localReady.length) {
        line +=
          "\\nlocal last-resort: " + localReady.map((p) => p.id).join(", ") + " (not used this hop)";
      }
      return line;
    }
    async function probeOrConnect(button, path) {
      const id = button.getAttribute("data-probe") || button.getAttribute("data-connect");
      const status = document.querySelector('[data-probe-status="' + id + '"]');
      const keyEl = document.querySelector('[data-key="' + id + '"]');
      status.className = "probe muted";
      status.textContent = path.indexOf("connect") >= 0 ? "connecting…" : "checking…";
      button.disabled = true;
      try {
        const result = await api(path, {
          method: "POST",
          body: JSON.stringify({
            providerId: id,
            apiKey: keyEl ? keyEl.value.trim() : "",
            extra: extraFromCard(id)
          })
        });
        if (result.ok) {
          const n = (result.models || []).length;
          status.className = "probe ok";
          status.textContent = n ? ("connected · " + n + " model" + (n === 1 ? "" : "s")) : "connected · no models listed";
          if (result.saved) await load();
        } else {
          status.className = "probe bad";
          status.textContent = result.error || "unreachable";
        }
      } catch (err) {
        status.className = "probe bad";
        status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    }
    document.addEventListener("click", async (event) => {
      const expandTarget = event.target.closest("[data-expand]");
      if (expandTarget) {
        const id = expandTarget.getAttribute("data-expand");
        if (id) {
          if (expanded.has(id)) expanded.delete(id);
          else expanded.add(id);
          paintCatalog();
        }
        return;
      }
      const addAccountBtn = event.target.closest("[data-add-account]");
      if (addAccountBtn) {
        const id = addAccountBtn.getAttribute("data-add-account");
        if (!id) return;
        const input = document.querySelector('[data-account-id="' + id + '"]');
        const accountId = input ? input.value.trim() : "";
        if (!accountId) {
          $("message").textContent = "Enter an account name (e.g. work).";
          $("message").className = "bad";
          return;
        }
        addAccountBtn.disabled = true;
        try {
          await api("/admin/api/account", {
            method: "POST",
            body: JSON.stringify({ providerId: id, accountId })
          });
          $("message").textContent = "Added " + id + "@" + accountId + ". Configure its key in the new card.";
          $("message").className = "ok";
          await load();
        } catch (err) {
          $("message").textContent = err.message;
          $("message").className = "bad";
        } finally {
          addAccountBtn.disabled = false;
        }
        return;
      }
      const connectBtn = event.target.closest("[data-connect]");
      if (connectBtn) {
        await probeOrConnect(connectBtn, "/admin/api/connect");
        return;
      }
      const probeBtn = event.target.closest("[data-probe]");
      if (probeBtn) {
        await probeOrConnect(probeBtn, "/admin/api/probe");
        return;
      }
      const useBtn = event.target.closest("[data-use-model]");
      if (useBtn) {
        const id = useBtn.getAttribute("data-use-model");
        if (!id) return;
        useBtn.disabled = true;
        try {
          await api("/admin/api/settings", {
            method: "POST",
            body: JSON.stringify({ model: id })
          });
          $("message").textContent = "Default is " + id + ".";
          $("message").className = "ok";
          await load();
        } catch (err) {
          $("message").textContent = err.message;
          $("message").className = "bad";
        } finally {
          useBtn.disabled = false;
        }
        return;
      }
      const removeBtn = event.target.closest("[data-remove]");
      if (removeBtn) {
        const id = removeBtn.getAttribute("data-remove");
        if (!id) return;
        if (!confirm("Remove " + id + "? This drops its models and takes it off the list.")) return;
        const status = document.querySelector('[data-probe-status="' + id + '"]');
        removeBtn.disabled = true;
        try {
          await api("/admin/api/remove", {
            method: "POST",
            body: JSON.stringify({ providerId: id })
          });
          $("message").textContent = "Removed " + id + ".";
          $("message").className = "ok";
          await load();
        } catch (err) {
          if (status) {
            status.className = "probe bad";
            status.textContent = err.message;
          }
          $("message").textContent = err.message;
          $("message").className = "bad";
        } finally {
          removeBtn.disabled = false;
        }
      }
    });
    $("save").onclick = async () => {
      const keys = {};
      const extra = {};
      document.querySelectorAll("[data-key]").forEach((el) => {
        if (el.value.trim()) keys[el.getAttribute("data-key")] = el.value.trim();
      });
      document.querySelectorAll("[data-extra]").forEach((el) => {
        const [id, field] = el.getAttribute("data-extra").split(":");
        extra[id] = extra[id] || {};
        extra[id][field] = el.value.trim();
      });
      try {
        await api("/admin/api/settings", {
          method: "POST",
          body: JSON.stringify({
            model: $("model").value.trim() || null,
            fallbacks: $("fallbacks").value.split(",").map((s) => s.trim()).filter(Boolean),
            keys, extra
          })
        });
        $("message").textContent = "Saved. Restart OpenCode if the picker looks stale.";
        $("message").className = "ok";
        await load();
      } catch (err) {
        $("message").textContent = err.message;
        $("message").className = "bad";
      }
    };
    $("refresh").onclick = () => load().catch((err) => { $("message").textContent = err.message; });
    $("provider-filter").oninput = () => paintCatalog();
    $("autofind").onclick = async () => {
      const status = $("autofind-status");
      const button = $("autofind");
      status.className = "muted";
      status.textContent = "scanning localhost, LAN, Tailscale…";
      button.disabled = true;
      try {
        const result = await api("/admin/api/autofind", { method: "POST", body: "{}" });
        const n = (result.connected || []).length;
        const notes = (result.notes || []).join(" ");
        status.className = n ? "ok" : "muted";
        status.textContent = n
          ? ("found " + n + " endpoint" + (n === 1 ? "" : "s") + (notes ? " · " + notes : ""))
          : (notes || "nothing answered");
        $("message").textContent = n ? "Connected: " + result.connected.join(", ") : (notes || "No self-hosted endpoints found.");
        $("message").className = n ? "ok" : "muted";
        await load();
      } catch (err) {
        status.className = "bad";
        status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
    load().catch((err) => { $("status").textContent = err.message; $("status").className = "bad"; });
  </script>
</body>
</html>`;
}

/**
 * The ready/configured-first ordering the Admin grid uses.
 *
 * Pure and unit-tested so the real rule is verified without scraping the HTML.
 * `rows` mimic the per-provider object from `/admin/api/state` (only `id`,
 * `name`, `ready`, and `configured` are read). Ready/configured providers sort
 * above everything else; within a bucket, order is stable by id (which tracks
 * catalog order).
 */
export type AdminCatalogSortRow = {
  id: string;
  name?: string;
  ready?: boolean;
  configured?: boolean;
};

export function sortAdminCatalog(rows: AdminCatalogSortRow[]): AdminCatalogSortRow[] {
  const level = (p: AdminCatalogSortRow): number => (p.ready || p.configured ? 1 : 0);
  return rows.slice().sort((a, b) => {
    const al = level(a);
    const bl = level(b);
    if (al !== bl) return bl - al;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
