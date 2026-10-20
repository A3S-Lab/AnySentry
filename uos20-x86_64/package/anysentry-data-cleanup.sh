#!/usr/bin/env bash
# anysentry-data-cleanup.sh —— AnySentry 磁盘占用查询 + ClickHouse 事件数据清理
#
# 默认只读报告，不修改任何数据。删除必须显式给参数并二次确认：
#
#   bash anysentry-data-cleanup.sh                        只读报告（默认）
#   bash anysentry-data-cleanup.sh --keep-days N          删除 N 天以前的事件（只保留最近 N 天）
#   bash anysentry-data-cleanup.sh --drop-oldest-days N   删除最早 N 天的事件
#   附加 --yes                                            跳过交互确认
#
# 清理范围只有事件族四张表：events / event_locators_v1 / kernel_fact_locators_v1 /
# agent_interactions_v1。审核记录（config 表）、审计、配置等数据永不动。
# 删除走 ClickHouse mutation（ALTER DELETE），磁盘空间在被改写的分区分配合并后归还，
# 脚本会等待 mutation 结束并提示复核。
set -uo pipefail

ENV_FILE=/etc/anysentry/anysentry.env
[[ -r $ENV_FILE ]] && {
  CLICKHOUSE_USER=$(awk -F= '/^CLICKHOUSE_USER=/{print $2}' "$ENV_FILE")
  CLICKHOUSE_PASSWORD=$(awk -F= '/^CLICKHOUSE_PASSWORD=/{print $2}' "$ENV_FILE")
}
CH_URL=http://127.0.0.1:8123/
CH=(curl -sS --connect-timeout 2 --max-time 60 --user "${CLICKHOUSE_USER:-anysentry}:${CLICKHOUSE_PASSWORD:-}")

TABLES=(events event_locators_v1 kernel_fact_locators_v1 agent_interactions_v1)
TABLE_LIST=$(IFS=,; printf "'%s'," "${TABLES[@]}"); TABLE_LIST=${TABLE_LIST%,}

step() { echo; echo "########## $* ##########"; }
note() { echo "  $*"; }

chq() { # chq <sql>，失败打印空并返回非零
  "${CH[@]}" "$CH_URL" --data-binary "$1" 2>/dev/null
}

MODE=report; KEEP_DAYS=""; OLDEST_DAYS=""; ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-days)        KEEP_DAYS=${2:-}; MODE=keep; shift 2 ;;
    --drop-oldest-days) OLDEST_DAYS=${2:-}; MODE=oldest; shift 2 ;;
    --yes)              ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（--help 看用法）" >&2; exit 2 ;;
  esac
done
[[ $MODE == keep   && ! $KEEP_DAYS   =~ ^[0-9]+$ ]] && { echo "--keep-days 需要正整数天数" >&2; exit 2; }
[[ $MODE == oldest && ! $OLDEST_DAYS =~ ^[0-9]+$ ]] && { echo "--drop-oldest-days 需要正整数天数" >&2; exit 2; }

# =========================================================================
step "1. 文件系统占用"
df -h / /data /var/lib/anysentry /opt 2>/dev/null | awk 'NR==1 || !seen[$1]++' | sed 's/^/  /'

