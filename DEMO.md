# Presentation-Day Checklist

## Prerequisites (do the day before)

- [ ] `server/.venv` exists, `server/.env` has a **working** `GROQ_API_KEY` and `PVA_LOG_PAYLOADS=1`
- [ ] Spare Groq key ready (free tier has a *daily* token quota — a second account's key is the fix)
- [ ] `tools/node_modules` installed (`cd tools && npm install && npx playwright install chromium`)
- [ ] Extension loaded in Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extension/`
- [ ] Pin the extension icon to the toolbar (puzzle-piece menu → pin)
- [ ] Recorded backup: run `node tools/demo.mjs` once and keep the terminal output + `eval/redaction-*.png`

## Start / stop

```bash
./start-demo.sh   # frees :8000/:8080, starts server + test pages, waits for /health, prints URLs
./stop-demo.sh    # stops both
```

## 2-minute demo script

| # | Do | Say |
|---|----|-----|
| 1 | Open `http://localhost:8080/gov-portal.html` | "A cluttered government portal — nav links, notices, an ad. The form in the middle is empty." |
| 2 | Click the extension icon → side panel opens | "This is our agent. Everything privacy-sensitive runs inside the browser." |
| 3 | Expand **🔐 My Vault** | "The user's real details live only in local browser storage — Aadhaar, PAN, phone, address." |
| 4 | Type: `Fill in the Aadhaar Detail Update form using my saved details and submit it.` → **Run** | "The LLM is a cloud model on Groq. It will never see these values." |
| 5 | Point at the live log + blue highlights (Demo mode on, ~700 ms delay) | "Each step: we read the page, swap PII for tokens like `[AADHAAR_1]`, send only that. The LLM answers with one action. The real value is typed back in *here*, locally." |
| 6 | Point at the submitted form result | "The form got the real values, so detokenization worked." |
| 7 | Point at **🔒 Privacy Report** | "6 sensitive values protected, 0 sent in raw form. That's a real check on every outgoing request, not a claim. A leak would be blocked before sending." |
| 8 | (Optional) `tail -1 eval/network-payload.jsonl` | "This is what the server *received*, logged on the server side. Only tokens." |

## Backup flows

- **`demo.html`**: profile card on the left, job form on the right. Prompt: *"Fill out the application form on the right using the saved profile information on the left, then submit the form."*
- **`pii-review.html`**: pre-filled PII plus an empty Confirm Aadhaar field. Prompt: *"Copy the Aadhaar number into the Confirm Aadhaar Number field, then submit the form."*
- **`redaction-test.html`** (no LLM needed): open `chrome-extension://<id>/debug.html` (the id is on `chrome://extensions`) and click **Run Vision Scan**. The face gets pixelated, and the password and the Aadhaar/email in the ID-card image are blacked out. Static copy: `eval/redaction-before.png` / `redaction-after.png`.
- **No internet / no LLM at all**: `server/.venv/bin/python eval/run.py --skip-llm`, giving PII P/R/F1 of 94.4 / 100 / 97.1 % and 4/4 redaction targets.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 8000/8080 in use, or the server "healthy" but running old code | `./stop-demo.sh && ./start-demo.sh` (it kills whatever is on the ports) |
| Agent stops with 429 / rate limit / quota error | Groq free-tier quota, not a bug. Put a spare key in `server/.env` and restart. Or show `eval/run.py --skip-llm` + the recorded `demo.mjs` run |
| Changed extension code but behaviour unchanged | `chrome://extensions` → reload ↻ on the extension, then **reload the page tab** |
| Side panel says nothing happens / no content script | Page opened as `file://`. Use `http://localhost:8080/...` (Chrome blocks content scripts on `file://` by default) |
| Side panel doesn't open on icon click | Reload the extension. Make sure you clicked the extension's own icon, not the puzzle piece |
| Vision scan slow the first time | Normal: models load on demand (~1–2 s). WASM is used, and WebGPU is off by default on purpose |
