#!/usr/bin/env bash
# AnySentry x86_64 调试变体：部署后全量体检（只读）
# 覆盖：服务/探针/心跳通道/丢弃/事件流/接口延迟/CH 慢查询/资源
# 用法：bash /opt/anysentry/POST_DEPLOY_AUDIT.sh
set -uo pipefail
ENV_FILE=${ANYSENTRY_ENV_FILE:-/etc/anysentry/anysentry.env}
API=http://127.0.0.1:29653/security-center
PASS_N=0; WARN_N=0; FAIL_N=0
ok()   { echo "  [PASS] $*"; PASS_N=$((PASS_N+1)); }
warn() { echo "  [WARN] $*"; WARN_N=$((WARN_N+1)); }
bad()  { echo "  [FAIL] $*"; FAIL_N=$((FAIL_N+1)); }
step() { echo; echo "== $* =="; }
tok() { grep -oP '(?<=ANYSENTRY_ADMIN_TOKEN=).*' "$ENV_FILE" 2>/dev/null | head -1 | tr -d '"'; }
chu() { sed -n 's/^CLICKHOUSE_USER=//p' "$ENV_FILE" | head -1 | tr -d '"'; }
chp() { sed -n 's/^CLICKHOUSE_PASSWORD=//p' "$ENV_FILE" | head -1 | tr -d '"'; }
chq() { curl -sS -m 25 --data-binary @- "http://127.0.0.1:8123/?default_format=TabSeparatedWithNames&database=anysentry" -u "$(chu):$(chp)" 2>/dev/null; }

echo "AnySentry 部署后体检  $(date '+%F %T')  host=$(hostname)"

step "1. 服务单元"
units=$(systemctl list-units 'anysentry-*' --no-legend --plain 2>/dev/null | awk '{print $1}')
n_total=0
for u in $units; do
  n_total=$((n_total+1))
  s=$(systemctl is-active "$u" 2>/dev/null)
  [ "$s" = active ] || bad "$u -> $s"
done
[ "$n_total" -ge 13 ] && ok "${n_total} 个 anysentry 单元全部 active" || warn "单元数 $n_total（预期 14；若为升级后部分运行请核对）"
today=$(date +%F)
crashes=$(journalctl -u anysentry -u anysentry-observer --since "$today" --no-pager 2>/dev/null | grep -c 'Failed with result')
[ "${crashes:-0}" -eq 0 ] && ok "今日 API/Observer 无崩溃记录" || warn "今日 API/Observer 崩溃 $crashes 次（coredump 见 /var/lib/systemd/coredump）"

step "2. 探针（8 基础 + 6 明文 = 14）"
attached=$(journalctl -u anysentry-observer -b -o cat --no-pager 2>/dev/null | grep 'legacy probe attached' | grep -o 'program="[^"]*"' | sort -u | wc -l)
loadfail=$(journalctl -u anysentry-observer -b -o cat --no-pager 2>/dev/null | grep -c 'legacy probe load failed')
[ "${attached:-0}" -ge 14 ] && ok "探针 $attached/14 挂载" || bad "探针仅 $attached/14（load failed $loadfail 次，详见 journal 验证器输出）"
journalctl -u anysentry-observer -b -o cat --no-pager 2>/dev/null | grep 'legacy probe attached' | grep -o 'program="[^"]*"' | sort | sed 's/^/     /'

