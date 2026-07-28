// content.js - Scans the active page for quota warnings

const api = typeof browser !== "undefined" ? browser : chrome;

console.log("[SessionSwitcher] Content script injected and watching for limits...");

function checkForQuota() {
    const rawText = document.body.innerText || document.body.textContent || "";
    const text = rawText.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");

    let state = null;
    let resetTimestamp = null;

    if (text.match(/out of free.*messages until/i)) {
        state = "100";
        const match = text.match(/messages until\s+(\d{1,2}:\d{2}\s*[aApP][mM])/i);
        if (match) {
            resetTimestamp = parseTimeStr(match[1]);
        }
    } else if (text.match(/used 90% of your session/i)) {
        state = "90";
    }

    if (state) {
        const domain = window.location.hostname;
        const activeKey = `activeAccount::${domain}`;
        const accountsKey = `accounts::${domain}`;

        api.storage.local.get([activeKey, accountsKey]).then(res => {
            const activeAcc = res[activeKey];
            const accounts = res[accountsKey];

            // Safely write the warning directly to the active account's profile
            if (activeAcc && accounts && accounts[activeAcc]) {
                const acc = accounts[activeAcc];

                if (acc.quotaState !== state || acc.quotaResetAt !== resetTimestamp) {
                    acc.quotaState = state;
                    if (resetTimestamp) acc.quotaResetAt = resetTimestamp;

                    api.storage.local.set({ [accountsKey]: accounts }).then(() => {
                        console.log(`[SessionSwitcher] Saved ${state}% limit exclusively to account: ${activeAcc}`);
                    });
                }
            }
        }).catch(err => console.error("[SessionSwitcher] Storage error:", err));
    }
}

function parseTimeStr(timeStr) {
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const modifier = match[3].toUpperCase();

    if (modifier === 'PM' && hours < 12) hours += 12;
    if (modifier === 'AM' && hours === 12) hours = 0;

    const now = new Date();
    const resetDate = new Date();
    resetDate.setHours(hours, minutes, 0, 0);

    if (resetDate < now) {
        resetDate.setDate(resetDate.getDate() + 1);
    }

    return resetDate.getTime();
}

// --- NEW: Hide Logout Button Logic ---
function updateLogoutVisibility(shouldHide) {
    const styleId = "ss-hide-logout-style";
    let style = document.getElementById(styleId);

    if (shouldHide) {
        if (!style) {
            style = document.createElement("style");
            style.id = styleId;
            style.textContent = `a[href="/logout"] { display: none !important; }`;
            document.head.appendChild(style);
        }
    } else if (style) {
        style.remove();
    }
}

// Apply immediately on load and listen for live toggle changes
api.storage.local.get("hideLogout").then(res => {
    updateLogoutVisibility(!!res.hideLogout);
});

api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.hideLogout !== undefined) {
        updateLogoutVisibility(changes.hideLogout.newValue);
    }
});

checkForQuota();
setInterval(checkForQuota, 3000);