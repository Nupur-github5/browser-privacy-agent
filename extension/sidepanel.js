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
