#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <aarch64-elf>" >&2
  exit 2
fi

FILE=$1
MAX_GLIBC=GLIBC_2.28
TARGET_PAGE_SIZE=65536

if [[ ! -f "$FILE" ]]; then
  echo "ELF file not found: $FILE" >&2
  exit 1
fi

if ! LANG=C readelf -h "$FILE" | grep -Eq 'Machine:[[:space:]]+AArch64'; then
  echo "ELF is not AArch64: $FILE" >&2
  LANG=C readelf -h "$FILE" >&2 || true
  exit 1
fi

required_glibc=$(
  LANG=C readelf -W --version-info --dyn-syms "$FILE" \
    | sed -nE 's/.*Name: GLIBC_([0-9.]+).*/\1/p' \
    | sort -V \
    | tail -n 1
)

if [[ -n "$required_glibc" ]]; then
  highest=$(printf '%s\n' "${MAX_GLIBC#GLIBC_}" "$required_glibc" | sort -V | tail -n 1)
  if [[ "$highest" != "${MAX_GLIBC#GLIBC_}" ]]; then
    echo "ELF requires GLIBC_${required_glibc}, newer than ${MAX_GLIBC}: $FILE" >&2
    exit 1
  fi
fi

load_segments=0
while read -r offset vaddr align; do
  load_segments=$((load_segments + 1))
  offset_dec=$((offset))
  vaddr_dec=$((vaddr))
  align_dec=$((align))
  if (( align_dec < TARGET_PAGE_SIZE )); then
    echo "ELF PT_LOAD alignment $align is smaller than 0x10000: $FILE" >&2
    exit 1
  fi
  if (( offset_dec % TARGET_PAGE_SIZE != vaddr_dec % TARGET_PAGE_SIZE )); then
    echo "ELF PT_LOAD offset/address are not congruent for 65536-byte pages: $FILE" >&2
    exit 1
  fi
done < <(LANG=C readelf -lW "$FILE" | awk '$1 == "LOAD" { print $2, $3, $NF }')

if (( load_segments == 0 )); then
  echo "ELF has no PT_LOAD segments: $FILE" >&2
  exit 1
fi

echo "PASS AArch64 ELF ABI: $FILE (glibc ${required_glibc:-none} <= ${MAX_GLIBC#GLIBC_}, 64 KiB pages)"