# =========================================================================
step "2. AnySentry 目录占用"
if [[ -d /var/lib/anysentry ]]; then
  du -sh /var/lib/anysentry/* 2>/dev/null | sort -rh | sed 's/^/  /'
  note "/var/lib/anysentry 合计: $(du -sh /var/lib/anysentry 2>/dev/null | awk '{print $1}')"
else
  note "/var/lib/anysentry 不存在（未安装？）"
fi
for d in /var/log/anysentry /opt/anysentry; do
  [[ -d $d ]] && note "$d: $(du -sh "$d" 2>/dev/null | awk '{print $1}')"
done
note "systemd journal: $(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMG]' | tail -1)"

# =========================================================================
step "3. 可手工清理项（本脚本不动，只提示）"
shopt -s nullglob
rollbacks=(/opt/.anysentry.rollback.* /opt/.anysentry.units.* /opt/.anysentry.env.*)
shopt -u nullglob
if ((${#rollbacks[@]})); then
  for d in "${rollbacks[@]}"; do
    note "回滚残留: $d  $(du -sh "$d" 2>/dev/null | awk '{print $1}')  修改时间 $(date -r "$d" '+%F' 2>/dev/null)"
  done
  note "→ 确认当前版本运行正常后可删: rm -rf /opt/.anysentry.rollback.<时间戳>（units/env 备份只有几 KB，可一并删）"
else
  note "无 /opt 回滚残留"
fi
note "→ journal 超量可收: journalctl --vacuum-size=500M"
note "→ /var/log/anysentry 旧日志可保留最近后压缩/删除"

# =========================================================================
step "4. ClickHouse 表级占用（anysentry 库）"
alive=$(chq "SELECT 1")
if [[ $alive != 1 ]]; then
  note "!! ClickHouse 8123 不可达或无权限，跳过 4/5 节（检查 anysentry-clickhouse.service 与 $ENV_FILE 凭据）"
  [[ $MODE != report ]] && exit 1
else
  chq "SELECT table, formatReadableSize(sum(bytes_on_disk)) AS sz, sum(rows) AS rows_cnt
       FROM system.parts WHERE database='anysentry' AND active
       GROUP BY table ORDER BY sum(bytes_on_disk) DESC
       FORMAT TabSeparatedWithNames" | sed 's/^/  /'

  step "5. events 按月分区 / 按天分布"
  note "按月分区大小（partition=YYYYMM，删除按天进行时跨月的边界分区会被重写）:"
  chq "SELECT partition, formatReadableSize(sum(bytes_on_disk)) AS sz, sum(rows) AS rows_cnt
       FROM system.parts WHERE database='anysentry' AND table='events' AND active
       GROUP BY partition ORDER BY partition
       FORMAT TabSeparatedWithNames" | sed 's/^/  /'
  note "按天行数（最早 5 天 + 最晚 5 天）:"
  chq "SELECT * FROM (
         SELECT toDate(ts) AS d, count() AS cnt FROM anysentry.events GROUP BY d ORDER BY d ASC LIMIT 5
       ) UNION ALL
       SELECT * FROM (
         SELECT toDate(ts) AS d, count() AS cnt FROM anysentry.events GROUP BY d ORDER BY d DESC LIMIT 5
       ) ORDER BY d FORMAT TabSeparatedWithNames" | sed 's/^/  /'
  chq "SELECT '  总天数/总行数:', uniqExact(toDate(ts)), count(), '  时间范围:',
              min(toDate(ts)), '→', max(toDate(ts)) FROM anysentry.events FORMAT TabSeparated" | sed 's/^/  /'
fi

[[ $MODE == report ]] && { echo; note "只读报告结束。删除用法见: bash $0 --help"; exit 0; }

# =========================================================================
# 删除流程
[[ $alive == 1 ]] || exit 1
step "6. 计算删除边界"
if [[ $MODE == keep ]]; then
  CUTOFF=$(date -d "-${KEEP_DAYS} days" '+%F')
  note "保留最近 ${KEEP_DAYS} 天 → 删除 ${CUTOFF} 之前（不含当天）的事件"
else
  DMIN=$(chq "SELECT toString(min(toDate(ts))) FROM anysentry.events")
  [[ -n ${DMIN:-} && $DMIN != "1970-01-01" ]] || { echo "events 表为空，无需清理"; exit 0; }
  CUTOFF=$(date -d "$DMIN +${OLDEST_DAYS} days" '+%F')
  TODAY=$(date '+%F')
  note "最早一天 ${DMIN}，删除最早的 ${OLDEST_DAYS} 天 → 删除 ${CUTOFF} 之前（不含当天）的事件"
  if [[ ! $CUTOFF < $TODAY ]]; then
    echo "!! 边界 ${CUTOFF} 已覆盖到今天，等于清空全部事件，请减小 --drop-oldest-days" >&2
    exit 2
  fi
fi

note "各表将被删除的行数:"
TOTAL=0
for t in "${TABLES[@]}"; do
  c=$(chq "SELECT count() FROM anysentry.$t WHERE toDate(ts) < '$CUTOFF'")
  note "  anysentry.$t: ${c:-查询失败} 行"
  [[ ${c:-0} =~ ^[0-9]+$ ]] && TOTAL=$((TOTAL+c))
done
[[ $TOTAL -eq 0 ]] && { echo "没有 ${CUTOFF} 之前的数据，无需清理"; exit 0; }

AVAIL=$(df -B1 --output=avail /var/lib/anysentry/clickhouse 2>/dev/null | tail -1 | tr -d ' ')
BOUNDARY=$(chq "SELECT sum(bytes_on_disk) FROM system.parts
                WHERE database='anysentry' AND active AND table IN ($TABLE_LIST)
                  AND partition = toString(toYYYYMM(toDate('$CUTOFF')))")
note "磁盘余量: $(( ${AVAIL:-0} / 1024 / 1024 )) MiB；边界月分区可能被重写，约需临时空间 $(( ${BOUNDARY:-0} / 1024 / 1024 )) MiB"
if [[ -n ${BOUNDARY:-} && -n ${AVAIL:-} && $BOUNDARY -gt 0 && $AVAIL -lt $BOUNDARY ]]; then
  echo "!! 余量不足覆盖边界分区重写，先按第 3 节释放空间或缩小删除范围" >&2
  exit 1
fi

if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "确认删除 $TOTAL 行（${CUTOFF} 之前）？输入 YES 继续: " ans
  [[ $ans == YES ]] || { echo "已取消"; exit 0; }
fi

step "7. 执行删除（mutation 异步重写，等待完成）"
for t in "${TABLES[@]}"; do
  if chq "ALTER TABLE anysentry.$t DELETE WHERE toDate(ts) < '$CUTOFF'" >/dev/null; then
    note "已提交: anysentry.$t"
  else
    echo "!! 提交失败: anysentry.$t（查看 anysentry-clickhouse 日志）" >&2
  fi
done
deadline=$(( $(date +%s) + 1200 ))
while :; do
  pending=$(chq "SELECT count() FROM system.mutations
                 WHERE database='anysentry' AND table IN ($TABLE_LIST) AND is_done=0
                   AND command LIKE '%DELETE%'")
  [[ ${pending:-0} == 0 ]] && break
  (( $(date +%s) > deadline )) && { note "等待超时（20 分钟），mutation 仍在后台跑，稍后重跑本脚本报告核对"; break; }
  sleep 5
done
chq "SELECT table, mutation_id, is_done, latest_fail_reason FROM system.mutations
     WHERE database='anysentry' AND table IN ($TABLE_LIST) AND command LIKE '%DELETE%'
     ORDER BY create_time DESC LIMIT 8 FORMAT TabSeparatedWithNames" | sed 's/^/  /'
note "完成。空间在分配合并后归还，重跑 'bash $0' 第 1/4 节核对。"
