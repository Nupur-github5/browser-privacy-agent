// Background service worker: message relay + per-tab state cache.
// Phase 0: scaffold only — no real relay logic yet.

const tabStateCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.log("[privacy-vision-agent] installed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ type: "PONG", ts: Date.now() });
    return true;
  }

  if (message?.type === "STATE_UPDATE" && sender.tab?.id != null) {
    tabStateCache.set(sender.tab.id, message.payload);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
