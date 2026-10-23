#!/usr/bin/env bash
# start-demo.sh — start the agent server (:8000) and the test-page server (:8080)
# in the background for a live demo. Stop both with ./stop-demo.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/pva-demo"
mkdir -p "$RUN_DIR"

free_port() {
  local pids
  pids="$(lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "  port $1 in use by PID(s) $(echo $pids) — killing (stale servers serve old code; see PROGRESS.md Phase 2)"
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

if [ ! -x "$ROOT/server/.venv/bin/python" ]; then
  echo "ERROR: server/.venv missing. Run: cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt"
  exit 1
fi
if [ ! -f "$ROOT/server/.env" ] || ! grep -qE '^GROQ_API_KEY=.+' "$ROOT/server/.env"; then
  echo "WARNING: GROQ_API_KEY is not set in server/.env — the agent will not be able to call the LLM."
fi

echo "[1/4] Freeing ports 8000 and 8080..."
free_port 8000
free_port 8080

echo "[2/4] Starting agent server on :8000 (log: $RUN_DIR/server.log)..."
# shellcheck disable=SC1091
source "$ROOT/server/.venv/bin/activate"
(cd "$ROOT/server" && setsid python run.py >"$RUN_DIR/server.log" 2>&1 & echo $! >"$RUN_DIR/server.pid")

echo "[3/4] Starting test-page server on :8080 (log: $RUN_DIR/pages.log)..."
(cd "$ROOT/test-pages" && setsid python -m http.server 8080 >"$RUN_DIR/pages.log" 2>&1 & echo $! >"$RUN_DIR/pages.pid")

echo "[4/4] Waiting for http://localhost:8000/health ..."
for _ in $(seq 1 30); do
  if curl -fsS http://localhost:8000/health 2>/dev/null | grep -q '"ok"'; then
    HEALTH_OK=1; break
  fi
  sleep 1
done
if [ "${HEALTH_OK:-0}" != 1 ]; then
  echo "ERROR: server did not become healthy in 30s. Last log lines:"
  tail -20 "$RUN_DIR/server.log"
  exit 1
fi

cat <<EOF

  Server healthy:  http://localhost:8000/health -> {"status":"ok"}

  Open in Chrome (extension loaded from: $ROOT/extension):
    Main demo   http://localhost:8080/gov-portal.html
    Backup 1    http://localhost:8080/demo.html
    Backup 2    http://localhost:8080/pii-review.html
    Backup 3    http://localhost:8080/redaction-test.html   (use the extension's debug page -> Run Vision Scan)

  Demo prompt (paste into the side panel, then click Run):
    Fill in the Aadhaar Detail Update form using my saved details and submit it.

  Privacy proof log: $ROOT/eval/network-payload.jsonl
  Stop everything:   ./stop-demo.sh
EOF
