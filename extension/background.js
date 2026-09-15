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

  // Relay from the debug/popup page (which has no content-script context of
  // its own) to the content script running in a specific tab.
  if (message?.type === "RELAY_TO_TAB" && message.tabId != null) {
    chrome.tabs.sendMessage(message.tabId, message.payload, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse(response ?? { ok: false, error: "empty response from content script" });
    });
    return true; // async response
  }

  return false;
});
