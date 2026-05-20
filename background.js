// background.js — minimal service worker.
// Most logic lives in content.js (must run same-origin) and popup.js.
// This worker exists so we can lazily inject the content script onto an
// instagram tab if needed, and to keep storage clean.

chrome.runtime.onInstalled.addListener(() => {
  console.log("Instagram Following Cleaner installed.");
});

// Optional helper: respond if popup asks for a refreshed injection.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "ensure_injected" && msg.tabId) {
    chrome.scripting
      .executeScript({
        target: { tabId: msg.tabId },
        files: ["content.js"],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
