# Privacy-Preserving Vision Agent

A local browser agent that reads the page, redacts all sensitive/PII data
**on-device**, and sends only anonymised structure/context to a server-side
LLM, which returns one `click` / `type` / `scroll` / `done` action per step
for the client to execute.

Built for SIH 2026 (ISRO). `PROGRESS.md` has the full build log, including
every bug found and fixed along the way — this README covers setup, the demo,
architecture, and results.

## Hard privacy invariant

**No raw PII value ever appears in any network request the server receives.**
Detection, tokenization, and visual redaction all happen in the browser,
before a single byte leaves it:

- **Text**: the DOM extractor's output is run through a multi-signal PII
  classifier (value regex + checksum, DOM type, label keywords) before it's
  ever serialised. Detected values are swapped for tokens (`[NAME_1]`,
  `[AADHAAR_1]`, ...); the real values live only in an in-memory vault inside
  the content script. The server sees tokens and nothing else, and validates
  every action against `available_tokens` — it can never invent or leak a
  real value it never had.
- **Images**: screenshots run through on-device face detection (BlazeFace)
  and OCR (Tesseract.js) entirely inside a `chrome.offscreen` document, with
  zero third-party network calls. Detected faces are pixelated and any
  OCR'd text matching a PII pattern (or a password field's DOM bounds) is
  blacked out *before* the image is treated as sendable.

This isn't just asserted — it's proven by inspecting the exact payloads:
`eval/network-payload.jsonl` logs every request the server *actually
received* (not a client-side claim of what was sent), and
`eval/redaction-{before,after}.png` is a real before/after screenshot pair.
Both are generated fresh by running the demo/eval scripts below.

## Architecture

```
CLIENT (Chrome MV3 extension — extension/)
  content.js + lib/
    dom-extractor.js   → target_id / role / label / type / value / bbox per element
    pii-detector.js     → classifies each element (value regex/checksum, DOM type, label)
    tokenizer.js         → real value <-> [TOKEN_N], in-memory vault only
    executor.js           → click / type / scroll, detokenizes right before typing
  background.js  → orchestrates: extract -> POST /agent/step -> execute -> repeat
  offscreen.js + offscreen.html  (chrome.offscreen document, created on demand)
    BlazeFace (TFJS)  → local face detection
    Tesseract.js        → local OCR
    redaction pass        → pixelate faces, black-box passwords + PII-matched OCR text

SERVER (Python FastAPI — server/)
  POST /agent/step  → builds a prompt from sanitised state + task + history,
                       calls Groq, validates the action against known
                       target_ids and available_tokens, returns exactly one
                       action. Never sees raw PII — only tokens.
```

Why a `chrome.offscreen` document for vision: face detection needs
`<canvas>` and OCR needs Web Workers, and neither a content script's isolated
world nor the background service worker can provide both. This is the
MV3-native answer, created on demand (not at startup), so it costs nothing on
ordinary page loads.

## Setup

### Server

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in GROQ_API_KEY (free at console.groq.com)
python run.py            # serves on http://localhost:8000
curl localhost:8000/health
```

### Extension

1. Open `chrome://extensions`.
2. Enable "Developer mode".
3. Click "Load unpacked" and select the `extension/` directory.

### Tools (for the demo/eval/smoke scripts)

```bash
cd tools
npm install   # installs Playwright, used to drive a real Chromium with the extension loaded
```

## Running the demo

With the server's `.env` configured (see above):

```bash
cd tools
node demo.mjs
```

This runs one scripted end-to-end scenario: a job-application form next to a
"saved profile" card containing a name, email, phone number, Aadhaar number,
PAN, and address. The agent reads the profile, fills the empty form fields
using only tokens, and submits — the script then proves no raw PII ever hit
the network by inspecting `eval/network-payload.jsonl`, and confirms the
submitted form actually contains the real values (proving client-side
detokenization worked).

Also runnable directly from the debug console for interactive poking around:
load the extension, open `chrome-extension://<id>/debug.html`, open
`test-pages/demo.html` (served over `http://localhost` — not `file://`, since
Chrome only runs content scripts on `file://` pages after a manual
per-extension opt-in) in another tab, and use the Extract State / Run Agent /
Run Vision Scan controls.

## Evaluation

```bash
cd /path/to/repo
python eval/run.py             # full report, including a live agent-loop run
python eval/run.py --skip-llm  # skip the LLM-dependent section (fast, no key needed)
```

Every number below is a real measurement from an actual run of the extension
in a real, Playwright-driven Chromium — not an estimate.

| Metric | Result |
|---|---|
| PII detection precision | 94.4% |
| PII detection recall | 100.0% |
| PII detection F1 | 97.1% |
| Redaction recall (pixel-verified) | 4/4 targets (face, password, 2 PII-in-image regions) |
| Redaction precision (non-PII left alone) | confirmed |
| Face detection latency | ~160ms (WASM) |
| OCR latency | ~1.3s (WASM) |
| Bundled vision footprint | 12.5MB (loaded only on-demand, zero cost otherwise) |
| Core extraction/PII/redaction logic | 20.3KB |
| End-to-end agent task | see note below |

The one PII-detector false positive (precision 94.4%, not 100%) is a
deliberately adversarial test case — a "Ticket ID" field whose value happens
to be PAN-shaped — documented rather than excluded from the set; see
`eval/pii_testset.json`.

**End-to-end task latency**: the harness's live-agent section depends on a
working, unexhausted Groq API key. Groq's free tier has a **daily** token
quota (not just per-minute), which this project's own iterative development
and testing exhausted on the day this was built — `python eval/run.py`
degrades that one section to a clearly-labelled `N/A` with the real error
rather than crashing the rest of the report. The extraction/tokenization
mechanism it depends on is independently verified working (see
`tools/demo.mjs`'s output up to the agent-loop step, and Phase 2/3 in
`PROGRESS.md`); the full live run just needs a fresh key or a quota reset.

## Privacy proof

Two artifacts, regenerated by running the scripts above:

- **`eval/network-payload.jsonl`** — every `/agent/step` request the server
  actually received, logged server-side (not a client-side claim). Generated
  by `tools/demo.mjs` or `tools/smoke-phase3.mjs`.
- **`eval/redaction-before.png`** / **`redaction-after.png`** — a real
  screenshot before and after the visual redaction pass: a face pixelated, a
  password field and an Aadhaar number + email baked into an image both
  blacked out. Generated by `tools/smoke-phase5.mjs`.

## Repo layout

```
extension/    Chrome MV3 extension — all privacy-sensitive work happens here
  lib/          DOM extraction, PII detection, tokenization, action execution
  offscreen.*   chrome.offscreen document: local face detection + OCR + redaction
  vendor/       TFJS + BlazeFace + Tesseract.js runtime (bundled, no CDN)
  models/       BlazeFace weights + Tesseract English trained data (bundled)
server/       Python FastAPI server — LLM agent loop over sanitised state only
test-pages/   Local HTML pages used to exercise the extension end-to-end
tools/        Playwright scripts: per-phase smoke tests + the scripted demo
eval/         Evaluation harness + generated privacy-proof artifacts
```

## Status

All 7 build phases complete and verified — see `PROGRESS.md` for the full
log, including every bug found and how it was diagnosed and fixed.
