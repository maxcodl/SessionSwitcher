# Context Handoff — "SessionSwitcher" Browser Extension

Paste this whole document as your first message in a new chat to resume exactly where this conversation left off. It contains the full project spec, every file's current content, the reasoning behind key decisions, and open next steps.

---

## 1. Project Summary

A cross-browser (Chrome + Firefox) **Manifest V3** extension that lets a user save and instantly switch between multiple logged-in sessions on any website, by capturing and swapping cookies.

**Core features (all implemented):**
1. Popup detects the active tab's domain and shows only accounts saved for that domain.
2. "Save current" button captures all cookies visible to the active tab under a user-given account name.
3. Clicking a saved account clears existing cookies for that domain, restores the saved cookie set, and reloads the tab.
4. Saved profiles persist in `chrome.storage.local`, keyed per-domain.

**Permissions used:** `cookies`, `storage`, `tabs`, `host_permissions: ["<all_urls>"]` — deliberately minimal for what the feature needs.

---

## 2. Key Technical Decisions & Rationale

- **Background service worker owns all cookie mutation logic** (not the popup) — avoids race conditions between removing old cookies and setting new ones, and keeps the popup as a thin UI layer that just sends a `SWITCH_ACCOUNT` message.
- **Cross-browser compatibility via a tiny shim, not a full polyfill file**: `const ext = typeof browser !== "undefined" ? browser : chrome;` — Firefox's native `browser.*` is Promise-based; Chrome's `chrome.*` also returns Promises for `cookies`/`storage`/`tabs` methods in MV3 when no callback is passed. This covers everything needed here with 2 lines instead of shipping `webextension-polyfill.js`. Lives in `browser-compat.js`, loaded via `<script src>` in the popup and `importScripts()` in the background worker.
- **Firefox MV3 background quirk**: Firefox only supports `background.service_worker` from **v109+**. `manifest.json` sets `browser_specific_settings.gecko.strict_min_version: "109.0"` accordingly. (If older-Firefox support is ever needed, the Firefox build would need `"background": {"scripts": ["background.js"]}` instead — Firefox still allows persistent background scripts as a fallback, unlike Chrome.)
- **Cookie capture uses `cookies.getAll({url: tab.url})`**, not `{domain}` — this correctly captures parent-domain cookies visible to the page, not just exact-host cookies.
- **Cookie restoration logic (in `background.js`)**:
  - Builds a `url` per cookie from `domain` + `path` + `secure` to satisfy the API's addressing requirements.
  - Only sets the `domain` field on the `cookies.set()` call for non-host-only cookies (domain cookies), so host-only cookies are correctly recreated as host-only rather than accidentally becoming domain cookies.
  - Normalizes `sameSite` to the three values Chrome's API accepts (`no_restriction`, `lax`, `strict`), omitting it otherwise.
  - Omits `expirationDate` entirely for session cookies (so they stay session cookies).
  - Non-fatal per-cookie error handling — one bad cookie doesn't abort the whole switch.
- **Storage schema**: `chrome.storage.local` key `accounts::<hostname>` → object map of `{ [accountName]: { savedAt, cookies: [...] } }`.
- **Icon**: generated programmatically (not hand-drawn) with Python/Pillow — two overlapping avatar-silhouette circles (accent blue + white) on a dark rounded-square background matching the popup's palette, plus a small green "swap" badge in the corner. Exported at 16/32/48/128px and wired into `manifest.json`'s `action.default_icon` and top-level `icons`.

---

## 3. Current File Tree

```
account-switcher/
├── manifest.json
├── popup.html
├── popup.js
├── background.js
├── browser-compat.js
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

All files below are the **current, final versions** already delivered to the user as downloadable files.

---

## 4. Full File Contents

### `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "SessionSwitcher",
  "version": "1.0.0",
  "description": "Save and instantly switch between multiple logged-in sessions on any website by swapping cookies.",

  "permissions": ["cookies", "storage", "tabs"],
  "host_permissions": ["<all_urls>"],

  "action": {
    "default_popup": "popup.html",
    "default_title": "SessionSwitcher",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },

  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },

  "background": {
    "service_worker": "background.js"
  },

  "browser_specific_settings": {
    "gecko": {
      "id": "quick-account-switcher@example.com",
      "strict_min_version": "109.0"
    }
  }
}
```

### `browser-compat.js`
```javascript
/**
 * Cross-browser compatibility shim.
 *
 * Firefox exposes a native, Promise-based `browser.*` API.
 * Chrome (MV3) exposes `chrome.*`, which also returns Promises for
 * cookies/storage/tabs methods as long as you don't pass a callback.
 *
 * This lets the rest of the code just call `ext.cookies.getAll(...)`
 * with `await`, everywhere, on both browsers.
 */
