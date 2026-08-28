#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_command base64
require_command curl
require_command jq
require_prepared

cleanup_session_temps() {
  local path
  shopt -s nullglob
  for path in "$DIFY_LAB_RUNTIME/session"/.*; do
    [[ -f "$path" ]] || continue
    : >"$path"
    unlink "$path"
  done
  shopt -u nullglob
}
trap cleanup_session_temps EXIT
trap 'exit 130' INT TERM

console_api="$DIFY_LAB_CONSOLE_URL/console/api"
cookies="$DIFY_LAB_RUNTIME/session/console-cookies.txt"
csrf_header="$DIFY_LAB_RUNTIME/session/csrf-header"
admin_email="${DIFY_LAB_ADMIN_EMAIL:-admin@anysentry.test}"
admin_name="${DIFY_LAB_ADMIN_NAME:-AnySentry Lab Admin}"
init_password_file="${DIFY_LAB_INIT_PASSWORD_FILE:-$DIFY_LAB_RUNTIME/secrets/dify-init-password}"
admin_password_file="${DIFY_LAB_ADMIN_PASSWORD_FILE:-$DIFY_LAB_RUNTIME/secrets/dify-admin-password}"
provider_base_url="${DIFY_LAB_LLM_BASE_URL:-https://llm-mock/v1}"
provider_endpoint_model="${DIFY_LAB_ENDPOINT_MODEL_NAME:-$DIFY_LAB_MODEL}"
if [[ "$provider_base_url" == http://* && "${DIFY_LAB_ALLOW_INSECURE_HTTP:-0}" != "1" ]]; then
  die "plain HTTP exposes the provider credential and conversation on the network; set DIFY_LAB_ALLOW_INSECURE_HTTP=1 only for an explicitly approved isolated test"
fi

create_private_file "$cookies"
create_private_file "$csrf_header"

http_json() {
  local method="$1"
  local endpoint="$2"
  local output="$3"
  local input="${4:-}"
  local -a args=(
    --silent
    --show-error
    --location
    --request "$method"
    --cookie "$cookies"
    --cookie-jar "$cookies"
    --output "$output"
    --write-out '%{http_code}'
    --header 'Content-Type: application/json'
  )
  if [[ -s "$csrf_header" ]]; then
    args+=(--header "@$csrf_header")
  fi
  if [[ -n "$input" ]]; then
    args+=(--data-binary "@$input")
  fi
  curl "${args[@]}" "$console_api$endpoint"
}

expect_status() {
  local actual="$1"
  local expected_pattern="$2"
  local response_file="$3"
  local operation="$4"
  if [[ ! "$actual" =~ $expected_pattern ]]; then
    printf '%s failed with HTTP %s; response body was withheld from output to protect credentials\n' \
      "$operation" "$actual" >&2
    [[ -s "$response_file" ]] || printf 'Dify returned an empty response body.\n' >&2
    exit 1
  fi
}

tmp_json() {
  mktemp "$DIFY_LAB_RUNTIME/session/.request.XXXXXX.json"
}

setup_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.setup-status.XXXXXX.json")"
setup_code="$(curl --silent --show-error --output "$setup_response" --write-out '%{http_code}' \
  "$console_api/setup")"
expect_status "$setup_code" '^200$' "$setup_response" "Dify setup status"
setup_step="$(jq -r '.step // empty' "$setup_response")"

if [[ "$setup_step" == "not_started" ]]; then
  init_request="$(tmp_json)"
  jq -n --rawfile password "$init_password_file" \
    '{password: ($password | rtrimstr("\n") | rtrimstr("\r"))}' >"$init_request"
  init_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.init-response.XXXXXX.json")"
  init_code="$(http_json POST /init "$init_response" "$init_request")"
  expect_status "$init_code" '^201$' "$init_response" "Dify init-password validation"

  setup_request="$(tmp_json)"
  jq -n \
    --arg email "$admin_email" \
    --arg name "$admin_name" \
    --rawfile password "$admin_password_file" \
    '{
      email: $email,
      name: $name,
      password: ($password | rtrimstr("\n") | rtrimstr("\r")),
      language: "zh-Hans"
    }' >"$setup_request"
  setup_create_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.setup-create.XXXXXX.json")"
  setup_create_code="$(http_json POST /setup "$setup_create_response" "$setup_request")"
  expect_status "$setup_create_code" '^201$' "$setup_create_response" "Dify initial account setup"
  printf 'Created the isolated Dify lab administrator account.\n'
elif [[ "$setup_step" != "finished" ]]; then
  die "unexpected Dify setup state: $setup_step"
fi

# Login uses Dify's current Base64 transport encoding. The encoded password is
# written only to a mode-0600 request file and never appears in argv or output.
login_password_b64_file="$(mktemp "$DIFY_LAB_RUNTIME/session/.login-password.XXXXXX")"
read_secret_file "$admin_password_file" | base64 --wrap=0 >"$login_password_b64_file"
login_request="$(tmp_json)"
jq -n \
    --arg email "$admin_email" \
    --rawfile password "$login_password_b64_file" \
    '{email: $email, password: $password, language: "zh-Hans", remember_me: true}' \
    >"$login_request"
login_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.login-response.XXXXXX.json")"
login_code="$(http_json POST /login "$login_response" "$login_request")"
expect_status "$login_code" '^200$' "$login_response" "Dify console login"
[[ "$(jq -r '.result // empty' "$login_response")" == "success" ]] ||
  die "Dify console login did not report success"

csrf_token="$(awk '$6 == "csrf_token" || $6 == "__Host-csrf_token" { value=$7 } END { print value }' "$cookies")"
[[ -n "$csrf_token" ]] || die "Dify login did not issue a CSRF token"
create_private_file "$csrf_header"
printf 'X-CSRF-Token: %s\n' "$csrf_token" >"$csrf_header"
unset csrf_token

plugin_list="$(mktemp "$DIFY_LAB_RUNTIME/session/.plugin-list.XXXXXX.json")"
plugin_list_code="$(http_json GET '/workspaces/current/plugin/list?page=1&page_size=256' "$plugin_list")"
expect_status "$plugin_list_code" '^200$' "$plugin_list" "Dify plugin list"

if ! jq -e --arg plugin_id "$DIFY_OPENAI_COMPATIBLE_PLUGIN_ID" \
  'any(.plugins[]?; .plugin_unique_identifier == $plugin_id)' "$plugin_list" >/dev/null; then
  install_request="$(tmp_json)"
  jq -n --arg plugin_id "$DIFY_OPENAI_COMPATIBLE_PLUGIN_ID" \
    '{plugin_unique_identifiers: [$plugin_id]}' >"$install_request"
  install_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.plugin-install.XXXXXX.json")"
  install_code="$(http_json POST /workspaces/current/plugin/install/marketplace "$install_response" "$install_request")"
  expect_status "$install_code" '^200$' "$install_response" "OpenAI-compatible plugin install"
  task_id="$(jq -r '.task_id // empty' "$install_response")"
  [[ -n "$task_id" ]] || die "plugin install response did not contain task_id"

  task_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.plugin-task.XXXXXX.json")"
  task_status="running"
  plugin_timeout_seconds="${DIFY_LAB_PLUGIN_INSTALL_TIMEOUT_SECONDS:-600}"
  [[ "$plugin_timeout_seconds" =~ ^[0-9]+$ && "$plugin_timeout_seconds" -ge 2 ]] ||
    die "DIFY_LAB_PLUGIN_INSTALL_TIMEOUT_SECONDS must be an integer >= 2"
  plugin_poll_attempts=$((plugin_timeout_seconds / 2))
  for _attempt in $(seq 1 "$plugin_poll_attempts"); do
    task_code="$(http_json GET "/workspaces/current/plugin/tasks/$task_id" "$task_response")"
    expect_status "$task_code" '^200$' "$task_response" "plugin installation task"
    task_status="$(jq -r '.task.status // empty' "$task_response")"
    [[ "$task_status" == "success" ]] && break
    if [[ "$task_status" == "failed" ]]; then
      jq -c '{status: .task.status, plugins: [.task.plugins[]? | {status, message}]}' \
        "$task_response" >&2
      die "OpenAI-compatible plugin installation failed"
    fi
    sleep 2
  done
  [[ "$task_status" == "success" ]] ||
    die "plugin installation did not finish within $plugin_timeout_seconds seconds"
  printf 'Installed pinned OpenAI-compatible plugin %s.\n' "$DIFY_OPENAI_COMPATIBLE_PLUGIN_ID"
fi

provider_key_file="${DIFY_LAB_LLM_API_KEY_FILE:-}"
provider_key_tmp=""
if [[ -n "${DIFY_LAB_LLM_API_KEY:-}" ]]; then
  provider_key_tmp="$(mktemp "$DIFY_LAB_RUNTIME/session/.provider-key.XXXXXX")"
  printf '%s' "$DIFY_LAB_LLM_API_KEY" >"$provider_key_tmp"
  provider_key_file="$provider_key_tmp"
elif [[ -z "$provider_key_file" && "$provider_base_url" == "https://llm-mock/v1" ]]; then
  provider_key_file="$DIFY_LAB_RUNTIME/secrets/mock-api-key"
fi
[[ -n "$provider_key_file" && -s "$provider_key_file" ]] ||
  die "set DIFY_LAB_LLM_API_KEY_FILE (recommended) or DIFY_LAB_LLM_API_KEY for a non-local provider"

credentials_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.model-credentials.XXXXXX.json")"
credentials_code="$(http_json GET "/workspaces/current/model-providers/$DIFY_OPENAI_COMPATIBLE_PROVIDER/models/credentials?model=$DIFY_LAB_MODEL&model_type=llm" "$credentials_response")"

credential_exists=false
credential_id=""
if [[ "$credentials_code" == "200" ]] &&
  jq -e '.current_credential_id != null' "$credentials_response" >/dev/null 2>&1; then
  credential_exists=true
  credential_id="$(jq -r '.current_credential_id' "$credentials_response")"
fi

if [[ "$credential_exists" != "true" || "${DIFY_LAB_FORCE_MODEL_CREDENTIAL:-0}" == "1" ]]; then
  credential_request="$(tmp_json)"
  jq -n \
    --arg model "$DIFY_LAB_MODEL" \
    --arg endpoint_model "$provider_endpoint_model" \
    --arg endpoint_url "$provider_base_url" \
    --rawfile api_key "$provider_key_file" \
    '{
      model: $model,
      model_type: "llm",
      name: "AnySentry Dify observation lab",
      credentials: {
        api_key: ($api_key | rtrimstr("\n") | rtrimstr("\r")),
        endpoint_url: $endpoint_url,
        endpoint_model_name: $endpoint_model,
        mode: "chat",
        context_size: "8192",
        max_tokens_to_sample: "2048",
        compatibility_mode: "strict",
        api_type: "chat_completions",
        token_param_name: "auto",
        stream_include_usage: "enabled",
        function_calling_type: "tool_call",
        stream_function_calling: "supported",
        vision_support: "support",
        user_identity_support: "support"
      }
    }' >"$credential_request"
  credential_create_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.credential-create.XXXXXX.json")"
  if [[ "$credential_exists" == "true" ]]; then
    credential_update_request="$(tmp_json)"
    jq --arg credential_id "$credential_id" '. + {credential_id: $credential_id}' \
      "$credential_request" >"$credential_update_request"
    credential_create_code="$(http_json PUT "/workspaces/current/model-providers/$DIFY_OPENAI_COMPATIBLE_PROVIDER/models/credentials" "$credential_create_response" "$credential_update_request")"
    expect_status "$credential_create_code" '^200$' "$credential_create_response" "model credential update"
  else
    credential_create_code="$(http_json POST "/workspaces/current/model-providers/$DIFY_OPENAI_COMPATIBLE_PROVIDER/models/credentials" "$credential_create_response" "$credential_request")"
    expect_status "$credential_create_code" '^201$' "$credential_create_response" "model credential creation"
  fi
  printf 'Configured Dify model %s (endpoint model %s) against %s; the API key was not printed.\n' \
    "$DIFY_LAB_MODEL" "$provider_endpoint_model" "$provider_base_url"
