#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_command curl
require_command jq
require_command openssl
require_command sha256sum

workflow="${1:-llm}"
case "$workflow" in
  llm|tool) ;;
  *) die "usage: run-workflow.sh [llm|tool]" ;;
esac

auth_header="$DIFY_LAB_RUNTIME/secrets/$workflow-app-authorization-header"
[[ -s "$auth_header" ]] || die "workflow is not initialized; run initialize.sh"

reset_fixture() {
  local port="$1"
  curl --fail --silent --show-error --http1.1 \
    --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
    --header "@$DIFY_LAB_RUNTIME/secrets/mock-authorization-header" \
    --request POST \
    "https://localhost:$port/debug/reset" >/dev/null 2>&1 || true
}

reset_fixture "${DIFY_LAB_LLM_HTTPS_PORT:-18444}"
reset_fixture "${DIFY_LAB_TOOL_HTTPS_PORT:-18445}"

request_file="$(mktemp "$DIFY_LAB_RUNTIME/results/.workflow-request.XXXXXX.json")"
result_file="$DIFY_LAB_RUNTIME/results/$workflow-$(date -u +%Y%m%dT%H%M%SZ).sse"
sentinel="ANYSENTRY_INTERNAL_RAG_MUST_NOT_EGRESS_$(openssl rand -hex 8)"

if [[ "$workflow" == "llm" ]]; then
  query="${DIFY_LAB_QUERY:-Explain the AnySentry final-request observation boundary.}"
  final_context="${DIFY_LAB_FINAL_CONTEXT:-ANYSENTRY_FINAL_SELECTED_RAG: selected context must reach the model.}"
  jq -n \
    --arg query "$query" \
    --arg final_context "$final_context" \
    --arg sentinel "$sentinel" \
    '{
      inputs: {
        query: $query,
        final_context: $final_context,
        internal_rag_sentinel: $sentinel
      },
      response_mode: "streaming",
      user: "anysentry-dify-observation-lab"
    }' >"$request_file"
else
  query="${DIFY_LAB_QUERY:-Return the current observation fixture status.}"
  jq -n \
    --arg query "$query" \
    '{
      inputs: {query: $query},
      response_mode: "streaming",
      user: "anysentry-dify-observation-lab"
    }' >"$request_file"
fi

printf '%s\n' "$sentinel" >"$DIFY_LAB_RUNTIME/results/$workflow-last-internal-rag-sentinel"
chmod 0600 "$DIFY_LAB_RUNTIME/results/$workflow-last-internal-rag-sentinel"

http_code="$(curl \
  --silent \
  --show-error \
  --no-buffer \
  --max-time "${DIFY_LAB_RUN_TIMEOUT_SECONDS:-180}" \
  --header "@$auth_header" \
  --header 'Content-Type: application/json' \
  --data-binary "@$request_file" \
  --output "$result_file" \
  --write-out '%{http_code}' \
  "$DIFY_LAB_CONSOLE_URL/v1/workflows/run")"

if [[ "$http_code" != "200" ]]; then
  printf 'workflow call failed with HTTP %s; response saved to %s\n' "$http_code" "$result_file" >&2
  exit 1
fi

printf 'Workflow completed; streaming response saved to %s\n' "$result_file"
printf 'Service request SHA-256: %s\n' "$(sha256sum "$request_file" | awk '{print $1}')"

show_records() {
  local role="$1"
  local port="$2"
  local records_file="$DIFY_LAB_RUNTIME/results/$workflow-last-$role-records.json"
  if curl --fail --silent --show-error --http1.1 \
    --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
    --output "$records_file" "https://localhost:$port/debug/records"; then
    printf 'Latest %s fixture reconciliation record:\n' "$role"
    jq -c '.data[-1] // {}' "$records_file"
  fi
}

show_records llm "${DIFY_LAB_LLM_HTTPS_PORT:-18444}"
if [[ "$workflow" == "tool" ]]; then
  show_records tool "${DIFY_LAB_TOOL_HTTPS_PORT:-18445}"
fi
