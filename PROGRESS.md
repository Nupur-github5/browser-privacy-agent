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

## Phase 2 — Server agent loop (end-to-end, still no privacy) ✅

- `server/app/schemas.py` — Pydantic models for `SanitizedState`/`Element`/`BBox` and a
  discriminated `Action` union (`ClickAction | TypeAction | ScrollAction | DoneAction`) matching
  the schema in the spec exactly (no `navigate`/`press`/`wait` — kept the action surface to what
  the client executor actually implements).
  `AgentStepRequest`/`AgentStepResponse` carry `{state, history}` in, `{action, repaired,
  raw_llm_output}` out.
  `raw_llm_output` is a debug field returned on every response — not sent back to the client's
  network layer by anything downstream, and will need excluding from any payload log once Phase
  3 wires up the "prove no PII leaves the browser" logging in `eval/`.
- `server/app/llm.py` — `GroqClient`, thin `httpx` wrapper over Groq's OpenAI-compatible
  `/chat/completions`, JSON mode on, no `groq` SDK dependency (keeps the server light).
- `server/app/prompt.py` — system prompt explains the token/PII contract up front (agent must
  never invent PII, must use `available_tokens` verbatim) even though Phase 2 always sends an
  empty token list — this way Phase 3 needs no prompt rewrite, only real tokens flowing in.
- `server/app/agent.py` — `agent_step()`: calls the LLM, strips stray markdown fences, parses
  into the `Action` union, validates `target_id` against the current state's elements and any
  `[TOKEN_N]`-shaped value against `available_tokens`. On failure, does ONE repair round-trip
  (re-prompts the model with its bad output + the validation error); if that also fails, returns
  a synthetic `{"action": "done", "reason": "..."}` rather than crashing the loop.
  `POST /agent/step` in `server/app/main.py` exposes this.
- `server/tests/test_agent.py` (pytest + pytest-asyncio, `FakeLLM` stub — no network/key needed)
  — 5 tests: valid action passes straight through; unknown `target_id` triggers repair and
  recovers; markdown-fenced JSON is stripped; a token outside `available_tokens` is rejected and
  repaired; two rounds of unparseable garbage falls back to `done`. All 5 pass
  (`pytest server/tests -q`).
- `extension/background.js` gained `runTask(tabId, task)`: loops
  `EXTRACT_STATE → POST /agent/step → EXECUTE_ACTION` (re-extracting state each turn) until the
  server returns `done` or `MAX_STEPS` (25) is hit, driven from the client so no server-side
  polling/session state is needed. Wired to a new "Run Agent" control in `extension/debug.html`.
- `tools/smoke-phase2.mjs` — spawns the real FastAPI server (real Groq calls), loads the
  extension, drives "Fill this form with realistic test data ... and submit" through the debug
  page's Run Agent button, polls for completion, and asserts the form actually submitted.
  **Not yet run** — needs a `GROQ_API_KEY` in `server/.env`, which is the user's to provide.
- Decision: the client (background service worker) owns the step loop rather than the server
  polling an action queue (as in the `new-sih` reference). One dependency direction only —
  server is a pure function of (state, history) → action — and it means Phase 3/5's redaction
  work only ever has to reason about one outgoing HTTP call per step.

**Verified (live, real Groq calls):** `pytest server/tests -q` → 5 passed. `node
tools/smoke-phase2.mjs` → **PASS** (two consecutive clean runs): agent autonomously fills all 7
employee-portal fields and submits, 9 steps, 0 repairs, ~35–45s wall clock.

**Issues hit and fixed while getting the live run green:**
- `llama-3.3-70b-versatile` (the model named in the original build brief) is no longer served by
  Groq — the account's live model list is `openai/gpt-oss-{20b,120b}`, `groq/compound{,-mini}`,
  `whisper-large-v3*`, `allam-2-7b`, a couple of `qwen`/`canopylabs` models, and prompt-guard
  models. Switched default to **`openai/gpt-oss-20b`**.
- The `gpt-oss` models are reasoning models that emit hidden chain-of-thought tokens by default,
  which alone blew through the free tier's 8000 TPM budget in ~4 calls. Fixed by sending
  `reasoning_effort` (`"low"` under-performed on instruction-following — see below — settled on
  `"medium"`) and by trimming the per-step payload: `_compact_element()` in `prompt.py` drops
  `bbox`/`visible` from what the LLM sees (the LLM reasons over role/label/value text, not pixel
  geometry — Phase 4's vision path will consume bbox separately) and history is capped to the
  last 4 turns instead of 8.
- Added 429 retry-with-backoff in `server/app/llm.py` (reads `retry-after`, up to 3 retries) —
  free-tier bursts are expected in normal use, not just under test load.
- At `reasoning_effort: "low"` the 20b model was unreliable in two ways, both fixed by raising to
  `"medium"` and one prompt clarification: (1) it sometimes looped, re-typing already-filled
  fields for 25 steps without ever reaching `done` — fixed by adding an explicit
  "CRITICAL — AVOID REPEATING WORK" rule to `SYSTEM_PROMPT` telling it to check each element's
  current value before acting; (2) it once refused to fill the form at all, misreading an empty
  `available_tokens` (expected in Phase 2 — no redaction yet) as a blocking error — fixed by
  telling it explicitly that an empty token list is normal, not an error.
- A stale leftover `python run.py` from Phase 0's manual test (started with `nohup ... &`, not
  fully killed) sat on port 8000 for the whole session, silently serving all "healthy" checks
  with the OLD code/env while every real fix went to a process nothing was ever hitting. Cost the
  most debugging time of anything in this phase — always `lsof -ti:8000 | xargs kill -9` before
  trusting a "server healthy" log line during iteration.
- Found and fixed a real accuracy bug while poking at the transcripts, not from a test failure:
  `dom-extractor.js` was registering each `<option>` as its own clickable target. Clicking a
  synthetic `<option>` doesn't fire a native `<select>`'s change mechanics, so the agent could
  "successfully click" an option and the department field would still submit empty. Removed
  `option` from `INTERACTIVE_TAGS` — only the parent `<select>` is now exposed, and the agent
  must use `type` on it (already correctly handled in `executor.js`'s select branch).

**Next:** Phase 3 — PII detection + tokenization (port vision-guard's JS detector +
redectionFramwork's tokenizer/vault), thread real tokens through `available_tokens`, detokenize
client-side right before `EXECUTE_ACTION` runs a `type`, and log the exact outgoing
`/agent/step` payload to prove zero raw PII crosses the wire.
