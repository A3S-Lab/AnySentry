#!/usr/bin/env bash
set -euo pipefail

lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_dir="${CLI_LAB_RUNTIME_ROOT:-${lab_root}/.runtime}/${run_id}"
results_dir="$run_dir/results"
tls_dir="$run_dir/tls"
server_pid=""
mode="${1:-all}"
case "$mode" in
  all) products=(codex claude) ;;
  codex|claude) products=("$mode") ;;
  *) printf 'usage: %s [all|codex|claude]\n' "$0" >&2; exit 64 ;;
esac

mkdir -p "$results_dir" "$tls_dir"
chmod 0700 "$results_dir" "$tls_dir"
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

export CLI_LAB_RESULTS_DIR="$results_dir"
export CLI_LAB_TLS_DIR="$tls_dir"
export CLI_LAB_API_KEY=fixture-key-not-secret
export CLI_LAB_HTTPS_PORT="${CLI_LAB_HTTPS_PORT:-19443}"
export CLI_LAB_HTTP_PORT="${CLI_LAB_HTTP_PORT:-19080}"

node "$lab_root/app/server.mjs" >"$results_dir/provider-stdout.log" 2>"$results_dir/provider-stderr.log" &
server_pid="$!"
for _ in $(seq 1 80); do
  [[ -s "$tls_dir/ca.crt" ]] && curl --fail --silent --cacert "$tls_dir/ca.crt" \
    "https://127.0.0.1:$CLI_LAB_HTTPS_PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done
curl --fail --silent --cacert "$tls_dir/ca.crt" \
  "https://127.0.0.1:$CLI_LAB_HTTPS_PORT/healthz" >/dev/null
curl --fail --silent "http://127.0.0.1:$CLI_LAB_HTTP_PORT/healthz" >/dev/null

for product in "${products[@]}"; do
  node "$lab_root/app/run-cli.mjs" "$product"
done
node "$lab_root/app/verify.mjs" "${products[@]}"

printf 'CLI HTTP/TLS fixture passed (%s)\n' "$mode"
printf 'results=%s\n' "$results_dir"
