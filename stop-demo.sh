#!/usr/bin/env bash
# stop-demo.sh — stop the servers started by start-demo.sh.
set -uo pipefail

RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/pva-demo"

for name in server pages; do
  pidfile="$RUN_DIR/$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    # setsid made each server its own process group; kill the whole group
    # (uvicorn --reload runs a child worker process).
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
done
sleep 0.5

# Belt and braces: anything still listening on the demo ports goes too.
for port in 8000 8080; do
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
done

echo "Stopped. Ports 8000 and 8080 are free."
