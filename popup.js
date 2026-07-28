// popup.js — SessionSwitcher popup logic

const els = {
  domain: document.getElementById("domain"),
  passphrase: document.getElementById("passphrase"),
  accountName: document.getElementById("accountName"),
  saveBtn: document.getElementById("saveBtn"),
  accounts: document.getElementById("accounts"),
  emptyState: document.getElementById("empty-state"),
  status: document.getElementById("status"),
  clearBtn: document.getElementById("clearBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  toggleAddBtn: document.getElementById("toggleAddBtn"),
  addAccountForm: document.getElementById("add-account-form"),
};

let activeTab = null;
let activeDomain = null;
let storageKey = null;
let activeAccountKey = null;
let timerInterval = null;

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
    activeAccountKey = `activeAccount::${activeDomain}`;
    els.domain.textContent = activeDomain;

    await renderAccounts();
    timerInterval = setInterval(renderAccounts, 60000);
  } catch (err) {
    setStatus(`Initialization failed: ${err.message}`, "error");
  }
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

els.toggleAddBtn.addEventListener("click", () => {
  const isHidden = els.addAccountForm.style.display === "none";
  els.addAccountForm.style.display = isHidden ? "block" : "none";
});

els.saveBtn.addEventListener("click", saveCurrentSession);
els.clearBtn.addEventListener("click", clearSiteData);
els.exportBtn.addEventListener("click", exportAllAccounts);
els.importBtn.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importAccountsFromFile(file);
  e.target.value = "";
});

async function saveCurrentSession() {
  const name = els.accountName.value.trim();
  const pass = els.passphrase.value;

  if (!name) {
    setStatus("Please enter an account name.", "error");
    return;
  }

  const accounts = await getAccounts();
  if (accounts[name] && !confirm(`An account named "${name}" already exists. Overwrite it?`)) {
    return;
  }

  if (!pass) {
    console.warn("[SessionSwitcher] Warning: Saving account without a passphrase stores cookies in plaintext.");
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

    accounts[name] = {
      svgIconId: DEFAULT_SVG_ICON,
      savedAt: Date.now(),
      quotaResetAt: null,
      isEncrypted: !!pass,
      data: payload,
    };

    await setAccounts(accounts);
    await ext.storage.local.set({ [activeAccountKey]: name });

    els.accountName.value = "";
    els.passphrase.value = "";
    els.addAccountForm.style.display = "none";

    setStatus(`Saved session "${name}" (${rawCookies.length} cookies).`, "success");
    await renderAccounts();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, "error");
  }
}

// NEW: Updates an existing session by fetching the current live browser cookies
async function updateAccount(name, inlinePassphrase = "") {
  try {
    setStatus(`Updating "${name}"…`);
    const accounts = await getAccounts();
    const acc = accounts[name];

    if (!acc) {
      setStatus("Account not found.", "error");
      return;
    }

    const rawCookies = await ext.cookies.getAll({ url: activeTab.url });
    if (rawCookies.length === 0) {
      setStatus("No cookies found to update.", "error");
      return;
    }

    const serialized = rawCookies.map(serializeCookie);
    let payload;

    if (acc.isEncrypted) {
      if (!inlinePassphrase) {
        setStatus("Enter passphrase to update this session.", "error");
        return;
      }
      try {
        // Validate the password before attempting to overwrite the data
        await decryptData(acc.data, inlinePassphrase);
      } catch (e) {
        setStatus("Update failed: Incorrect passphrase.", "error");
        return;
      }
      payload = await encryptData(serialized, inlinePassphrase);
    } else {
      payload = { plain: serialized };
    }

    acc.data = payload;
    acc.savedAt = Date.now();

    await setAccounts(accounts);
    setStatus(`Successfully updated "${name}"!`, "success");
    await renderAccounts();
  } catch (err) {
    setStatus(`Update failed: ${err.message}`, "error");
  }
}

