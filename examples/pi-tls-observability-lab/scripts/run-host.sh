#!/usr/bin/env bash
set -euo pipefail

lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
protocol="${PI_LAB_PROTOCOL:-https}"
mode="${PI_LAB_MODE:-fake}"
http_port="${PI_LAB_HTTP_PORT:-18080}"
https_port="${PI_LAB_HTTPS_PORT:-18443}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
runtime_root="${PI_LAB_RUNTIME_ROOT:-${lab_root}/.runtime/host}"
run_dir="${runtime_root}/${run_id}"
results_dir="${run_dir}/results"
workspace_dir="${run_dir}/workspace"
tls_dir="${run_dir}/tls"
agent_dir="${run_dir}/pi-state"
server_pid=""

case "$protocol" in
  http|https) ;;
  *) echo "PI_LAB_PROTOCOL must be http or https" >&2; exit 64 ;;
esac
case "$mode" in
  fake|external) ;;
  *) echo "PI_LAB_MODE must be fake or external" >&2; exit 64 ;;
esac

mkdir -p "$results_dir" "$workspace_dir" "$tls_dir" "$agent_dir"

cleanup_server() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup_server EXIT INT TERM

if [ ! -x "${lab_root}/node_modules/.bin/pi" ]; then
  npm --prefix "$lab_root" ci --no-audit --no-fund
fi

if [ "$mode" = "fake" ]; then
  node "${lab_root}/app/generate-test-certs.mjs" "$tls_dir"
  FIXTURE_HTTP_HOST=127.0.0.1 \
  FIXTURE_HTTP_PORT="$http_port" \
  FIXTURE_HTTPS_PORT="$https_port" \
  FIXTURE_TLS_DIR="$tls_dir" \
  FIXTURE_TRANSCRIPT_PATH="${results_dir}/fake-llm.ndjson" \
  FIXTURE_API_KEY=fixture-key-not-secret \
    node "${lab_root}/app/fake-openai-server.mjs" >"${results_dir}/fake-server.log" 2>&1 &
  server_pid="$!"
  if [ "$protocol" = "https" ]; then
    health_url="https://127.0.0.1:${https_port}/healthz"
    base_url="https://127.0.0.1:${https_port}/v1"
  else
    health_url="http://127.0.0.1:${http_port}/healthz"
    base_url="http://127.0.0.1:${http_port}/v1"
  fi
  healthy=0
  for _ in $(seq 1 60); do
    if node "${lab_root}/app/healthcheck.mjs" "$health_url" "${tls_dir}/ca.crt" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 0.25
  done
  if [ "$healthy" -ne 1 ]; then
    echo "fake LLM failed its health check; see ${results_dir}/fake-server.log" >&2
    exit 1
  fi
  api_key="fixture-key-not-secret"
  expect_fixture=1
else
  base_url="${PI_LAB_BASE_URL:-}"
  api_key="${PI_LAB_API_KEY:-}"
  expect_fixture="${PI_LAB_EXPECT_FIXTURE:-0}"
  if [ -z "$base_url" ] || [ -z "$api_key" ]; then
    echo "external mode requires PI_LAB_BASE_URL and PI_LAB_API_KEY" >&2
    exit 78
  fi
  if [ "${PI_LAB_ALLOW_EXTERNAL_HOST_TOOLS:-0}" != "1" ]; then
    echo "external host mode executes model-selected tools; set PI_LAB_ALLOW_EXTERNAL_HOST_TOOLS=1 after reviewing the endpoint" >&2
    exit 78
  fi
fi

export PI_LAB_BASE_URL="$base_url"
export PI_LAB_API_KEY="$api_key"
export PI_LAB_MODEL="${PI_LAB_MODEL:-fixture-tool-model}"
export PI_LAB_WORKSPACE="$workspace_dir"
export PI_LAB_RESULTS_DIR="$results_dir"
export PI_LAB_AGENT_DIR="$agent_dir"
export PI_LAB_EXPECT_FIXTURE="$expect_fixture"
if [ "$protocol" = "https" ] && [ "$mode" = "fake" ]; then
  export NODE_EXTRA_CA_CERTS="${tls_dir}/ca.crt"
fi

node "${lab_root}/app/run-pi-fixture.mjs"
node "${lab_root}/app/verify-run.mjs"

echo "Pi host fixture passed"
echo "protocol=$protocol"
echo "results=$results_dir"