const ext = typeof browser !== "undefined" ? browser : chrome;
```

### `popup.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>SessionSwitcher</title>
<style>
  :root {
    --bg: #1e1f26;
    --panel: #2a2b35;
    --accent: #5b8cff;
    --danger: #ff5b6e;
    --text: #eceef2;
    --muted: #9a9db0;
  }
  * { box-sizing: border-box; }
  body {
    width: 320px;
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header {
    padding: 12px 14px;
    border-bottom: 1px solid #3a3b46;
  }
  header h1 {
    font-size: 14px;
    margin: 0 0 2px 0;
    font-weight: 600;
  }
  #domain {
    font-size: 12px;
    color: var(--muted);
    word-break: break-all;
  }
  #save-section {
    display: flex;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 1px solid #3a3b46;
  }
  #accountName {
    flex: 1;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid #45465280;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
  }
  button {
    cursor: pointer;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    padding: 6px 10px;
    font-weight: 600;
  }
  #saveBtn {
    background: var(--accent);
    color: white;
  }
  #saveBtn:hover { filter: brightness(1.1); }

  #accounts {
    max-height: 260px;
    overflow-y: auto;
    padding: 6px 0;
  }
  .account-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
  }
  .account-row:hover { background: var(--panel); }
  .account-name {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .switch-btn {
    background: #34364280;
    color: var(--text);
  }
  .switch-btn:hover { background: var(--accent); }
  .delete-btn {
    background: transparent;
    color: var(--danger);
    padding: 6px 8px;
  }
  .delete-btn:hover { background: #ff5b6e22; }

  #empty-state {
    padding: 20px 14px;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
  }
  #status {
    padding: 8px 14px;
    font-size: 11px;
    color: var(--muted);
    min-height: 14px;
  }
  #status.error { color: var(--danger); }
  #status.success { color: #4fd18b; }
</style>
</head>
<body>
  <header>
    <h1>SessionSwitcher</h1>
    <div id="domain">Loading domain…</div>
  </header>

  <div id="save-section">
    <input type="text" id="accountName" placeholder="Account name (e.g. Work)" maxlength="40" />
    <button id="saveBtn">Save current</button>
  </div>

  <div id="accounts"></div>
  <div id="empty-state" style="display:none;">No saved accounts for this site yet.</div>

  <div id="status"></div>

  <script src="browser-compat.js"></script>
  <script src="popup.js"></script>
</body>
</html>
```

### `popup.js`
```javascript
// popup.js — runs in the extension popup

const els = {
  domain: document.getElementById("domain"),
  accountName: document.getElementById("accountName"),
  saveBtn: document.getElementById("saveBtn"),
  accounts: document.getElementById("accounts"),
  emptyState: document.getElementById("empty-state"),
  status: document.getElementById("status"),
};

let activeTab = null;
let activeDomain = null;
let storageKey = null; // "accounts::<domain>"

init();

async function init() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      setStatus("This page can't be managed (not http/https).", "error");
      els.saveBtn.disabled = true;
      return;
    }
    activeTab = tab;
    activeDomain = new URL(tab.url).hostname;
    storageKey = `accounts::${activeDomain}`;

    els.domain.textContent = activeDomain;
    await renderAccounts();
  } catch (err) {
    setStatus(`Failed to read active tab: ${err.message}`, "error");
  }
}

els.saveBtn.addEventListener("click", saveCurrentSession);
els.accountName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveCurrentSession();
});

