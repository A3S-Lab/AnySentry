#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
anysentry_root="$(cd "${script_dir}/.." && pwd)"
sentry_root="${1:-${anysentry_root}/../Sentry}"
sdk_dir="${sentry_root}/sdk/typescript"
output_dir="${anysentry_root}/.local/sentry-sdk"
pack_dir="$(mktemp -d)"
trap 'rm -rf "${pack_dir}"' EXIT

if [[ ! -f "${sdk_dir}/package.json" ]]; then
  echo "Sentry TypeScript SDK not found at ${sdk_dir}" >&2
  exit 1
fi

npm --prefix "${sdk_dir}" run build
(cd "${sdk_dir}" && npm pack --pack-destination "${pack_dir}" >/dev/null)
mkdir -p "${output_dir}"
archive="$(find "${pack_dir}" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
if [[ -z "${archive}" ]]; then
  echo "Sentry SDK package was not produced" >&2
  exit 1
fi
tar -xzf "${archive}" --strip-components=1 -C "${output_dir}"
node -e 'const sdk=require(process.argv[1]); const judge=sdk.Sentry.create("fail_closed = false"); if(typeof judge.evaluateL1!=="function") throw new Error("local Sentry SDK does not expose evaluateL1"); console.log(`prepared @a3s-lab/sentry ${require(process.argv[1]+"/package.json").version}`)' "${output_dir}"
