// background.js — MV3 service worker
// Firefox (109+) and Chrome both support service_worker for MV3 background.
// background.js — MV3 service worker (Chrome) / background script (Firefox)
//
// On Chrome this runs as a real service worker, so we pull in the compat
// shim via importScripts(). On Firefox (background.scripts mode), the
// manifest already loads browser-compat.js first, and importScripts()
// doesn't exist in that context — so we only call it if it's available.
if (typeof importScripts === "function") {
  importScripts("browser-compat.js");
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SWITCH_ACCOUNT") {
    handleSwitchAccount(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
  if (message?.type === "CLEAR_COOKIES") {
    handleClearCookies(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function handleSwitchAccount({ tabUrl, tabId, cookies }) {
  // 1. Remove every cookie currently visible to this page.
  const existing = await ext.cookies.getAll({ url: tabUrl });
  for (const cookie of existing) {
    try {
      await ext.cookies.remove({
        url: cookieUrl(cookie),
        name: cookie.name,
        storeId: cookie.storeId,
      });
    } catch (err) {
      // Non-fatal: keep going even if one cookie can't be removed.
      console.warn("Failed to remove cookie", cookie.name, err);
    }
  }

  // 2. Re-create every cookie from the saved account.
  const failures = [];
  for (const cookie of cookies) {
    try {
      await ext.cookies.set(buildSetDetails(cookie));
    } catch (err) {
      failures.push(`${cookie.name}: ${err.message}`);
    }
  }

  // 3. Reload the tab so the site picks up the new session.
  if (typeof tabId === "number") {
    await ext.tabs.reload(tabId);
  }

  if (failures.length > 0) {
    return {
      ok: true,
      warning: `Some cookies could not be restored: ${failures.join("; ")}`,
    };
  }
  return { ok: true };
}

// NEW: manually clear cookies (and optionally localStorage/sessionStorage/
// IndexedDB) for the active tab's domain — useful for sites like Coda that
// cache auth state client-side, where clearing cookies alone isn't enough
// to force a real logout before switching accounts.
async function handleClearCookies({ tabUrl, tabId, alsoClearStorage }) {
  const existing = await ext.cookies.getAll({ url: tabUrl });
  const cookieFailures = [];
  for (const cookie of existing) {
    try {
      await ext.cookies.remove({
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
      await ext.scripting.executeScript({
        target: { tabId },
        func: clearPageStorage,
      });
    } catch (err) {
      storageWarning = `Could not clear page storage: ${err.message}`;
    }
  }

  if (typeof tabId === "number") {
    await ext.tabs.reload(tabId);
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

// This function is injected into the page itself via chrome.scripting,
// so it runs in the page's context, not the extension's.
function clearPageStorage() {
  try {
    localStorage.clear();
  } catch (e) {
    /* ignore — some pages restrict storage access */
  }
  try {
    sessionStorage.clear();
  } catch (e) {
    /* ignore */
  }
  try {
    if (indexedDB.databases) {
      indexedDB.databases().then((dbs) => {
        dbs.forEach((db) => {
          if (db.name) indexedDB.deleteDatabase(db.name);
        });
      });
    }
  } catch (e) {
    /* ignore — indexedDB.databases() isn't supported everywhere */
  }
}

// Builds the URL chrome.cookies.remove/set needs to identify a cookie.
function cookieUrl(cookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`;
}

function buildSetDetails(cookie) {
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };

  // Only set `domain` for domain-cookies (leading dot). Host-only cookies
  // should be left without a domain so the browser derives it from `url`.
  if (!cookie.hostOnly && cookie.domain) {
    details.domain = cookie.domain;
  }

  // Normalize sameSite across browsers; fall back to a safe default.
  const validSameSite = ["no_restriction", "lax", "strict"];
  if (validSameSite.includes(cookie.sameSite)) {
    details.sameSite = cookie.sameSite;
  }

  // Omit expirationDate entirely for session cookies.
  if (typeof cookie.expirationDate === "number") {
    details.expirationDate = cookie.expirationDate;
  }

  if (cookie.storeId) {
    details.storeId = cookie.storeId;
  }

  return details;
}