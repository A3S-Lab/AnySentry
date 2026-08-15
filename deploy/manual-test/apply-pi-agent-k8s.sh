#!/usr/bin/env bash
set -euo pipefail

# This helper never prints the key and never writes a Secret manifest to disk.
# kubectl reads the authorized local key file and streams the Secret directly to
# the API server. Keep shell tracing disabled while running it.
set +x

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
namespace="anysentry-agent-test"
models_file="${ANYSENTRY_LLM_MODELS_FILE:-${repo_root}/.local/real-llm/models.json}"
key_file="${ANYSENTRY_LLM_KEY_FILE:-${repo_root}/.local/real-llm/secrets/api-key}"
image="${ANYSENTRY_AGENT_LAB_IMAGE:-}"

if [[ ! "${image}" =~ ^[A-Za-z0-9._/:@-]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "ANYSENTRY_AGENT_LAB_IMAGE must be an immutable image@sha256:<64 lowercase hex> reference" >&2
  exit 64
fi

for required_file in "${models_file}" "${key_file}"; do
  if [[ ! -f "${required_file}" || ! -r "${required_file}" || ! -s "${required_file}" ]]; then
    echo "Required non-empty file is not readable: ${required_file}" >&2
    exit 66
  fi
done

kubectl create namespace "${namespace}" \
  --dry-run=client -o json | kubectl apply -f -

kubectl -n "${namespace}" create configmap pi-agent-models \
  --from-file="models.json=${models_file}" \
  --dry-run=client -o json | kubectl apply -f -

kubectl -n "${namespace}" create secret generic pi-agent-llm \
  --from-file="deepseek_api_key=${key_file}" \
  --dry-run=client -o json | kubectl apply -f -

sed "s|__ANYSENTRY_AGENT_LAB_IMAGE__|${image}|g" \
  "${script_dir}/pi-agent-k8s.yaml" | kubectl apply -f -

kubectl -n "${namespace}" rollout status deployment/pi-coding-agent
