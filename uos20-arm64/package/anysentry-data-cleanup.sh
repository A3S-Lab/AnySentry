#!/usr/bin/env bash
# anysentry-data-cleanup - AnySentry 数据保留清理（v2）
# 覆盖：ClickHouse 七表 + PostgreSQL（raw_observations/kernel_facts/会话族，含 VACUUM FULL 还地）
#       + Flink 旧 checkpoint + Kafka 旧日志 + journal 收缩 + 回滚残留（可选）。
# 语义：--keep-days N = 保留最近 N 天（含今天），删除更早数据。
# 用法：
#   bash anysentry-data-cleanup.sh                          # 只读报告
#   bash anysentry-data-cleanup.sh --keep-days 2 --yes      # 清理（CH+PG+杂项）
#   bash anysentry-data-cleanup.sh --keep-days 2 --yes --purge-rollbacks
#   bash anysentry-data-cleanup.sh --drop-oldest-days 7 --yes
#   可选：--skip-vacuum-full（PG 只标记复用不还磁盘空间）
set -uo pipefail

ENV_FILE=${ANYSENTRY_ENV_FILE:-/etc/anysentry/anysentry.env}
PG_BIN=/opt/anysentry/postgresql/bin
# compat30 fix: the background (nohup) re-exec drops inherited env; bundled psql
# cannot load libpq without this -> every PG step silently failed (field 2026-11-12:
# DELETE reported 0/fail while manual runs deleted 518k rows).
export LD_LIBRARY_PATH="$(dirname "$PG_BIN")/../lib:${LD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH=/opt/anysentry/postgresql/lib
[[ -f $ENV_FILE ]] || { echo "缺 $ENV_FILE" >&2; exit 1; }
CLICKHOUSE_USER=$(awk -F= '/^CLICKHOUSE_USER=/{print $2}' "$ENV_FILE")
CLICKHOUSE_PASSWORD=$(awk -F= '/^CLICKHOUSE_PASSWORD=/{print $2}' "$ENV_FILE")
CH_URL=http://127.0.0.1:8123/
CH=(curl -sS --connect-timeout 2 --max-time 120 --user "${CLICKHOUSE_USER:-anysentry}:${CLICKHOUSE_PASSWORD:-}")

# CH 表与时间表达式（ toDate(...) ），存在性启动时过滤
declare -a TABLES=(events event_locators_v1 kernel_fact_locators_v1 agent_interactions_v1
                   event_revision_identities process_lifecycle_facts collector_heartbeats)
declare -a TSEXPR=('toDate(ts)' 'toDate(ts)' 'toDate(ts)' 'toDate(ts)'
                   'toDate(ts)' 'toDate(toDateTime(intDiv(at,1000)))' 'toDate(toDateTime(intDiv(at,1000)))')
# PG 大表（纳秒时间列）与会话族（created_at TIMESTAMPTZ）
PG_NS_TABLES=(anysentry_raw_observations_v1:event_at anysentry_kernel_facts_v1:observed_at)
PG_FAMILY_TABLES=(anysentry_agent_conversation_threads_v1 anysentry_agent_conversation_segments_v1
                  anysentry_agent_conversation_bindings_v1 anysentry_agent_conversation_anchors_v1
                  anysentry_agent_conversation_memberships_v2 anysentry_agent_conversation_route_aliases_v1
                  anysentry_agent_run_technical_activities_v1 anysentry_session_memberships_v1
                  anysentry_semantic_records_v1 anysentry_coverage_gaps_v1 anysentry_evidence_links_v1)

step() { echo; echo "########## $* ##########"; }
note() { echo "  $*"; }
chq() { "${CH[@]}" "$CH_URL" --data-binary "$1" 2>/dev/null; }
pgq() { "$PG_BIN/psql" -h 127.0.0.1 -U anysentry -d anysentry -v ON_ERROR_STOP=1 "$@" 2>&1; }
# v4: 打包缺 llvmjit*.bc，触发 JIT 的大表查询整条报错（2026-11-03 现场根因）——清理前确保关闭
pgq -c "ALTER SYSTEM SET jit='off'" >/dev/null 2>&1 || true
pgq -c "SELECT pg_reload_conf()" >/dev/null 2>&1 || true

