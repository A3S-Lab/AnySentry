#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_command curl
require_command jq
require_command python3
require_command rg
require_command sha256sum
require_prepared

response_mode="${DIFY_LAB_CHATFLOW_RESPONSE_MODE:-blocking}"
check_workflow_isolation=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --blocking) response_mode=blocking ;;
    --streaming) response_mode=streaming ;;
    --no-workflow-isolation) check_workflow_isolation=0 ;;
    *) die "usage: run-chatflow.sh [--blocking|--streaming] [--no-workflow-isolation]" ;;
  esac
  shift
done
[[ "$response_mode" == "blocking" || "$response_mode" == "streaming" ]] ||
  die "DIFY_LAB_CHATFLOW_RESPONSE_MODE must be blocking or streaming"

chatflow_auth="${DIFY_LAB_CHATFLOW_AUTH_HEADER_FILE:-$DIFY_LAB_RUNTIME/secrets/chatflow-app-authorization-header}"
chatflow_app_file="${DIFY_LAB_CHATFLOW_APP_ID_FILE:-$DIFY_LAB_RUNTIME/state/chatflow-app-id}"
[[ -s "$chatflow_auth" && -s "$chatflow_app_file" ]] ||
  die "Chatflow is not initialized; run initialize.sh first"

workflow_auth="${DIFY_LAB_WORKFLOW_AUTH_HEADER_FILE:-$DIFY_LAB_RUNTIME/secrets/llm-app-authorization-header}"
workflow_app_file="${DIFY_LAB_WORKFLOW_APP_ID_FILE:-$DIFY_LAB_RUNTIME/state/llm-app-id}"
if [[ "$check_workflow_isolation" == "1" ]]; then
  [[ -s "$workflow_auth" && -s "$workflow_app_file" ]] ||
    die "the Workflow app is required for isolation checks; use --no-workflow-isolation to skip"
fi

results_dir="${DIFY_LAB_RESULTS_DIR:-$DIFY_LAB_RUNTIME/results}"
install -d -m 0700 "$results_dir"
chmod 0700 "$results_dir"
chatflow_url="${DIFY_LAB_CHATFLOW_API_URL:-$DIFY_LAB_CONSOLE_URL/v1/chat-messages}"
workflow_url="${DIFY_LAB_WORKFLOW_API_URL:-$DIFY_LAB_CONSOLE_URL/v1/workflows/run}"
run_timeout="${DIFY_LAB_CHATFLOW_RUN_TIMEOUT_SECONDS:-180}"
[[ "$run_timeout" =~ ^[0-9]+$ && "$run_timeout" -ge 5 ]] ||
  die "DIFY_LAB_CHATFLOW_RUN_TIMEOUT_SECONDS must be an integer >= 5"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
request_one="$(mktemp "$DIFY_LAB_RUNTIME/session/.chatflow-request.XXXXXX.json")"
request_two="$(mktemp "$DIFY_LAB_RUNTIME/session/.chatflow-request.XXXXXX.json")"
response_one="$(mktemp "$results_dir/chatflow-$stamp-turn1.XXXXXX")"
response_two="$(mktemp "$results_dir/chatflow-$stamp-turn2.XXXXXX")"
workflow_request_one=""
workflow_request_two=""
workflow_response_one=""
workflow_response_two=""
summary_file="$results_dir/chatflow-last-summary.json"

cleanup() {
  local path
  for path in "$request_one" "$request_two" "$workflow_request_one" "$workflow_request_two"; do
    [[ -n "$path" && -e "$path" ]] || continue
    : >"$path"
    unlink "$path"
  done
}
trap cleanup EXIT INT TERM
chmod 0600 "$response_one" "$response_two"

chatflow_user="${DIFY_LAB_CHATFLOW_USER:-anysentry-dify-chatflow-lab}"
query_one="${DIFY_LAB_CHATFLOW_QUERY_1:-ANYSENTRY_CHATFLOW_TURN_1: establish a conversation.}"
query_two="${DIFY_LAB_CHATFLOW_QUERY_2:-ANYSENTRY_CHATFLOW_TURN_2: continue the same conversation.}"

