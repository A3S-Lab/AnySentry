#!/bin/sh
set -eu

marker_file="${PI_E2E_MARKER_FILE:-}"
release_file="${PI_E2E_RELEASE_FILE:-}"
workspace="${AGENT_WORKSPACE:-/workspace}"

case "$marker_file" in
  /*) ;;
  *) echo "PI_E2E_MARKER_FILE must be an absolute path" >&2; exit 64 ;;
esac
case "$workspace" in
  /*) ;;
  *) echo "AGENT_WORKSPACE must be an absolute path" >&2; exit 64 ;;
esac
if [ ! -r "$marker_file" ]; then
  echo "PI_E2E_MARKER_FILE is not readable" >&2
  exit 66
fi

if [ -n "$release_file" ]; then
  case "$release_file" in
    /*) ;;
    *) echo "PI_E2E_RELEASE_FILE must be an absolute path" >&2; exit 64 ;;
  esac
  remaining=90
  while [ ! -f "$release_file" ]; do
    if [ "$remaining" -le 0 ]; then
      echo "PI_E2E release gate timed out" >&2
      exit 75
    fi
    remaining=$((remaining - 1))
    /bin/sleep 1
  done
  if [ -L "$release_file" ] || [ ! -r "$release_file" ]; then
    echo "PI_E2E release gate is not a readable regular file" >&2
    exit 65
  fi
  release=''
  release_extra=''
  {
    if ! IFS= read -r release; then
      if [ -z "$release" ]; then
        echo "PI_E2E release gate is empty" >&2
        exit 65
      fi
    fi
    if IFS= read -r release_extra || [ -n "$release_extra" ]; then
      echo "PI_E2E release gate must contain exactly one line" >&2
      exit 65
    fi
  } < "$release_file"
  if [ "$release" != 'go' ]; then
    echo "PI_E2E release gate has invalid content" >&2
    exit 65
  fi
fi

marker=''
extra=''
{
  if ! IFS= read -r marker; then
    if [ -z "$marker" ]; then
      echo "PI_E2E_MARKER_FILE is empty" >&2
      exit 65
    fi
  fi
  if IFS= read -r extra || [ -n "$extra" ]; then
    echo "PI_E2E_MARKER_FILE must contain exactly one line" >&2
    exit 65
  fi
} < "$marker_file"

case "$marker" in
  ''|*[!a-z0-9-]*) echo "PI_E2E marker has an invalid format" >&2; exit 65 ;;
esac
if [ "${#marker}" -gt 160 ]; then
  echo "PI_E2E marker is too long" >&2
  exit 65
fi

umask 077
printf '%s\n' "$marker" >> "$workspace/tool-events.log"
# Keep the exact marker-bearing exec alive long enough for /proc ancestry resolution. The final
# ':' prevents dash from replacing itself with sleep, so the original argv remains observable.
exec /bin/sh -c '/bin/sleep 3;:' "$marker"
