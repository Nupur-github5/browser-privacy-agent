// Resolves target_id -> live DOM element via the active registry and
// performs the requested action. Runs in the content-script isolated world.
//
// Demo mode (Feature 2): when options.demoMode is true, actions highlight
// their target, pause briefly before/after acting, and type character-by-
// character at a watchable speed, so a human can follow the agent live in
// the side panel. When demoMode is absent/false (debug.html's existing
// calls, and any other caller that doesn't pass options), every function
// below behaves byte-for-byte like it did before this feature — same 30ms
// post-scroll pause, same instant synchronous typing, no highlight.
(function () {
  "use strict";
  window.__PVA = window.__PVA || {};

  const DEFAULT_STEP_DELAY_MS = 700;
  const CHAR_DELAY_MS = 35;

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

  // --- Demo-mode highlight -------------------------------------------------
  // Plain inline-style manipulation on the target element itself (no overlay
  // div, no coordinate math — stays correct across scrolling/resizing for
  // free). Saves and restores the element's own prior inline style values,
  // so a real page's styling is never permanently altered.
  function highlightElement(el) {
    const prev = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      boxShadow: el.style.boxShadow,
      transition: el.style.transition,
    };
    el.style.transition = "outline 0.15s ease, box-shadow 0.15s ease";
    el.style.outline = "3px solid #1a73e8";
    el.style.outlineOffset = "2px";
    el.style.boxShadow = "0 0 0 5px rgba(26, 115, 232, 0.25)";
    return () => {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.outlineOffset;
      el.style.boxShadow = prev.boxShadow;
      el.style.transition = prev.transition;
    };
  }

  async function handleClick(action, registry, options = {}) {
    const el = registry.getElement(action.target_id);
    if (!el) return { success: false, error: `target_id ${action.target_id} not found` };
    const { demoMode, stepDelayMs = DEFAULT_STEP_DELAY_MS } = options;

    scrollIntoViewIfNeeded(el);
    await sleep(30);

    let clearHighlight;
    if (demoMode) {
      clearHighlight = highlightElement(el);
      await sleep(Math.round(stepDelayMs * 0.4));
    }

    el.focus();
    el.click();

    if (demoMode) {
      await sleep(Math.round(stepDelayMs * 0.6));
      clearHighlight();
    }

    return { success: true };
  }

  async function handleType(action, registry, options = {}) {
    const el = registry.getElement(action.target_id);
    if (!el) return { success: false, error: `target_id ${action.target_id} not found` };
    const { demoMode, stepDelayMs = DEFAULT_STEP_DELAY_MS } = options;

    scrollIntoViewIfNeeded(el);
    await sleep(30);

    let clearHighlight;
    if (demoMode) {
      clearHighlight = highlightElement(el);
      await sleep(Math.round(stepDelayMs * 0.4));
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const target = String(action.value);
      const opt = Array.from(el.options).find((o) => o.value === target || o.textContent.trim() === target);
      if (!opt) {
        if (clearHighlight) clearHighlight();
        return { success: false, error: `no option matching "${target}"` };
      }
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (demoMode) {
        await sleep(Math.round(stepDelayMs * 0.6));
        clearHighlight();
      }
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
      if (demoMode) await sleep(CHAR_DELAY_MS);
    }
    fireInputEvent(el);

    if (demoMode) {
      await sleep(Math.round(stepDelayMs * 0.6));
      clearHighlight();
    }

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

  async function execute(action, registry, options = {}) {
    if (!action || !action.action) return { success: false, error: "missing action type" };
    switch (action.action) {
      case "click":
        return handleClick(action, registry, options);
      case "type":
        return handleType(action, registry, options);
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
