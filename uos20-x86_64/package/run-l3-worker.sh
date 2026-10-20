#!/usr/bin/env bash
set -euo pipefail

if [[ ${ANYSENTRY_L3_ENABLED:-false} != true ]]; then
  exec /bin/sleep infinity
fi

exec /opt/anysentry/runtime/node/bin/node \
  /opt/anysentry/app/dist/security-monitoring/worker-main.js
