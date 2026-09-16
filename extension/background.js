// Background service worker: message relay, per-tab state cache, and the
// client-driven agent loop (extract -> ask server -> execute -> repeat).

const tabStateCache = new Map();
const SERVER_BASE = "http://127.0.0.1:8000";
const MAX_STEPS = 25;

chrome.runtime.onInstalled.addListener(() => {
  console.log("[privacy-vision-agent] installed");
});

// Clicking the toolbar icon opens the side panel (extension/sidepanel.html)
// instead of a popup — the side panel is the primary front-end now.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error("[privacy-vision-agent] sidePanel setup failed:", e));

// One AbortController per in-flight task, keyed by tabId, so a side panel
// "Stop" click can cancel a running runTask() loop — cooperative (checked
// between steps) and immediate (aborts any in-flight fetch).
const taskControllers = new Map();

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

const OFFSCREEN_URL = "offscreen.html";
let offscreenReady = null;

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    if (existing.length > 0) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Face detection (canvas) and OCR (Web Workers) need DOM APIs the service worker doesn't have.",
    });
  })();
  return offscreenReady;
}

async function captureActiveTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab always captures whichever tab is currently active in
  // the given window (it takes no tabId) — so the target tab must actually
  // be active first, not just exist.
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
  }
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

async function runVisionScan(tabId, { skipOcr = false, redact = true } = {}) {
  await ensureOffscreenDocument();

  // Password field boxes come from the DOM, not vision — a filled password
  // input renders as dots, not the real characters, but redaction blacks it
  // out anyway per spec (defense in depth, and it hides the dot count/box
  // outline too). Best-effort: if extraction fails, redaction still runs
  // with face + OCR-matched PII coverage.
  let passwordBboxes = [];
  if (redact) {
    const extractResp = await sendToTab(tabId, { type: "EXTRACT_STATE" });
    if (extractResp?.ok) {
      passwordBboxes = extractResp.state.elements.filter((e) => e.type === "password" && e.visible).map((e) => e.bbox);
    }
  }

  const imageDataUrl = await captureActiveTab(tabId);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "RUN_VISION", imageDataUrl, skipOcr, redact, passwordBboxes }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response?.ok ? { ...response, beforeImageDataUrl: imageDataUrl } : response);
    });
  });
}

function broadcastStep(tabId, step) {
  // Fire-and-forget: no listener (e.g. side panel not open) just means this
  // is a no-op, not an error.
  chrome.runtime.sendMessage({ type: "TASK_STEP", tabId, step }).catch(() => {});
}

async function runTask(tabId, task, maxSteps = MAX_STEPS) {
  const history = [];
  const steps = [];

  const stopController = new AbortController();
  taskControllers.set(tabId, stopController);

  try {
    for (let i = 0; i < maxSteps; i++) {
      if (stopController.signal.aborted) {
        return { ok: true, stopped: true, steps };
      }

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
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), 45000);
        let res;
        try {
          res = await fetch(`${SERVER_BASE}/agent/step`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state, history }),
            signal: AbortSignal.any([timeoutController.signal, stopController.signal]),
          });
        } finally {
          clearTimeout(timeoutId);
        }
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: `server ${res.status}: ${text}`, steps };
        }
        stepResp = await res.json();
      } catch (e) {
        if (stopController.signal.aborted) return { ok: true, stopped: true, steps };
        const reason = e.name === "AbortError" ? "agent server request timed out after 45s" : `could not reach agent server: ${e.message}`;
        return { ok: false, error: reason, steps };
      }

      const action = stepResp.action;
      const targetLabel = action.target_id != null ? state.elements.find((e) => e.target_id === action.target_id)?.label : null;
      steps.push({ state_id: state.state_id, action, repaired: stepResp.repaired, label: targetLabel });

      if (action.action === "done") {
        broadcastStep(tabId, { action, label: targetLabel });
        return { ok: true, done: true, steps, reason: action.reason };
      }

      const execResp = await sendToTab(tabId, { type: "EXECUTE_ACTION", action });
      broadcastStep(tabId, { action, label: targetLabel, success: execResp?.result?.success });
      history.push({
        action,
        result: execResp?.result || { success: false, error: execResp?.error },
      });
    }

    return { ok: true, done: false, steps, reason: "max steps reached without done" };
  } finally {
    taskControllers.delete(tabId);
  }
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
    runTask(message.tabId, message.task, message.maxSteps)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }

  if (message?.type === "VISION_SCAN" && message.tabId != null) {
    runVisionScan(message.tabId, { skipOcr: message.skipOcr, redact: message.redact !== false })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }

  if (message?.type === "STOP_TASK" && message.tabId != null) {
    const controller = taskControllers.get(message.tabId);
    if (controller) controller.abort();
    sendResponse({ ok: true, wasRunning: !!controller });
    return true;
  }

  return false;
});