async function saveCurrentSession() {
  const name = els.accountName.value.trim();
  if (!name) {
    setStatus("Enter a name for this account first.", "error");
    return;
  }

  try {
    setStatus("Reading cookies…");
    // url-based lookup captures every cookie visible to this page,
    // including parent-domain cookies, not just exact-host cookies.
    const cookies = await ext.cookies.getAll({ url: activeTab.url });

    if (cookies.length === 0) {
      setStatus("No cookies found for this site.", "error");
      return;
    }

    const accounts = await getAccounts();
    accounts[name] = {
      savedAt: Date.now(),
      cookies: cookies.map(serializeCookie),
    };
    await setAccounts(accounts);

    els.accountName.value = "";
    setStatus(`Saved "${name}" (${cookies.length} cookies).`, "success");
    await renderAccounts();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, "error");
  }
}

async function renderAccounts() {
  const accounts = await getAccounts();
  const names = Object.keys(accounts).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );

  els.accounts.innerHTML = "";
  els.emptyState.style.display = names.length === 0 ? "block" : "none";

  for (const name of names) {
    const row = document.createElement("div");
    row.className = "account-row";

    const label = document.createElement("div");
    label.className = "account-name";
    label.textContent = name;
    label.title = `${accounts[name].cookies.length} cookies · saved ${new Date(
      accounts[name].savedAt
    ).toLocaleString()}`;

    const switchBtn = document.createElement("button");
    switchBtn.className = "switch-btn";
    switchBtn.textContent = "Switch";
    switchBtn.addEventListener("click", () => switchToAccount(name));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Delete this saved account";
    deleteBtn.addEventListener("click", () => deleteAccount(name));

    row.append(label, switchBtn, deleteBtn);
    els.accounts.appendChild(row);
  }
}

async function switchToAccount(name) {
  try {
    setStatus(`Switching to "${name}"…`);
    const accounts = await getAccounts();
    const account = accounts[name];
    if (!account) {
      setStatus("That account no longer exists.", "error");
      return;
    }

    const response = await ext.runtime.sendMessage({
      type: "SWITCH_ACCOUNT",
      domain: activeDomain,
      tabUrl: activeTab.url,
      tabId: activeTab.id,
      cookies: account.cookies,
    });

    if (response && response.ok) {
      setStatus(`Switched to "${name}". Reloading tab…`, "success");
      window.close();
    } else {
      setStatus(`Switch failed: ${response?.error || "unknown error"}`, "error");
    }
  } catch (err) {
    setStatus(`Switch failed: ${err.message}`, "error");
  }
}

async function deleteAccount(name) {
  const accounts = await getAccounts();
  delete accounts[name];
  await setAccounts(accounts);
  setStatus(`Deleted "${name}".`, "success");
  await renderAccounts();
}

// ---------- storage helpers ----------

async function getAccounts() {
  const result = await ext.storage.local.get(storageKey);
  return result[storageKey] || {};
}

async function setAccounts(accounts) {
  await ext.storage.local.set({ [storageKey]: accounts });
}

