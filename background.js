// background.js — MV3 service worker

// Firefox (109+) and Chrome both support service_worker for MV3 background.
if (typeof importScripts === "function") {
  importScripts("browser-compat.js");
}

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SWITCH_ACCOUNT") {
    handleSwitchAccount(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "CLEAR_COOKIES") {
    handleClearCookies(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function handleSwitchAccount({ domain, tabUrl, tabId, cookies }) {
  let backupCookies = [];
  try {
    // 1. Capture current cookies for rollback in case of partial failure
    backupCookies = await api.cookies.getAll({ url: tabUrl });

    // 2. Remove every cookie currently visible to this page.
    await clearCookiesForUrl(tabUrl);
    await clearPageStorage(tabId);

    // 3. Re-create every cookie from the saved account with strict validation.
    const failures = [];
    for (const cookie of cookies) {
      // Validate that the injected cookie actually belongs to the active domain
      if (!cookie.domain.endsWith(domain) && !domain.endsWith(cookie.domain)) {
        console.warn(`[SessionSwitcher] Rejected mismatched cookie domain: ${cookie.domain}`);
        continue;
      }

      try {
        await api.cookies.set(buildSetDetails(cookie));
      } catch (err) {
        failures.push(`${cookie.name}: ${err.message}`);
      }
    }

    // 4. Reload the tab so the site picks up the new session.
    if (typeof tabId === "number") {
      await api.tabs.reload(tabId);
    }

    if (failures.length > 0) {
      return {
        ok: true,
        warning: `Some cookies could not be restored: ${failures.join("; ")}`,
      };
    }
    return { ok: true };

  } catch (error) {
    // Failsafe Rollback: Restore backup cookies if the core injection crashed
    if (backupCookies.length > 0) {
      console.log("[SessionSwitcher] Switch failed, attempting rollback...");
      await clearCookiesForUrl(tabUrl);
      for (const bc of backupCookies) {
        try {
          await api.cookies.set(buildSetDetails(bc));
        } catch (e) { /* ignore rollback errors */ }
      }
    }
    return { ok: false, error: error.message };
  }
}

async function handleClearCookies({ tabUrl, tabId, alsoClearStorage }) {
  const existing = await api.cookies.getAll({ url: tabUrl });
  const cookieFailures = [];

  for (const cookie of existing) {
    try {
      await api.cookies.remove({
        url: cookieUrl(cookie),
        name: cookie.name,
        storeId: cookie.storeId,
      });
    } catch (err) {
      cookieFailures.push(`${cookie.name}: ${err.message}`);
    }
  }

  let storageWarning = null;
  if (alsoClearStorage && typeof tabId === "number") {
    try {
      await clearPageStorage(tabId);
    } catch (err) {
      storageWarning = `Could not clear page storage: ${err.message}`;
    }
  }

  if (typeof tabId === "number") {
    await api.tabs.reload(tabId);
  }

  if (cookieFailures.length > 0 || storageWarning) {
    const parts = [];
    if (cookieFailures.length > 0) {
      parts.push(`Some cookies could not be removed: ${cookieFailures.join("; ")}`);
    }
    if (storageWarning) parts.push(storageWarning);
    return { ok: true, warning: parts.join(" | ") };
  }
  return { ok: true };
}

// Clears cookies specifically using the constructed URL
async function clearCookiesForUrl(url) {
  const currentCookies = await api.cookies.getAll({ url });
  const clearPromises = currentCookies.map((c) =>
    api.cookies.remove({
      url: cookieUrl(c),
      name: c.name,
      storeId: c.storeId,
    })
  );
  await Promise.all(clearPromises);
}

// Injects the cleanup script into the page context
async function clearPageStorage(tabId) {
  await api.scripting.executeScript({
    target: { tabId: tabId },
    func: async () => {
      try { localStorage.clear(); } catch (e) { }
      try { sessionStorage.clear(); } catch (e) { }

      try {
        if (indexedDB.databases) {
          const dbs = await indexedDB.databases();
          const deletePromises = dbs.map(db => new Promise((resolve, reject) => {
            if (!db.name) return resolve();
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = () => resolve();
            req.onerror = () => reject();
            req.onblocked = () => resolve();
          }));
          await Promise.all(deletePromises);
        }
      } catch (e) { }
    }
  });
}

// Builds the URL chrome.cookies.remove/set needs to identify a cookie.
function cookieUrl(cookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`;
}

// Accurately formats the cookie object for the browser API
function buildSetDetails(cookie) {
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };

  if (!cookie.hostOnly && cookie.domain) {
    details.domain = cookie.domain;
  }

  const validSameSite = ["no_restriction", "lax", "strict"];
  if (validSameSite.includes(cookie.sameSite)) {
    details.sameSite = cookie.sameSite;
  }

  if (typeof cookie.expirationDate === "number") {
    details.expirationDate = cookie.expirationDate;
  }

  if (cookie.storeId) {
    details.storeId = cookie.storeId;
  }

  return details;
}