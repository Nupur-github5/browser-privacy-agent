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

## Phase 3 — PII detection + tokenization ✅

- `extension/lib/pii-patterns.js` (UMD — runs in both the content script and Node) — regex +
  checksum value detectors ported from redectionFramwork's `pii_detector.py`: EMAIL, GSTIN
  (mod-36 checksum), AADHAAR (Verhoeff checksum), PAN, IFSC, UPI, CARD (Luhn), PHONE (Indian
  mobile). Checksums are enforced, not just format-matched, matching the reference's design —
  a format match that fails its checksum is not reported.
- `extension/lib/pii-detector.js` (UMD) — `classifyElement({role,label,type,value})` combines
  three signals in priority order: (1) value regex/checksum — strongest, works on filled fields;
  (2) DOM `type` attribute (email/tel/password) — strong, works on empty fields too, needed so
  an about-to-be-filled field still gets recognised; (3) label keyword match (adapted from
  vision-guard's `KEYWORD_GROUPS`) — medium confidence, also works empty. A negative-context
  check (button roles, submit/cancel/department/etc. labels) runs first and short-circuits
  everything else, so e.g. the "Department" `<select>` is never mistaken for PII.
- `extension/lib/tokenizer.js` — in-memory `Vault`: `tokenize(category, value)` (dedupes
  identical values to the same token via a `category::value` key, so the same real value always
  maps to the same token across re-extractions without needing to persist the vault instance
  itself), `detokenize(token)`, `detokenizeText()` (replaces every `[TOKEN_N]` in a string).
  Lives only in the content script's isolated world; never serialised.
- `content.js`: `extractState()` now runs every element through the classifier and swaps the
  `value` for a token when PII is detected (and the field is non-empty — nothing to redact in an
  empty field yet); `executeAction()` detokenizes any `[TOKEN_N]` in `action.value` right before
  handing off to `executor.js`, so the real value only ever exists in the DOM and the vault, never
  in a message or network payload.
- Removed `option` from `dom-extractor.js`'s `INTERACTIVE_TAGS` (found while testing this phase,
  not this phase's bug, but this is where it got caught): a synthetic click on an `<option>`
  doesn't fire native `<select>` change mechanics, so the agent could "successfully" select a
  department and have it submit empty. Selection now always goes through `executor.js`'s
  type-on-`<select>` path.
- `server/app/main.py`: `PVA_LOG_PAYLOADS=1` (server/.env) appends every `/agent/step` request
  the server *actually received* to `eval/network-payload.jsonl` — the privacy proof reads from
  the receiving end, not a client-side claim of what was sent.
- New test page `test-pages/pii-review.html`: pre-filled with real (synthetic) PII — name,
  email, phone, Aadhaar (`234123412346`, Verhoeff-valid), PAN, address — plus an empty "Confirm
  Aadhaar Number" field. Exercises the full loop: extraction must tokenize the pre-filled values,
  the agent must reuse `[AADHAAR_1]` from `available_tokens` to fill the confirm field, and the
  client must detokenize it back to the real number before typing.
- `tools/smoke-phase3.mjs` — end-to-end: asserts (a) no raw PII value ever appears in
  `eval/network-payload.jsonl`, (b) `[AADHAAR_1]` DOES appear there (proving redaction is active,
  not just coincidentally absent data), and (c) the form submits with the REAL Aadhaar number in
  both the original and confirm fields (proving client-side detokenization is correct, not just
  that redaction happened).
- `eval/pii_testset.json` + `eval/pii-precision-recall.mjs` — 27 hand-labelled cases (positive/
  negative/ambiguous tiers) run straight through `classifyElement()` via Node. **Result:
  precision 94.4%, recall 100%, F1 97.1%.** The one false positive is a deliberately adversarial
  case ("Ticket ID" whose value happens to be PAN-shaped) — a known, honest limitation of
  format-only detection without negative context for that specific collision, not hidden or
  excluded from the set.
- Fixed a real reliability gap surfaced while testing this phase: Groq's own JSON-mode
  validation occasionally fails server-side and returns an empty generation with a 400 (not a
  429) — `agent_step()` in `server/app/agent.py` now retries transient `LLMError`s from the LLM
  call itself (up to 3 attempts total, shared with the parse/validation repair budget) instead of
  letting one bad generation abort the whole step. Two new unit tests cover this (retry-and-
  recover, and propagation when all attempts are transient failures) — 7/7 passing.

**Verified (live, real Groq calls):**
- `node eval/pii-precision-recall.mjs` → precision 94.4%, recall 100%, F1 97.1% (no network).
- `pytest server/tests -q` → 7 passed.
- `node tools/smoke-phase3.mjs` → **PASS**: zero raw PII in any logged outgoing payload, the
  `[AADHAAR_1]` token present (redaction confirmed active), and the form submitted with the
  correct real Aadhaar value in both fields (detokenization confirmed correct).
- `node tools/smoke-phase1.mjs` → still PASS (no regression).
- `node tools/smoke-phase2.mjs` → still PASS. Also surfaced a nice side effect: once the agent
  types real-looking data into employee-portal's fields, the *next* extraction on that same page
  now tokenizes them too — Phase 3's redaction protects any page with real-looking PII values on
  it, not just the dedicated PII test page. The model occasionally does one harmless redundant
  re-type of an already-filled (now-tokenized) field before recognizing it's done; costs a step,
  never breaks correctness.
- Note: further live re-confirmation was cut short by Groq's free-tier **daily** token quota
  (200k TPD) being exhausted by this session's iterative testing — not a code issue. The
  `network-payload.jsonl` and passing run above are from before the quota hit; the agent.py
  changes made afterward (LLM-error retry) are covered by unit tests and don't touch the
  tokenize/detokenize/prompt logic Phase 3 actually validates.

## Phase 4 — Local vision (face detection + OCR) ✅

Pure client-side capability — no LLM/server involved at all, so unaffected by the Groq quota.

- **Architecture: `chrome.offscreen` document**, not a content script or the service worker.
  Face detection needs `<canvas>` (turn a screenshot data URL into pixels); OCR needs Web
  Workers. Service workers have neither; content scripts run in an isolated JS world that can't
  share globals with classic (non-module) vendor scripts the way a normal page can. An offscreen
  document (`extension/offscreen.html` + `offscreen.js`) is the MV3-native answer: a real page,
  part of the extension, with full DOM — created on demand by `background.js`
  (`ensureOffscreenDocument()`, `reasons: ["WORKERS"]`), not at startup, so it costs nothing on
  ordinary page loads.
- **Face detection: BlazeFace on TensorFlow.js.** Chosen after actually comparing bundle sizes,
  not just picking the first option in the brief: ONNX Runtime Web's WASM backend is 14–28MB per
  variant; `@mediapipe/tasks-vision`'s generic multi-task WASM runtime is ~9MB; TFJS
  core+wasm-backend+webgpu-backend+BlazeFace comes to **~1.4MB of runtime code**, and the actual
  BlazeFace model weights (fetched from TF Hub once, now vendored locally) are only ~460KB. All
  fetched from `chrome.runtime.getURL(...)` — zero third-party network calls at inference time.
- **OCR: Tesseract.js**, LSTM-only core build (`tesseract-core-simd-lstm.wasm`, ~2.8MB) +
  `eng.traineddata` from the `tessdata_fast` set (~4MB) — the "fast" variant specifically to keep
  the bundle down; the full accuracy-tuned traineddata is 3–4x larger for a use case (reading
  short in-image labels/badges) that doesn't need it.
- Total bundled footprint: **~12.6MB** (`extension/vendor/` + `extension/models/`), committed to
  the repo (not gitignored — `.gitignore`'s old blanket `models/`/`*.wasm` rules were from Phase
  0, written before there was a real reason to bundle either; removed now that there is).
- `extension/lib` untouched — vision is a separate pipeline from DOM extraction/PII, feeding
  into the same `vision_regions` field the schema already reserved for it back in Phase 0.
- New test fixtures: `test-pages/vision-test.html` with (a) a real face — a public-domain NASA
  astronaut portrait via `images-api.nasa.gov`'s official-portraits collection (US government
  work, unambiguous license, and an anonymous-enough subject that it's a clean test fixture
  rather than a recognisable-public-figure concern) and (b) `assets/access-badge.png`, a PNG
  with "Badge ID: MC-77219" rendered as pixels — deliberately NOT in the page's DOM, so the only
  way to recover it is OCR over the actual screenshot.
