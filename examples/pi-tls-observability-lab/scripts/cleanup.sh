#!/usr/bin/env bash
set -euo pipefail

lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-all}"
runtime_root="${lab_root}/.runtime"

case "$target" in
  host)
    cleanup_path="${runtime_root}/host"
    ;;
  docker)
    cleanup_path="${runtime_root}/docker"
    ;;
  all)
    cleanup_path="$runtime_root"
    ;;
  *)
    echo "usage: $0 [host|docker|all]" >&2
    exit 64
    ;;
esac

case "$cleanup_path" in
  "${lab_root}/.runtime"|"${lab_root}/.runtime/host"|"${lab_root}/.runtime/docker") ;;
  *) echo "refusing to clean unexpected path: $cleanup_path" >&2; exit 1 ;;
esac

if [ -e "$cleanup_path" ]; then
  rm -rf -- "$cleanup_path"
  echo "removed test-only runtime data: $cleanup_path"
else
  echo "no test runtime data to remove: $cleanup_path"
fi