step "3. 心跳通道"
hb_fail=$(journalctl -u anysentry-observer --since '15 min ago' --no-pager -o cat 2>/dev/null | grep -c 'heartbeat delivery failed')
[ "${hb_fail:-0}" -eq 0 ] && ok "近 15 分钟心跳投递 0 失败" || bad "近 15 分钟心跳投递失败 $hb_fail 次（API 事件循环可能被慢查询阻塞）"
row=$(echo 'SELECT payload FROM collector_heartbeats ORDER BY at DESC LIMIT 1' | chq | tail -1)
if [ -n "$row" ]; then
  hb_status=$(echo "$row" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status","?"))' 2>/dev/null)
  hb_age=$(echo "$row" | python3 -c 'import json,sys,time; print(int((time.time()*1000-json.load(sys.stdin)["at"])/1000))' 2>/dev/null)
  [ "$hb_status" = ok ] && ok "最新心跳 status=ok（${hb_age}s 前）" || bad "最新心跳 status=$hb_status"
  [ "${hb_age:-999}" -lt 120 ] && ok "心跳新鲜度 ${hb_age}s（<120s）" || warn "心跳距今 ${hb_age}s（>120s：通道可能断流）"
else
  bad "collector_heartbeats 无数据"
fi

step "4. 丢弃与队列（最新心跳窗口）"
if [ -n "${row:-}" ]; then
  echo "$row" | python3 -c '
import json,sys
p=json.load(sys.stdin)
for k in ("droppedEvents","outputDropped","errorCount","queueDepth"):
    v=p.get(k); print(f"  {k}={v}")
' 2>/dev/null
  dz=$(echo "$row" | python3 -c 'import json,sys;p=json.load(sys.stdin);print(1 if (p.get("droppedEvents") or 0)==0 and (p.get("outputDropped") or 0)==0 and (p.get("errorCount") or 0)==0 else 0)' 2>/dev/null)
  [ "$dz" = 1 ] && ok "丢弃/错误全部为 0" || bad "存在丢弃或错误（见上）——对照 FIELD_DIAGNOSTIC.sh 定位"
else
  warn "无心跳数据可查"
fi

step "5. 事件流活性"
ev10=$(echo 'SELECT count() FROM events WHERE at > now() - 600' | chq | tail -1 | tr -d ' ')
ev1=$(echo 'SELECT count() FROM events WHERE at > now() - 60' | chq | tail -1 | tr -d ' ')
[ "${ev10:-0}" -gt 0 ] && ok "近 10 分钟事件 ${ev10} 条（近 1 分钟 ${ev1:-0}）" || bad "近 10 分钟 0 事件（探针/过滤链路异常）"

step "6. 接口延迟（冷查询阈值 20s，缓存阈值 2s）"
T=$(tok); H2="Authorization: Bearer $T"; H1="Content-Type: application/json"
lat() { curl -sS -m 40 -o /dev/null -w '%{http_code} %{time_total}' "$@"; }
r=$(lat -X GET $API/healthz);      echo "  healthz        $r";  case "$r" in *" 0."*) ok;; *) warn;; esac
r=$(lat -X POST $API/agents/inventory -H "$H1" -H "$H2" --data '{"timeType":"last_3h","includeUnclassified":true}'); echo "  inventory冷    $r"
r=$(lat -X POST $API/agents/inventory -H "$H1" -H "$H2" --data '{"timeType":"last_3h","includeUnclassified":true}'); echo "  inventory缓存  $r"
r=$(lat -X POST $API/agents/directory -H "$H1" -H "$H2" --data '{"timeType":"last_3h"}'); echo "  directory      $r"
r=$(lat -X POST $API/agents/interactions -H "$H1" -H "$H2" --data '{"page":1,"pageSize":10}'); echo "  interactions   $r"
inv_cold=$(curl -sS -m 40 -o /dev/null -w '%{time_total}' -X POST $API/agents/inventory -H "$H1" -H "$H2" --data '{"timeType":"last_1h"}' 2>/dev/null)
awk -v t="$inv_cold" 'BEGIN{exit !(t<20)}' && ok "inventory 冷路径 ${inv_cold}s < 20s" || bad "inventory 冷路径 ${inv_cold}s ≥ 20s（检查 ANYSENTRY_CH_READ_* 与 ANYSENTRY_CH_BUCKET_* 预算 env）"
hs=$(curl -sS -m 10 -o /dev/null -w '%{time_total}' $API/healthz)
awk -v t="$hs" 'BEGIN{exit !(t<1)}' && ok "healthz ${hs}s" || bad "healthz ${hs}s（API 事件循环阻塞）"

step "7. CH 慢查询与负载"
slow=$(echo "SELECT count() FROM system.query_log WHERE event_time > now() - 3600 AND type = 3 AND query_duration_ms > 2000 AND query NOT LIKE '%system.query_log%'" | chq | tail -1 | tr -d ' ')
[ "${slow:-0}" -le 5 ] && ok "近 1 小时 >2s 查询 ${slow:-0} 条" || warn "近 1 小时 >2s 查询 ${slow:-0} 条（看 query_log 优化或调 env 预算）"
running=$(echo "SELECT count() FROM system.processes WHERE query NOT LIKE '%system.processes%'" | chq | tail -1 | tr -d ' ')
[ "${running:-0}" -le 2 ] && ok "当前运行中查询 ${running:-0}" || warn "当前运行中查询 ${running:-0}"

step "8. 资源快照"
free -h | sed -n '2p' | sed 's/^/  内存 /'
df -h / | tail -1 | sed 's/^/  磁盘 /'
uptime | sed 's/^/  /'
ps -eo rss,pcpu,comm --sort=-rss | grep -iE 'clickhouse|node|observer|java' | head -5 | awk '{printf "  %.1fGB %s%% %s\n", $1/1048576, $2, $3}'

step "9. 明文引导"
if [ -f /run/anysentry-filter/tls-agent-cgroups.json ] && grep -q '"entries":\[[^]]' /run/anysentry-filter/tls-agent-cgroups.json 2>/dev/null; then
  ok "白名单已有条目（明文已开）——完整链路验收跑: bash /opt/anysentry/ACCEPTANCE_CHECK.sh"
else
  warn "明文白名单为空：先审核 office-agent 候选/身份为已确认 Agent（Agents 页或 PUT /agents/<id>/review），15s 后重查"
fi

echo
echo "====== 汇总: PASS=$PASS_N WARN=$WARN_N FAIL=$FAIL_N ======"
[ "$FAIL_N" -eq 0 ] && echo "结论：体检通过" || echo "结论：存在 FAIL 项，按上文提示处理"
