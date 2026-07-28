// content.js - Scans the active page for quota warnings

const ext = typeof browser !== "undefined" ? browser : chrome;

function checkForQuota() {
    const text = document.body.innerText || "";
    let state = null;
    let resetTimestamp = null;

    // Look for the 100% warning and extract the time using Regex
    const match = text.match(/You are out of free.*messages until (\d{1,2}:\d{2}\s*[AP]M)/i);

    if (match) {
        state = "100";
        const timeString = match[1]; // e.g., "4:20 PM"
        resetTimestamp = parseTimeStr(timeString);
    } else if (text.includes("You’ve used 90% of your session limit")) {
        state = "90";
    }

    if (state) {
        const domain = window.location.hostname;
        const key = `quotaAlert::${domain}`;

        ext.storage.local.get(key).then(res => {
            const currentData = res[key];
            // Only update storage if the state or the reset time has changed
            if (!currentData || currentData.state !== state || currentData.resetAt !== resetTimestamp) {
                ext.storage.local.set({
                    [key]: { state: state, resetAt: resetTimestamp }
                });
            }
        });
    }
}

// Helper function to turn "4:20 PM" into a real Javascript Timestamp
function parseTimeStr(timeStr) {
    const [time, modifier] = timeStr.split(/(?=[AP]M)/i);
    if (!time || !modifier) return null;

    let [hours, minutes] = time.trim().split(':');
    hours = parseInt(hours, 10);
    minutes = parseInt(minutes, 10);

    if (modifier.toUpperCase().includes('PM') && hours < 12) hours += 12;
    if (modifier.toUpperCase().includes('AM') && hours === 12) hours = 0;

    const now = new Date();
    const resetDate = new Date();
    resetDate.setHours(hours, minutes, 0, 0);

    // If the time already passed today, it means the reset is tomorrow
    if (resetDate < now) {
        resetDate.setDate(resetDate.getDate() + 1);
    }

    return resetDate.getTime();
}

checkForQuota();
setInterval(checkForQuota, 3000);