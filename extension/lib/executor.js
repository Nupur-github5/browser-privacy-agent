// Resolves target_id -> live DOM element via the active registry and
// performs the requested action. Runs in the content-script isolated world.
(function () {
  "use strict";
  window.__PVA = window.__PVA || {};

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function scrollIntoViewIfNeeded(el) {
    try {
      el.scrollIntoView({ behavior: "instant", block: "center" });
    } catch (_) {}
  }

  function fireInputEvent(el) {
    const proto = el.tagName.toLowerCase() === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, el.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function handleClick(action, registry) {
    const el = registry.getElement(action.target_id);
    if (!el) return { success: false, error: `target_id ${action.target_id} not found` };
    scrollIntoViewIfNeeded(el);
    await sleep(30);
    el.focus();
    el.click();
    return { success: true };
  }

  async function handleType(action, registry) {
    const el = registry.getElement(action.target_id);
    if (!el) return { success: false, error: `target_id ${action.target_id} not found` };
    scrollIntoViewIfNeeded(el);
    await sleep(30);

    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const target = String(action.value);
      const opt = Array.from(el.options).find((o) => o.value === target || o.textContent.trim() === target);
      if (!opt) return { success: false, error: `no option matching "${target}"` };
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true };
    }

    el.focus();
    el.value = "";
    fireInputEvent(el);
    const text = String(action.value ?? "");
    for (const char of text) {
      el.value += char;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
    }
    fireInputEvent(el);
    return { success: true };
  }

  async function handleScroll(action) {
    const amount = action.direction === "up" ? -(action.amount || 400) : action.amount || 400;
    window.scrollBy({ top: amount, behavior: "instant" });
    await sleep(50);
    return { success: true };
  }

  async function handleDone(action) {
    return { success: true, done: true, reason: action.reason || "" };
  }

  async function execute(action, registry) {
    if (!action || !action.action) return { success: false, error: "missing action type" };
    switch (action.action) {
      case "click":
        return handleClick(action, registry);
      case "type":
        return handleType(action, registry);
      case "scroll":
        return handleScroll(action);
      case "done":
        return handleDone(action);
      default:
        return { success: false, error: `unknown action type: ${action.action}` };
    }
  }

  window.__PVA.execute = execute;
})();
