#!/usr/bin/env bash
set -euo pipefail

lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
runtime_dir="${LANGCHAIN_LAB_RUNTIME_ROOT:-${lab_root}/.runtime}/${run_id}"
project="langchain-tls-lab-${run_id,,}"

mkdir -p "$runtime_dir/tls" "$runtime_dir/results" "$runtime_dir/workspace"
chmod 0700 "$runtime_dir/tls" "$runtime_dir/results" "$runtime_dir/workspace"
export LANGCHAIN_LAB_RUNTIME_DIR="$runtime_dir"

compose=(docker compose --project-name "$project" --file "$lab_root/compose.yaml")
cleanup() {
  "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"${compose[@]}" build fake-llm langchain-agent
"${compose[@]}" up -d --no-build fake-llm
"${compose[@]}" run --rm langchain-agent
docker run --rm \
  --entrypoint python \
  -e LANGCHAIN_LAB_RESULTS=/results \
  -e LANGCHAIN_LAB_WORKSPACE=/workspace \
  -v "$runtime_dir/results:/results:ro" \
  -v "$runtime_dir/workspace:/workspace:ro" \
  "${LANGCHAIN_LAB_IMAGE:-anysentry-langchain-tls-observability-lab:0.1.0}" \
  /opt/langchain-tls-lab/app/verify.py

printf 'LangChain Docker TLS fixture passed\n'
printf 'results=%s\n' "$runtime_dir/results"
