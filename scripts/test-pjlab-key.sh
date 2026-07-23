#!/usr/bin/env bash
set -u

BASE_URL="${PJLAB_BASE_URL:-http://api.pjlab.org.cn/v1}"
MODEL="${PJLAB_MODEL:-glm-5.2}"
API_KEY="${PJLAB_API_KEY:-}"

if [[ -z "$API_KEY" ]]; then
  read -rsp "PJLAB API key: " API_KEY
  printf '\n'
fi

if [[ -z "$API_KEY" ]]; then
  printf 'ERROR: API key is empty.\n' >&2
  exit 2
fi

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local status

  if [[ "$method" == "GET" ]]; then
    status="$(curl -sS --max-time 30 -o "$response_file" -w '%{http_code}' \
      -H "Authorization: Bearer $API_KEY" \
      "$BASE_URL$path")" || return 1
  else
    status="$(curl -sS --max-time 60 -o "$response_file" -w '%{http_code}' \
      -X "$method" \
      -H "Authorization: Bearer $API_KEY" \
      -H 'Content-Type: application/json' \
      --data "$body" \
      "$BASE_URL$path")" || return 1
  fi

  printf '%s' "$status"
}

printf 'Checking authentication at %s ...\n' "$BASE_URL"
models_status="$(request GET /models)" || {
  printf 'ERROR: Unable to reach the API.\n' >&2
  exit 3
}

if [[ "$models_status" != "200" ]]; then
  printf 'FAILED: /models returned HTTP %s\n' "$models_status" >&2
  cat "$response_file" >&2
  printf '\n' >&2
  exit 1
fi

printf 'Authentication succeeded. Testing model %s ...\n' "$MODEL"
payload="$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with exactly OK."}],"max_tokens":16,"temperature":0}' "$MODEL")"
chat_status="$(request POST /chat/completions "$payload")" || {
  printf 'ERROR: Unable to call the model endpoint.\n' >&2
  exit 3
}

if [[ "$chat_status" != "200" ]]; then
  printf 'FAILED: /chat/completions returned HTTP %s\n' "$chat_status" >&2
  cat "$response_file" >&2
  printf '\n' >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  reply="$(jq -r '.choices[0].message.content // empty' "$response_file")"
else
  reply="Model response received (install jq to display its content)."
fi

printf 'SUCCESS: API key and model are available.\n'
printf 'Model reply: %s\n' "$reply"
