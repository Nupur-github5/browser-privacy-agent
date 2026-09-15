// Content script entry point: owns the current registry and dispatches
// EXTRACT_STATE / EXECUTE_ACTION messages from the background worker or
// debug page to the DOM extractor and executor modules.

console.log("[privacy-vision-agent] content script loaded on", location.href);

let currentRegistry = null;

function extractState() {
  currentRegistry = window.__PVA.createRegistry();
  const elements = window.__PVA.extractElements(document.body, currentRegistry);
  return {
    state_id: currentRegistry.stateId,
    url: location.href,
    title: document.title,
    elements,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ type: "PONG", ts: Date.now() });
    return true;
  }

  if (message?.type === "EXTRACT_STATE") {
    try {
      sendResponse({ ok: true, state: extractState() });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }

  if (message?.type === "EXECUTE_ACTION") {
    if (!currentRegistry) {
      sendResponse({ ok: false, error: "no active state — call EXTRACT_STATE first" });
      return true;
    }
    window.__PVA
      .execute(message.action, currentRegistry)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }

  return false;
});
