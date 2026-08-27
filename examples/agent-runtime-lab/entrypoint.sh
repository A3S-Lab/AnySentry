#!/bin/sh
set -eu

runtime="${AGENT_RUNTIME:-a3s-loop}"

if [ -n "${DEEPSEEK_API_KEY_FILE:-}" ]; then
  if [ ! -r "$DEEPSEEK_API_KEY_FILE" ]; then
    echo "DEEPSEEK_API_KEY_FILE is not readable" >&2
    exit 78
  fi
  DEEPSEEK_API_KEY="$(tr -d '\r\n' < "$DEEPSEEK_API_KEY_FILE")"
  export DEEPSEEK_API_KEY
fi

case "$runtime" in
  a3s-loop)
    exec node /opt/agent-lab/app/a3s-loop.mjs
    ;;
  pi)
    exec node /opt/agent-lab/app/pi-loop.mjs
    ;;
  *)
    echo "Unsupported AGENT_RUNTIME=$runtime; expected a3s-loop or pi" >&2
    exit 64
    ;;
esac
