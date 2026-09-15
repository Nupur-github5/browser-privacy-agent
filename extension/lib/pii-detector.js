// Multi-signal PII classifier for extracted elements: DOM type, label
// keywords, and value regex/checksum (via pii-patterns.js). UMD so it can be
// unit-tested from Node (eval/) as well as run in the content script.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./pii-patterns.js"));
  } else {
    root.PVADetector = factory(root.PVAPatterns);
  }
})(typeof self !== "undefined" ? self : this, function (Patterns) {
  "use strict";

  // Label keyword -> category. Checked as whole-word or substring depending
  // on keyword length (short keywords need a word boundary to avoid matching
  // inside unrelated words).
  const LABEL_KEYWORDS = {
    NAME: ["full name", "fullname", "first name", "last name", "surname", "your name", "employee name", "customer name", "name"],
    EMAIL: ["email", "e-mail", "mail id"],
    PHONE: ["phone", "mobile", "contact number", "telephone", "cell", "whatsapp"],
    ADDRESS: ["address", "street", "shipping address", "billing address", "residential address"],
    AADHAAR: ["aadhaar", "aadhar", "uidai"],
    PAN: ["pan number", "pan card", "pan"],
    GSTIN: ["gstin", "gst number"],
    IFSC: ["ifsc"],
    UPI: ["upi id", "upi"],
    CARD: ["card number", "credit card", "debit card", "card ending"],
    PASSWORD: ["password", "passcode", "pwd"],
    DOB: ["date of birth", "dob", "birthday", "birth date"],
  };

  // DOM `type` attribute -> category (strong signal, from dom-extractor's
  // computed `type` field).
  const TYPE_MAP = {
    email: "EMAIL",
    tel: "PHONE",
    password: "PASSWORD",
  };

  // Values/labels that must never be classified as PII even if a keyword or
  // regex would otherwise match (e.g. a "Department" select whose current
  // value is a plain category word, or a submit button).
  const NEGATIVE_LABELS = ["submit", "cancel", "search", "continue", "save", "reset", "department", "role", "category", "country", "state"];

  function normalize(s) {
    return (s || "").toString().trim().toLowerCase();
  }

  function matchLabelKeyword(label) {
    const norm = normalize(label);
    if (!norm) return null;
    for (const [category, keywords] of Object.entries(LABEL_KEYWORDS)) {
      for (const kw of keywords) {
        const trimmedKw = kw.trim();
        const hit = trimmedKw.length <= 4 ? new RegExp(`\\b${trimmedKw}\\b`, "i").test(norm) : norm.includes(trimmedKw);
        if (hit) return category;
      }
    }
    return null;
  }

  function isNegativeContext(label, role, type) {
    if (role === "button" || type === "submit" || type === "button" || type === "reset") return true;
    const norm = normalize(label);
    return NEGATIVE_LABELS.some((kw) => norm === kw || norm.includes(kw));
  }

  /**
   * Classify one extracted element. `element` is the stable-schema shape
   * from dom-extractor.js: { role, label, type, value }.
   * Returns { isPII: boolean, category: string|null, confidence: number, signal: string }.
   */
  function classifyElement(element) {
    const { role, label, type, value } = element;

    if (isNegativeContext(label, role, type)) {
      return { isPII: false, category: null, confidence: 0, signal: "negative_context" };
    }

    // 1. Value regex/checksum — strongest, format-verified signal.
    if (typeof value === "string" && value.trim()) {
      const valueMatch = Patterns.matchValue(value);
      if (valueMatch) {
        return { isPII: true, category: valueMatch.type, confidence: valueMatch.confidence, signal: `value_${valueMatch.source}` };
      }
    }

    // 2. DOM type attribute — strong signal, works even on an empty field
    //    (needed so an about-to-be-filled email input still gets a token
    //    plan without depending on being non-empty first).
    if (TYPE_MAP[type]) {
      return { isPII: true, category: TYPE_MAP[type], confidence: 0.9, signal: "dom_type" };
    }

    // 3. Label keyword — medium-confidence signal, also works on empty fields.
    const labelCategory = matchLabelKeyword(label);
    if (labelCategory) {
      return { isPII: true, category: labelCategory, confidence: 0.75, signal: "label_keyword" };
    }

    return { isPII: false, category: null, confidence: 0, signal: "none" };
  }

  return { classifyElement, matchLabelKeyword, isNegativeContext };
});
