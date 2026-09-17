// Content script entry point: owns the current registry + PII vault, and
// dispatches EXTRACT_STATE / EXECUTE_ACTION messages from the background
// worker or debug page to the DOM extractor, PII detector, tokenizer, and
// executor modules.
//
// Privacy boundary: extractState() is the ONLY place raw element values are
// read from the live DOM. Any value the detector classifies as PII is
// swapped for a token before the element ever enters the returned state —
// the vault holding the real value never leaves this module.

console.log("[privacy-vision-agent] content script loaded on", location.href);

let currentRegistry = null;
let currentVault = null;

function extractState() {
  currentRegistry = window.__PVA.createRegistry();
  currentVault = window.__PVA.createVault();

  const rawElements = window.__PVA.extractElements(document.body, currentRegistry);
  const elements = rawElements.map((el) => {
    const classification = window.PVADetector.classifyElement(el);
    if (classification.isPII && typeof el.value === "string" && el.value.trim()) {
      const token = currentVault.tokenize(classification.category, el.value);
      return { ...el, value: token };
    }
    return el;
  });

  return {
    state_id: currentRegistry.stateId,
    url: location.href,
    title: document.title,
    elements,
    available_tokens: currentVault.listTokens(),
  };
}

function executeAction(action, options) {
  // Detokenize any [TOKEN_N] in the action's value locally, right before the
  // real DOM write — the resolved real value never travels back out.
  const resolvedAction = { ...action };
  if (typeof resolvedAction.value === "string" && currentVault) {
    resolvedAction.value = currentVault.detokenizeText(resolvedAction.value);
  }
  return window.__PVA.execute(resolvedAction, currentRegistry, options);
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
    executeAction(message.action, { demoMode: message.demoMode, stepDelayMs: message.stepDelayMs })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }

  return false;
});
