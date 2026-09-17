// Side panel front-end for the SAME agent loop in background.js — this file
// only sends/receives messages, it re-implements none of the extraction,
// tokenization, or execution logic.

let activeTab = null;
let running = false;

const taskInput = document.getElementById("task-input");
const runBtn = document.getElementById("run-btn");
const stopBtn = document.getElementById("stop-btn");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const tabLabelEl = document.getElementById("tab-label");
const demoModeCheckbox = document.getElementById("demo-mode");
const delayRow = document.getElementById("delay-row");
const delaySlider = document.getElementById("delay-slider");
const delayValueEl = document.getElementById("delay-value");

function updateDelayRowVisibility() {
  delayRow.style.display = demoModeCheckbox.checked ? "flex" : "none";
}
demoModeCheckbox.addEventListener("change", updateDelayRowVisibility);
delaySlider.addEventListener("input", () => {
  delayValueEl.textContent = `${delaySlider.value}ms`;
});
updateDelayRowVisibility();

// --- Vault editor ---------------------------------------------------------
// Reads/writes the SAME chrome.storage.local profile (extension/lib/
// vault-profile.js) that content.js seeds tokens from on every extraction —
// there is no separate "panel copy" of the vault, this just edits it.
const vaultFixedFieldsEl = document.getElementById("vault-fixed-fields");
const vaultCustomFieldsEl = document.getElementById("vault-custom-fields");
const vaultAddFieldBtn = document.getElementById("vault-add-field");
const vaultSaveBtn = document.getElementById("vault-save");
const vaultResetBtn = document.getElementById("vault-reset");
const vaultStatusEl = document.getElementById("vault-status");

function renderFixedFields(profile) {
  vaultFixedFieldsEl.innerHTML = "";
  for (const def of window.__PVA.VAULT_FIELD_DEFS) {
    const row = document.createElement("div");
    row.className = "vault-field";
    const label = document.createElement("label");
    label.textContent = def.label;
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.key = def.key;
    input.value = profile[def.key] || "";
    row.append(label, input);
    vaultFixedFieldsEl.appendChild(row);
  }
}

function addCustomRow(label = "", value = "") {
  const row = document.createElement("div");
  row.className = "vault-custom-row";
  const labelInput = document.createElement("input");
  labelInput.className = "custom-label";
  labelInput.placeholder = "Field label";
  labelInput.value = label;
  const valueInput = document.createElement("input");
  valueInput.className = "custom-value";
  valueInput.placeholder = "Value";
  valueInput.value = value;
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-field";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove this field";
  removeBtn.addEventListener("click", () => row.remove());
  row.append(labelInput, valueInput, removeBtn);
  vaultCustomFieldsEl.appendChild(row);
}

function renderCustomFields(customList) {
  vaultCustomFieldsEl.innerHTML = "";
  for (const entry of customList) addCustomRow(entry.label, entry.value);
}

function readProfileFromUI() {
  const profile = {};
  vaultFixedFieldsEl.querySelectorAll("input").forEach((input) => {
    profile[input.dataset.key] = input.value.trim();
  });
  profile.custom = Array.from(vaultCustomFieldsEl.querySelectorAll(".vault-custom-row"))
    .map((row) => ({
      label: row.querySelector(".custom-label").value.trim(),
      value: row.querySelector(".custom-value").value.trim(),
    }))
    .filter((c) => c.label && c.value);
  return profile;
}

async function loadVaultUI() {
  const profile = await window.__PVA.getProfile();
  renderFixedFields(profile);
  renderCustomFields(profile.custom || []);
}

function flashVaultStatus(text) {
  vaultStatusEl.textContent = text;
  setTimeout(() => {
    if (vaultStatusEl.textContent === text) vaultStatusEl.textContent = "";
  }, 2500);
}

vaultAddFieldBtn.addEventListener("click", () => addCustomRow());

vaultSaveBtn.addEventListener("click", async () => {
  await window.__PVA.saveProfile(readProfileFromUI());
  flashVaultStatus("Saved.");
});

vaultResetBtn.addEventListener("click", async () => {
  await window.__PVA.saveProfile(window.__PVA.DEFAULT_PROFILE);
  await loadVaultUI();
  flashVaultStatus("Reset to default.");
});

loadVaultUI();

// --- Privacy report ---------------------------------------------------------
// Rendered ONLY from what a real run actually reported (background.js's
// runTask() return value) — never hardcoded, never invented here.
const privacyReportEl = document.getElementById("privacy-report");
const privacyEntriesEl = document.getElementById("privacy-report-entries");
const privacySummaryEl = document.getElementById("privacy-report-summary");