MODE=report; KEEP_DAYS=""; OLDEST_DAYS=""; ASSUME_YES=0; PURGE_RB=0; VAC_FULL=1
ORIG_ARGS=("$@")   # 解析循环会 shift 掉参数；后台重执行前必须先留存原参
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-days)          KEEP_DAYS=${2:-}; MODE=keep; shift 2 ;;
    --drop-oldest-days)   OLDEST_DAYS=${2:-}; MODE=oldest; shift 2 ;;
    --yes)                ASSUME_YES=1; shift ;;
    --purge-rollbacks)    PURGE_RB=1; shift ;;
    --skip-vacuum-full)   VAC_FULL=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（--help 看用法）" >&2; exit 2 ;;
  esac
done
[[ $MODE == keep   && ! $KEEP_DAYS   =~ ^[0-9]+$ ]] && { echo "--keep-days 需要正整数" >&2; exit 2; }
[[ $MODE == oldest && ! $OLDEST_DAYS =~ ^[0-9]+$ ]] && { echo "--drop-oldest-days 需要正整数" >&2; exit 2; }

# 过滤出实际存在的 CH 表（保持下标对齐）
ALIVE_T=(); ALIVE_E=()
for i in "${!TABLES[@]}"; do
  [[ $(chq "SELECT count() FROM system.tables WHERE database='anysentry' AND name='${TABLES[$i]}'") == 1 ]] && {
    ALIVE_T+=("${TABLES[$i]}"); ALIVE_E+=("${TSEXPR[$i]}"); }
