// Content script: DOM extraction, vision, PII detection, redaction, and
// action execution will all live here (or in modules it imports) in later
// phases. Phase 0: scaffold only.

console.log("[privacy-vision-agent] content script loaded on", location.href);

chrome.runtime.sendMessage({ type: "PING" }, (response) => {
  if (chrome.runtime.lastError) {
    console.warn("[privacy-vision-agent] background not reachable:", chrome.runtime.lastError.message);
    return;
  }
  console.log("[privacy-vision-agent] background responded:", response);
});
