#!/usr/bin/env bash
# Initialize the bundled PostgreSQL data directory on first start (idempotent).
set -euo pipefail
PG_BIN=/opt/anysentry/postgresql/bin
PGDATA=${ANYSENTRY_PGDATA:-/var/lib/anysentry/postgresql}
ENV_FILE=${ANYSENTRY_ENV_FILE:-/etc/anysentry/anysentry.env}
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  echo 'Initializing PostgreSQL data directory...'
  LD_LIBRARY_PATH=/opt/anysentry/postgresql/lib "$PG_BIN/initdb" -D "$PGDATA" -U anysentry --auth=trust -E UTF8 >/dev/null
  echo "listen_addresses = '127.0.0.1'" >>"$PGDATA/postgresql.conf"
  echo 'initialized'
fi
# ensure the application database exists
if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p 5432 -q; then echo 'postgresql not ready' >&2; exit 0; fi
 "$PG_BIN/psql" -h 127.0.0.1 -p 5432 -U anysentry -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='anysentry'" | grep -q 1 || \
  "$PG_BIN/psql" -h 127.0.0.1 -p 5432 -U anysentry -d postgres -c 'CREATE DATABASE anysentry' >/dev/null
# wire the API env on first init
if ! grep -q '^ANYSENTRY_DATABASE_URL=' "$ENV_FILE" 2>/dev/null; then
  echo 'ANYSENTRY_DATABASE_URL=postgresql://anysentry@127.0.0.1:5432/anysentry' >>"$ENV_FILE"
  echo 'env: ANYSENTRY_DATABASE_URL appended (restart anysentry to activate)'
fi
