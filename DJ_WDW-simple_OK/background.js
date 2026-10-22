// Background service worker: keeps the usage numbers, updates the toolbar badge, sends notifications.
//
// Two sources of numbers (both come from claude.ai itself):
//   1. the usage report at the end of every reply   -> handleReply()   (instant)
//   2. GET /api/organizations/<id>/usage             -> refreshUsage()  (exact, every 5 min)
//
// Saved in chrome.storage.local:
//   usage    : { session, weekly, scoped, extra, fetchedAt }    each limit = { pct, resetsAt }
//   history  : [ { title, delta } ]   newest first, delta = how many % one message cost
//   settings : { notify, notifyAt, notifyOnLimit, showWidget }
//
// Debug: chrome://extensions -> "service worker" -> Console.

const DEFAULT_SETTINGS = { notify: true, notifyAt: 80, notifyOnLimit: true, showWidget: true };
const log = (...args) => console.log("[usage-meter]", ...args);

// ---------- small helpers ----------

const clamp = (n) => Math.min(100, Math.max(0, n));

// Accepts an ISO date string or a unix time (seconds or ms). Returns milliseconds, or null.
function toMs(v) {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "<1m";
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message });
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

// ---------- talking to claude.ai ----------

async function apiGet(path) {
  // Normal way: call claude.ai directly (your login cookie is sent automatically).
  try {
    const res = await fetch("https://claude.ai/api" + path, { credentials: "include" });
    if (res.ok) return await res.json();
  } catch (e) {}
  // Backup plan: ask an open claude.ai tab to make the call (see content.js).
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "apiGet", path });
      if (reply && reply.ok) return reply.data;
    } catch (e) {}
  }
  throw new Error("claude.ai request failed: " + path);
}

// Turns the /usage answer into { session, weekly, scoped, extra }. claude.ai uses two formats.
function parseUsage(raw) {
  const usage = { session: null, weekly: null, scoped: [], extra: null };
  if (!raw || typeof raw !== "object") return usage;

  if (Array.isArray(raw.limits) && raw.limits.length) {
    // Format 1: a list of limits
    for (const e of raw.limits) {
      if (typeof e.percent !== "number") continue;
      const limit = { pct: clamp(Math.round(e.percent)), resetsAt: toMs(e.resets_at) };
      if (e.kind === "session") usage.session = limit;
      else if (e.kind === "weekly_all") usage.weekly = limit;
      else if (e.kind === "weekly_scoped") {
        const name = (e.scope && e.scope.model && e.scope.model.display_name) || "Model";
        usage.scoped.push({ name, ...limit });
      }
    }
  } else {
    // Format 2: five_hour, seven_day, ...
    const read = (o) => (o && typeof o.utilization === "number" ? { pct: clamp(Math.round(o.utilization)), resetsAt: toMs(o.resets_at) } : null);
    usage.session = read(raw.five_hour);
    usage.weekly = read(raw.seven_day);
    const sonnet = read(raw.seven_day_sonnet);
    const opus = read(raw.seven_day_opus);
    if (sonnet) usage.scoped.push({ name: "Sonnet", ...sonnet });
    if (opus) usage.scoped.push({ name: "Opus", ...opus });
  }

  // Extra usage (paid overage). Money is in cents.
  const spend = raw.spend;
  if (spend && spend.enabled) {
    usage.extra = {
      limit: (spend.limit && spend.limit.amount_minor) ?? (spend.cap && spend.cap.money && spend.cap.money.amount_minor) ?? 0,
      used: (spend.used && spend.used.amount_minor) ?? 0
    };
  } else if (raw.extra_usage && raw.extra_usage.is_enabled) {
    usage.extra = { limit: raw.extra_usage.monthly_limit ?? 0, used: raw.extra_usage.used_credits ?? 0 };
  }
  return usage;
}

// One limit from the reply stream. There, utilization is a fraction (0.5 = 50%).
function parseStreamWindow(w) {
  if (!w || typeof w !== "object") return null;
  const full = w.status === "exceeded_limit";
  const resetsAt = toMs(w.resets_at);
  if (!resetsAt || (!full && typeof w.utilization !== "number")) return null;
  return { pct: full ? 100 : clamp(Math.round(w.utilization * 100)), resetsAt };
}

// ---------- updating the numbers ----------

// A reply just finished. m.messageLimit is the usage report from the stream.
async function handleReply(m) {
  const windows = (m.messageLimit && m.messageLimit.windows) || {};
  const session = parseStreamWindow(windows["5h"]);
  const weekly = parseStreamWindow(windows["7d"]);
  log("reply finished. session:", session, "weekly:", weekly);
  if (!session && !weekly) return;

  const { usage: old, history = [] } = await chrome.storage.local.get(["usage", "history"]);
  const usage = { session: null, weekly: null, scoped: [], extra: null, ...old, fetchedAt: Date.now() };

  // What did this message cost? New % minus old %. (If the session was reset, the cost is the new %.)
  if (session) {
    const sameSession = old && old.session && Math.abs(old.session.resetsAt - session.resetsAt) < 60000;
    const delta = sameSession ? session.pct - old.session.pct : session.pct;
    history.unshift({ title: m.title || "Chat", delta });
    history.length = Math.min(history.length, 30);
    usage.session = session;
  }
  if (weekly) usage.weekly = weekly;

  await chrome.storage.local.set({ usage, history });
  await updateBadge();
}

