document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  chrome.runtime.sendMessage({ type: "PING" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      statusEl.textContent = "Background worker unreachable.";
      return;
    }
    statusEl.textContent = "Background worker alive at " + new Date(response.ts).toLocaleTimeString();
  });
});
