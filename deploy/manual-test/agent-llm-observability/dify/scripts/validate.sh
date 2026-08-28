#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_command docker
require_command curl
require_command jq
require_command openssl
require_command python3
require_command rg

mode="${1:---static}"
case "$mode" in
  --static|--container) ;;
  *) die "usage: validate.sh [--static|--container]" ;;
esac

for script in "$SCRIPT_DIR"/*.sh; do
  bash -n "$script"
done

python3 - "$DIFY_LAB_ROOT" <<'PY'
from __future__ import annotations

import pathlib
import sys
import yaml

root = pathlib.Path(sys.argv[1])
server = root / "mock-runtime" / "server.py"
compile(server.read_text(encoding="utf-8"), str(server), "exec")

versions = {}
for line in (root / "versions.env").read_text(encoding="utf-8").splitlines():
    if line and not line.startswith("#"):
        key, value = line.split("=", 1)
        versions[key] = value

for fixture in sorted((root / "fixtures").glob("*.yml")):
    fixture_text = fixture.read_text(encoding="utf-8")
    value = yaml.safe_load(fixture_text)
    assert value["kind"] == "app", fixture
    assert value["app"]["mode"] == "workflow", fixture
    assert value["workflow"]["graph"]["nodes"], fixture
    assert versions["DIFY_OPENAI_COMPATIBLE_PLUGIN_ID"] in fixture_text, fixture

llm_fixture = (root / "fixtures" / "llm-observation-workflow.yml").read_text(encoding="utf-8")
assert "internal_rag_sentinel" in llm_fixture
assert "{{#start_node.internal_rag_sentinel#}}" not in llm_fixture
assert "{{#start_node.final_context#}}" in llm_fixture
PY

if rg -n --hidden --glob '!.runtime/**' \
  'sk-[A-Za-z0-9_-]{16,}' "$DIFY_LAB_ROOT"; then
  die "a key-like literal is present in tracked lab files"
fi

prepare_args=()
if [[ -n "${DIFY_LAB_ARCHIVE_FILE:-}" ]]; then
  prepare_args=(--archive "$DIFY_LAB_ARCHIVE_FILE")
fi
"$SCRIPT_DIR/prepare.sh" "${prepare_args[@]}" >/dev/null
dify_compose config --quiet
openssl verify \
  -CAfile "$DIFY_LAB_RUNTIME/tls/ca-bundle.crt" \
  "$DIFY_LAB_RUNTIME/tls/server.crt" >/dev/null

printf 'Static validation passed: scripts, Python source, DSL fixtures, key scan, and merged Compose config.\n'

if [[ "$mode" != "--container" ]]; then
  exit 0
fi

validation_image="anysentry/dify-observation-mock:validate"
validation_container="anysentry-dify-mock-validate-$$"

cleanup() {
  docker stop --time 2 "$validation_container" >/dev/null 2>&1 || true
  docker rm --force "$validation_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build --quiet --tag "$validation_image" "$DIFY_LAB_ROOT/mock-runtime" >/dev/null
docker run --detach --rm \
  --name "$validation_container" \
  --user "$DIFY_LAB_UID:$DIFY_LAB_GID" \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --publish 127.0.0.1::8000 \
  --publish 127.0.0.1::443 \
  --env MOCK_ROLE=validate \
  --env MOCK_HTTP_PORT=8000 \
  --env MOCK_HTTPS_PORT=443 \
  --env MOCK_TLS_CERT_FILE=/run/tls/server.crt \
  --env MOCK_TLS_KEY_FILE=/run/tls/server.key \
  --env MOCK_API_KEY_FILE=/run/secrets/mock-api-key \
  --mount "type=bind,src=$DIFY_LAB_RUNTIME/tls/server.crt,dst=/run/tls/server.crt,readonly" \
  --mount "type=bind,src=$DIFY_LAB_RUNTIME/tls/server.key,dst=/run/tls/server.key,readonly" \
  --mount "type=bind,src=$DIFY_LAB_RUNTIME/secrets/mock-api-key,dst=/run/secrets/mock-api-key,readonly" \
  "$validation_image" >/dev/null

http_port="$(docker port "$validation_container" 8000/tcp | awk -F: 'NR == 1 {print $NF}')"
https_port="$(docker port "$validation_container" 443/tcp | awk -F: 'NR == 1 {print $NF}')"
[[ -n "$http_port" && -n "$https_port" ]] || die "failed to resolve validation container ports"

for _attempt in $(seq 1 40); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$http_port/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl --fail --silent --show-error "http://127.0.0.1:$http_port/health" >/dev/null
curl --fail --silent --show-error --http1.1 \
  --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
  "https://localhost:$https_port/health" >/dev/null

unauthorized_code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data-binary '{"model":"anysentry-observation-model","messages":[],"stream":false}' \
  "http://127.0.0.1:$http_port/v1/chat/completions")"
[[ "$unauthorized_code" == "401" ]] || die "mock accepted a model request without Authorization"

nonstream_request="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-nonstream.XXXXXX.json")"
printf '%s\n' \
  '{"model":"anysentry-observation-model","messages":[{"role":"user","content":"plain HTTP validation"}],"stream":false}' \
  >"$nonstream_request"
nonstream_response="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-nonstream-response.XXXXXX.json")"
curl --fail --silent --show-error --http1.1 \
  --header "@$DIFY_LAB_RUNTIME/secrets/mock-authorization-header" \
  --header 'Content-Type: application/json' \
  --data-binary "@$nonstream_request" \
  --output "$nonstream_response" \
  "http://127.0.0.1:$http_port/v1/chat/completions"
jq -e '.object == "chat.completion" and .choices[0].finish_reason == "stop"' \
  "$nonstream_response" >/dev/null

responses_request="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-responses.XXXXXX.json")"
printf '%s\n' \
  '{"model":"anysentry-observation-model","input":"Responses API validation","stream":false}' \
  >"$responses_request"
responses_response="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-responses-response.XXXXXX.json")"
curl --fail --silent --show-error --http1.1 \
  --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
  --header "@$DIFY_LAB_RUNTIME/secrets/mock-authorization-header" \
  --header 'Content-Type: application/json' \
  --data-binary "@$responses_request" \
  --output "$responses_response" \
  "https://localhost:$https_port/v1/responses"
jq -e '.object == "response" and .status == "completed"' "$responses_response" >/dev/null

tool_request="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-tool.XXXXXX.json")"
printf '%s\n' '{"instruction":"ANYSENTRY_TOOL_INSTRUCTION: validation"}' >"$tool_request"
tool_response="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-tool-response.XXXXXX.json")"
curl --fail --silent --show-error --http1.1 \
  --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
  --header 'Content-Type: application/json' \
  --data-binary "@$tool_request" \
  --output "$tool_response" \
  "https://localhost:$https_port/tool/execute"
jq -e '
  .status == "succeeded"
  and (.result | startswith("ANYSENTRY_TOOL_RESULT:"))
  and (.finished_at_unix_ns >= .started_at_unix_ns)
' "$tool_response" >/dev/null

request_file="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-request.XXXXXX.json")"
printf '%s\n' \
  '{"model":"anysentry-observation-model","messages":[{"role":"system","content":"ANYSENTRY_DIFY_SYSTEM_V1"},{"role":"user","content":"ANYSENTRY_FINAL_SELECTED_RAG: container validation"}],"stream":true,"stream_options":{"include_usage":true}}' \
  >"$request_file"
response_file="$(mktemp "$DIFY_LAB_RUNTIME/results/.mock-response.XXXXXX.sse")"
curl --fail --silent --show-error --http1.1 \
  --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
  --header "@$DIFY_LAB_RUNTIME/secrets/mock-authorization-header" \
  --header 'Content-Type: application/json' \
  --data-binary "@$request_file" \
  --output "$response_file" \
  "https://localhost:$https_port/v1/chat/completions"

rg -q 'ANYSENTRY' "$response_file"
rg -q '^data: \[DONE\]$' "$response_file"
records="$(curl --fail --silent --show-error --http1.1 \
  --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
  "https://localhost:$https_port/debug/records")"
jq -e '
  (.data | length) == 4
  and all(.data[];
    .role == "validate"
    and .http_version == "HTTP/1.1"
    and .status == 200
    and (.request_sha256 | length == 64)
    and (.response_sha256 | length == 64)
  )
  and any(.data[]; .path == "/v1/chat/completions" and .stream == false)
  and any(.data[]; .path == "/v1/responses" and .stream == false)
  and any(.data[]; .path == "/tool/execute" and .stream == false)
  and (
    .data[-1]
    | .path == "/v1/chat/completions"
      and .stream == true
      and .final_selected_rag_marker_present == true
      and .internal_rag_sentinel_present == false
  )
' <<<"$records" >/dev/null

printf 'Container validation passed: HTTP/HTTPS, TLS 1.2+, JSON, Responses, tool, HTTP/1.1 chunked SSE, auth, and hash ledger.\n'
