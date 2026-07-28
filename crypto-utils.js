// crypto-utils.js

const CURRENT_ITERATIONS = 600000;

async function getDerivedKey(passphrase, salt, iterations) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(passphrase),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: iterations,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptData(data, passphrase) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getDerivedKey(passphrase, salt, CURRENT_ITERATIONS);

    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        enc.encode(JSON.stringify(data))
    );

    return {
        salt: Array.from(salt),
        iv: Array.from(iv),
        data: Array.from(new Uint8Array(encrypted)),
        iterations: CURRENT_ITERATIONS
    };
}

async function decryptData(payload, passphrase) {
    // Fallback to 100,000 for older saved sessions that didn't record their iteration count
    const iterations = payload.iterations || 100000;

    const salt = new Uint8Array(payload.salt);
    const iv = new Uint8Array(payload.iv);
    const encrypted = new Uint8Array(payload.data);

    const key = await getDerivedKey(passphrase, salt, iterations);

    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        encrypted
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
}