fi

import_app() {
  local fixture_name="$1"
  local state_name="$2"
  local fixture="$DIFY_LAB_ROOT/fixtures/$fixture_name"
  local state_file="$DIFY_LAB_RUNTIME/state/$state_name-app-id"
  local existing_id=""

  if [[ -s "$state_file" ]]; then
    existing_id="$(read_secret_file "$state_file")"
    existing_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.app-existing.XXXXXX.json")"
    existing_code="$(http_json GET "/apps/$existing_id" "$existing_response")"
    if [[ "$existing_code" == "200" ]]; then
      printf '%s\n' "$existing_id"
      return
    fi
  fi

  import_request="$(tmp_json)"
  jq -n --rawfile yaml "$fixture" '{mode: "yaml-content", yaml_content: $yaml}' >"$import_request"
  import_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.app-import.XXXXXX.json")"
  import_code="$(http_json POST /apps/imports "$import_response" "$import_request")"
  expect_status "$import_code" '^(200|202)$' "$import_response" "Dify app import"
  import_status="$(jq -r '.status // empty' "$import_response")"
  if [[ "$import_status" == "pending" ]]; then
    import_id="$(jq -r '.id // empty' "$import_response")"
    [[ -n "$import_id" ]] || die "pending import did not contain an id"
    confirm_request="$(tmp_json)"
    printf '{}\n' >"$confirm_request"
    confirm_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.app-confirm.XXXXXX.json")"
    confirm_code="$(http_json POST "/apps/imports/$import_id/confirm" "$confirm_response" "$confirm_request")"
    expect_status "$confirm_code" '^200$' "$confirm_response" "Dify app import confirmation"
    import_response="$confirm_response"
  fi
  app_id="$(jq -r '.app_id // empty' "$import_response")"
  [[ -n "$app_id" ]] || die "Dify app import did not return app_id"
  create_private_file "$state_file"
  printf '%s\n' "$app_id" >"$state_file"
  printf '%s\n' "$app_id"
}