async function renderAccounts() {
  navigator.locks.request("sessionswitcher_storage", async () => {
    const accounts = await getAccounts();
    const names = Object.keys(accounts).sort((a, b) => a.localeCompare(b));

    const res = await ext.storage.local.get([activeAccountKey]);
    const activeAccountName = res[activeAccountKey];

    els.accounts.innerHTML = "";
    els.emptyState.style.display = names.length === 0 ? "block" : "none";

    let anyActive = false;
    let accountsUpdated = false;

    for (const name of names) {
      const acc = accounts[name];
      const card = document.createElement("div");
      card.className = "account-card";

      const isActive = (name === activeAccountName);

      if (isActive) {
        card.classList.add("active-account");
        anyActive = true;
      }

      if (acc.quotaState && acc.quotaResetAt && Date.now() >= acc.quotaResetAt) {
        acc.quotaState = null;
        acc.quotaResetAt = null;
        accountsUpdated = true;
      }

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

      const nameSpan = document.createElement("span");
      nameSpan.className = "account-name-text";
      nameSpan.textContent = name;
      titleArea.appendChild(nameSpan);

      if (isActive) {
        const activeBadge = document.createElement("span");
        activeBadge.className = "active-badge";
        activeBadge.textContent = "● Active now";
        titleArea.appendChild(activeBadge);
      }

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
      card.append(header);

      let passInput = null;

      if (acc.isEncrypted) {
        const lockIcon = createSSIcon("icon-lock");
        lockIcon.style.color = "var(--muted)";
        titleArea.insertBefore(lockIcon, nameSpan);

        passInput = document.createElement("input");
        passInput.type = "password";
        passInput.className = "card-pass-input";
        passInput.placeholder = "Enter passphrase to unlock...";
        passInput.style.display = "none";

        passInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            isActive ? updateAccount(name, passInput.value) : switchToAccount(name, passInput.value);
          }
        });
        card.append(passInput);
      }

      const actions = document.createElement("div");
      actions.className = "card-actions";

      const switchBtn = document.createElement("button");
      switchBtn.className = "action-btn main-btn";
      switchBtn.textContent = isActive ? "Update Session" : "Switch Account";

      switchBtn.onclick = () => {
        if (passInput && passInput.style.display === "none") {
          passInput.style.display = "block";
          passInput.focus();
          switchBtn.textContent = "Confirm";
        } else {
          // Detect whether to Switch or Update based on the active state
          if (isActive) {
            updateAccount(name, passInput ? passInput.value : "");
          } else {
            switchToAccount(name, passInput ? passInput.value : "");
          }
        }
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "action-btn delete";
      deleteBtn.appendChild(createSSIcon("icon-trash"));
      deleteBtn.title = "Delete Account";
      deleteBtn.onclick = () => deleteAccount(name);

      actions.append(switchBtn, deleteBtn);
      card.append(actions);
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
    }
  });
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

async function switchToAccount(name, inlinePassphrase = "") {
  try {
    setStatus(`Switching to "${name}"…`);
    const accounts = await getAccounts();
    const acc = accounts[name];

    if (!acc) {
      setStatus("Account not found.", "error");
      return;
    }

    acc.quotaState = null;
    acc.quotaResetAt = null;

    await setAccounts(accounts);
    await ext.storage.local.set({ [activeAccountKey]: name });

    let cookies = [];
    if (Array.isArray(acc.cookies)) {
      cookies = acc.cookies;
    } else if (acc.isEncrypted) {
      if (!inlinePassphrase) {
        setStatus("Enter passphrase to decrypt this session.", "error");
        return;
      }
      cookies = await decryptData(acc.data, inlinePassphrase);
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
      await ext.storage.local.remove(activeAccountKey);
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

    const hasPlaintext = Object.values(accountEntries).some(accs =>
      Object.values(accs).some(acc => !acc.isEncrypted)
    );
    if (hasPlaintext) {
      const confirmed = confirm(
        "WARNING: You are exporting unencrypted sessions.\n\n" +
        "Anyone who possesses this JSON file will be able to access those accounts. Do you wish to continue?"
      );
      if (!confirmed) {
        setStatus("Export cancelled.", "success");
        return;
      }
    }

    const exportPayload = {
      format: "sessionswitcher-export",
      version: 1,
      exportedAt: Date.now(),
      accounts: accountEntries,
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
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
    let errorCount = 0;

    for (const domainKey of domainKeys) {
      const incoming = parsed.accounts[domainKey] || {};
      const existingResult = await ext.storage.local.get(domainKey);
      const existing = existingResult[domainKey] || {};
      const validIncoming = {};

      for (const [accountName, acc] of Object.entries(incoming)) {
        if (!acc || typeof acc !== "object" || !acc.data || (!acc.data.plain && !acc.data.iv && !Array.isArray(acc.cookies))) {
          errorCount++;
          continue;
        }

        validIncoming[accountName] = acc;
        if (existing[accountName]) overwriteCount++;
        else importedCount++;
      }

      if (Object.keys(validIncoming).length > 0) {
        const merged = { ...existing, ...validIncoming };
        await ext.storage.local.set({ [domainKey]: merged });
      }
    }

    let msg = `Imported ${importedCount} account(s) across ${domainKeys.length} domain(s).`;
    if (overwriteCount > 0) msg += ` (${overwriteCount} overwritten.)`;
    if (errorCount > 0) msg += ` (${errorCount} invalid skipped.)`;
    setStatus(msg, errorCount > 0 ? "error" : "success");

    await renderAccounts();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, "error");
  }
}

async function deleteAccount(name) {
  const accounts = await getAccounts();
  delete accounts[name];

  const res = await ext.storage.local.get(activeAccountKey);
  if (res[activeAccountKey] === name) {
    await ext.storage.local.remove(activeAccountKey);
  }

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