- `tools/smoke-phase4.mjs` asserts a real face is found with a plausible bbox, a real provider
  name (`webgpu`/`wasm`) and positive latency are reported, and the OCR text genuinely contains
  "77219"/"Badge" — not just that *some* output was produced.

**Bugs found and fixed while getting this green** (each confirmed via targeted before/after
tests, not assumed):
- **BlazeFace's default `scoreThreshold` (0.75) rejects real, clearly-visible faces fairly
  often** — the NASA portrait scored 0.66. Lowered to 0.5, which is still comfortably above
  noise-level scores for non-faces. This is a genuine accuracy tuning finding, not a code bug.
- **WebGPU backend returns silently WRONG (empty) BlazeFace predictions** in a
  software-rendered environment (headless Chromium + swiftshader, no real GPU) — no error, just
  zero detections where WASM correctly finds the same face at the same confidence. Since this
  can't be distinguished at runtime from "genuinely no face in frame," WebGPU is now gated behind
  `globalThis.__PVA_ENABLE_WEBGPU__` (off by default) and WASM is the verified-correct path. A
  real GPU may make WebGPU worth re-enabling — untested here since this environment has none.
- **`tf.wasm`'s multithread auto-detection hangs forever, silently, against a non-threaded
  binary.** Only one WASM variant is bundled (non-threaded SIMD, to avoid requiring
  cross-origin-isolation headers just for a threaded build); the auto-detector otherwise tries
  to spin up Workers expecting the threaded build's message protocol against a binary that
  doesn't speak it. Fixed with `tf.env().set("WASM_HAS_MULTITHREAD_SUPPORT", false)` +
  `tf.wasm.setThreadsCount(1)`.
  This class of bug (a promise that never settles, no exception, no log) was the single biggest
  time sink in this phase — worth naming the general lesson: when an extension flow hangs with
  zero error, the fix that finds it fastest is relaying `console.log` from wherever the hang
  actually is (offscreen document, content script, service worker) to whichever context the test
  harness *can* observe, not staring at the one log stream that's silent.
