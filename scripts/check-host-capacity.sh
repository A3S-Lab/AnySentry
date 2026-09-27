#!/usr/bin/env bash
# Lightweight host capacity gate for Design B / docker / heavy builds.
# Exit 0 = proceed carefully; 1 = defer heavy I/O work.
set -euo pipefail

LOAD1=$(awk '{print $1}' /proc/loadavg)
CPUS=$(nproc)
MEM_AVAIL_MB=$(awk '/MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo)
SWAP_USED_MB=$(awk '/SwapTotal:/ {t=$2} /SwapFree:/ {f=$2} END {printf "%d", (t-f)/1024}' /proc/meminfo)
DISK_USE=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
D_COUNT=$(ps -eLo stat | awk '/^D/ {c++} END {print c+0}')

IO_FULL10="n/a"
if [[ -r /proc/pressure/io ]]; then
  IO_FULL10=$(awk '/^full / {for(i=1;i<=NF;i++) if($i ~ /^avg10=/){split($i,a,"="); print a[2]}}' /proc/pressure/io)
fi

NVME_UTIL="n/a"
NVME_WAWAIT="n/a"
if command -v iostat >/dev/null 2>&1; then
  # one sample after 1s settle
  read -r NVME_UTIL NVME_WAWAIT < <(iostat -x 1 2 2>/dev/null | awk '/^nvme0n1/ {u=$NF; w=$(NF-8)} END {print u+0, w+0}')
fi

DOCKER_CREATED=0
if timeout 8 docker ps -aq --filter status=created >/tmp/docker-created.ids 2>/dev/null; then
  DOCKER_CREATED=$(wc -l </tmp/docker-created.ids | tr -d ' ')
fi

printf 'load1=%s cpus=%s mem_avail_mb=%s swap_used_mb=%s disk_use_pct=%s\n' \
  "$LOAD1" "$CPUS" "$MEM_AVAIL_MB" "$SWAP_USED_MB" "$DISK_USE"
printf 'psi_io_full_avg10=%s nvme_util=%s nvme_w_await_ms=%s d_state=%s docker_created=%s\n' \
  "$IO_FULL10" "$NVME_UTIL" "$NVME_WAWAIT" "$D_COUNT" "$DOCKER_CREATED"

# Gates tuned for this lab host (16 CPU / 32G / single NVMe).
fail=0
awk -v l="$LOAD1" -v c="$CPUS" 'BEGIN{exit !(l > c*1.5)}' && { echo 'GATE fail: load1 > 1.5*cpus'; fail=1; }
[[ "$MEM_AVAIL_MB" -lt 2048 ]] && { echo 'GATE fail: MemAvailable < 2Gi'; fail=1; }
[[ "$SWAP_USED_MB" -gt 6144 ]] && { echo 'GATE fail: swap used > 6Gi'; fail=1; }
[[ "$DISK_USE" -ge 90 ]] && { echo 'GATE fail: root disk >= 90%'; fail=1; }
[[ "$D_COUNT" -gt 30 ]] && { echo 'GATE fail: D-state threads > 30'; fail=1; }
[[ "$DOCKER_CREATED" -gt 0 ]] && { echo 'GATE warn: docker Created leftovers present'; }
if [[ "$IO_FULL10" != "n/a" ]]; then
  awk -v x="$IO_FULL10" 'BEGIN{exit !(x+0 > 40)}' && { echo 'GATE fail: PSI io full avg10 > 40%'; fail=1; }
fi
if [[ "$NVME_UTIL" != "n/a" ]]; then
  awk -v x="$NVME_UTIL" 'BEGIN{exit !(x+0 > 85)}' && { echo 'GATE fail: nvme %util > 85'; fail=1; }
  awk -v x="$NVME_WAWAIT" 'BEGIN{exit !(x+0 > 100)}' && { echo 'GATE fail: nvme w_await > 100ms'; fail=1; }
fi

if [[ "$fail" -eq 0 ]]; then
  echo 'RESULT=GO (heavy docker/compose/build allowed)'
  exit 0
fi
echo 'RESULT=NO-GO (prefer code/docs/k8s-light work; defer docker create/compose)'
exit 1
