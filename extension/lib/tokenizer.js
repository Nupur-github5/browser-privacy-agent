// In-memory PII vault: tokenize(category, value) <-> detokenize(token).
// Lives only in the content script's isolated world for the lifetime of one
// extracted state; never serialised, never sent over the network.
(function () {
  "use strict";
  window.__PVA = window.__PVA || {};

  function titleCaseCategory(category) {
    return String(category)
      .split("_")
      .filter(Boolean)
      .map((w) => w[0] + w.slice(1).toLowerCase())
      .join(" ");
  }

  // Shows only the last 4 characters of a value — enough for a human to
  // recognise "yes, that's my Aadhaar" without the report itself becoming a
  // second copy of the PII it exists to prove was protected.
  function maskValue(value) {
    const s = String(value ?? "");
    if (s.length <= 4) return "****";
    return "****" + s.slice(-4);
  }

  class Vault {
    constructor() {
      this.tokenToValue = new Map();
      this.valueToToken = new Map(); // "CATEGORY::value" -> token, so identical values reuse one token
      this.tokenToLabel = new Map();
      this.counters = new Map(); // category -> next index
    }

    tokenize(category, value, label) {
      const key = `${category}::${value}`;
      if (this.valueToToken.has(key)) return this.valueToToken.get(key);

      const next = (this.counters.get(category) || 0) + 1;
      this.counters.set(category, next);
      const token = `[${category}_${next}]`;

      this.tokenToValue.set(token, value);
      this.valueToToken.set(key, token);
      this.tokenToLabel.set(token, label || titleCaseCategory(category));
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

    /**
     * Human-readable, masked summary of every value this vault has
     * tokenized — never the raw value itself. This is the data the side
     * panel's privacy report is built from.
     */
    getReport() {
      return this.listTokens().map((token) => {
        const label = this.tokenToLabel.get(token) || token;
        return { token, label, maskedHint: `${label} ${maskValue(this.tokenToValue.get(token))}` };
      });
    }
  }

  window.__PVA.createVault = () => new Vault();
})();
