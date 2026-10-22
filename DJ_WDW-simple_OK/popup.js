const $ = (id) => document.getElementById(id);
const fmtMoney = (c) => (c / 100).toFixed(2);
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "<1m";
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
const level = (p) => (p >= 90 ? "hot" : p >= 70 ? "warn" : "");

let cur = null;
let formFilled = false;

function meter(label, value, pct) {
  const d = document.createElement("div");
  d.className = "meter";
  const top = document.createElement("div");
  top.className = "top";
  const a = document.createElement("span"), b = document.createElement("span");
  a.textContent = label; b.textContent = value;
  top.append(a, b);
  const bar = document.createElement("div");
  bar.className = "bar " + (pct == null ? "" : level(pct));
  const i = document.createElement("i");
  i.style.width = Math.min(100, pct || 0) + "%";
  bar.append(i);
  d.append(top, bar);
  return d;
}

function render() {
  if (!cur) return;
  const { view: v, history, settings: s, messagesLeft } = cur;
  const ses = v.session;
  const blocked = v.blocked;
  const pct = blocked ? 100 : ses ? ses.pct : 0;

  $("pct").textContent = v.fetchedAt ? pct : "–";
  $("fill").style.width = Math.min(100, pct) + "%";
  $("bar").className = "bar " + level(pct);
  $("bar").setAttribute("aria-valuenow", String(Math.min(100, pct)));
  $("sub").textContent = cur.signedIn === false ? "Not signed in"
    : !v.fetchedAt ? "No data yet"
    : ses ? (ses.resetsAt ? `Session resets in ${dur(ses.resetsAt - Date.now())}` : "Session active")
      : "No active session";

  // Which account these numbers belong to (only worth showing once you use more than one).
  const acct = $("acct");
  const a = cur.account || {};
  if (a.label && a.count > 1) { acct.hidden = false; acct.textContent = "Account: " + a.label; }
  else acct.hidden = true;

  const lim = $("limit");
  if (blocked) {
    lim.hidden = false;
    const what = blocked.kind === "weekly" ? "Weekly limit reached" : "Usage limit reached";
    lim.textContent = what + " – you can't send messages" +
      (blocked.resetsAt ? ` until it resets in ${blocked.estimated ? "about " : ""}${dur(blocked.resetsAt - Date.now())}.` : ".");
  } else lim.hidden = true;

  const left = $("left");
  if (blocked) { left.hidden = false; left.textContent = "0 messages left until the limit resets."; }
  else if (messagesLeft != null) { left.hidden = false; left.textContent = `About ${messagesLeft} messages left at your recent pace.`; }
  else left.hidden = true;

  const meters = $("meters");
  meters.replaceChildren();
  const reset = (w) => `${w.pct}%` + (w.resetsAt ? ` · ${dur(w.resetsAt - Date.now())}` : "");
  if (v.weekly) meters.append(meter("Weekly", reset(v.weekly), v.weekly.pct));
  for (const m of v.scoped) meters.append(meter(m.name + " weekly", reset(m), m.pct));
  if (v.extra) {
    const p = v.extra.limit ? Math.round((v.extra.used / v.extra.limit) * 100) : 0;
    meters.append(meter("Extra usage", `${fmtMoney(v.extra.used)} / ${fmtMoney(v.extra.limit)}`, p));
  }

  const list = $("list");
  list.replaceChildren();
  if (!history.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Send a message on claude.ai to start tracking.";
    list.append(li);
  }
  for (const h of history.slice(0, 6)) {
    const li = document.createElement("li");
    const a = document.createElement("span"), b = document.createElement("span");
    a.textContent = h.title;
    b.textContent = h.delta > 0 ? "+" + h.delta + "%" : "<1%";
    li.append(a, b);
    list.append(li);
  }

  if (!formFilled) {
    const f = $("f").elements;
    f.showWidget.checked = s.showWidget;
    f.notify.checked = s.notify;
    f.notifyOnLimit.checked = s.notifyOnLimit;
    f.notifyAt.value = s.notifyAt;
    formFilled = true;
  }
}

const apply = (r) => { if (r) { cur = r; render(); } };
// Reading lastError marks it handled; without this Chrome logs "Unchecked runtime.lastError"
// whenever the service worker is still waking up.
const call = (msg) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; apply(r); });

$("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements;
  call({ type: "setSettings", settings: {
    showWidget: f.showWidget.checked,
    notify: f.notify.checked,
    notifyOnLimit: f.notifyOnLimit.checked,
    notifyAt: Math.min(100, Math.max(1, Number(f.notifyAt.value) || 80))
  } });
});
$("refreshBtn").addEventListener("click", () => call({ type: "refreshUsage" }));
$("clearBtn").addEventListener("click", () => call({ type: "clearHistory" }));

call({ type: "getState" });
call({ type: "refreshUsage" });
setInterval(render, 1000);
setInterval(() => call({ type: "getState" }), 5000);
