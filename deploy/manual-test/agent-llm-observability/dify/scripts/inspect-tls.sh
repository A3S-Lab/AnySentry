#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_command docker
require_command curl
require_command jq

probe_python_image() {
  local image="$1"
  printf 'Image TLS probe: %s\n' "$image"
  docker run --rm --entrypoint python "$image" -c '
import _ssl
import ctypes
import ctypes.util
import json
import ssl

library_name = ctypes.util.find_library("ssl")
library = ctypes.CDLL(library_name) if library_name else None
symbols = {}
for symbol in ("SSL_write", "SSL_write_ex", "SSL_read", "SSL_read_ex", "SSL_set_fd", "SSL_free"):
    symbols[symbol] = bool(library is not None and getattr(library, symbol, None))
maps = []
with open("/proc/self/maps", encoding="utf-8") as handle:
    for line in handle:
        if "libssl" in line or "_ssl" in line:
            maps.append(line.rstrip().split()[-1])
print(json.dumps({
    "openssl_version": ssl.OPENSSL_VERSION,
    "python_ssl_extension": _ssl.__file__,
    "ctypes_library": library_name,
    "symbols": symbols,
    "mapped_objects": sorted(set(maps)),
}, sort_keys=True))
'
}

if [[ "${1:-}" == "--images" ]]; then
  probe_python_image "$DIFY_API_IMAGE"
  printf '%s\n' \
    "The plugin-daemon image hosts provider subprocesses only after plugin installation;" \
    "inspect the running container after initialize.sh and run-workflow.sh for its real libssl inode."
  exit 0
fi
[[ $# -eq 0 ]] || die "usage: inspect-tls.sh [--images]"

require_prepared

for service in api worker; do
  container_id="$(dify_compose ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    printf '%s: not running\n' "$service"
    continue
  fi
  printf '\n%s (%s):\n' "$service" "$container_id"
  docker exec "$container_id" python -c '
import _ssl
import ctypes
import ctypes.util
import json
import ssl

name = ctypes.util.find_library("ssl")
library = ctypes.CDLL(name) if name else None
symbols = {symbol: bool(library is not None and getattr(library, symbol, None)) for symbol in (
    "SSL_write", "SSL_write_ex", "SSL_read", "SSL_read_ex", "SSL_set_fd", "SSL_free"
)}
mapped = []
with open("/proc/self/maps", encoding="utf-8") as handle:
    for line in handle:
        if "libssl" in line or "_ssl" in line:
            mapped.append(line.rstrip().split()[-1])
print(json.dumps({
    "openssl_version": ssl.OPENSSL_VERSION,
    "python_ssl_extension": _ssl.__file__,
    "ctypes_library": name,
    "symbols": symbols,
    "mapped_objects": sorted(set(mapped)),
}, sort_keys=True))
'
done

plugin_container="$(dify_compose ps -q plugin_daemon)"
if [[ -n "$plugin_container" ]]; then
  printf '\nplugin_daemon process map candidates (%s):\n' "$plugin_container"
  mapfile -t plugin_pids < <(docker top "$plugin_container" -eo pid,comm | awk 'NR > 1 {print $1}')
  found=0
  for pid in "${plugin_pids[@]}"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ -r "/proc/$pid/maps" ]] || continue
    mapped_ssl="$(awk '/\/libssl[^/]*\.so|\/_ssl[^/]*\.so/ {print $NF}' "/proc/$pid/maps" | sort -u)"
    if [[ -n "$mapped_ssl" ]]; then
      found=1
      comm="$(tr -d '\r\n' <"/proc/$pid/comm")"
      printf '  pid=%s comm=%s\n' "$pid" "$comm"
      sed 's/^/    /' <<<"$mapped_ssl"
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    printf '%s\n' \
      "  no mapped libssl found yet; install the provider and run one workflow," \
      "  then retry while the provider subprocess is alive"
  fi
else
  printf '\nplugin_daemon: not running\n'
fi

printf '\nFixture protocol records (content-free hashes only):\n'
for pair in \
  "llm:${DIFY_LAB_LLM_HTTPS_PORT:-18444}" \
  "tool:${DIFY_LAB_TOOL_HTTPS_PORT:-18445}"; do
  role="${pair%%:*}"
  port="${pair##*:}"
  if response="$(curl --fail --silent --show-error --http1.1 \
    --cacert "$DIFY_LAB_RUNTIME/tls/ca.crt" \
    "https://localhost:$port/debug/records" 2>/dev/null)"; then
    jq -c --arg role "$role" \
      '{role: $role, records: [.data[]? | {path, http_version, stream, status, request_bytes, request_sha256, response_bytes, response_sha256}]}' \
      <<<"$response"
  fi
done