- **Tesseract.js's default worker loading is incompatible with MV3 extensions.** It normally
  wraps the worker script in a `Blob(['importScripts("<workerPath>")'])`, and that blob-origin
  worker cannot reach `chrome-extension://` resources — not even with
  `web_accessible_resources` declared (tried that first; it didn't help, because the blob
  worker's origin isn't what `matches` is evaluated against). Fixed with the `workerBlobURL:
  false` option, which loads `worker.min.js` directly instead.
- **Tesseract.js v7's `recognize()` doesn't populate `data.words`/`data.blocks` by default** —
  only `data.text` (plain string) and `data.tsv` are generated unless you ask for more via the
  third (`output`) argument. Word-level boxes now come from parsing `data.tsv` (Tesseract's
  well-documented tab-separated format) directly rather than a hierarchical field that turned
  out to always be empty at these default settings.
- `chrome.tabs.captureVisibleTab` needs **`<all_urls>` or `activeTab`** — the specific
  `http://127.0.0.1:*/*`-style host_permissions used since Phase 1 (sufficient for content-script
  injection and messaging) are not sufficient for this particular API. Broadened
  `host_permissions` to `<all_urls>` accordingly; also learned along the way that
  `captureVisibleTab` always captures whichever tab is *currently active* in a window (no tabId
  parameter), so `background.js` now explicitly activates the target tab first.
