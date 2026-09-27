#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_command curl
require_command openssl
require_command sha256sum
require_command tar

archive_override="${DIFY_LAB_ARCHIVE_FILE:-}"
if [[ "${1:-}" == "--archive" ]]; then
  [[ -n "${2:-}" ]] || die "--archive requires a path"
  archive_override="$2"
  shift 2
fi
[[ $# -eq 0 ]] || die "usage: prepare.sh [--archive /absolute/path/to/dify.tar.gz]"

install -d -m 0700 \
  "$DIFY_LAB_RUNTIME/cache" \
  "$DIFY_LAB_RUNTIME/secrets" \
  "$DIFY_LAB_RUNTIME/state" \
  "$DIFY_LAB_RUNTIME/results" \
  "$DIFY_LAB_RUNTIME/session" \
  "$DIFY_LAB_RUNTIME/tls" \
  "$DIFY_LAB_RUNTIME/upstream"
chmod 0700 \
  "$DIFY_LAB_RUNTIME" \
  "$DIFY_LAB_RUNTIME/cache" \
  "$DIFY_LAB_RUNTIME/secrets" \
  "$DIFY_LAB_RUNTIME/state" \
  "$DIFY_LAB_RUNTIME/results" \
  "$DIFY_LAB_RUNTIME/session" \
  "$DIFY_LAB_RUNTIME/tls" \
  "$DIFY_LAB_RUNTIME/upstream"

archive="$DIFY_LAB_RUNTIME/cache/dify-$DIFY_VERSION.tar.gz"
if [[ ! -f "$archive" ]]; then
  archive_tmp="$(mktemp "$DIFY_LAB_RUNTIME/cache/.dify-archive.XXXXXX")"
  if [[ -n "$archive_override" ]]; then
    [[ -f "$archive_override" ]] || die "archive does not exist: $archive_override"
    cp -- "$archive_override" "$archive_tmp"
  else
    curl --fail --location --silent --show-error \
      --output "$archive_tmp" "$DIFY_ARCHIVE_URL"
  fi
  actual_sha="$(sha256sum "$archive_tmp" | awk '{print $1}')"
  [[ "$actual_sha" == "$DIFY_ARCHIVE_SHA256" ]] ||
    die "Dify archive checksum mismatch: expected $DIFY_ARCHIVE_SHA256, got $actual_sha"
  mv -- "$archive_tmp" "$archive"
fi

actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual_sha" == "$DIFY_ARCHIVE_SHA256" ]] ||
  die "cached Dify archive checksum mismatch; move $archive aside and retry"

if [[ ! -d "$DIFY_LAB_DOCKER_DIR" ]]; then
  extract_dir="$(mktemp -d "$DIFY_LAB_RUNTIME/upstream/.dify-extract.XXXXXX")"
  tar -xzf "$archive" \
    -C "$extract_dir" \
    --strip-components=2 \
    "dify-$DIFY_VERSION/docker"
  install -d -m 0700 "$(dirname -- "$DIFY_LAB_DOCKER_DIR")"
  mv -- "$extract_dir" "$DIFY_LAB_DOCKER_DIR"
fi

[[ -f "$DIFY_LAB_DOCKER_DIR/docker-compose.yaml" ]] ||
  die "official Dify Compose file is missing after extraction"
[[ -f "$DIFY_LAB_DOCKER_DIR/.env.example" ]] ||
  die "official Dify environment template is missing after extraction"

write_random_secret() {
  local path="$1"
  local prefix="${2:-}"
  local random_bytes="${3:-16}"
  if [[ ! -s "$path" ]]; then
    create_private_file "$path"
    printf '%s%s\n' "$prefix" "$(openssl rand -hex "$random_bytes")" >"$path"
  fi
}

write_random_secret "$DIFY_LAB_RUNTIME/secrets/dify-init-password" "Init9!" 10
write_random_secret "$DIFY_LAB_RUNTIME/secrets/dify-admin-password" "Admin9!"
write_random_secret "$DIFY_LAB_RUNTIME/secrets/dify-secret-key"
write_random_secret "$DIFY_LAB_RUNTIME/secrets/dify-db-password"
write_random_secret "$DIFY_LAB_RUNTIME/secrets/dify-redis-password"
write_random_secret "$DIFY_LAB_RUNTIME/secrets/dify-plugin-daemon-key"
write_random_secret "$DIFY_LAB_RUNTIME/secrets/dify-plugin-inner-api-key"
write_random_secret "$DIFY_LAB_RUNTIME/secrets/mock-api-key" "mock-"

init_password="$(read_secret_file "$DIFY_LAB_RUNTIME/secrets/dify-init-password")"
[[ ${#init_password} -le 30 ]] ||
  die "generated Dify init password exceeds the upstream 30-character contract"
secret_key="$(read_secret_file "$DIFY_LAB_RUNTIME/secrets/dify-secret-key")"
db_password="$(read_secret_file "$DIFY_LAB_RUNTIME/secrets/dify-db-password")"
redis_password="$(read_secret_file "$DIFY_LAB_RUNTIME/secrets/dify-redis-password")"
plugin_daemon_key="$(read_secret_file "$DIFY_LAB_RUNTIME/secrets/dify-plugin-daemon-key")"
plugin_inner_key="$(read_secret_file "$DIFY_LAB_RUNTIME/secrets/dify-plugin-inner-api-key")"

env_tmp="$(mktemp "$DIFY_LAB_DOCKER_DIR/.env.XXXXXX")"
while IFS= read -r line || [[ -n "$line" ]]; do
  key="${line%%=*}"
  case "$key" in
    SECRET_KEY) printf 'SECRET_KEY=%s\n' "$secret_key" ;;
    INIT_PASSWORD) printf 'INIT_PASSWORD=%s\n' "$init_password" ;;
    CHECK_UPDATE_URL) printf 'CHECK_UPDATE_URL=\n' ;;
    ENABLE_COLLABORATION_MODE) printf 'ENABLE_COLLABORATION_MODE=false\n' ;;
    ENABLE_REQUEST_LOGGING) printf 'ENABLE_REQUEST_LOGGING=False\n' ;;
    LOG_LEVEL) printf 'LOG_LEVEL=INFO\n' ;;
    DB_PASSWORD) printf 'DB_PASSWORD=%s\n' "$db_password" ;;
    REDIS_PASSWORD) printf 'REDIS_PASSWORD=%s\n' "$redis_password" ;;
    CELERY_BROKER_URL) printf 'CELERY_BROKER_URL=redis://:%s@redis:6379/1\n' "$redis_password" ;;
    PLUGIN_DAEMON_KEY) printf 'PLUGIN_DAEMON_KEY=%s\n' "$plugin_daemon_key" ;;
    PLUGIN_DIFY_INNER_API_KEY) printf 'PLUGIN_DIFY_INNER_API_KEY=%s\n' "$plugin_inner_key" ;;
    VECTOR_STORE) printf 'VECTOR_STORE=weaviate\n' ;;
    DB_TYPE) printf 'DB_TYPE=postgresql\n' ;;
    COMPOSE_PROFILES) printf 'COMPOSE_PROFILES=weaviate,postgresql\n' ;;
    EXPOSE_NGINX_PORT) printf 'EXPOSE_NGINX_PORT=%s\n' "${DIFY_LAB_CONSOLE_PORT:-18080}" ;;
    EXPOSE_NGINX_SSL_PORT) printf 'EXPOSE_NGINX_SSL_PORT=%s\n' "${DIFY_LAB_CONSOLE_TLS_PORT:-18443}" ;;
    NGINX_HTTPS_ENABLED) printf 'NGINX_HTTPS_ENABLED=false\n' ;;
    *) printf '%s\n' "$line" ;;
  esac
