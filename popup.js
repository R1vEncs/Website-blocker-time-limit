const input = document.getElementById("siteInput");
const addButton = document.getElementById("addButton");
const list = document.getElementById("siteList");
const emptyState = document.getElementById("emptyState");
const error = document.getElementById("error");

const RULE_ID_START = 1000;

function normalizeSite(inputValue) {
  let value = inputValue.trim().toLowerCase();

  value = value.replace(/^https?:\/\//, "");
  value = value.replace(/^www\./, "");
  value = value.split("/")[0];
  value = value.split("?")[0];
  value = value.split("#")[0];
  value = value.replace(/:\d+$/, "");

  const validDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value);

  if (!validDomain) {
    return null;
  }

  return value;
}

async function getSites() {
  const data = await chrome.storage.local.get({ sites: [] });
  return data.sites;
}

async function saveSites(sites) {
  await chrome.storage.local.set({ sites });
  await syncRules(sites);
  await render();
}

async function syncRules(sites) {
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();

  const oldRuleIds = existingRules
    .filter(rule => rule.id >= RULE_ID_START && rule.id < RULE_ID_START + 10000)
    .map(rule => rule.id);

  const newRules = sites.map((site, index) => {
    return {
      id: RULE_ID_START + index,
      priority: 1,
      action: {
        type: "block"
      },
      condition: {
        urlFilter: `||${site}^`,
        resourceTypes: ["main_frame"]
      }
    };
  });

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldRuleIds,
    addRules: newRules
  });
}

async function addSite() {
  error.textContent = "";

  const site = normalizeSite(input.value);

  if (!site) {
    error.textContent = "Enter a valid domain, for example youtube.com";
    return;
  }

  const sites = await getSites();

  if (sites.includes(site)) {
    error.textContent = "This site is already blocked.";
    return;
  }

  sites.push(site);
  input.value = "";

  await saveSites(sites);
}

async function removeSite(siteToRemove) {
  const sites = await getSites();
  const updatedSites = sites.filter(site => site !== siteToRemove);

  await saveSites(updatedSites);
}

async function render() {
  const sites = await getSites();

  list.innerHTML = "";
  emptyState.style.display = sites.length ? "none" : "block";

  sites.forEach(site => {
    const item = document.createElement("div");
    item.className = "site";

    const name = document.createElement("span");
    name.textContent = site;

    const removeButton = document.createElement("button");
    removeButton.className = "remove";
    removeButton.textContent = "Remove";

    removeButton.addEventListener("click", () => {
      removeSite(site);
    });

    item.appendChild(name);
    item.appendChild(removeButton);
    list.appendChild(item);
  });
}

addButton.addEventListener("click", addSite);

input.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    addSite();
  }
});

render();

// ---- Time-limited sites ----

const trackInput = document.getElementById("trackInput");
const trackMinutes = document.getElementById("trackMinutes");
const trackAddButton = document.getElementById("trackAddButton");
const trackList = document.getElementById("trackList");
const trackEmpty = document.getElementById("trackEmpty");
const trackError = document.getElementById("trackError");

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

async function getTracked() {
  const data = await chrome.storage.local.get({ tracked: [] });
  return data.tracked;
}

async function saveTracked(tracked) {
  await chrome.storage.local.set({ tracked });
  chrome.runtime.sendMessage("refresh"); // let the background flush + enforce
  await renderTracked();
}

async function addTracked() {
  trackError.textContent = "";

  const domain = normalizeSite(trackInput.value);
  const minutes = parseInt(trackMinutes.value, 10);

  if (!domain) {
    trackError.textContent = "Enter a valid domain, for example youtube.com";
    return;
  }

  if (!Number.isInteger(minutes) || minutes < 1) {
    trackError.textContent = "Enter a limit in minutes (1 or more).";
    return;
  }

  const tracked = await getTracked();

  if (tracked.some(t => t.domain === domain)) {
    trackError.textContent = "This site already has a time limit.";
    return;
  }

  tracked.push({ domain, limitMinutes: minutes });
  trackInput.value = "";
  trackMinutes.value = "";

  await saveTracked(tracked);
}

async function removeTracked(domainToRemove) {
  const tracked = await getTracked();
  const updated = tracked.filter(t => t.domain !== domainToRemove);
  await saveTracked(updated);
}

async function renderTracked() {
  const { tracked, usage, resetDate } = await chrome.storage.local.get({
    tracked: [],
    usage: {},
    resetDate: ""
  });

  // Treat yesterday's counters as zero until the background resets them.
  const use = resetDate === todayStr() ? usage : {};

  // Add the seconds elapsed since the active tab was last flushed, so the
  // count ticks up live instead of jumping once a minute.
  const session = await chrome.storage.session.get({
    activeDomain: null,
    activeSince: 0
  });
  if (session.activeDomain && session.activeSince) {
    const elapsed = Math.floor((Date.now() - session.activeSince) / 1000);
    if (elapsed > 0) {
      use[session.activeDomain] = (use[session.activeDomain] || 0) + elapsed;
    }
  }

  trackList.innerHTML = "";
  trackEmpty.style.display = tracked.length ? "none" : "block";

  tracked.forEach(t => {
    const used = use[t.domain] || 0;
    const limitSec = t.limitMinutes * 60;
    const over = used >= limitSec;

    const item = document.createElement("div");
    item.className = "site";

    const meta = document.createElement("div");
    meta.className = "meta";

    const name = document.createElement("span");
    name.textContent = t.domain;

    const time = document.createElement("span");
    time.className = over ? "time over" : "time";
    time.textContent = over
      ? `Blocked · ${formatTime(used)} / ${t.limitMinutes}m`
      : `${formatTime(used)} / ${t.limitMinutes}m`;

    meta.appendChild(name);
    meta.appendChild(time);

    const removeButton = document.createElement("button");
    removeButton.className = "remove";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => removeTracked(t.domain));

    item.appendChild(meta);
    item.appendChild(removeButton);
    trackList.appendChild(item);
  });
}

trackAddButton.addEventListener("click", addTracked);

trackInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    addTracked();
  }
});

trackMinutes.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    addTracked();
  }
});

// Wake the background so counters/reset are current, then keep the view live.
chrome.runtime.sendMessage("refresh");
renderTracked();
setInterval(renderTracked, 1000);