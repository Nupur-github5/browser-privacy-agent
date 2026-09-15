# Progress Log — Privacy-Preserving Vision Agent

Reference repos are mined for components; nothing is git-merged. They're cloned
to a scratch dir outside this project for reading only:
- `new-sih` (JaySahu08) — DOM extractor / target_id registry / agent loop backbone
- `vision-guard-` (kri-jha) — JS PII detector (`extension/pii/`) + vision scaffolding (`extension/vision/`, stubbed model)
- `redectionFramwork` (Nupur-github5) — PII regex/checksum detectors, tokenize/detokenize, vault (Python reference — will be ported to JS for the client)

## Phase 0 — Scaffold ✅

- Repo layout created: `extension/`, `server/`, `test-pages/`, `eval/`.
- Extension: minimal MV3 skeleton — `manifest.json`, `background.js` (service worker,
  message relay stub + per-tab cache), `content.js` (loads, pings background),
  `popup.html`/`popup.js`.
- Server: FastAPI app (`server/app/main.py`) with `/health`, CORS locked to
  `chrome-extension://*` and localhost via `allow_origin_regex`. Config in
  `server/config.json`, secrets via `server/.env` (gitignored, `.env.example` committed).
  Run with `python run.py` inside `server/.venv`.
- Decisions:
  - **FastAPI over Flask** — async support will matter once we're calling an LLM API
    per agent step, and Pydantic models double as our schema validation for the
    sanitised-state / action JSON contracts in Phase 2+.
  - **Groq as default LLM provider** — free tier, fast inference, good for demo latency.

**Verified:**
- `python3 -c "import json; json.load(open('extension/manifest.json'))"` → OK.
- `curl localhost:8000/health` → `{"status":"ok"}`.
- Extension load-in-`chrome://extensions` not verifiable headlessly in this environment —
  manifest validated structurally instead; ask user to confirm a real load when convenient.

## Phase 1 — Perception + actuation (no privacy, no server) ✅

- `extension/lib/element-registry.js` — per-page `target_id <-> live element` map (`WeakMap` +
  `Map`), lives only in the content script's isolated world; never serialised.
- `extension/lib/dom-extractor.js` — single-pass `TreeWalker` over `document.body` collecting
  interactive elements (`a[href]`, `button`, `input`, `textarea`, `select`, `[role=...]`,
  `[contenteditable]`, `[tabindex>=0]`, `[onclick]`). For each: `target_id`, `role` (explicit
  `role` attr → tag/type heuristic), `label` (aria-label → aria-labelledby → `<label for>` →
  ancestor `<label>` → placeholder → title → text content → `name`), `type`, `value`
  (checked/select-option/input value), `bbox`, `visible`.
- `extension/lib/executor.js` — `click` / `type` / `scroll` / `done`, resolves `target_id` via
  the registry, dispatches real `input`/`change`/`keydown`/`keyup` events (React/Vue-safe via
  the native value-setter trick) so framework-bound forms pick up the change.
- `content.js` wires these together behind `EXTRACT_STATE` / `EXECUTE_ACTION` runtime messages;
  `background.js` gained a generic `RELAY_TO_TAB` relay so any extension page can talk to a
  specific tab's content script.
- `extension/debug.html` + `debug.js` — a manual/automated test console: pick the page's
  non-extension tab, "Extract State" to dump the element list, and a small form to fire one
  action by `target_id` and see the raw result. Doubles as the Phase 7 demo control panel.
- `tools/smoke-phase1.mjs` (Playwright, Chromium pinned to the cached `chromium-1234` build)
  — loads the unpacked extension for real, serves `test-pages/` over local HTTP (file:// was
  ruled out: Chrome only runs content scripts on `file://` pages after a manual per-extension
  toggle, which would break both CI and a fresh demo checkout), extracts state, fills every
  field on `employee-portal.html` by `target_id`, submits, and asserts the submitted payload
  matches. Run with `npm run smoke:phase1` inside `tools/`.
- Decisions:
  - Registry never crosses the messaging boundary — only the flat `elements` array does. This
    is the seam Phase 3 will thread tokens through instead of raw values.
  - Test pages are served over HTTP rather than opened as `file://`, both for the smoke test
    and for manual demos, to sidestep Chrome's file-access opt-in entirely.

**Verified:** `node tools/smoke-phase1.mjs` → `PHASE 1 SMOKE TEST: PASS` (extracts 12 elements,
fills name/email/phone/aadhaar/pan/address/department by `target_id`, clicks submit, submitted
JSON matches expected values exactly).

**Next:** Phase 2 — server agent loop (LLM chooses actions from raw state; still no privacy),
looped against `content.js` until `done`, with action validation against known `target_id`s.
