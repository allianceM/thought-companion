#!/usr/bin/env zsh
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p logs

if [[ -f .server.pid ]] && kill -0 "$(cat .server.pid)" 2>/dev/null; then
  echo "Thought Companion is already running at PID $(cat .server.pid)."
  exit 0
fi

nohup node server.js > logs/server.log 2>&1 &
echo $! > .server.pid
echo "Thought Companion started at http://127.0.0.1:${PORT:-3334}"
