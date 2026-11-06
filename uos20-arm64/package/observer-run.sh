#!/usr/bin/env bash
# AnySentry observer supervisor (compat18).
# 替代旧的 `collector | node forwarder` 管道单元：管道形态下半死静默（2026-11-05 现场
# forwarder 死亡 4 小时无人察觉）。本脚本用 FIFO 保持原数据通路（collector stdout →
# forwarder stdin），同时监控两个子进程：任一退出即全部拉起重来（≤4 秒）。
set -u
DIR=/run/anysentry-observer
FIFO=$DIR/pipe
C=/opt/anysentry/observer/bin/a3s-observer-collector
NODE=/opt/anysentry/runtime/node/bin/node
FWD=/opt/anysentry/observer/observer-forward.js

# compat21: BPF map creation EPERMs under the inherited 64KiB memlock (field
# 2026-11-06: collector died at map EVENTS on every supervised start while the
# old pipeline unit's children ran unlimited). Declare the budget explicitly.
ulimit -l unlimited 2>/dev/null || true
mkdir -p "$DIR"
echo "run-observer: memlock=$(ulimit -l)"
# compat19: die together - a bare pkill of this script must not orphan the children
trap 'kill "$cp" "$fp" 2>/dev/null; exit 0' TERM INT
echo "run-observer: supervisor started (fifo=$FIFO)"
FAILS=0
while :; do
  _cycle_start=$(date +%s)
  rm -f "$FIFO"
  mkfifo "$FIFO" || { echo "run-observer: mkfifo failed" >&2; sleep 5; continue; }
  "$C" >"$FIFO" 2>&2 &
  cp=$!
  "$NODE" "$FWD" <"$FIFO" 2>&2 &
  fp=$!
  # 存活监控：任一子进程退出即结束本轮
  while kill -0 "$cp" 2>/dev/null && kill -0 "$fp" 2>/dev/null; do
    sleep 2
  done
  [ $(( $(date +%s) - _cycle_start )) -ge 30 ] && FAILS=0
  echo "run-observer: pipeline member exited (collector pid=$cp alive=$(kill -0 $cp 2>/dev/null && echo y || echo n), forwarder pid=$fp alive=$(kill -0 $fp 2>/dev/null && echo y || echo n)); restarting both" >&2
  kill "$cp" "$fp" 2>/dev/null
  wait "$cp" 2>/dev/null
  wait "$fp" 2>/dev/null
  FAILS=$((FAILS + 1))
  if [ "$FAILS" -ge 5 ]; then
    echo "run-observer: 5 consecutive failed cycles; exiting for systemd restart pacing" >&2
    exit 1
  fi
  sleep $((FAILS * 2))
done
