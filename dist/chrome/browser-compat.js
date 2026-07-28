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