- Lost significant time to a **red herring**: after this phase's manifest/background.js changes,
  Phase 2's agent loop appeared to hang indefinitely. Exhaustively ruled out CSP, host_permissions,
  the event loop backend (uvloop vs asyncio), and stray processes as causes, by testing each in
  isolation via raw `httpx` calls made directly inside a FastAPI endpoint. The actual cause: the
  Groq free-tier **daily** token quota (200k TPD) was nearly exhausted from cumulative testing
  across today's session, so every retry attempt in `agent_step()`'s existing backoff logic hit
  *another* 429, taking up to ~45s to finally surface a clear rate-limit error — which looked
  like a silent hang in shorter test timeouts. No actual regression; the retry logic was working
  exactly as designed. Added a client-side `AbortController` timeout (45s) to `runTask()`'s fetch
  in `background.js` regardless, so a genuinely stuck request now fails fast with a clear reason
  instead of hanging the whole task — good hardening independent of the root cause here.

**Verified:** `node tools/smoke-phase4.mjs` → **PASS** (run twice): 1 face detected (confidence
0.66, plausible bbox), provider `wasm`, latency ~155–165ms; OCR finds 86 word regions including
"MC-77219" and "MISSION CONTROL" from the badge PNG, provider `wasm`, latency ~1.2s. `node
tools/smoke-phase1.mjs` still passes (no regression from the manifest/host_permissions changes).

## Phase 5 — Visual redaction ✅

Also pure client-side — no LLM/server involved, unaffected by the Groq quota.

- Extends `extension/offscreen.js` (same document as Phase 4 — reuses the already-decoded
  screenshot canvas rather than redecoding): after face detection + OCR resolve, a redaction
  pass runs directly on that canvas before anything reads `toDataURL()` from it.
- **Faces**: pixelated (downscale-then-upscale onto the same region — simpler and more robust
  across canvas sizes than `ctx.filter='blur()'` on a sub-region), with the reported bbox padded
  25% on each side first. Necessary in practice, not just defensive: at the confidence this
  model produces on a full-page screenshot (see below), the box is often loose enough that
  blurring only the literal reported rectangle leaves a visible sliver of face at the edge.
- **Password fields**: DOM `bbox` for every extracted `type === "password"` element, fetched by
  `background.js` via one `EXTRACT_STATE` call before capturing the screenshot, passed into the
  `RUN_VISION` message. Solid black, no padding needed (exact element bounds).
- **PII-in-image text**: every OCR'd word *and* line (`extension/lib/pii-patterns.js` — the same
  module Phase 3 uses for JSON tokenization, now also loaded into the offscreen document) is
  checked with `matchValue()`; any hit gets solid-blacked. Checking whole lines in addition to
  single words matters — a spaced-out Aadhaar number splits across multiple OCR word boxes, and
  only the joined line matches the pattern. Known gap: this only catches values matching a
  *format* (AADHAAR/PAN/GSTIN/IFSC/UPI/CARD/PHONE/EMAIL) — a bare name like "Rahul Sharma" baked
  into an image has no fixed shape and needs label context OCR text doesn't carry, so it is
  **not** redacted by this pass. Same fundamental limitation Phase 3 already documented for
  DOM-side NAME detection (label-keyword only, no value pattern) — consistent, not a new gap.
- New test-pages/redaction-test.html: real face + a filled `type="password"` input + an ID card
  PNG with a real Aadhaar number and email baked into its pixels (not DOM text). Deliberately
  compact/single-viewport layout — the first version had the ID card below the screenshot fold
  and it silently went unredacted, which is exactly the kind of bug this phase exists to catch.
