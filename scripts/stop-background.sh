#!/usr/bin/env zsh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .server.pid ]]; then
  echo "No .server.pid found."
  exit 0
fi

pid="$(cat .server.pid)"
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  echo "Stopped Thought Companion at PID $pid."
else
  echo "PID $pid is not running."
fi

rm -f .server.pid
