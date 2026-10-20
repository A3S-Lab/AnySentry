#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <x86_64-elf>" >&2
  exit 2
fi

FILE=$1
MAX_GLIBC=GLIBC_2.34
TARGET_PAGE_SIZE=4096

if [[ ! -f "$FILE" ]]; then
  echo "ELF file not found: $FILE" >&2
  exit 1
fi

if ! LANG=C readelf -h "$FILE" | grep -Eq 'Machine:[[:space:]]+Advanced Micro Devices X86-64|Machine:[[:space:]]+X86-64'; then
  echo "ELF is not x86-64: $FILE" >&2
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
    echo "ELF PT_LOAD alignment $align is smaller than 0x1000: $FILE" >&2
    exit 1
  fi
  if (( offset_dec % TARGET_PAGE_SIZE != vaddr_dec % TARGET_PAGE_SIZE )); then
    echo "ELF PT_LOAD offset/address are not congruent for 4096-byte pages: $FILE" >&2
    exit 1
  fi
done < <(LANG=C readelf -lW "$FILE" | awk '$1 == "LOAD" { print $2, $3, $NF }')

if (( load_segments == 0 )); then
  echo "ELF has no PT_LOAD segments: $FILE" >&2
  exit 1
fi

echo "PASS x86-64 ELF ABI: $FILE (glibc ${required_glibc:-none} <= ${MAX_GLIBC#GLIBC_}, 4 KiB pages)"