done
TABLES=("${ALIVE_T[@]}"); TSEXPR=("${ALIVE_E[@]}")
TABLE_LIST=$(IFS=,; printf "'%s'," "${TABLES[@]}"); TABLE_LIST=${TABLE_LIST%,}
[[ ${#TABLES[@]} -gt 0 ]] || { echo "ClickHouse 无可管理表" >&2; exit 1; }

step "1. 文件系统占用"
df -h / /data /var/lib/anysentry /opt 2>/dev/null | awk 'NR==1 || !seen[$1]++' | sed 's/^/  /'
DATA_PCT=$(df --output=pcent /data 2>/dev/null | tail -1 | tr -dc '0-9')
[[ ${DATA_PCT:-0} -ge 90 ]] && note "/data ${DATA_PCT}% —— 非 AnySentry 占用（业务系统数据），需业务侧自行处理"

step "2. AnySentry 目录占用"
if [[ -d /var/lib/anysentry ]]; then
  du -sh /var/lib/anysentry/* 2>/dev/null | sort -rh | sed 's/^/  /'
  note "/var/lib/anysentry 合计: $(du -sh /var/lib/anysentry 2>/dev/null | awk '{print $1}')"
else note "/var/lib/anysentry 不存在"; fi
du -sh /var/log/anysentry /opt/anysentry 2>/dev/null | sed 's/^/  /'
note "systemd journal: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[MG]' | head -1)"

step "3. 回滚残留与手工项"
shopt -s nullglob
for d in /opt/.anysentry.rollback.*; do note "回滚残留: $d  $(du -sh $d 2>/dev/null | cut -f1)"; done
for d in /opt/.anysentry.units.* /opt/.anysentry.env.*; do note "小备份: $d"; done
shopt -u nullglob
[[ $PURGE_RB -ne 1 ]] && note "确认当前版本正常后可加 --purge-rollbacks 一并清理"

step "4. ClickHouse 表级占用（anysentry 库）"
chq "SELECT table, formatReadableSize(sum(bytes_on_disk)) AS sz, sum(rows) AS rows_cnt
     FROM system.parts WHERE active AND database='anysentry' GROUP BY table
     ORDER BY sum(bytes_on_disk) DESC FORMAT PrettyCompactNoEscapes" | sed 's/^/  /'

step "5. events 时间分布"
PARTS=$(chq "SELECT DISTINCT partition FROM system.parts WHERE active AND database='anysentry' AND table='events'")
[[ $PARTS == *"tuple()"* ]] && note "提示: events 无分区键（partition=tuple()），每次 DELETE 是全表级 mutation 重写；建议上游 DDL 按月分区"
TOTAL_DAYS=$(chq "SELECT uniqExact(toDate(ts)) FROM anysentry.events")
if [[ ${TOTAL_DAYS:-0} -le 10 ]]; then
  chq "SELECT toDate(ts) AS d, count() AS cnt FROM anysentry.events GROUP BY d ORDER BY d FORMAT PrettyCompactNoEscapes" | sed 's/^/  /'
else
  note "按天行数（最早 5 天 + 最晚 5 天）:"
  chq "SELECT * FROM (SELECT toDate(ts) d, count() cnt FROM anysentry.events GROUP BY d ORDER BY d ASC LIMIT 5)
       UNION ALL SELECT * FROM (SELECT toDate(ts) d, count() cnt FROM anysentry.events GROUP BY d ORDER BY d DESC LIMIT 5)
       ORDER BY d FORMAT PrettyCompactNoEscapes" | sed 's/^/  /'
fi
chq "SELECT '总天数/总行数:', uniqExact(toDate(ts)), count(), '范围:', min(toDate(ts)), '→', max(toDate(ts))
     FROM anysentry.events FORMAT TabSeparated" | sed 's/^/  /'

step "5b. PostgreSQL 占用与死元组（含 pg_isready 状态）"
if "$PG_BIN/pg_isready" -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
  "$PG_BIN/psql" -h 127.0.0.1 -U anysentry -d anysentry -c \
    "SELECT relname AS 表, pg_size_pretty(pg_total_relation_size(relid)) AS 总占用,
            n_live_tup AS 活元组, n_dead_tup AS 死元组
       FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 12" 2>/dev/null | sed 's/^/  /'
  note "PG 总占用: $(du -sh /var/lib/anysentry/postgresql 2>/dev/null | cut -f1)"
else note "PG 未就绪，跳过 PG 段"; fi

[[ $MODE == report ]] && { echo; note "只读报告结束。删除用法见: bash $0 --help"; exit 0; }

# 断线自持久（v3）：清理模式 + 交互终端时自动转后台，SSH 断线不杀脚本。
# 重 I/O 阶段机器可能忙到 SSH 无响应（现场两次断线的根因），后台化后断线无害。
if [[ -z ${CLEANUP_DAEMON:-} && -t 1 ]]; then
  export CLEANUP_DAEMON=1
  LOGF=/var/log/anysentry/cleanup-run.log
  mkdir -p /var/log/anysentry
  setsid nohup bash "$0" "${ORIG_ARGS[@]}" >>"$LOGF" 2>&1 < /dev/null &
  echo "已转入后台运行（SSH 断线安全）"
  echo "  日志: $LOGF    跟踪: tail -f $LOGF"
  exit 0
fi

# =========================================================================
step "6. 计算删除边界（--keep-days N = 保留最近 N 天，含今天）"
if [[ $MODE == keep ]]; then
  CUTOFF=$(date -d "-$((KEEP_DAYS-1)) days" '+%F')
  note "保留最近 ${KEEP_DAYS} 天（含今天）→ 删除 ${CUTOFF} 之前的全部数据"
else
  DMIN=$(chq "SELECT toString(min(toDate(ts))) FROM anysentry.events")
  [[ -n ${DMIN:-} && $DMIN != "1970-01-01" ]] || { echo "events 表为空，无需清理"; exit 0; }
  CUTOFF=$(date -d "$DMIN +${OLDEST_DAYS} days" '+%F')
  note "最早一天 ${DMIN}，删除最早 ${OLDEST_DAYS} 天 → 删除 ${CUTOFF} 之前的数据"
  [[ $CUTOFF < $(date '+%F') ]] || { echo "!! 边界 ${CUTOFF} 覆盖到今天，等于清空，请减小 --drop-oldest-days" >&2; exit 2; }
fi
CUTOFF_MS=$(( $(date -d "$CUTOFF" +%s) * 1000 ))
CUTOFF_NS=$(( CUTOFF_MS * 1000000 ))

step "7. 待删除量预览"
TOTAL=0
for i in "${!TABLES[@]}"; do
  c=$(chq "SELECT count() FROM anysentry.${TABLES[$i]} WHERE ${TSEXPR[$i]} < '$CUTOFF'")
  [[ ${c:-} =~ ^[0-9]+$ ]] || c=0
  note "  CH ${TABLES[$i]}: ${c} 行"; TOTAL=$((TOTAL+c))
done
PG_READY=0; "$PG_BIN/pg_isready" -h 127.0.0.1 -p 5432 -q 2>/dev/null && PG_READY=1
if [[ $PG_READY == 1 ]]; then
  for te in "${PG_NS_TABLES[@]}"; do
    t=${te%%:*}; col=${te##*:}
    c=$("$PG_BIN/psql" -h 127.0.0.1 -U anysentry -d anysentry -tAc "SELECT count(*) FROM $t WHERE $col < $CUTOFF_NS" 2>&1)
    if [[ ${c:-} =~ ^[0-9]+$ ]]; then
      note "  PG ${t}: ${c} 行"; TOTAL=$((TOTAL+c))
    else
      note "  PG ${t}: 查询失败（${c:0:80}）——检查 psql/LD_LIBRARY_PATH"; PG_READY=0
    fi
  done
  for t in "${PG_FAMILY_TABLES[@]}"; do
    has=$("$PG_BIN/psql" -h 127.0.0.1 -U anysentry -d anysentry -tAc \
      "SELECT 1 FROM information_schema.columns WHERE table_name='$t' AND column_name='created_at'" 2>/dev/null)
    [[ $has == 1 ]] || continue
    c=$("$PG_BIN/psql" -h 127.0.0.1 -U anysentry -d anysentry -tAc "SELECT count(*) FROM $t WHERE created_at < '$CUTOFF'" 2>/dev/null || echo 0)
    [[ ${c:-0} -gt 0 ]] && note "  PG ${t}: ${c} 行"
    TOTAL=$((TOTAL+${c:-0}))
  done
fi
[[ $TOTAL -eq 0 ]] && { echo "边界 ${CUTOFF} 之前没有数据，无需清理"; exit 0; }

AVAIL=$(df -B1 --output=avail /var/lib/anysentry/clickhouse 2>/dev/null | tail -1 | tr -d ' ')
BOUNDARY=$(chq "SELECT sum(bytes_on_disk) FROM system.parts
                WHERE database='anysentry' AND active AND table IN ($TABLE_LIST)
                  AND partition = toString(toYYYYMM(toDate('$CUTOFF')))")
note "磁盘余量 $(( ${AVAIL:-0}/1048576 ))MiB；边界月分区重写约需 $(( ${BOUNDARY:-0}/1048576 ))MiB"
if [[ -n ${BOUNDARY:-} && $BOUNDARY -gt 0 && ${AVAIL:-1} -lt $BOUNDARY ]]; then
  echo "!! 余量不足覆盖边界分区重写，先释放空间或缩小范围" >&2; exit 1; fi
if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "确认删除 ${CUTOFF} 之前共 ${TOTAL} 行？输入 YES 继续: " ans
  [[ $ans == YES ]] || { echo 已取消; exit 0; }
fi

step "8. ClickHouse 删除（mutation 异步，等待完成）"
# v3: 先等上一轮遗留 mutation（断线重启场景），避免叠加重写
pre=$(chq "SELECT count() FROM system.mutations WHERE database='anysentry'
           AND table IN ($TABLE_LIST) AND is_done=0 AND command LIKE '%DELETE%'")
if [[ ${pre:-0} != 0 ]]; then
  note "上轮遗留 ${pre} 个未完成 mutation，先等它们结束（不叠加新重写）..."
  while :; do
    p=$(chq "SELECT count() FROM system.mutations WHERE database='anysentry'
             AND table IN ($TABLE_LIST) AND is_done=0 AND command LIKE '%DELETE%'")
    [[ ${p:-0} == 0 ]] && break
    sleep 10
  done
  note "遗留 mutation 已完成"
fi
for i in "${!TABLES[@]}"; do
  if chq "ALTER TABLE anysentry.${TABLES[$i]} DELETE WHERE ${TSEXPR[$i]} < '$CUTOFF'" >/dev/null; then
    note "已提交: ${TABLES[$i]}"
  else echo "!! 提交失败: ${TABLES[$i]}" >&2; fi
done
deadline=$(( $(date +%s) + 1200 ))
while :; do
  pending=$(chq "SELECT count() FROM system.mutations WHERE database='anysentry'
                 AND table IN ($TABLE_LIST) AND is_done=0 AND command LIKE '%DELETE%'")
  [[ ${pending:-0} == 0 ]] && break
  (( $(date +%s) > deadline )) && { note "等待超时（20 分钟）"; break; }
  sleep 5
done
# compat32: CH internal bookkeeping tables get 4h retention (not user-facing)
for it in event_commit_facts_v2 event_revision_identities process_lifecycle_facts event_locators_v1 kernel_fact_locators_v1; do
  chq "ALTER TABLE anysentry.${it} DELETE WHERE ts < now() - INTERVAL 4 HOUR" >/dev/null 2>&1 || true
done

# v3: mutation 未完成时绝不进入 PG VACUUM FULL——两场全表重写叠加曾把机器压到 SSH 无响应
if [[ ${pending:-0} != 0 ]]; then
  echo "!! CH mutation 仍在重写（${pending} 个）。为避免与 PG VACUUM FULL 叠加压垮磁盘，本次到此为止。" >&2
  echo "!! 等 mutation 完成后重跑本脚本（幂等，会跳过已删数据直奔 PG 段）。" >&2
  exit 1
fi

step "9. PostgreSQL 删除 + 空间回收"
if [[ $PG_READY == 1 ]]; then
  for te in "${PG_NS_TABLES[@]}"; do
    t=${te%%:*}; col=${te##*:}
    r=$(pgq -c "DELETE FROM $t WHERE $col < $CUTOFF_NS")
    [[ $r == DELETE* ]] || note "  !! $t 删除失败：$(echo "$r" | head -c 160)"
    note "DELETE $t: $(echo "$r" | grep -oE 'DELETE [0-9]+' || echo "失败:$(echo "$r" | head -c 120)")"
  done

  # compat32: PG kernel facts short retention (4h; CH events is authoritative)
  SHORT_CUT=$(($(date +%s) - 14400))000000000
  pgq -c "DELETE FROM anysentry_kernel_facts_v1 WHERE observed_at < $SHORT_CUT" >/dev/null 2>&1 || true
  pgq -c "DELETE FROM anysentry_raw_observations_v1 WHERE event_at < $(($(date +%s) - 7200))000000000" >/dev/null 2>&1 || true
  for t in "${PG_FAMILY_TABLES[@]}"; do
    has=$("$PG_BIN/psql" -h 127.0.0.1 -U anysentry -d anysentry -tAc \
      "SELECT 1 FROM information_schema.columns WHERE table_name='$t' AND column_name='created_at'" 2>/dev/null)
    [[ $has == 1 ]] || continue
    r=$(pgq -c "DELETE FROM $t WHERE created_at < '$CUTOFF'")
    n=$(echo "$r" | grep -oE 'DELETE [0-9]+' | grep -oE '[0-9]+' || echo 0)
    [[ ${n:-0} -gt 0 ]] && note "DELETE $t: $n"
  done
  pgq "VACUUM ANALYZE" >/dev/null 2>&1
  if [[ $VAC_FULL == 1 ]]; then
    # v3: 磁盘余量守卫（VACUUM FULL 需约等于表大小的临时空间）+ checkpoint 降压
    FREE_KB=$(df -P --output=avail /var/lib/anysentry/postgresql 2>/dev/null | tail -1 | tr -d ' ')
    BIG_KB=$("$PG_BIN/psql" -h 127.0.0.1 -U anysentry -d anysentry -tAc \
      "SELECT greatest(pg_total_relation_size('anysentry_raw_observations_v1'),
                        pg_total_relation_size('anysentry_kernel_facts_v1'))/1024" 2>/dev/null || echo 0)
    note "VACUUM FULL 前检查: 余量 ${FREE_KB:-?}KB vs 最大表 ${BIG_KB:-?}KB"
    if [[ -n ${FREE_KB:-} && -n ${BIG_KB:-} && ${BIG_KB:-0} -gt 0 && $FREE_KB -lt $((BIG_KB*2)) ]]; then
      note "!! 余量不足（需约 2×最大表），跳过 VACUUM FULL——空间已可复用，下次余量充足时再跑"
    else
      note "VACUUM FULL 还磁盘空间（每表短暂锁，API loopback 专用，影响为秒级停顿）..."
      for t in anysentry_raw_observations_v1 anysentry_kernel_facts_v1 anysentry_agent_conversation_memberships_v2 anysentry_coverage_gaps_v1 anysentry_semantic_records_v1 anysentry_session_memberships_v1 anysentry_agent_conversation_anchors_v1 anysentry_agent_conversation_threads_v1 anysentry_agent_conversation_segments_v1 anysentry_evidence_links_v1 anysentry_agent_conversation_bindings_v1; do
        pgq -c "CHECKPOINT" >/dev/null 2>&1
        b=$(pgq -tAc "SELECT pg_size_pretty(pg_total_relation_size('$t'))" 2>/dev/null)
        out=$(pgq -c "VACUUM FULL $t" 2>&1)
        a=$(pgq -tAc "SELECT pg_size_pretty(pg_total_relation_size('$t'))" 2>/dev/null)
        if echo "$out" | grep -q VACUUM; then note "VACUUM FULL $t: $b -> $a"
        else note "!! VACUUM FULL $t 失败: $(echo "$out" | head -c 120)"; fi
      done
    fi
  else note "已跳过 VACUUM FULL（--skip-vacuum-full）：空间仅标记复用，不返还磁盘"
  fi
  note "PG 现占用: $(du -sh /var/lib/anysentry/postgresql 2>/dev/null | cut -f1)"
else note "PG 未就绪，跳过 PG 清理"; fi

step "10. 杂项清理（Flink 旧 checkpoint / Kafka 旧日志 / journal / 回滚残留）"
find /var/lib/anysentry/flink/checkpoints -mindepth 1 -maxdepth 1 -type d -mtime +$((KEEP_DAYS+1)) \
  -exec rm -rf {} \; 2>/dev/null && note "Flink: 已清旧 checkpoint 目录"
find /var/lib/anysentry/kafka-logs -type f -mtime +$((KEEP_DAYS+1)) -delete 2>/dev/null && note "Kafka: 已清旧日志文件"
journalctl --vacuum-size=500M >/dev/null 2>&1 && note "journal: 已收缩至 500M 内"
if [[ $PURGE_RB == 1 ]]; then
  rm -rf /opt/.anysentry.rollback.* /opt/.anysentry.units.* /opt/.anysentry.env.* 2>/dev/null
  note "回滚残留: 已清理（--purge-rollbacks）"
fi

note "完成。重跑 'bash $0' 第 1/4/5b 节核对。"
note "提示: prometheus TSDB 由其自身 retention 管理（compat13 起配置内建）。"
