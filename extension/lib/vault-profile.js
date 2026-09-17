// User's own PII vault: chrome.storage.local-backed "source of truth" for
// the real values the agent fills forms with. Seeded by default with
// realistic but entirely FAKE data (the same fake identity test-pages/
// demo.html has used since Phase 7 — reused rather than inventing a second
// fake person) so the project demos safely without ever touching a real
// person's PII. The user can edit every field from the side panel.
//
// Runs in three contexts unchanged: the content script (loaded via
// manifest.json's content_scripts, alongside tokenizer.js), the side panel
// (plain <script> include), and the background service worker (via
// importScripts). `self` is the right root in all three — it IS `window` in
// a content script or an ordinary page, and is the service worker's global
// scope in background.js — so one file/one namespace works everywhere
// without duplicating this module per context.
(function () {
  "use strict";
  const root = typeof self !== "undefined" ? self : this;
  root.__PVA = root.__PVA || {};

  const STORAGE_KEY = "pva_vault_profile";

  // Same fake "Priya Nair" identity test-pages/demo.html has used since
  // Phase 7. Aadhaar passes the Verhoeff checksum; PAN is format-valid.
  const DEFAULT_PROFILE = {
    fullName: "Priya Nair",
    email: "priya.nair@example.com",
    phone: "9812345670",
    aadhaar: "234123412346",
    pan: "ABCDE1234F",
    address: "221 Residency Road, Bengaluru",
    custom: [],
  };

  // key -> {category, label} for the fixed fields. `category` matches
  // pii-detector.js's LABEL_KEYWORDS/TYPE_MAP categories exactly, so a
  // vault-issued token (e.g. "[AADHAAR_1]") reads exactly like a
  // DOM-discovered one would — one token vocabulary, not two.
  const FIELD_DEFS = [
    { key: "fullName", category: "NAME", label: "Full Name" },
    { key: "email", category: "EMAIL", label: "Email" },
    { key: "phone", category: "PHONE", label: "Phone Number" },
    { key: "aadhaar", category: "AADHAAR", label: "Aadhaar Number" },
    { key: "pan", category: "PAN", label: "PAN" },
    { key: "address", category: "ADDRESS", label: "Address" },
  ];

  function slugCategory(label) {
    const slug = String(label || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return slug || "CUSTOM";
  }

  function normalizeProfile(stored) {
    const profile = { ...DEFAULT_PROFILE, ...(stored || {}) };
    profile.custom = Array.isArray(profile.custom) ? profile.custom : [];
    return profile;
  }

  async function getProfile() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return normalizeProfile(null);
    }
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored && stored[STORAGE_KEY]) return normalizeProfile(stored[STORAGE_KEY]);
    const seeded = normalizeProfile(null);
    await chrome.storage.local.set({ [STORAGE_KEY]: seeded });
    return seeded;
  }

  async function saveProfile(profile) {
    const normalized = normalizeProfile(profile);
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  }

  /** Flattens a profile into [{category, label, value}], skipping empty values. */
  function profileToFields(profile) {
    const fields = [];
    for (const def of FIELD_DEFS) {
      const value = (profile?.[def.key] || "").toString().trim();
      if (value) fields.push({ category: def.category, label: def.label, value });
    }
    for (const custom of profile?.custom || []) {
      const label = (custom?.label || "").toString().trim();
      const value = (custom?.value || "").toString().trim();
      if (label && value) fields.push({ category: slugCategory(label), label, value });
    }
    return fields;
  }

  root.__PVA.DEFAULT_PROFILE = DEFAULT_PROFILE;
  root.__PVA.VAULT_FIELD_DEFS = FIELD_DEFS;
  root.__PVA.getProfile = getProfile;
  root.__PVA.saveProfile = saveProfile;
  root.__PVA.profileToFields = profileToFields;
  root.__PVA.slugCategory = slugCategory;
})();
