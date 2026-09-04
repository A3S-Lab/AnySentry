#!/usr/bin/env bash
set -euo pipefail

# A3S Test TUI entrypoint.  The fixture's HTTPS certificate is intentionally short-lived.  The
# product is supplied as the first argument (codex by default), so the same harness exercises the
# generic CLI adapter path for both supported products without duplicating a provider or runner.
product="${1:-codex}"
case "$product" in
  codex|claude) ;;
  *) echo "usage: $0 [codex|claude]" >&2; exit 2 ;;
esac
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
run_dir="$(mktemp -d /tmp/anysentry-a3s-tui.XXXXXX)"
results_dir="$run_dir/results"
tls_dir="$run_dir/tls"
mkdir -p "$results_dir" "$tls_dir"

server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  # This is the exact private directory created above; remove it without touching workspace data.
  node -e 'const fs=require("node:fs"); try { fs.rmSync(process.argv[1], { recursive: true, force: true }); } catch {}' "$run_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export CLI_LAB_RESULTS_DIR="$results_dir"
export CLI_LAB_TLS_DIR="$tls_dir"
export CLI_LAB_HTTP_PORT="${CLI_LAB_HTTP_PORT:-29180}"
export CLI_LAB_HTTPS_PORT="${CLI_LAB_HTTPS_PORT:-29543}"
export CLI_LAB_CODEX_PROTOCOL="${CLI_LAB_CODEX_PROTOCOL:-http}"
export CLI_LAB_CLAUDE_MODEL="${CLI_LAB_CLAUDE_MODEL:-claude-3-5-sonnet-20241022}"
export CLI_LAB_API_KEY=fixture-key-not-secret

node "$repo_root/examples/cli-tls-observability-lab/app/server.mjs" \
  >"$run_dir/provider-stdout.log" 2>"$run_dir/provider-stderr.log" &
server_pid="$!"

for _ in $(seq 1 80); do
  if curl --noproxy '*' --silent --fail \
    "http://127.0.0.1:${CLI_LAB_HTTP_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl --noproxy '*' --silent --fail \
  "http://127.0.0.1:${CLI_LAB_HTTP_PORT}/healthz" >/dev/null

node "$repo_root/examples/cli-tls-observability-lab/app/run-cli.mjs" "$product"
printf 'A3S_TUI_CLI_PASS %s\n' "$product"
