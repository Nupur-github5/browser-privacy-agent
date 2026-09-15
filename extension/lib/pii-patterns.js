// Regex + checksum PII value detectors. UMD so the same module runs inside
// the content script (browser) and inside eval/ scripts (Node) for testing.
// Ported and trimmed from the redectionFramwork reference (Verhoeff/Luhn/GSTIN
// checksums enforced, not just format-matched — a format match that fails
// its checksum is not reported).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PVAPatterns = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function verhoeffOk(number) {
    const D = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
      [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
      [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
      [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
      [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    ];
    const P = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
      [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
      [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
      [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
    ];
    const digits = (number.match(/\d/g) || []).map(Number);
    if (digits.length !== 12) return false;
    let c = 0;
    const reversed = digits.slice().reverse();
    for (let i = 0; i < reversed.length; i++) {
      c = D[c][P[i % 8][reversed[i]]];
    }
    return c === 0;
  }

  function luhnOk(number) {
    const digits = (number.match(/\d/g) || []).map(Number);
    if (digits.length < 13 || digits.length > 19) return false;
    let total = 0;
    const reversed = digits.slice().reverse();
    for (let i = 0; i < reversed.length; i++) {
      let d = reversed[i];
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      total += d;
    }
    return total % 10 === 0;
  }

  const GST_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function gstinChecksumOk(value) {
    const s = value.toUpperCase();
    if (s.length !== 15 || [...s].some((ch) => !GST_ALPHABET.includes(ch))) return false;
    let total = 0;
    for (let i = 0; i < 14; i++) {
      const factor = i % 2 === 0 ? 1 : 2;
      const d = factor * GST_ALPHABET.indexOf(s[i]);
      total += Math.floor(d / 36) + (d % 36);
    }
    const check = GST_ALPHABET[(36 - (total % 36)) % 36];
    return check === s[14];
  }

  const PATTERNS = {
    EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    AADHAAR: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,
    PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/i,
    GSTIN: /\b\d{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i,
    IFSC: /\b[A-Z]{4}0[A-Z0-9]{6}\b/i,
    PHONE: /(?<!\d)(?:\+91[-\s]?|0)?[6-9]\d{4}[-\s]?\d{5}(?!\d)/,
    UPI: /\b[A-Za-z0-9.\-_]{2,64}@[A-Za-z]{3,64}\b(?!\.[A-Za-z])/,
    CARD: /\b\d{4}(?:[ -]?\d{4}){2,3}\b|\b\d{13,19}\b/,
  };

  const CHECKSUM_VALIDATORS = {
    AADHAAR: verhoeffOk,
    GSTIN: gstinChecksumOk,
    CARD: luhnOk,
  };

  // Order matters: more specific/checksum-backed formats first, so e.g. a
  // GSTIN (which contains a PAN-shaped substring) is tried before PAN.
  const CHECK_ORDER = ["EMAIL", "GSTIN", "AADHAAR", "PAN", "IFSC", "UPI", "CARD", "PHONE"];

  /**
   * Classify a single value string against all known PII value patterns.
   * Returns { type, confidence } for the first (highest-priority) match
   * whose checksum (if any) passes, or null.
   */
  function matchValue(value) {
    if (!value || typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    for (const type of CHECK_ORDER) {
      const pattern = PATTERNS[type];
      if (!pattern.test(trimmed)) continue;
      const validator = CHECKSUM_VALIDATORS[type];
      if (validator) {
        const match = trimmed.match(pattern);
        if (!match || !validator(match[0])) continue;
        return { type, confidence: 0.98, source: "checksum" };
      }
      return { type, confidence: type === "EMAIL" ? 0.95 : 0.85, source: "regex" };
    }
    return null;
  }

  return { PATTERNS, verhoeffOk, luhnOk, gstinChecksumOk, matchValue };
});
