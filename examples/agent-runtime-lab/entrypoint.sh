#!/bin/sh
set -eu

runtime="${AGENT_RUNTIME:-a3s-loop}"

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
