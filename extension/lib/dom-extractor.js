// DOM extractor: walks the live DOM and produces a flat list of interactive
// elements with target_id, role, label, type, value, bbox, visible.
// Raw element references never leave this module — only the registry does,
// and the registry never leaves the content-script isolated world.
(function () {
  "use strict";
  window.__PVA = window.__PVA || {};

  const INTERACTIVE_TAGS = new Set(["a", "button", "input", "textarea", "select", "option", "summary"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "checkbox", "radio", "combobox", "tab",
    "menuitem", "switch", "slider", "spinbutton", "searchbox", "option",
    "listbox", "menu", "tablist",
  ]);

  const INPUT_ROLE_MAP = {
    checkbox: "checkbox",
    radio: "radio",
    submit: "button",
    button: "button",
    reset: "button",
    range: "slider",
    search: "searchbox",
    email: "textbox",
    password: "textbox",
    tel: "textbox",
    text: "textbox",
    number: "textbox",
  };

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href");
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    const ce = el.getAttribute("contenteditable");
    if (ce !== null && ce !== "false") return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && parseInt(ti, 10) >= 0) return true;
    if (el.hasAttribute("onclick")) return true;
    return false;
  }

  function computeRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLE_MAP[type] || "textbox";
    }
    return tag;
  }

  function computeType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "button") return (el.getAttribute("type") || "submit").toLowerCase();
    return tag;
  }

  function labelFromFor(el) {
    if (!el.id) return null;
    try {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      return lbl && lbl.textContent.trim() ? lbl.textContent.trim() : null;
    } catch (_) {
      return null;
    }
  }

  function computeLabel(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }

    const forLabel = labelFromFor(el);
    if (forLabel) return forLabel;

    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent.trim()) return parentLabel.textContent.trim();

    if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
    if (el.title && el.title.trim()) return el.title.trim();

    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "button" || tag === "summary") {
      const text = el.textContent?.trim();
      if (text && text.length < 200) return text;
    }
    if (tag === "select") {
      const selected = el.options?.[el.selectedIndex];
      if (selected && selected.textContent.trim() && !el.getAttribute("aria-label")) {
        // fall through — value is captured separately; label stays name/placeholder based
      }
    }

    if (el.name) return el.name;
    return "";
  }

  function computeValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const opt = el.options?.[el.selectedIndex];
      return opt ? opt.value ?? opt.textContent.trim() : "";
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return el.checked;
      return el.value ?? "";
    }
    if (tag === "textarea") return el.value ?? "";
    return el.textContent ? el.textContent.trim().slice(0, 200) : "";
  }

  function roundBBox(rect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  /**
   * Extracts a flat list of interactive elements from `root`, registering
   * each in `registry` so target_ids can later be resolved back to live
   * DOM nodes for action execution.
   */
  function extract(root, registry) {
    const elements = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const tag = node.tagName.toLowerCase();
        if (["script", "style", "noscript", "template", "meta", "link", "head"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE && isInteractive(node)) {
        const visible = isVisible(node);
        const targetId = registry.register(node);
        elements.push({
          target_id: targetId,
          role: computeRole(node),
          label: computeLabel(node),
          type: computeType(node),
          value: computeValue(node),
          bbox: roundBBox(node.getBoundingClientRect()),
          visible,
        });
      }
      node = walker.nextNode();
    }
    return elements;
  }

  window.__PVA.extractElements = extract;
})();