publish_and_create_key() {
  local app_id="$1"
  local state_name="$2"
  local publish_request="$(tmp_json)"
  printf '{"marked_name":"AnySentry lab","marked_comment":"Non-invasive TLS observation fixture"}\n' \
    >"$publish_request"
  local publish_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.publish.XXXXXX.json")"
  local publish_code
  publish_code="$(http_json POST "/apps/$app_id/workflows/publish" "$publish_response" "$publish_request")"
  expect_status "$publish_code" '^200$' "$publish_response" "Dify workflow publish"

  local keys_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.api-keys.XXXXXX.json")"
  local keys_code
  keys_code="$(http_json GET "/apps/$app_id/api-keys" "$keys_response")"
  expect_status "$keys_code" '^200$' "$keys_response" "Dify app API-key list"
  local app_key
  app_key="$(jq -r '.data[0].token // empty' "$keys_response")"
  if [[ -z "$app_key" ]]; then
    local key_request="$(tmp_json)"
    printf '{}\n' >"$key_request"
    local key_response="$(mktemp "$DIFY_LAB_RUNTIME/session/.api-key-create.XXXXXX.json")"
    local key_code
    key_code="$(http_json POST "/apps/$app_id/api-keys" "$key_response" "$key_request")"
    expect_status "$key_code" '^201$' "$key_response" "Dify app API-key creation"
    app_key="$(jq -r '.token // empty' "$key_response")"
  fi
  [[ -n "$app_key" ]] || die "Dify did not return an app API key"
  local key_file="$DIFY_LAB_RUNTIME/secrets/$state_name-app-api-key"
  local header_file="$DIFY_LAB_RUNTIME/secrets/$state_name-app-authorization-header"
  create_private_file "$key_file"
  printf '%s\n' "$app_key" >"$key_file"
  create_private_file "$header_file"
  printf 'Authorization: Bearer %s\n' "$app_key" >"$header_file"
  unset app_key
}

llm_app_id="$(import_app llm-observation-workflow.yml llm)"
tool_app_id="$(import_app llm-http-tool-workflow.yml tool)"
publish_and_create_key "$llm_app_id" llm
publish_and_create_key "$tool_app_id" tool

printf 'Dify observation fixtures are initialized.\n'
printf '  LLM workflow app ID:  %s\n' "$llm_app_id"
printf '  Tool workflow app ID: %s\n' "$tool_app_id"
printf '  API keys are stored only as mode-0600 files under %s/secrets.\n' "$DIFY_LAB_RUNTIME"
printf 'Run %s/run-workflow.sh llm or %s/run-workflow.sh tool.\n' "$SCRIPT_DIR" "$SCRIPT_DIR"
