#!/usr/bin/env bash
# Bundled PostgreSQL bootstrap (idempotent). Run as root; initdb runs as anysentry.
set -euo pipefail
PG_HOME=/opt/anysentry/postgresql
export LD_LIBRARY_PATH=$PG_HOME/lib
PGDATA=${ANYSENTRY_PGDATA:-/var/lib/anysentry/postgresql}
ENV_FILE=${ANYSENTRY_ENV_FILE:-/etc/anysentry/anysentry.env}
PGBIN=$PG_HOME/bin

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  echo 'Initializing PostgreSQL data directory...'
  install -d -o anysentry -g anysentry -m 0700 "$PGDATA"
  runuser -u anysentry -- "$PGBIN/initdb" -D "$PGDATA" -U anysentry --auth=trust -E UTF8 -L "$PG_HOME/share"
  { echo "listen_addresses = '127.0.0.1'"; echo port = 5432; } >>"$PGDATA/postgresql.conf"
  chown anysentry:anysentry "$PGDATA/postgresql.conf"
  echo "initdb completed"
fi

if ! "$PGBIN/pg_isready" -h 127.0.0.1 -p 5432 -q; then
  echo 'postgresql not ready (service not started yet) — start anysentry-postgresql first' >&2
  exit 0
fi

if ! "$PGBIN/psql" -h 127.0.0.1 -p 5432 -U anysentry -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='anysentry'" | grep -q 1; then
  "$PGBIN/psql" -h 127.0.0.1 -p 5432 -U anysentry -d postgres -c "CREATE DATABASE anysentry" >/dev/null
  echo 'database anysentry created'
fi

if ! grep -q "^ANYSENTRY_DATABASE_URL=" "$ENV_FILE" 2>/dev/null; then
  echo 'ANYSENTRY_DATABASE_URL=postgresql://anysentry@127.0.0.1:5432/anysentry' >>"$ENV_FILE"
  echo 'env: ANYSENTRY_DATABASE_URL appended'
fi
echo "PostgreSQL bootstrap OK"
