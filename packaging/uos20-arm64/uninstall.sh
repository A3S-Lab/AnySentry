#!/usr/bin/env bash
set -euo pipefail

PURGE_DATA=0

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [--purge-data]

Without --purge-data, /etc/anysentry, /var/lib/anysentry, and
/var/log/anysentry are retained for a later reinstall.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge-data) PURGE_DATA=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "ERROR: uninstaller must run as root" >&2; exit 1; }

systemctl disable --now anysentry-observer.service 2>/dev/null || true
systemctl disable --now anysentry.service 2>/dev/null || true
systemctl disable --now anysentry-clickhouse.service 2>/dev/null || true
rm -f /etc/systemd/system/anysentry-observer.service /etc/systemd/system/anysentry.service /etc/systemd/system/anysentry-clickhouse.service
systemctl daemon-reload
systemctl reset-failed anysentry-observer.service anysentry.service anysentry-clickhouse.service 2>/dev/null || true
rm -rf /opt/anysentry

if [ "$PURGE_DATA" -eq 1 ]; then
  rm -rf /etc/anysentry /var/lib/anysentry /var/log/anysentry
  userdel anysentry 2>/dev/null || true
  echo "AnySentry program, configuration, logs, and persistent data removed."
else
  echo "AnySentry program removed; configuration and data retained in /etc/anysentry and /var/lib/anysentry."
fi