write_chat_request() {
  local output="$1"
  local query="$2"
  local conversation_id="${3:-}"
  jq -n \
    --arg query "$query" \
    --arg user "$chatflow_user" \
    --arg response_mode "$response_mode" \
    --arg conversation_id "$conversation_id" \
    '{
      inputs: {},
      query: $query,
      response_mode: $response_mode,
      user: $user,
      auto_generate_name: false
    } + (if $conversation_id == "" then {} else {conversation_id: $conversation_id} end)' \
    >"$output"
}

call_endpoint() {
  local endpoint="$1"
  local request_file="$2"
  local response_file="$3"
  local header_file="$4"
  local code
  code="$(curl --noproxy '*' \
    --silent --show-error --no-buffer \
    --max-time "$run_timeout" \
    --output "$response_file" \
    --write-out '%{http_code}' \
    --header "@$header_file" \
    --header 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "$endpoint" || true)"
  if [[ "$code" != "200" ]]; then
    printf 'endpoint request failed with HTTP %s (response bytes=%s); body withheld\n' \
      "$code" "$(wc -c <"$response_file" 2>/dev/null || echo 0)" >&2
    return 1
  fi
}

# Parse blocking JSON and streaming SSE; emit metadata only, never answer text.
extract_chat_metadata() {
  local response_file="$1"
  python3 - "$response_file" <<'PY'
from __future__ import annotations

import json
import pathlib
import sys

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
objects: list[dict[str, object]] = []
try:
    parsed = json.loads(raw)
except json.JSONDecodeError:
    parsed = None
if isinstance(parsed, dict):
    objects.append(parsed)
else:
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            item = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            objects.append(item)

def first(*values: object) -> str:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return ""

conversation_id = ""
message_id = ""
workflow_run_id = ""
workflow_id = ""
task_id = ""
mode = ""
status = ""
answer_present = False
for item in objects:
    nested = item.get("data") if isinstance(item.get("data"), dict) else {}
    conversation_id = first(item.get("conversation_id"), nested.get("conversation_id"), conversation_id)
    message_id = first(item.get("message_id"), nested.get("message_id"), message_id)
    workflow_run_id = first(item.get("workflow_run_id"), nested.get("workflow_run_id"), workflow_run_id)
    workflow_id = first(item.get("workflow_id"), nested.get("workflow_id"), workflow_id)
    task_id = first(item.get("task_id"), nested.get("task_id"), task_id)
    mode = first(item.get("mode"), nested.get("mode"), mode)
    status = first(item.get("event"), item.get("status"), nested.get("status"), status)
    answer_present = answer_present or isinstance(item.get("answer"), str) and bool(item["answer"])
    answer_present = answer_present or isinstance(nested.get("answer"), str) and bool(nested["answer"])
    if not message_id:
        message_id = first(item.get("id"), nested.get("id"), message_id)
execution_id = workflow_run_id or task_id
print("|".join((conversation_id, message_id, execution_id, workflow_id, mode, status, "1" if answer_present else "0")))
PY
}

write_chat_request "$request_one" "$query_one"
call_endpoint "$chatflow_url" "$request_one" "$response_one" "$chatflow_auth"
IFS='|' read -r conversation_one message_one chatflow_execution_one chatflow_workflow_id_one mode_one status_one answer_one < <(
  extract_chat_metadata "$response_one"
)
[[ -n "$conversation_one" && -n "$message_one" ]] ||
  die "Chatflow turn 1 did not return conversation_id and message_id"

write_chat_request "$request_two" "$query_two" "$conversation_one"
call_endpoint "$chatflow_url" "$request_two" "$response_two" "$chatflow_auth"
IFS='|' read -r conversation_two message_two chatflow_execution_two chatflow_workflow_id_two mode_two status_two answer_two < <(
  extract_chat_metadata "$response_two"
)
[[ -n "$conversation_two" && -n "$message_two" ]] ||
  die "Chatflow turn 2 did not return conversation_id and message_id"
[[ "$conversation_one" == "$conversation_two" ]] ||
  die "Dify returned different conversation IDs for the two turns"
[[ "$message_one" != "$message_two" ]] ||
  die "Dify reused a message ID across two turns"
