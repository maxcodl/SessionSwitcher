// popup.js — SessionSwitcher popup logic

const els = {
  domain: document.getElementById("domain"),
  passphrase: document.getElementById("passphrase"),
  accountName: document.getElementById("accountName"),
  saveBtn: document.getElementById("saveBtn"),
  accounts: document.getElementById("accounts"),
  emptyState: document.getElementById("empty-state"),
  status: document.getElementById("status"),
  quotaOffset: document.getElementById("quotaResetOffset"),
  resetText: document.getElementById("selectedResetText"),
  clearBtn: document.getElementById("clearBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
};

let activeTab = null;
let activeDomain = null;
let storageKey = null;
let timerInterval = null;
let passDebounceTimer = null;

const DEFAULT_SVG_ICON = "icon-bot";

init();

async function init() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      setStatus("Page cannot be managed (not http/https).", "error");
      els.saveBtn.disabled = true;
      return;
    }
    activeTab = tab;
    activeDomain = new URL(tab.url).hostname;
    storageKey = `accounts::${activeDomain}`;
    els.domain.textContent = activeDomain;

    setupPresetButtons();
    await renderAccounts();

    // Refresh quota countdowns and active-session highlighting every minute
    timerInterval = setInterval(renderAccounts, 60000);
  } catch (err) {
    setStatus(`Initialization failed: ${err.message}`, "error");
  }
}

function setupPresetButtons() {
  document.querySelectorAll(".chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hours = parseFloat(btn.dataset.hours);
      els.quotaOffset.value = hours;
      els.resetText.textContent = hours > 0 ? `(+${hours}h)` : "";
    });
  });
}

function createSSIcon(iconId) {
  const svgNS = "http://www.w3.org/2000/svg";
  const xlinkNS = "http://www.w3.org/1999/xlink";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "ss-icon");
  const use = document.createElementNS(svgNS, "use");
  use.setAttributeNS(xlinkNS, "xlink:href", `#${iconId}`);
  svg.appendChild(use);
  return svg;
}

els.saveBtn.addEventListener("click", saveCurrentSession);
els.clearBtn.addEventListener("click", clearSiteData);
els.exportBtn.addEventListener("click", exportAllAccounts);
els.importBtn.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importAccountsFromFile(file);
  e.target.value = ""; // allow re-selecting the same file later
});

// Re-check active-session highlighting shortly after the passphrase
// changes, since encrypted accounts can only be verified against the
// current session once we're able to decrypt them.
els.passphrase.addEventListener("input", () => {
  clearTimeout(passDebounceTimer);
  passDebounceTimer = setTimeout(renderAccounts, 400);
});

async function saveCurrentSession() {
  const name = els.accountName.value.trim();
  const pass = els.passphrase.value;
  const hours = parseFloat(els.quotaOffset.value) || 0;

  if (!name) {
    setStatus("Please enter an account name.", "error");
    return;
  }

  try {
    setStatus("Capturing cookies…");
    const rawCookies = await ext.cookies.getAll({ url: activeTab.url });

    if (rawCookies.length === 0) {
      setStatus("No cookies found for this tab.", "error");
      return;
    }

    const serialized = rawCookies.map(serializeCookie);
    const payload = pass ? await encryptData(serialized, pass) : { plain: serialized };

    const accounts = await getAccounts();
    const quotaResetAt = hours > 0 ? Date.now() + hours * 3600 * 1000 : null;

    accounts[name] = {
      svgIconId: DEFAULT_SVG_ICON,
      savedAt: Date.now(),
      quotaResetAt,
      isEncrypted: !!pass,
      data: payload,
    };

    await setAccounts(accounts);
    els.accountName.value = "";
    els.quotaOffset.value = "0";
    els.resetText.textContent = "";
    setStatus(`Saved session "${name}" (${rawCookies.length} cookies).`, "success");
    await renderAccounts();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, "error");
  }
}

