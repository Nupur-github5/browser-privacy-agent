// In-memory PII vault: tokenize(category, value) <-> detokenize(token).
// Lives only in the content script's isolated world for the lifetime of one
// extracted state; never serialised, never sent over the network.
(function () {
  "use strict";
  window.__PVA = window.__PVA || {};

  class Vault {
    constructor() {
      this.tokenToValue = new Map();
      this.valueToToken = new Map(); // "CATEGORY::value" -> token, so identical values reuse one token
      this.counters = new Map(); // category -> next index
    }

    tokenize(category, value) {
      const key = `${category}::${value}`;
      if (this.valueToToken.has(key)) return this.valueToToken.get(key);

      const next = (this.counters.get(category) || 0) + 1;
      this.counters.set(category, next);
      const token = `[${category}_${next}]`;

      this.tokenToValue.set(token, value);
      this.valueToToken.set(key, token);
      return token;
    }

    detokenize(token) {
      return this.tokenToValue.has(token) ? this.tokenToValue.get(token) : null;
    }

    /** Replaces every [TOKEN_N] occurrence in `text` with its real value. */
    detokenizeText(text) {
      if (typeof text !== "string") return text;
      return text.replace(/\[[A-Z_]+_\d+\]/g, (match) => {
        const real = this.detokenize(match);
        return real === null ? match : real;
      });
    }

    listTokens() {
      return Array.from(this.tokenToValue.keys());
    }
  }

  window.__PVA.createVault = () => new Vault();
})();
