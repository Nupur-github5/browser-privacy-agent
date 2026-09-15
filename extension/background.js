// Background service worker: message relay, per-tab state cache, and the
// client-driven agent loop (extract -> ask server -> execute -> repeat).

const tabStateCache = new Map();
const SERVER_BASE = "http://127.0.0.1:8000";
const MAX_STEPS = 25;

chrome.runtime.onInstalled.addListener(() => {
  console.log("[privacy-vision-agent] installed");
});

function sendToTab(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

async function runTask(tabId, task, maxSteps = MAX_STEPS) {
  const history = [];
  const steps = [];

  for (let i = 0; i < maxSteps; i++) {
    const extractResp = await sendToTab(tabId, { type: "EXTRACT_STATE" });
    if (!extractResp?.ok) {
      return { ok: false, error: extractResp?.error || "EXTRACT_STATE failed", steps };
    }

    const state = extractResp.state;
    state.task = task;
    state.available_tokens = state.available_tokens || [];
    state.vision_regions = state.vision_regions || [];

    let stepResp;
    try {
      const res = await fetch(`${SERVER_BASE}/agent/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, history }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `server ${res.status}: ${text}`, steps };
      }
      stepResp = await res.json();
    } catch (e) {
      return { ok: false, error: `could not reach agent server: ${e.message}`, steps };
    }

    const action = stepResp.action;
    steps.push({ state_id: state.state_id, action, repaired: stepResp.repaired });

    if (action.action === "done") {
      return { ok: true, done: true, steps, reason: action.reason };
    }

    const execResp = await sendToTab(tabId, { type: "EXECUTE_ACTION", action });
    history.push({
      action,
      result: execResp?.result || { success: false, error: execResp?.error },
    });
  }

  return { ok: true, done: false, steps, reason: "max steps reached without done" };
}

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

  if (message?.type === "RUN_TASK" && message.tabId != null) {
    runTask(message.tabId, message.task, message.maxSteps).then(sendResponse);
    return true; // async response
  }

  return false;
});
