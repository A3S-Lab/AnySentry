#!/usr/bin/env bash

CHANNEL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ANYSENTRY_REPO=${ANYSENTRY_REPO:-$(git -C "$CHANNEL_DIR/.." rev-parse --show-toplevel)}
OBSERVER_REPO=${OBSERVER_REPO:-/home/chensicheng/.config/superpowers/worktrees/Observer/uos20-arm64-0.2.0}
SENTRY_REPO=${SENTRY_REPO:-/home/chensicheng/a3s/security/Sentry}
# shellcheck source=../versions.env
source "$CHANNEL_DIR/versions.env"

BUILD_DIR=${ANYSENTRY_BUILD_DIR:-$ANYSENTRY_REPO/.build/uos20-arm64}
RELEASE_DIR=${ANYSENTRY_RELEASE_DIR:-$ANYSENTRY_REPO/release}
SOURCE_DIR=$BUILD_DIR/sources
STAGE_ROOT=$BUILD_DIR/stage

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "==> $*"; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

repo_path() {
  case "$1" in
    anysentry) printf '%s\n' "$ANYSENTRY_REPO" ;;
    observer) printf '%s\n' "$OBSERVER_REPO" ;;
    sentry) printf '%s\n' "$SENTRY_REPO" ;;
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

require_source_revision() {
  local repo=$1 path actual expected
  path=$(repo_path "$repo")
  [[ -d $path ]] || die "$repo source repository is missing: $path"
  actual=$(git -C "$path" rev-parse HEAD)
  case "$repo" in
    anysentry)
      git -C "$path" merge-base --is-ancestor "$ANYSENTRY_UPSTREAM_COMMIT" "$actual" ||
        die "AnySentry source does not contain reviewed upstream $ANYSENTRY_UPSTREAM_COMMIT"
      ;;
    observer) expected=$OBSERVER_INTEGRATION_COMMIT ;;
    sentry) expected=$SENTRY_SOURCE_COMMIT ;;
  esac
  if [[ -n ${expected:-} && $actual != "$expected" ]]; then
    die "$repo source is $actual, required $expected"
  fi
}

export_source() {
  local repo=$1 destination=$SOURCE_DIR/$1
  rm -rf "$destination"
  mkdir -p "$destination"
  git -C "$(repo_path "$repo")" archive --format=tar HEAD | tar -xf - -C "$destination"
}

prepare_sources() {
  local repo
  mkdir -p "$BUILD_DIR" "$SOURCE_DIR"
  for repo in anysentry observer sentry; do
    require_source_revision "$repo"
    require_clean_repo "$repo"
    export_source "$repo"
  done
  {
    printf 'ANYSENTRY_COMMIT=%s\n' "$(source_commit anysentry)"
    printf 'OBSERVER_COMMIT=%s\n' "$(source_commit observer)"
    printf 'SENTRY_COMMIT=%s\n' "$(source_commit sentry)"
    printf 'kernel_version=%s\n' "$UOS_BPF_KERNEL_VERSION"
    printf 'kernel_version_code=%s\n' "$UOS_BPF_KERNEL_VERSION_CODE"
  } > "$BUILD_DIR/source-provenance.env"
}

ensure_stage() {
  [[ -n "${RELEASE_VERSION:-}" ]] || die 'RELEASE_VERSION is not set'
  STAGE_NAME=anysentry-security-suite-${RELEASE_VERSION}-uos20-arm64
  STAGE_DIR=$STAGE_ROOT/$STAGE_NAME
  export STAGE_NAME STAGE_DIR BUILD_DIR RELEASE_DIR SOURCE_DIR CHANNEL_DIR
  export ANYSENTRY_REPO OBSERVER_REPO SENTRY_REPO
  mkdir -p "$STAGE_DIR" "$RELEASE_DIR"
}
