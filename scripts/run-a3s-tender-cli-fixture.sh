#!/usr/bin/env bash
set -euo pipefail

# A3S Test TUI entrypoint for the real CLI binaries installed in tender_jang.  The provider and
# runner are copied only into the container's private /tmp area for this invocation; no repository
# file, credential, or transcript is mounted into the container or retained after cleanup.
product="${1:-codex}"
case "$product" in
  codex|claude) ;;
  *) echo "usage: $0 [codex|claude]" >&2; exit 2 ;;
esac

container="${ANYSENTRY_TENDER_CONTAINER:-tender_jang}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runner_host="$repo_root/examples/cli-tls-observability-lab/app/run-cli.mjs"
run_id="anysentry-a3s-tender-${product}-$(date +%s)-$$"
results_dir="/tmp/${run_id}/results"
tls_dir="/tmp/${run_id}/tls"
runner_path="/tmp/${run_id}-run-cli.mjs"
http_port="$((29180 + ($$ % 500)))"
https_port="$((29543 + ($$ % 500)))"

cleanup() {
  # Remove only the exact ephemeral paths created by this script. Node's fs.rmSync is used instead
  # of a broad shell glob so a malformed variable cannot target unrelated container data.
  timeout 15s docker exec "$container" node -e 'const fs=require("node:fs"); for (const p of process.argv.slice(1)) { try { fs.rmSync(p,{recursive:true,force:true}); } catch {} }' \
    "$runner_path" "/tmp/${run_id}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ ! -f "$runner_host" ]]; then
  echo "CLI fixture runner is missing: $runner_host" >&2
  exit 1
fi

timeout 30s docker cp "$runner_host" "${container}:${runner_path}"
timeout 180s docker exec \
  -e CLI_LAB_RESULTS_DIR="$results_dir" \
  -e CLI_LAB_TLS_DIR="$tls_dir" \
  -e CLI_LAB_HTTP_PORT="$http_port" \
  -e CLI_LAB_HTTPS_PORT="$https_port" \
  -e CLI_LAB_CODEX_PROTOCOL=http \
  -e CLI_LAB_CLAUDE_MODEL="${CLI_LAB_CLAUDE_MODEL:-claude-3-5-sonnet-20241022}" \
  -e CLI_LAB_API_KEY=fixture-key-not-secret \
  "$container" sh -lc '
    set +x
    mkdir -p "$CLI_LAB_RESULTS_DIR" "$CLI_LAB_TLS_DIR"
    node /opt/anysentry-examples/cli-tls-observability-lab/app/server.mjs >"$CLI_LAB_RESULTS_DIR/provider.log" 2>&1 &
    provider_pid=$!
    trap "kill $provider_pid 2>/dev/null || true" EXIT
    for _ in $(seq 1 80); do
      curl --noproxy "*" --silent --fail "http://127.0.0.1:${CLI_LAB_HTTP_PORT}/healthz" >/dev/null 2>&1 && break
      sleep 0.25
    done
    curl --noproxy "*" --silent --fail "http://127.0.0.1:${CLI_LAB_HTTP_PORT}/healthz" >/dev/null
    node "'"$runner_path"'" "'"$product"'"
  '
printf 'A3S_TENDER_TUI_PASS %s\n' "$product"
