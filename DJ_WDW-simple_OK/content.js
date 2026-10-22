// Runs on claude.ai pages. Two jobs:
//   1. when inject.js says "a reply finished", tell the background
//   2. draw the little floating meter (the part below, UI code unchanged)
(() => {
  let state = null; // latest numbers received from the background

  // Send a message to background.js and wait for its answer (null if it failed).
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => { void chrome.runtime.lastError; resolve(reply); });
      } catch (e) { resolve(null); }
    });
  }

  // Backup plan: if the background can't call claude.ai itself, it asks this tab to do it.
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (!m || m.type !== "apiGet") return;
    fetch("/api" + m.path, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => reply({ ok: true, data }), () => reply({ ok: false }));
    return true; // we will reply later
  });

  // Job 1: inject.js posts a message to the page every time a reply finishes.
  window.addEventListener("message", async (event) => {
    const d = event.data;
    if (event.source !== window || !d || d.source !== "usage-meter") return;
    const title = document.title.replace(/\s*[-–—|]\s*Claude\s*$/i, "").trim() || "Chat";
    await send({ type: "sse", messageLimit: d.messageLimit, title }); // instant numbers from the stream
    await send({ type: "refreshUsage" });                             // exact numbers from /usage
    refresh();
  });

  // Job 2: the floating meter (UI code)
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483000;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host { font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .wrap { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
    .pill { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; cursor:pointer;
      background:#fff; color:#1b2430; border:1px solid #d5dbe2; font:inherit; box-shadow:0 1px 3px rgba(20,30,50,.12); }
    .track { width:56px; height:6px; border-radius:3px; background:#e3e8ee; overflow:hidden; }
    .track i { display:block; height:100%; width:0; background:#2f6fed; transition:width .4s; }
    .warn .track i { background:#c98a00; } .hot .track i { background:#d6453d; }
    .txt { font-variant-numeric:tabular-nums; font-weight:600; }
    .panel { min-width:250px; padding:10px 12px; border-radius:10px; background:#fff; color:#1b2430;
      border:1px solid #d5dbe2; box-shadow:0 4px 16px rgba(20,30,50,.16); }
    .panel[hidden] { display:none; }
    .row { display:flex; justify-content:space-between; gap:16px; padding:2px 0; }
    .row span:first-child { color:#667384; } .row span:last-child { font-variant-numeric:tabular-nums; font-weight:600; text-align:right; }
    .note { margin-top:6px; color:#667384; font-size:11px; }
    @media (prefers-color-scheme: dark) {
      .pill, .panel { background:#1d232b; color:#e8edf2; border-color:#323b46; }
      .track { background:#323b46; } .row span:first-child, .note { color:#93a0af; }
    }
  </style>
  <div class="wrap">
    <div class="panel" hidden></div>
    <button class="pill" aria-expanded="false" aria-label="Claude usage"><span class="track"><i></i></span><span class="txt">–</span></button>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const pill = $(".pill"), panel = $(".panel");
  pill.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    pill.setAttribute("aria-expanded", String(!panel.hidden));
  });

  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return "<1m";
    if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  }
  const money = (c) => (c / 100).toFixed(2);
  const withReset = (w) => `${w.pct}%` + (w.resetsAt ? ` · ${dur(w.resetsAt - Date.now())}` : "");

  function addRow(label, value, title) {
    const r = document.createElement("div");
    r.className = "row";
    if (title) r.title = title;
    const a = document.createElement("span"), b = document.createElement("span");
    a.textContent = label; b.textContent = value;
    r.append(a, b);
    panel.append(r);
  }

  function render() {
    const settings = (state && state.settings) || {};
    if (settings.showWidget === false) { host.remove(); return; }
    if (!document.body) return;
    if (!document.body.contains(host)) document.body.appendChild(host);

    const v = state && state.view;
    const ses = v && v.session;
    const blocked = v && v.blocked;
    const pct = blocked ? 100 : ses ? ses.pct : 0;
    pill.className = "pill " + (pct >= 90 ? "hot" : pct >= 70 ? "warn" : "");
    $(".track i").style.width = Math.min(100, pct) + "%";
    $(".txt").textContent = !v || !v.fetchedAt ? "–" : pct + "%";
    pill.title = blocked ? "Limit reached" + (blocked.resetsAt ? " · resets in " + dur(blocked.resetsAt - Date.now()) : "") : "";

    panel.replaceChildren();
    if (state && state.signedIn === false) {
      addRow("Usage", "Not signed in");
    } else if (!v || !v.fetchedAt) {
      addRow("Usage", "Waiting for data");
    } else {
      if (blocked) {
        const wk = blocked.kind === "weekly" ? "Weekly limit" : "Session limit";
        addRow(wk + " reached", blocked.resetsAt ? "resets in " + (blocked.estimated ? "~" : "") + dur(blocked.resetsAt - Date.now()) : "waiting for reset time",
          "You can't send messages until this resets");
      }
      addRow("Session (5h)", ses ? withReset(ses) : "0% · no active session", "Percent of your 5-hour session used, and time until it resets");
      if (v.weekly) addRow("Weekly", withReset(v.weekly), "Percent of your weekly limit used, and time until it resets");
      for (const s of v.scoped) addRow(s.name + " weekly", withReset(s));
      if (v.extra) addRow("Extra usage", `${money(v.extra.used)} / ${money(v.extra.limit)}`, "Extra usage spend this month");
      const last = state.history && state.history[0];
      if (last) addRow("Last message", last.delta > 0 ? "+" + last.delta + "%" : "<1%", "How much that message moved your session usage");
      if (state.messagesLeft != null && !blocked) addRow("Messages left", "~" + state.messagesLeft, "Based on your recent average cost per message");
    }
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Click the toolbar icon for settings.";
    panel.append(note);
  }


  async function refresh() {
    const reply = await send({ type: "getState" });
    if (reply) state = reply;
    render();
  }

  try { chrome.storage.onChanged.addListener(refresh); } catch (e) {}
  refresh();
  setInterval(refresh, 30000);
  setInterval(render, 15000);
})();
