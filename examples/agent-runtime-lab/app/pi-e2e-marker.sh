#!/bin/sh
set -eu

marker_file="${PI_E2E_MARKER_FILE:-}"
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

marker=''
extra=''
{
  if ! IFS= read -r marker; then
    if [ -z "$marker" ]; then
      echo "PI_E2E_MARKER_FILE is empty" >&2
      exit 65
    fi
  fi
  if IFS= read -r extra; then
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
exec /usr/bin/true "$marker"