[[ -n "$chatflow_execution_one" && -n "$chatflow_execution_two" ]] ||
  die "Chatflow responses did not expose an execution identifier"
[[ "$chatflow_execution_one" != "$chatflow_execution_two" ]] ||
  die "Chatflow reused an execution identifier across two turns"
if [[ -n "$chatflow_workflow_id_one" && -n "$chatflow_workflow_id_two" ]]; then
  [[ "$chatflow_workflow_id_one" == "$chatflow_workflow_id_two" ]] ||
    die "Chatflow workflow definition changed between turns"
fi

if [[ "${DIFY_LAB_CHATFLOW_REQUIRE_MARKERS:-1}" == "1" ]]; then
  rg -q --fixed-strings "$query_one" "$response_one" ||
    die "Chatflow turn 1 response did not contain its deterministic marker"
  rg -q --fixed-strings "$query_two" "$response_two" ||
    die "Chatflow turn 2 response did not contain its deterministic marker"
fi

chatflow_app_id="$(read_secret_file "$chatflow_app_file")"
workflow_app_id=""
workflow_run_one=""
workflow_run_two=""
workflow_conversation_one=0
workflow_conversation_two=0
workflow_id_one=""
workflow_id_two=""
if [[ "$check_workflow_isolation" == "1" ]]; then
  workflow_app_id="$(read_secret_file "$workflow_app_file")"
  [[ -n "$workflow_app_id" && "$workflow_app_id" != "$chatflow_app_id" ]] ||
    die "Chatflow and Workflow app definitions must have distinct IDs"
  workflow_request_one="$(mktemp "$DIFY_LAB_RUNTIME/session/.workflow-isolation-request.XXXXXX.json")"
  workflow_request_two="$(mktemp "$DIFY_LAB_RUNTIME/session/.workflow-isolation-request.XXXXXX.json")"
  workflow_response_one="$(mktemp "$results_dir/chatflow-$stamp-workflow1.XXXXXX")"
  workflow_response_two="$(mktemp "$results_dir/chatflow-$stamp-workflow2.XXXXXX")"
  chmod 0600 "$workflow_response_one" "$workflow_response_two"
  jq -n '{inputs: {query: "ANYSENTRY_WORKFLOW_ISOLATION_1", final_context: "ANYSENTRY_WORKFLOW_CONTEXT", internal_rag_sentinel: "ANYSENTRY_WORKFLOW_SENTINEL"}, response_mode: "blocking", user: "anysentry-dify-chatflow-isolation"}' >"$workflow_request_one"
  jq -n '{inputs: {query: "ANYSENTRY_WORKFLOW_ISOLATION_2", final_context: "ANYSENTRY_WORKFLOW_CONTEXT", internal_rag_sentinel: "ANYSENTRY_WORKFLOW_SENTINEL"}, response_mode: "blocking", user: "anysentry-dify-chatflow-isolation"}' >"$workflow_request_two"
  call_endpoint "$workflow_url" "$workflow_request_one" "$workflow_response_one" "$workflow_auth"
  call_endpoint "$workflow_url" "$workflow_request_two" "$workflow_response_two" "$workflow_auth"
  IFS='|' read -r workflow_run_one workflow_conversation_one workflow_id_one < <(
    python3 - "$workflow_response_one" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
value = value if isinstance(value, dict) else {}
data = value.get("data") if isinstance(value.get("data"), dict) else {}
run_id = value.get("workflow_run_id") or data.get("workflow_run_id") or ""
conversation = value.get("conversation_id") or data.get("conversation_id") or ""
workflow_id = data.get("workflow_id") or value.get("workflow_id") or ""
print("|".join((str(run_id), "1" if conversation else "0", str(workflow_id))))
PY
  )
  IFS='|' read -r workflow_run_two workflow_conversation_two workflow_id_two < <(
    python3 - "$workflow_response_two" <<'PY'
import json
import pathlib
import sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
value = value if isinstance(value, dict) else {}
data = value.get("data") if isinstance(value.get("data"), dict) else {}
run_id = value.get("workflow_run_id") or data.get("workflow_run_id") or ""
conversation = value.get("conversation_id") or data.get("conversation_id") or ""
workflow_id = data.get("workflow_id") or value.get("workflow_id") or ""
print("|".join((str(run_id), "1" if conversation else "0", str(workflow_id))))
PY
  )
  [[ -n "$workflow_run_one" && -n "$workflow_run_two" ]] ||
    die "Workflow isolation calls did not return workflow_run_id"
  [[ "$workflow_run_one" != "$workflow_run_two" ]] ||
    die "stateless Workflow calls reused the same workflow_run_id"
  [[ "$workflow_conversation_one" == "0" && "$workflow_conversation_two" == "0" ]] ||
    die "stateless Workflow calls unexpectedly returned a conversation_id"
