// Time-limit tracking + enforcement.
// Counts seconds spent on the active tab of a tracked domain. When today's
// usage reaches the domain's daily limit, the domain is blocked with a
// dynamic rule. All counters reset at local midnight.

const TRACK_RULE_ID_START = 20000; // separate range from popup's blocked list (1000+)
const IDLE_SECONDS = 60;

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function domainMatches(hostname, domain) {
  hostname = hostname.toLowerCase();
  return hostname === domain || hostname.endsWith("." + domain);
}

async function getStore() {
  return chrome.storage.local.get({ tracked: [], usage: {}, resetDate: "" });
}

async function getSession() {
  return chrome.storage.session.get({ activeDomain: null, activeSince: 0 });
}

// Returns the tracked domain the user is actively looking at, or null.
async function currentActiveDomain(tracked) {
  if (!tracked.length) return null;

  const idleState = await chrome.idle.queryState(IDLE_SECONDS);
  if (idleState !== "active") return null;

  let win;
  try {
    win = await chrome.windows.getLastFocused();
  } catch {
    return null;
  }
  if (!win || !win.focused) return null; // Chrome is not the focused application

  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab || !tab.url) return null;

  let host;
  try {
    host = new URL(tab.url).hostname;
  } catch {
    return null;
  }

  const match = tracked.find(t => domainMatches(host, t.domain));
  return match ? match.domain : null;
}

// Add/remove block rules so every over-limit domain is blocked and nothing else
// in the track range lingers.
async function enforce(tracked, usage) {
  const addRules = [];
  const removeRuleIds = [];

  tracked.forEach((t, index) => {
    const id = TRACK_RULE_ID_START + index;
    removeRuleIds.push(id); // remove first to avoid "rule id already exists"

    const used = usage[t.domain] || 0;
    const limit = t.limitMinutes * 60;

    if (used >= limit) {
      addRules.push({
        id,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: `||${t.domain}^`,
          resourceTypes: ["main_frame"]
        }
      });
    }
  });

  // Clean up any stale track rules left from removed sites.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  existing.forEach(rule => {
    if (
      rule.id >= TRACK_RULE_ID_START &&
      rule.id < TRACK_RULE_ID_START + 10000 &&
      !removeRuleIds.includes(rule.id)
    ) {
      removeRuleIds.push(rule.id);
    }
  });

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function _tick() {
  const store = await getStore();
  const today = todayStr();

  // Daily reset at local midnight.
  if (store.resetDate !== today) {
    store.usage = {};
    store.resetDate = today;
    await chrome.storage.local.set({ usage: {}, resetDate: today });
    await enforce(store.tracked, {});
  }

  const session = await getSession();
  const now = Date.now();

  // Credit elapsed time to whatever domain was active since last tick.
  if (session.activeDomain && session.activeSince) {
    const elapsedSec = Math.floor((now - session.activeSince) / 1000);
    if (elapsedSec > 0) {
      store.usage[session.activeDomain] =
        (store.usage[session.activeDomain] || 0) + elapsedSec;
      await chrome.storage.local.set({ usage: store.usage });
    }
  }

  // Recompute the current active domain and reset the timer baseline.
  const domain = await currentActiveDomain(store.tracked);
  await chrome.storage.session.set({ activeDomain: domain, activeSince: now });

  await enforce(store.tracked, store.usage);
}

// Serialize ticks so overlapping events don't double-count.
let chain = Promise.resolve();
function tick() {
  chain = chain.then(_tick).catch(err => console.error("tick error", err));
  return chain;
}

chrome.tabs.onActivated.addListener(() => tick());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === "complete") tick();
});
chrome.windows.onFocusChanged.addListener(() => tick());

chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener(() => tick());

chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => tick());

chrome.runtime.onInstalled.addListener(() => tick());
chrome.runtime.onStartup.addListener(() => tick());

// Popup asks us to flush/enforce right after it changes the tracked list.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg === "refresh") {
    tick().then(() => sendResponse(true));
    return true; // keep the message channel open for the async response
  }
});