async function renderAccounts() {
  const accounts = await getAccounts();
  const names = Object.keys(accounts).sort((a, b) => a.localeCompare(b));

  let currentCookies = [];
  try {
    currentCookies = await ext.cookies.getAll({ url: activeTab.url });
  } catch (err) {
    currentCookies = [];
  }

  // NEW: Check if content.js found a warning on this page
  const alertKey = `quotaAlert::${activeDomain}`;
  const alertRes = await ext.storage.local.get(alertKey);
  const pendingAlert = alertRes[alertKey];

  els.accounts.innerHTML = "";
  els.emptyState.style.display = names.length === 0 ? "block" : "none";

  let anyActive = false;
  let accountsUpdated = false;


  for (const name of names) {
    const acc = accounts[name];
    const card = document.createElement("div");
    card.className = "account-card";

    const isActive = await isAccountActive(acc, currentCookies);
    if (isActive) {
      card.classList.add("active-account");
      anyActive = true;

      // NEW: If this account is active and a warning was found, apply the warning!
      if (pendingAlert && acc.quotaState !== pendingAlert) {
        acc.quotaState = pendingAlert;
        accountsUpdated = true;
      }
    }

    // NEW: Proper placement of quotaState logic inside the loop
    if (acc.quotaState === "90") {
      card.classList.add("warning-account");
    } else if (acc.quotaState === "100") {
      card.classList.add("critical-warning");
    }

    const header = document.createElement("div");
    header.className = "card-header";

    const titleArea = document.createElement("div");
    titleArea.className = "account-title-area";

    const icon = createSSIcon(acc.svgIconId || DEFAULT_SVG_ICON);
    icon.classList.add("account-icon");
    titleArea.appendChild(icon);
    titleArea.appendChild(document.createTextNode(name));

    if (isActive) {
      const activeBadge = document.createElement("span");
      activeBadge.className = "active-badge";
      activeBadge.textContent = "● Active now";
      titleArea.appendChild(activeBadge);
    }

    // NEW: Proper placement of badge rendering
    if (acc.quotaState === "90") {
      const warningBadge = document.createElement("span");
      warningBadge.className = "warning-badge";
      warningBadge.appendChild(createSSIcon("icon-alert"));
      warningBadge.appendChild(document.createTextNode("90% Used"));
      titleArea.appendChild(warningBadge);
    } else if (acc.quotaState === "100") {
      const criticalBadge = document.createElement("span");
      criticalBadge.className = "critical-badge";
      criticalBadge.appendChild(createSSIcon("icon-alert"));
      criticalBadge.appendChild(document.createTextNode("100% Limit"));
      titleArea.appendChild(criticalBadge);
    }

    const badge = document.createElement("div");
    badge.className = "quota-badge";
    formatQuotaBadge(badge, acc.quotaResetAt);

    header.append(titleArea, badge);

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const resetBtn = document.createElement("button");
    resetBtn.className = "action-btn";
    resetBtn.appendChild(createSSIcon("icon-plus"));
    resetBtn.appendChild(document.createTextNode("3h Reset"));
    resetBtn.title = "Quick set quota reset to 3 hours from now";
    resetBtn.onclick = () => updateQuotaReset(name, 3);

    const switchBtn = document.createElement("button");
    switchBtn.className = "action-btn main-btn";
    switchBtn.textContent = isActive ? "Re-apply" : "Switch Account";
    switchBtn.onclick = () => switchToAccount(name);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "action-btn delete";
    deleteBtn.appendChild(createSSIcon("icon-trash"));
    deleteBtn.title = "Delete Account";
    deleteBtn.onclick = () => deleteAccount(name);

    actions.append(resetBtn, switchBtn, deleteBtn);
    card.append(header, actions);
    els.accounts.appendChild(card);
  }

  if (names.length > 0 && !anyActive) {
    const note = document.createElement("div");
    note.className = "no-match-note";
    note.textContent = "Current session doesn't match any saved account.";
    els.accounts.appendChild(note);
  }
  if (accountsUpdated) {
    await setAccounts(accounts);
    await ext.storage.local.remove(alertKey);
  }
}
// Determine whether a saved account's cookies match what's currently active
async function isAccountActive(acc, currentCookies) {
  let savedCookies = null;

  if (Array.isArray(acc.cookies)) {
    savedCookies = acc.cookies; // legacy pre-encryption format
  } else if (acc.isEncrypted) {
    const pass = els.passphrase.value;
    if (!pass) return false; // can't verify without the passphrase
    try {
      savedCookies = await decryptData(acc.data, pass);
    } catch (err) {
      return false; // wrong passphrase — silently skip, no error noise here
    }
  } else if (acc.data && Array.isArray(acc.data.plain)) {
    savedCookies = acc.data.plain;
  }

  if (!savedCookies || savedCookies.length === 0) return false;

  const currentMap = new Map(
    currentCookies.map((c) => [`${c.name}::${c.domain}::${c.path}`, c.value])
  );

  let matches = 0;
  for (const c of savedCookies) {
    const key = `${c.name}::${c.domain}::${c.path}`;
    if (currentMap.get(key) === c.value) matches++;
  }

  return matches / savedCookies.length >= 0.7;
}

function formatQuotaBadge(el, resetAt) {
  el.innerHTML = "";

  if (!resetAt) {
    const icon = createSSIcon("icon-check-circle");
    icon.classList.add("badge-icon");
    el.appendChild(icon);
    el.appendChild(document.createTextNode("Ready"));
    el.className = "quota-badge quota-ready";
    return;
  }

  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) {
    const icon = createSSIcon("icon-check-circle");
    icon.classList.add("badge-icon");
    el.appendChild(icon);
    el.appendChild(document.createTextNode("Ready"));
    el.className = "quota-badge quota-ready";
  } else {
    const icon = createSSIcon("icon-hourglass");
    icon.classList.add("badge-icon");
    el.appendChild(icon);

    const mins = Math.ceil(diffMs / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const timeStr = `${h > 0 ? `${h}h ` : ""}${m}m`;
    el.appendChild(document.createTextNode(timeStr));
    el.className = "quota-badge quota-cooldown";
  }
}