- `tools/smoke-phase5.mjs` doesn't trust the reported bboxes — it decodes both PNGs into a
  canvas via `page.evaluate` and samples actual pixel colour: the face region must visibly
  *change* between before/after (sampled across a 3×3 grid inside the padded bbox, since the
  single center point can land on background at low confidence), and the password + both PII
  regions must be solid black in the after image. Saves the pair to
  `eval/redaction-{before,after}.png` — the visual half of the privacy proof (alongside Phase
  3's `network-payload.jsonl`) — gitignored, regenerated by running the test.

**A real accuracy issue found while building the test, not a code bug:** the SAME portrait photo
that scored 0.66 confidence in Phase 4's `vision-test.html` scored only **0.19** in this phase's
`redaction-test.html` — same model, same image file, different in-page size/position. BlazeFace
resizes whatever canvas it's given to 128×128 before inference; a face occupying a smaller
fraction of a 1280×720 screenshot loses more detail in that resize and the model is measurably
less confident, even though nothing about the photo itself changed. At the default 0.75
threshold (or even the 0.5 Phase 4 settled on) this face would have gone completely undetected —
and unredacted. Lowered `scoreThreshold` to 0.15, chosen from an actual dump of raw per-box
scores at threshold 0 (0.19 → 0.12 → 0.04 → 0.02 → ~0, a real cliff between signal and noise —
not an arbitrary round number) and deliberately erring toward recall: for a redaction feature a
missed face is a real privacy leak, a false-positive blur is just wasted pixels on background.

**Verified:** `node tools/smoke-phase5.mjs` → **PASS** (run twice): face region pixel-changed by
68.2 (well above the 10-point noise floor) across the padded bbox, password field centre pixel
`(0,0,0)`, both ID-card PII regions' centre pixels `(0,0,0)`. `node tools/smoke-phase1.mjs` and
`node tools/smoke-phase4.mjs` still pass — no regression.

## Phase 6 — Evaluation harness ✅

- `eval/run.py`: one entry point, five sections, each backed by a real run of the actual
  extension in a real browser — nothing in the report is estimated or hand-typed. It shells out
  to the same Playwright scripts already built (and independently verified) in earlier phases,
  each of which gained a `--json` output mode for this purpose (`eval/pii-precision-recall.mjs`,
  `tools/smoke-phase{2,4,5}.mjs`), parses their last JSON-shaped stdout line, and formats a
  unified report:
  1. **PII detection precision/recall/F1** (overall + per-category) — Phase 3's detector against
     the 27-case labelled set.
  2. **Redaction precision/recall** — Phase 5's pixel-sampling checks against the
     face/password/PII-in-image targets, plus a genuine precision signal (a non-PII "Name" text
     region must stay *unredacted* — without checking that, a detector that just blacks out the
     whole image would trivially pass).
  3. **Visual-context accuracy** — Phase 4's face + OCR detection quality and latency.
  4. **Client resource use** — actual `extension/lib` / `vendor` / `models` directory sizes on
     disk (20.3KB / 8.1MB / 4.4MB) plus measured per-scan CPU latency; notes that the vision
     bundle only loads inside the on-demand `chrome.offscreen` document, so it costs nothing on
     ordinary page loads — the always-on path (DOM extraction, PII detection, tokenization) is
     `lib/` alone.
  5. **End-to-end task latency** — Phase 2's live agent loop. Wrapped so a failure here (LLM
     quota, network) degrades to a clearly-labelled `N/A` with the actual error message and a
     pointer to check quota before assuming a code problem, rather than crashing the whole
     report — sections 1-4 are pure client-side work and have no reason to be blocked by section
     5's dependency on a live key.
- `--skip-llm` flag skips section 5 outright for a fast, key-independent run.

**Verified:** `python eval/run.py --skip-llm` → all four client-side sections report real
numbers (PII: 94.4% precision / 100% recall / 97.1% F1; redaction: 4/4 targets correctly
redacted, non-PII content preserved; vision: 1 face + 86 OCR words, both ~150-1300ms; resource
use: 12.5MB total bundle, ~1.4s per-scan CPU cost). `python eval/run.py` (no flag, live LLM
attempted) → sections 1-4 identical, section 5 degrades to a clean `N/A` with the real Groq
quota-exhaustion error rather than crashing — and the partial agent transcript in that error
confirms the Phase 2 loop is still working correctly today (7 correct steps, including reusing
an already-issued `[NAME_1]`/`[EMAIL_1]` token) right up until the quota cut it off.

**Next:** Phase 7 — demo + docs. One scripted end-to-end scenario (Aadhaar/PAN/phone/email/name/
address all redacted before leaving the browser, form still submits correctly) and a README with
setup, run steps, an architecture summary, the metrics table from this phase, and the privacy
proof (`eval/network-payload.jsonl` + `eval/redaction-{before,after}.png`). Should also verify
against a fresh clone once Groq's daily quota has reset, to get a genuine end-to-end latency
number into the final report rather than relying on today's partial transcript.
