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

**Next:** Phase 1 — DOM extractor (target_id/role/label/bbox) + click/type/scroll executor,
tested against `test-pages/employee-portal.html`.