// NEW: Updated to clear quotaState instead of quotaWarning
async function updateQuotaReset(name, hours) {
  const accounts = await getAccounts();
  if (accounts[name]) {
    accounts[name].quotaResetAt = Date.now() + hours * 3600 * 1000;
    accounts[name].quotaState = null;
    await setAccounts(accounts);
    await renderAccounts();
  }
}

async function switchToAccount(name) {
  try {
    const pass = els.passphrase.value;
    setStatus(`Switching to "${name}"…`);
    const accounts = await getAccounts();
    const acc = accounts[name];

    if (!acc) {
      setStatus("Account not found.", "error");
      return;
    }

    let cookies = [];

    if (Array.isArray(acc.cookies)) {
      cookies = acc.cookies;
    } else if (acc.isEncrypted) {
      if (!pass) {
        setStatus("Enter passphrase to decrypt this session.", "error");
        return;
      }
      cookies = await decryptData(acc.data, pass);
    } else if (acc.data && Array.isArray(acc.data.plain)) {
      cookies = acc.data.plain;
    } else {
      setStatus("This saved account is in an unrecognized format.", "error");
      return;
    }

    const response = await ext.runtime.sendMessage({
      type: "SWITCH_ACCOUNT",
      domain: activeDomain,
      tabUrl: activeTab.url,
      tabId: activeTab.id,
      cookies,
    });

    if (response && response.ok) {
      setStatus(`Switched! Reloading tab…`, "success");
      window.close();
    } else {
      setStatus(`Switch failed: ${response?.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    if (err && err.name === "OperationError") {
      setStatus("Switch failed: incorrect passphrase.", "error");
    } else {
      setStatus(`Switch failed: ${err.message}`, "error");
    }
  }
}

async function clearSiteData() {
  const confirmed = confirm(
    `This will log you out of ${activeDomain} by clearing its cookies, ` +
    `local storage, and IndexedDB. This does NOT delete any saved accounts. Continue?`
  );
  if (!confirmed) return;

  try {
    setStatus("Clearing cookies and site data…");
    const response = await ext.runtime.sendMessage({
      type: "CLEAR_COOKIES",
      domain: activeDomain,
      tabUrl: activeTab.url,
      tabId: activeTab.id,
      alsoClearStorage: true,
    });

    if (response && response.ok) {
      setStatus(response.warning ? response.warning : "Cleared. Reloading tab…", response.warning ? "error" : "success");
      window.close();
    } else {
      setStatus(`Clear failed: ${response?.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    setStatus(`Clear failed: ${err.message}`, "error");
  }
}

async function exportAllAccounts() {
  try {
    setStatus("Preparing export…");
    const all = await ext.storage.local.get(null);
    const accountEntries = Object.fromEntries(
      Object.entries(all).filter(([key]) => key.startsWith("accounts::"))
    );

    if (Object.keys(accountEntries).length === 0) {
      setStatus("Nothing to export yet.", "error");
      return;
    }

    const exportPayload = {
      format: "sessionswitcher-export",
      version: 1,
      exportedAt: Date.now(),
      accounts: accountEntries,
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `sessionswitcher-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus(`Exported ${Object.keys(accountEntries).length} domain(s).`, "success");
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, "error");
  }
}

async function importAccountsFromFile(file) {
  try {
    setStatus("Reading import file…");
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!parsed || parsed.format !== "sessionswitcher-export" || typeof parsed.accounts !== "object") {
      setStatus("That doesn't look like a valid export file.", "error");
      return;
    }

    const domainKeys = Object.keys(parsed.accounts);
    if (domainKeys.length === 0) {
      setStatus("Import file has no accounts.", "error");
      return;
    }

    let importedCount = 0;
    let overwriteCount = 0;

    for (const domainKey of domainKeys) {
      const incoming = parsed.accounts[domainKey] || {};
      const existingResult = await ext.storage.local.get(domainKey);
      const existing = existingResult[domainKey] || {};

      for (const accountName of Object.keys(incoming)) {
        if (existing[accountName]) overwriteCount++;
        else importedCount++;
      }

      const merged = { ...existing, ...incoming };
      await ext.storage.local.set({ [domainKey]: merged });
    }

    let msg = `Imported ${importedCount} account(s) across ${domainKeys.length} domain(s).`;
    if (overwriteCount > 0) msg += ` (${overwriteCount} overwritten.)`;
    setStatus(msg, "success");

    await renderAccounts();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, "error");
  }
}

async function deleteAccount(name) {
  const accounts = await getAccounts();
  delete accounts[name];
  await setAccounts(accounts);
  await renderAccounts();
}

async function getAccounts() {
  const res = await ext.storage.local.get(storageKey);
  return res[storageKey] || {};
}

async function setAccounts(accounts) {
  await ext.storage.local.set({ [storageKey]: accounts });
}

function serializeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
    hostOnly: c.hostOnly,
    storeId: c.storeId,
  };
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || "";
}