// Keep only the fields we need to re-create the cookie later.
function serializeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate, // undefined => session cookie
    hostOnly: c.hostOnly,
    storeId: c.storeId,
  };
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || "";
}
```

### `background.js`
```javascript
// background.js — MV3 service worker
// Firefox (109+) and Chrome both support service_worker for MV3 background.
importScripts("browser-compat.js");

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SWITCH_ACCOUNT") {
    handleSwitchAccount(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
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
```

### `icons/` generation script (Python/Pillow, run once to produce the PNGs)
```python
from PIL import Image, ImageDraw
import math

SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

BG = (30, 31, 38, 255)        # matches popup --bg
ACCENT = (91, 140, 255, 255)  # matches popup --accent
WHITE = (236, 238, 242, 255)  # matches popup --text
DANGER = (79, 209, 139, 255)  # green swap badge (success color from popup)

radius = SIZE * 0.22
d.rounded_rectangle([0, 0, SIZE, SIZE], radius=radius, fill=BG)

def circle_mask(cx, cy, r):
    m = Image.new("L", (SIZE, SIZE), 0)
    md = ImageDraw.Draw(m)
    md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    return m

personA = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
pa = ImageDraw.Draw(personA)
cx, cy = SIZE*0.40, SIZE*0.52
head_r = 66
pa.ellipse([cx-head_r, cy-head_r*1.9, cx+head_r, cy-head_r*1.9+head_r*2], fill=ACCENT)
body_w, body_h = 210, 170
pa.rounded_rectangle([cx-body_w/2, cy+head_r*0.35, cx+body_w/2, cy+head_r*0.35+body_h],
                      radius=body_w*0.5, fill=ACCENT)
maskA = circle_mask(SIZE*0.38, SIZE*0.5, SIZE*0.30)
img = Image.composite(personA, img, maskA)

personB = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
pb = ImageDraw.Draw(personB)
cx, cy = SIZE*0.62, SIZE*0.58
head_r = 66
pb.ellipse([cx-head_r, cy-head_r*1.9, cx+head_r, cy-head_r*1.9+head_r*2], fill=WHITE)
body_w, body_h = 210, 170
pb.rounded_rectangle([cx-body_w/2, cy+head_r*0.35, cx+body_w/2, cy+head_r*0.35+body_h],
                      radius=body_w*0.5, fill=WHITE)
maskB = circle_mask(SIZE*0.64, SIZE*0.56, SIZE*0.30)
img = Image.composite(personB, img, maskB)

badge_r = SIZE * 0.20
bx, by = SIZE * 0.80, SIZE * 0.80
badge = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
bd = ImageDraw.Draw(badge)
bd.ellipse([bx-badge_r, by-badge_r, bx+badge_r, by+badge_r], fill=DANGER)

arrow_r = badge_r * 0.55
bbox = [bx-arrow_r, by-arrow_r, bx+arrow_r, by+arrow_r]
bd.arc(bbox, start=200, end=340, fill=BG, width=int(SIZE*0.018))
bd.arc(bbox, start=20, end=160, fill=BG, width=int(SIZE*0.018))

def arrow_head(cx, cy, angle_deg, size, color):
    a = math.radians(angle_deg)
    p1 = (cx, cy)
    p2 = (cx - size*math.cos(a - math.radians(25)), cy - size*math.sin(a - math.radians(25)))
    p3 = (cx - size*math.cos(a + math.radians(25)), cy - size*math.sin(a + math.radians(25)))
    bd.polygon([p1, p2, p3], fill=color)

tip1 = (bx + arrow_r*math.cos(math.radians(340)), by + arrow_r*math.sin(math.radians(340)))
arrow_head(tip1[0], tip1[1], 340+90, badge_r*0.32, BG)
tip2 = (bx + arrow_r*math.cos(math.radians(160)), by + arrow_r*math.sin(math.radians(160)))
arrow_head(tip2[0], tip2[1], 160+90, badge_r*0.32, BG)

img = Image.alpha_composite(img, badge)

for size in [128, 48, 32, 16]:
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(f"icons/icon{size}.png")
```
> Note: the actual PNG binaries were already generated and delivered to the user as files — this script just documents/reproduces them. A new chat can't regenerate identical bytes from this script without re-running it, but visually it will reproduce the same icon.

---

## 5. How to Load/Test (already communicated to user)

- **Chrome**: `chrome://extensions` → enable Developer Mode → "Load unpacked" → select the project folder.
- **Firefox**: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `manifest.json`. (Temporary add-ons unload on restart; permanent install requires signing via AMO.)

---

## 6. Known Limitations (already flagged to user)

- Sites that tie sessions to more than cookies (localStorage tokens, IndexedDB, fingerprinting) won't fully switch with cookies alone.
- `httpOnly` cookies are intentionally readable/writable via the `cookies` API (required for this to work) even though page JS can't touch them.
- Saved sessions are stored **in plaintext** in `chrome.storage.local`.

## 7. Open / Not-Yet-Done Items

- **Encryption for stored cookies was offered but not yet implemented.** Suggested approach discussed: a passphrase-derived key via WebCrypto (e.g., PBKDF2 → AES-GCM) to encrypt the `cookies` array before writing to `storage.local`, decrypt on switch. Not started — pick this up if the user wants it.
- No automated tests written yet.
- No icon design iteration beyond the first generated version (user has not requested changes).
- Extension has not been tested end-to-end in a real browser session by either party in this conversation — logic is sound but unverified in practice.

---

## 8. Suggested Opening Message for the New Chat

> "Continuing work on the 'SessionSwitcher' browser extension described above. Next I'd like to: [add encryption for stored cookies / fix a bug / add a feature — fill in]."