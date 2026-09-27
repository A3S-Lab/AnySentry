#!/usr/bin/env bash
set -euo pipefail

lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
protocol="${PI_LAB_PROTOCOL:-https}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
runtime_root="${PI_LAB_RUNTIME_ROOT:-${lab_root}/.runtime/docker}"
run_dir="${runtime_root}/${run_id}"
project="pi-tls-lab-${run_id,,}"

case "$protocol" in
  http)
    base_url="http://fake-llm:18080/v1"
    ;;
  https)
    base_url="https://fake-llm:18443/v1"
    ;;
  *)
    echo "PI_LAB_PROTOCOL must be http or https" >&2
    exit 64
    ;;
esac

mkdir -p "${run_dir}/tls" "${run_dir}/results" "${run_dir}/workspace" "${run_dir}/pi-state"
chmod 0700 "${run_dir}/tls" "${run_dir}/results" "${run_dir}/workspace" "${run_dir}/pi-state"

export PI_LAB_RUNTIME_DIR="$run_dir"
export PI_LAB_CONTAINER_UID="$(id -u)"
export PI_LAB_CONTAINER_GID="$(id -g)"
export PI_LAB_BASE_URL="${PI_LAB_BASE_URL:-$base_url}"
export PI_LAB_API_KEY="${PI_LAB_API_KEY:-fixture-key-not-secret}"
export PI_LAB_MODEL="${PI_LAB_MODEL:-fixture-tool-model}"
export PI_LAB_EXPECT_FIXTURE="${PI_LAB_EXPECT_FIXTURE:-1}"

compose=(docker compose -f "${lab_root}/compose.yaml" -p "$project")
up_build_args=(--build)
if [ "${PI_LAB_SKIP_BUILD:-0}" = "1" ]; then
  up_build_args=(--no-build)
fi
cleanup_compose() {
  "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup_compose EXIT INT TERM

"${compose[@]}" up -d "${up_build_args[@]}" fake-llm
"${compose[@]}" run --rm pi-agent
"${compose[@]}" run --rm verifier

echo "Pi Docker fixture passed"
echo "protocol=$protocol"
echo "results=${run_dir}/results"
