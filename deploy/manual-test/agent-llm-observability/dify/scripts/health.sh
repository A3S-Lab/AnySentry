#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_command curl
require_command jq
require_prepared

failed=0

check_json_url() {
  local name="$1"
  local url="$2"
  shift 2
  if response="$(curl --fail --silent --show-error --max-time 5 "$@" "$url")"; then
    printf '%-18s ready  %s\n' "$name" "$(jq -c . <<<"$response")"
  else
    printf '%-18s not-ready\n' "$name" >&2
    failed=1
  fi
}

check_json_url \
  "Dify console" \
  "$DIFY_LAB_CONSOLE_URL/console/api/setup"
check_json_url \
  "LLM mock HTTP" \
  "http://127.0.0.1:${DIFY_LAB_LLM_HTTP_PORT:-18000}/health"
check_json_url \
  "LLM mock HTTPS" \
  "https://localhost:${DIFY_LAB_LLM_HTTPS_PORT:-18444}/health" \
  --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" --http1.1
check_json_url \
  "Tool mock HTTPS" \
  "https://localhost:${DIFY_LAB_TOOL_HTTPS_PORT:-18445}/health" \
  --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" --http1.1

printf '\nCompose services:\n'
dify_compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}' || failed=1

exit "$failed"
