#!/bin/sh
set -eu

mode="${1:-pi}"

case "$mode" in
  fake-llm)
    exec node /opt/pi-tls-lab/app/fake-openai-server.mjs
    ;;
  pi)
    if [ "${PI_LAB_BASE_URL:-}" != "${PI_LAB_BASE_URL#https://}" ]; then
      ca_path="${NODE_EXTRA_CA_CERTS:-/tls/ca.crt}"
      waited=0
      while [ ! -r "$ca_path" ] && [ "$waited" -lt 60 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      if [ ! -r "$ca_path" ]; then
        echo "TLS CA did not become readable: $ca_path" >&2
        exit 78
      fi
    fi
    exec node /opt/pi-tls-lab/app/run-pi-fixture.mjs
    ;;
  verify)
    exec node /opt/pi-tls-lab/app/verify-run.mjs
    ;;
  *)
    echo "unsupported mode: $mode" >&2
    exit 64
    ;;
esac
