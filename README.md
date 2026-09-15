# Privacy-Preserving Vision Agent

A local browser agent that reads the page, redacts all sensitive/PII data
**on-device**, and sends only anonymised structure/context to a server-side
LLM, which returns one `click` / `type` / `scroll` / `done` action per step
for the client to execute.

Built for SIH 2026 (ISRO). See `PROGRESS.md` for build status.

## Hard privacy invariant

No raw PII value ever leaves the browser. Detection and redaction happen in
the content script; the server only ever sees tokens (`[NAME_1]`,
`[AADHAAR_1]`, ...) and redacted images. This is provable by inspecting the
logged outgoing payload (see `eval/` in later phases).

## Layout

```
extension/    Chrome MV3 extension — all privacy-sensitive work happens here
server/       Python FastAPI server — LLM agent loop over sanitised state only
test-pages/   Local HTML pages used to exercise the extension end-to-end
eval/         Evaluation harness (PII precision/recall, redaction, latency)
```

## Setup

### Server

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in GROQ_API_KEY
python run.py           # serves on http://localhost:8000
curl localhost:8000/health
```

### Extension

1. Open `chrome://extensions`.
2. Enable "Developer mode".
3. Click "Load unpacked" and select the `extension/` directory.

## Status

Phase 0 (scaffold) complete. See `PROGRESS.md` for the running log of what
works and what's left across all build phases.