// Ask claude.ai for the exact numbers and save them.
async function refreshUsage() {
  let raw;
  try {
    const orgs = await apiGet("/organizations");
    const org = orgs.find((o) => (o.capabilities || []).includes("chat")) || orgs[0]; // the account you're signed in to
    raw = await apiGet(`/organizations/${org.uuid}/usage`);
  } catch (e) {
    log("could not get usage:", String(e));
    return;
  }
  const fresh = parseUsage(raw);
  log("usage from claude.ai:", fresh);

  const { usage: old } = await chrome.storage.local.get("usage");
  const hasLimits = fresh.session || fresh.weekly || fresh.scoped.length;

  if (!hasLimits && old) {
    // Free plan: /usage has no limits. Keep what the reply stream told us.
    if (fresh.extra) await chrome.storage.local.set({ usage: { ...old, extra: fresh.extra } });
  } else {
    await chrome.storage.local.set({ usage: { ...fresh, fetchedAt: Date.now() } });
    // The session just hit 100%: tell the user.
    const wasFull = old && old.session && old.session.pct >= 100;
    if (fresh.session && fresh.session.pct >= 100 && !wasFull && (await getSettings()).notifyOnLimit) {
      notify("Claude usage limit reached", `You're out of usage. Resets in ${formatDuration(fresh.session.resetsAt - Date.now())}.`);
    }
  }
  await updateBadge();
}

// Runs every minute: has the 5-hour session ended? If so, notify (if it was heavily used) and clear it.
async function checkReset() {
  const { usage } = await chrome.storage.local.get("usage");
  if (!usage) return;
  const settings = await getSettings();
  const now = Date.now();

  if (usage.session && usage.session.resetsAt && now >= usage.session.resetsAt) {
    if (settings.notify && usage.session.pct >= settings.notifyAt) {
      notify("Claude usage is back", "Your 5-hour session has reset. You can keep chatting.");
    }
    usage.session = null;
  }
  if (usage.weekly && usage.weekly.resetsAt && now >= usage.weekly.resetsAt) usage.weekly = null;
  usage.scoped = (usage.scoped || []).filter((s) => !s.resetsAt || now < s.resetsAt);
  await chrome.storage.local.set({ usage });
}

// ---------- what the popup and widget see ----------

// Everything the popup/widget needs, in one object.
async function getState() {
  const { usage, history = [] } = await chrome.storage.local.get(["usage", "history"]);
  const settings = await getSettings();
  const now = Date.now();
  const u = usage || { scoped: [] };
  const active = (limit) => (limit && (!limit.resetsAt || now < limit.resetsAt) ? limit : null); // hide ended limits

  const view = {
    session: active(u.session),
    weekly: active(u.weekly),
    scoped: (u.scoped || []).filter(active),
    extra: u.extra || null,
    fetchedAt: u.fetchedAt || null,
    blocked: null
  };
  // "Blocked" = a limit is at 100%, so you can't send messages.
  if (view.session && view.session.pct >= 100) view.blocked = { kind: "session", resetsAt: view.session.resetsAt };
  else if (view.weekly && view.weekly.pct >= 100) view.blocked = { kind: "weekly", resetsAt: view.weekly.resetsAt };

  return {
    view, history, settings,
    messagesLeft: messagesLeft(view, history),
    signedIn: true,
    account: { id: null, label: null, count: 1 } // the popup expects this; we only track one account
  };
}

// "About how many messages until 100%?" = what's left / average cost of the last few messages.
function messagesLeft(view, history) {
  if (view.blocked) return 0;
  if (!view.session) return null;
  const recent = history.filter((h) => h.delta >= 0).slice(0, 8);
  if (recent.length < 2) return null;
  const average = recent.reduce((sum, h) => sum + h.delta, 0) / recent.length;
  if (average <= 0) return null;
  return Math.max(0, Math.floor((100 - view.session.pct) / average));
}

// The small number on the toolbar icon.
async function updateBadge() {
  const { view } = await getState();
  const pct = view.session ? view.session.pct : 0;
  await chrome.action.setBadgeText({ text: view.session ? pct + "%" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: pct >= 90 ? "#d6453d" : pct >= 70 ? "#c98a00" : "#2f6fed" });
}

// ---------- messages from popup.js and content.js ----------

async function handleMessage(m) {
  switch (m && m.type) {
    case "getState":
      return getState();
    case "sse": // a reply finished
      await handleReply(m);
      return { ok: true };
    case "refreshUsage":
      await refreshUsage();
      return getState();
    case "setSettings": {
      const s = m.settings || {};
      await chrome.storage.local.set({ settings: {
        notify: !!s.notify,
        notifyOnLimit: !!s.notifyOnLimit,
        showWidget: !!s.showWidget,
        notifyAt: Math.min(100, Math.max(1, Math.round(Number(s.notifyAt) || 80)))
      } });
      return getState();
    }
    case "clearHistory":
      await chrome.storage.local.set({ history: [] });
      return getState();
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  handleMessage(m).then(sendResponse, (e) => { log("failed:", m && m.type, e); sendResponse(null); });
  return true; // we will answer later
});

// ---------- timers ----------

chrome.alarms.onAlarm.addListener((alarm) => {
  (async () => {
    if (alarm.name === "tick") await checkReset();    // every minute
    if (alarm.name === "poll") await refreshUsage();  // every 5 minutes
    await updateBadge();
  })().catch((e) => log("alarm failed:", e));
});

function start() {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
  chrome.alarms.create("poll", { periodInMinutes: 5 });
  refreshUsage();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
