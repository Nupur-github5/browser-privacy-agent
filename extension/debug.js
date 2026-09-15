let activeTabId = null;

async function getActiveTab() {
  const tabs = await chrome.tabs.query({});
  const candidate = tabs.find((t) => t.url && /^https?:\/\//.test(t.url));
  return candidate || tabs.find((t) => t.active);
}

function relay(tabId, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "RELAY_TO_TAB", tabId, payload }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[debug] relay error:", chrome.runtime.lastError.message);
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

async function refreshActiveTab() {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  document.getElementById("active-tab").textContent = tab ? `tab: ${tab.title} (id=${tab.id})` : "no active tab";
}

document.getElementById("extract-btn").addEventListener("click", async () => {
  await refreshActiveTab();
  if (activeTabId == null) return;
  const response = await relay(activeTabId, { type: "EXTRACT_STATE" });
  document.getElementById("elements").textContent = JSON.stringify(response, null, 2);
  window.__lastState = response?.state ?? null;
});

document.getElementById("execute-btn").addEventListener("click", async () => {
  if (activeTabId == null) await refreshActiveTab();
  const action = {
    action: document.getElementById("action-type").value,
    target_id: Number(document.getElementById("target-id").value) || undefined,
    value: document.getElementById("action-value").value,
  };
  const response = await relay(activeTabId, { type: "EXECUTE_ACTION", action });
  document.getElementById("exec-result").textContent = JSON.stringify(response, null, 2);
});

document.getElementById("run-task-btn").addEventListener("click", async () => {
  await refreshActiveTab();
  if (activeTabId == null) return;
  const task = document.getElementById("task-input").value;
  const resultEl = document.getElementById("task-result");
  resultEl.textContent = "running...";
  chrome.runtime.sendMessage({ type: "RUN_TASK", tabId: activeTabId, task }, (response) => {
    resultEl.textContent = JSON.stringify(response, null, 2);
  });
});

refreshActiveTab();