function renderPrivacyReport(entries, leaksBlocked) {
  if (!entries || entries.length === 0) {
    privacyReportEl.style.display = "none";
    return;
  }
  privacyEntriesEl.innerHTML = "";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "privacy-entry";
    const masked = document.createElement("span");
    masked.className = "masked";
    masked.textContent = entry.maskedHint;
    const token = document.createElement("span");
    token.className = "token";
    token.textContent = entry.token;
    const confirm = document.createElement("span");
    confirm.className = "confirm";
    confirm.textContent = "✅ not sent raw";
    row.append(masked, token, confirm);
    privacyEntriesEl.appendChild(row);
  }
  const leaked = leaksBlocked || 0;
  privacySummaryEl.textContent = `${entries.length} sensitive value${entries.length === 1 ? "" : "s"} protected — ${leaked} sent in raw form this session.`;
  privacySummaryEl.className = leaked > 0 ? "privacy-summary leak" : "privacy-summary";
  privacyReportEl.style.display = "block";
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  tabLabelEl.textContent = activeTab ? `on: ${activeTab.title || activeTab.url} ` : "no active tab detected";
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function addLog(text, kind = "action", icon = "") {
  const line = document.createElement("div");
  line.className = `log-line ${kind}`;
  line.textContent = icon ? `${icon} ${text}` : text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.innerHTML = "";
}

function setRunning(isRunning) {
  running = isRunning;
  runBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
  taskInput.disabled = isRunning;
  demoModeCheckbox.disabled = isRunning;
  delaySlider.disabled = isRunning;
}

// Turns one agent step into a short, human-readable sentence — no raw JSON,
// no raw PII (values are already tokens by the time they reach here; we
// still don't print the value at all, just which field it went into).
function describeStep(step) {
  const a = step.action || {};
  const label = step.label ? `"${step.label}"` : `field #${a.target_id}`;
  switch (a.action) {
    case "type":
      return { text: `Typed into ${label}`, icon: "⌨️" };
    case "click":
      return { text: `Clicked ${label}`, icon: "🖱️" };
    case "scroll":
      return { text: `Scrolled ${a.direction || "down"}`, icon: "↕️" };
    case "done":
      return { text: `Finished: ${a.reason || "task complete"}`, icon: "✅" };
    default:
      return { text: `Unknown action: ${a.action}`, icon: "❓" };
  }
}

runBtn.addEventListener("click", async () => {
  await refreshActiveTab();
  if (!activeTab) {
    addLog("No active tab found — click on a page tab first, then try again.", "error");
    return;
  }
  const task = taskInput.value.trim();
  if (!task) {
    addLog("Type an instruction first.", "error");
    return;
  }

  const demoMode = demoModeCheckbox.checked;
  const stepDelayMs = Number(delaySlider.value);

  clearLog();
  privacyReportEl.style.display = "none";
  setRunning(true);
  setStatus("running", "running");
  addLog(`Task: "${task}"`, "info");
  addLog(`Working on: ${activeTab.title || activeTab.url}`, "info");
  if (demoMode) addLog(`Demo mode on — highlighting each field, ${stepDelayMs}ms per step.`, "info");

  chrome.runtime.sendMessage({ type: "RUN_TASK", tabId: activeTab.id, task, demoMode, stepDelayMs }, (response) => {
    setRunning(false);
    if (chrome.runtime.lastError) {
      setStatus("error", "error");
      addLog(`Error: ${chrome.runtime.lastError.message}`, "error");
      return;
    }
    if (!response) {
      setStatus("error", "error");
      addLog("No response from the agent.", "error");
      return;
    }
    renderPrivacyReport(response.privacyReport, response.leaksBlocked);
    if (response.stopped) {
      setStatus("stopped", "stopped");
      addLog("Stopped by user.", "info");
      return;
    }
    if (!response.ok) {
      setStatus("error", "error");
      addLog(`Error: ${response.error || "unknown error"}`, "error");
      return;
    }
    if (response.done) {
      setStatus("done", "done");
    } else {
      setStatus("stopped mid-task", "error");
      addLog(`Stopped: ${response.reason || "max steps reached"}`, "error");
    }
  });
});

stopBtn.addEventListener("click", () => {
  if (!activeTab) return;
  chrome.runtime.sendMessage({ type: "STOP_TASK", tabId: activeTab.id });
  addLog("Stopping...", "info");
});

// Background broadcasts one TASK_STEP message per step as the loop runs, so
// the log fills in live instead of only showing a result at the very end.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TASK_STEP" && activeTab && message.tabId === activeTab.id) {
    const { text, icon } = describeStep(message.step);
    addLog(text, message.step.action?.action === "done" ? "done" : "action", icon);
  }
});

refreshActiveTab();
chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === "complete") refreshActiveTab();
});
