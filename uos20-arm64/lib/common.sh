#!/usr/bin/env bash

CHANNEL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SECURITY_ROOT=$(cd "$CHANNEL_DIR/.." && pwd)
# shellcheck source=../versions.env
source "$CHANNEL_DIR/versions.env"

BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$SECURITY_ROOT/.build/uos20-arm64}
RELEASE_DIR=${ANYSENTRY_RELEASE_DIR:-$SECURITY_ROOT/release}
SOURCE_DIR=$BUILD_DIR/sources
STAGE_ROOT=$BUILD_DIR/stage

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "==> $*"; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

repo_path() {
  case "$1" in
    anysentry) printf '%s\n' "$SECURITY_ROOT/AnySentry" ;;
    observer) printf '%s\n' "$SECURITY_ROOT/Observer" ;;
    sentry) printf '%s\n' "$SECURITY_ROOT/Sentry" ;;
    *) die "unknown source repository: $1" ;;
  esac
}

require_clean_repo() {
  local repo=$1 path
  path=$(repo_path "$repo")
  git -C "$path" diff --quiet || die "$repo source has unstaged changes: $path"
  git -C "$path" diff --cached --quiet || die "$repo source has staged changes: $path"
  [[ -z "$(git -C "$path" ls-files --others --exclude-standard)" ]] || die "$repo source has untracked files: $path"
}

source_commit() { git -C "$(repo_path "$1")" rev-parse HEAD; }

export_source() {
  local repo=$1 destination=$SOURCE_DIR/$1
  rm -rf "$destination"
  mkdir -p "$destination"
  git -C "$(repo_path "$repo")" archive --format=tar HEAD | tar -xf - -C "$destination"
}

apply_adapter() {
  local source=$1 patch_file=$2
  [[ -s "$patch_file" ]] || die "compatibility patch is missing: $patch_file"
  # BUILD_DIR may itself live below another Git worktree. Applying from inside
  # the exported directory would then make Git treat ignored build files as
  # paths in that enclosing repository and silently leave them unchanged.
  # Apply from SECURITY_ROOT (which is intentionally not a repository) and
  # prefix every patch path with the absolute isolated-source directory.
  if ! (cd "$SECURITY_ROOT" && git apply --check --unsafe-paths --directory="$source" "$patch_file"); then
    die "compatibility patch conflicts with current HEAD: $patch_file"
  fi
  (cd "$SECURITY_ROOT" && git apply --unsafe-paths --directory="$source" "$patch_file")
}

prepare_sources() {
  local repo
  mkdir -p "$BUILD_DIR" "$SOURCE_DIR"
  for repo in anysentry observer sentry; do
    require_clean_repo "$repo"
    export_source "$repo"
  done
  apply_adapter "$SOURCE_DIR/anysentry" "$CHANNEL_DIR/patches/anysentry-current-head.patch"
  apply_adapter "$SOURCE_DIR/observer" "$CHANNEL_DIR/patches/observer-linux-4.19.90.patch"
  {
    printf 'ANYSENTRY_COMMIT=%s\n' "$(source_commit anysentry)"
    printf 'OBSERVER_COMMIT=%s\n' "$(source_commit observer)"
    printf 'SENTRY_COMMIT=%s\n' "$(source_commit sentry)"
    printf 'ANYSENTRY_PATCH_SHA256=%s\n' "$(sha256sum "$CHANNEL_DIR/patches/anysentry-current-head.patch" | awk '{print $1}')"
    printf 'OBSERVER_PATCH_SHA256=%s\n' "$(sha256sum "$CHANNEL_DIR/patches/observer-linux-4.19.90.patch" | awk '{print $1}')"
    printf 'kernel_version=%s\n' "$UOS_BPF_KERNEL_VERSION"
    printf 'kernel_version_code=%s\n' "$UOS_BPF_KERNEL_VERSION_CODE"
  } > "$BUILD_DIR/source-provenance.env"
}

ensure_stage() {
  [[ -n "${RELEASE_VERSION:-}" ]] || die 'RELEASE_VERSION is not set'
  STAGE_NAME=anysentry-security-suite-${RELEASE_VERSION}-uos20-arm64
  STAGE_DIR=$STAGE_ROOT/$STAGE_NAME
  export STAGE_NAME STAGE_DIR BUILD_DIR RELEASE_DIR SOURCE_DIR CHANNEL_DIR SECURITY_ROOT
  mkdir -p "$STAGE_DIR" "$RELEASE_DIR"
}