done <"$DIFY_LAB_DOCKER_DIR/.env.example" >"$env_tmp"
mv -- "$env_tmp" "$DIFY_LAB_DOCKER_DIR/.env"
chmod 0600 "$DIFY_LAB_DOCKER_DIR/.env"

ca_key="$DIFY_LAB_RUNTIME/tls/ca.key"
ca_cert="$DIFY_LAB_RUNTIME/tls/ca.crt"
server_key="$DIFY_LAB_RUNTIME/tls/server.key"
server_csr="$DIFY_LAB_RUNTIME/tls/server.csr"
server_cert="$DIFY_LAB_RUNTIME/tls/server.crt"

if [[ ! -s "$ca_key" || ! -s "$ca_cert" || ! -s "$server_key" || ! -s "$server_cert" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 \
    -subj '/CN=AnySentry Dify Lab CA' \
    -keyout "$ca_key" -out "$ca_cert" >/dev/null 2>&1

  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj '/CN=llm-mock' \
    -keyout "$server_key" -out "$server_csr" >/dev/null 2>&1

  extension_file="$(mktemp "$DIFY_LAB_RUNTIME/tls/.extensions.XXXXXX")"
  printf '%s\n' \
    'basicConstraints=CA:FALSE' \
    'keyUsage=digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' \
    'subjectAltName=DNS:llm-mock,DNS:tool-mock,DNS:localhost,IP:127.0.0.1' \
    >"$extension_file"
  openssl x509 -req -sha256 -days 30 \
    -in "$server_csr" \
    -CA "$ca_cert" \
    -CAkey "$ca_key" \
    -CAcreateserial \
    -extfile "$extension_file" \
    -out "$server_cert" >/dev/null 2>&1
  unlink "$extension_file"
fi

chmod 0600 "$ca_key" "$server_key"
chmod 0644 "$ca_cert" "$server_cert"

system_ca_bundle="${DIFY_LAB_SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
[[ -s "$system_ca_bundle" ]] ||
  die "system CA bundle not found; set DIFY_LAB_SYSTEM_CA_BUNDLE to a PEM bundle"
combined_ca_tmp="$(mktemp "$DIFY_LAB_RUNTIME/tls/.ca-bundle.XXXXXX")"
{
  cat -- "$system_ca_bundle"
  printf '\n'
  cat -- "$ca_cert"
} >"$combined_ca_tmp"
mv -- "$combined_ca_tmp" "$DIFY_LAB_RUNTIME/tls/ca-bundle.crt"
chmod 0644 "$DIFY_LAB_RUNTIME/tls/ca-bundle.crt"

mock_header="$DIFY_LAB_RUNTIME/secrets/mock-authorization-header"
create_private_file "$mock_header"
{
  printf 'Authorization: Bearer '
  read_secret_file "$DIFY_LAB_RUNTIME/secrets/mock-api-key"
  printf '\n'
} >"$mock_header"

unset init_password secret_key db_password redis_password plugin_daemon_key plugin_inner_key

printf 'Dify lab prepared\n'
printf '  upstream: Dify %s (%s)\n' "$DIFY_VERSION" "$DIFY_GIT_COMMIT"
printf '  runtime:  %s\n' "$DIFY_LAB_RUNTIME"
printf '  console:  %s\n' "$DIFY_LAB_CONSOLE_URL"
printf '  LLM mock: http://127.0.0.1:%s and https://localhost:%s\n' \
  "${DIFY_LAB_LLM_HTTP_PORT:-18000}" "${DIFY_LAB_LLM_HTTPS_PORT:-18444}"
printf '  secrets:  generated under a mode-0700 ignored runtime directory; values were not printed\n'
