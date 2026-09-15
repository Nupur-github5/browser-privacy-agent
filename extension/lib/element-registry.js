// Per-page registry mapping target_id <-> live DOM element.
// Lives in the content script's isolated world; never serialised as-is.
(function () {
  "use strict";
  window.__PVA = window.__PVA || {};

  function generateStateId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return "state_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  class ElementRegistry {
    constructor() {
      this.byId = new Map();
      this.byElement = new WeakMap();
      this.nextId = 1;
      this.stateId = generateStateId();
    }

    register(el) {
      if (this.byElement.has(el)) return this.byElement.get(el);
      const id = this.nextId++;
      this.byId.set(id, el);
      this.byElement.set(el, id);
      return id;
    }

    getElement(targetId) {
      return this.byId.get(targetId) || null;
    }

    size() {
      return this.byId.size;
    }
  }

  window.__PVA.createRegistry = () => new ElementRegistry();
})();