fi

hash_prefix() {
  printf '%s' "$1" | sha256sum | awk '{print substr($1, 1, 16)}'
}

workflow_app_hash=""
workflow_run_distinct=false
if [[ "$check_workflow_isolation" == "1" ]]; then
  workflow_app_hash="$(hash_prefix "$workflow_app_id")"
  workflow_run_distinct=true
fi

jq -n \
  --arg schema_version "anysentry.dify.chatflow.verification.v1" \
  --arg app_hash "$(hash_prefix "$chatflow_app_id")" \
  --arg workflow_app_hash "$workflow_app_hash" \
  --arg conversation_hash "$(hash_prefix "$conversation_one")" \
  --arg response_mode "$response_mode" \
  --argjson isolation "$([[ "$check_workflow_isolation" == "1" ]] && printf true || printf false)" \
  --argjson message_ids_distinct "$([[ "$message_one" != "$message_two" ]] && printf true || printf false)" \
  --argjson conversation_reused "$([[ "$conversation_one" == "$conversation_two" ]] && printf true || printf false)" \
  --argjson workflow_runs_distinct "$workflow_run_distinct" \
  --argjson marker_one "$([[ "$answer_one" == "1" ]] && printf true || printf false)" \
  --argjson marker_two "$([[ "$answer_two" == "1" ]] && printf true || printf false)" \
  --arg turn_one_bytes "$(wc -c <"$response_one")" \
  --arg turn_two_bytes "$(wc -c <"$response_two")" \
  '{schemaVersion: $schema_version,
    chatflow: {
      appIdSha256Prefix: $app_hash,
      responseMode: $response_mode,
      turns: 2,
      conversationIdSha256Prefix: $conversation_hash,
      conversationIdReused: $conversation_reused,
      messageIdsDistinct: $message_ids_distinct,
      responseMarkerPresent: [$marker_one, $marker_two],
      responseBytes: [($turn_one_bytes | tonumber), ($turn_two_bytes | tonumber)]
    },
    workflowIsolation: {
      checked: $isolation,
      workflowAppIdSha256Prefix: (if $workflow_app_hash == "" then null else $workflow_app_hash end),
      appDefinitionsDistinct: (if $workflow_app_hash == "" then null else true end),
      statelessRunIdsDistinct: (if $isolation then $workflow_runs_distinct else null end),
      conversationIdAbsent: (if $isolation then true else null end)
    },
    revisionBoundary: {
      chatflowDefinitionStableAcrossTurns: true,
      chatflowRunsRemainPerTurn: true,
      workflowRunsRemainPerRequest: (if $isolation then $workflow_runs_distinct else null end)
    }}' >"$summary_file"
chmod 0600 "$summary_file"

printf 'Chatflow verification passed: turns=2, conversation reused, message IDs distinct.\n'
printf '  Chatflow app hash prefix: %s\n' "$(hash_prefix "$chatflow_app_id")"
printf '  Conversation hash prefix: %s\n' "$(hash_prefix "$conversation_one")"
printf '  Response mode: %s (bodies retained only under mode-0600 results)\n' "$response_mode"
if [[ "$check_workflow_isolation" == "1" ]]; then
  printf '  Workflow isolation: app definitions distinct; per-request run IDs distinct; no conversation ID.\n'
else
  printf '  Workflow isolation: not run (--no-workflow-isolation).\n'
fi
printf '  Sanitized summary: %s\n' "$summary_file"
