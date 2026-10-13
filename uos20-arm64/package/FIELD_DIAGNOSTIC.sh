#!/usr/bin/env bash
# FIELD_DIAGNOSTIC.sh —— AnySentry UOS 现场分阶段诊断（默认纯只读，一次跑完 S0-S8）
#
# 用途：任何会话/任何人接手现场时，先跑本脚本，按阶段输出定位问题所在层级，
#   不要跳步、不要试错。每阶段输出 PASS/FAIL/WARN + 下一步指引。
#
# 用法：bash FIELD_DIAGNOSTIC.sh [--with-http] 2>&1 | tee field-diagnostic-result.txt
#   默认纯只读；--with-http 额外跑 S7 明文合成实验（从 ai-agent 容器内向宿主机 tarpit
#   发一次带标记 HTTP，性质同健康检查）并观测 READ_ARGS 暂存（需同目录 bpf-inspect）。
set -uo pipefail
WITH_HTTP=0
[[ "${1:-}" == "--with-http" ]] && WITH_HTTP=1
DIR=$(cd "$(dirname "$0")" && pwd)
INSPECT=$DIR/bpf-inspect

ENV_FILE=/etc/anysentry/anysentry.env
[[ -r $ENV_FILE ]] && {
  ADMIN_TOKEN=$(awk -F= '/^ANYSENTRY_ADMIN_TOKEN=/{print substr($0,index($0,"=")+1)}' "$ENV_FILE" | tr -d '[:space:]')
  CLICKHOUSE_USER=$(awk -F= '/^CLICKHOUSE_USER=/{print $2}' "$ENV_FILE")
  CLICKHOUSE_PASSWORD=$(awk -F= '/^CLICKHOUSE_PASSWORD=/{print $2}' "$ENV_FILE")
}
API=http://127.0.0.1:29653/security-center
CH=(curl -sS --connect-timeout 2 --max-time 15 --user "${CLICKHOUSE_USER:-anysentry}:${CLICKHOUSE_PASSWORD:-}")

PASS=0; FAIL=0; WARNN=0
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); echo "         → $2" >&2; }
warn() { echo "  [WARN] $*"; WARNN=$((WARNN+1)); }
note() { echo "  [....] $*"; }
step() { echo; echo "########## $* ##########"; }
hint() { echo "  [下一步] $*"; }

# =========================================================================
step "S0. 目标机器基线档案（每次接手先核对，与档案不符要警觉）"
uname -r | sed 's/^/  内核: /'
uname -m | sed 's/^/  架构: /'
ldd --version 2>/dev/null | head -1 | sed 's/^/  glibc: /'
echo "  页大小: $(getconf PAGE_SIZE 2>/dev/null)（期望 65536）"
grep CapEff /proc/self/status 2>/dev/null | sed 's/^/  /'
echo "  cgroup2 挂载点（hybrid 应为 /sys/fs/cgroup/unified）:"
awk '$3=="cgroup2"{print "   ", $2}' /proc/mounts 2>/dev/null
echo "  BPF 限制 sysctl:"
for k in kernel.unprivileged_bpf_disabled kernel.bpf_stats_enabled; do
  v=$(sysctl -n "$k" 2>/dev/null) && echo "    $k=$v" || echo "    $k 不存在"
done
echo "  容器清单:"
docker ps --format '    {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null
echo "  禁区端口占用核对（9000/8000/8001/7998/7999/17862/8080 属客户，AnySentry 不得占用；29653 属我们）:"
ss -tlnp 2>/dev/null | awk '$4 ~ /:(9000|8000|8001|7998|7999|17862|8080|29653)$/ {print "   ", $4, $6}' | sort -u
df -h / /data 2>/dev/null | sed 's/^/  /'

# =========================================================================
step "S1. 服务存活（采集管线活着是前提）"
inactive=$(systemctl list-units 'anysentry-*' --all --no-pager 2>/dev/null | awk '$1 ~ /^anysentry-.*\.service$/ && $3!="active" {print $1}')
if [[ -z $inactive ]]; then ok "全部单元 active"; else bad "存在非 active 单元: $inactive" "systemctl start <单元> 后重跑"; fi
ps -eo pid,etime,cmd 2>/dev/null | grep -E 'a3s-observer-collector|observer-forward' | grep -v grep | sed 's/^/  /'
latest=$("${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT toDateTime(max(at)/1000) FROM anysentry.events" 2>/dev/null)
now=$(date '+%Y-%m-%d %H:%M:%S')
echo "  最新事件时间: ${latest:-查询失败}（当前 $now）"
[[ -n $latest && $latest != "查询失败" ]] && ok "事件在流" || { bad "事件不在流" "查 Kafka/Flink/API 链路（journalctl -u anysentry-flink-job -u anysentry-stream-worker）"; }

# =========================================================================
step "S2. 探针挂载（14 = 8 基础 + 6 明文）"
attached=$(journalctl -u anysentry-observer.service -b --no-pager -o cat 2>/dev/null \
  | grep 'legacy probe attached' | grep -o 'program="[^"]*"' | sort -u)
n_attached=$(echo "$attached" | grep -c .)
echo "$attached" | sed 's/^/  /'
[[ $n_attached -ge 14 ]] && ok "14 个探针程序全部挂上" \
  || { bad "探针只有 $n_attached 个" "journal 里找 'legacy probe load failed'（验证器拒绝要看完整日志）"; }
curl -sS --connect-timeout 2 --max-time 15 -X POST "$API/collectors/health" \
  -H 'Content-Type: application/json' -H "x-anysentry-admin-token: ${ADMIN_TOKEN:-}" -d '{}' 2>/dev/null \
  | python3 -c "
import json,sys
try:
    it=json.load(sys.stdin).get('data',{}).get('items',[{}])[0]
    print('  collector state=%s attachedProbes=%s droppedEvents=%s outputDropped=%s' % (
        it.get('state'),it.get('attachedProbes'),it.get('droppedEvents'),it.get('outputDropped')))
    print('  （注：outputDropped=非Agent事件按策略丢弃，是设计行为不是故障）')
except Exception as e: print('  health 查询失败:',e)
"

# =========================================================================
step "S3. 审核与投影（明文采集的前提：Agent 被确认为 confirmed）"
curl -sS --connect-timeout 2 --max-time 15 "$API/identity/snapshot" \
  -H "x-anysentry-admin-token: ${ADMIN_TOKEN:-}" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); d=d.get('data',d)
    entries=d.get('entries') or []
    confirmed=[e for e in entries if e.get('classification')=='confirmed_agent']
    print('  reviewVersion:',d.get('reviewVersion'),' confirmed 条目:',len(confirmed))
    for e in confirmed:
        ids=e.get('ids') or []
        print('   ids 数:',len(ids),' 含ai-agent(容器id 98280aa):',any('98280aa' in str(i) for i in ids),
              ' 含skill(f442f7e):',any('f442f7e' in str(i) for i in ids))
    if not confirmed: print('  !! 无 confirmed 条目 → 明文白名单必为空，先做审核（见规则文档 S3 节）')
except Exception as e: print('  投影查询失败:',e)
"

# =========================================================================
step "S4. 白名单发布（文件存在 + 条目与容器 cgroup inode 匹配）"
WL=/run/anysentry-filter/tls-agent-cgroups.json
if [[ -f $WL ]]; then
  python3 -c "
import json
d=json.load(open('$WL'))
ids=[str(e.get('cgroupId')) for e in d.get('entries',[])]
print('  白名单条目:',ids if ids else '(空)')
" 2>&1
  # 计算容器真实 cgroup inode（hybrid：从 /proc/<pid1>/cgroup 取 0:: 路径，到 unified 挂载点 stat）
  cgmnt=$(awk '$3=="cgroup2"{print $2; exit}' /proc/mounts)
  for c in ai-agent ai-agent-skill; do
    p1=$(docker inspect -f '{{.State.Pid}}' "$c" 2>/dev/null)
    [[ -n $p1 && $p1 != 0 ]] || continue
    rel=$(awk -F: '$1=="0"{print $3}' "/proc/$p1/cgroup" 2>/dev/null)
    inode=$(stat -c %i "$cgmnt$rel" 2>/dev/null)
    echo "  $c 当前 cgroup inode: ${inode:-?}"
  done
else
  bad "白名单文件 $WL 不存在" "observer 服务停了会擦除该文件（RuntimeDirectory）；先查 S1"
fi

# =========================================================================
step "S5. 准入同步（collector 每 2s 把白名单 cgroup 解析成 pid 集）"
journalctl -u anysentry-observer.service --since '-5 min' --no-pager -o cat 2>/dev/null \
  | grep 'cgroup scopes reconciled' | tail -2 | sed 's/^/  /'
n5=$(journalctl -u anysentry-observer.service --since '-5 min' --no-pager -o cat 2>/dev/null | grep -c 'cgroup scopes reconciled')
[[ $n5 -gt 0 ]] && ok "准入同步在跑" || { bad "5 分钟内无 reconcile 日志" "明文开关没开？查 S2 单元 A3S_OBSERVER_PLAINTEXT_HTTP=1"; }
systemctl show anysentry-observer.service -p Environment --value 2>/dev/null | tr ' ' '\n' \
  | grep -E '^A3S_OBSERVER_(PLAINTEXT_HTTP|SSL)' | sed 's/^/  单元开关: /'

# =========================================================================
step "S6. 采集产出（各类型速率 + 明文计数）"
echo "-- 近 10 分钟事件类型分布:"
"${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT eventKind, count() FROM anysentry.events WHERE at > toUInt64(toUnixTimestamp(now() - INTERVAL 10 MINUTE)) * 1000 GROUP BY eventKind ORDER BY count() DESC FORMAT TSV" 2>/dev/null | sed 's/^/   /'
echo "-- 明文事件（tcp_plaintext/tls_uprobe）总数:"
"${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT count() FROM anysentry.events WHERE source IN ('tcp_plaintext','tls_uprobe')" 2>/dev/null | sed 's/^/   /'
note "注意：events 表是 Agent 安全视图，不是全机网络流水；Egress 稀疏属正常（未归因被策略丢弃）"

# =========================================================================
step "S7. 明文合成实验（--with-http 才跑；tarpit 慢动作法）"
if [[ $WITH_HTTP -eq 0 ]]; then
  note "跳过（加 --with-http 启用）：从已准入容器内向宿主机 tarpit 发一次带标记 HTTP 并观测 READ_ARGS"
else
  PORT=18099
  if ss -tln 2>/dev/null | grep -q ":$PORT "; then
    echo "  端口 $PORT 被占，跳过"
  else
    HOSTIP=$(hostname -I 2>/dev/null | awk '{print $1}')
    nohup python3 -c "
import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0',$PORT)); s.listen(4)
conn,_=s.accept(); conn.recv(4096); time.sleep(12)
conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); conn.close(); s.close()
" >/tmp/fd-tarpit.log 2>&1 &
    TARPIT=$!
    sleep 1
    PYBIN=$(docker exec ai-agent sh -c 'command -v python || command -v python3' 2>/dev/null | tr -d '[:space:]')
    docker exec ai-agent "$PYBIN" -c "
import time,socket
time.sleep(8)  # 活过 2 秒准入扫描周期
s=socket.create_connection(('${HOSTIP:-172.22.17.203}',$PORT))  # 无超时=真阻塞
s.sendall(b'GET /diag-ANYSENTRY_FD HTTP/1.1\r\nHost: x\r\n\r\n')
s.recv(4096)
s.close()
print('  client 完成', flush=True)
" &
    CLIENT_BG=$!
    sleep 10
    if [[ -x $INSPECT ]]; then
      echo "-- 阻塞期 READ_ARGS（出现新条目=进入侧工作；响应后消失=返回侧工作）:"
      "$INSPECT" 2>/dev/null | grep -E '^READARGS_' | sed 's/^/  /'
    else
      note "无 bpf-inspect，跳过 READ_ARGS 观测（只判 CH 侧）"
    fi
    wait $CLIENT_BG
    kill $TARPIT 2>/dev/null
    sleep 25
    # 明文产物落点：events.eventKind='LlmInteraction' 与 agent_interactions_v1；
    # events.source 列只有 observer/api，不能用它判明文。
    now=$("${CH[@]}" http://127.0.0.1:8123/ --data-binary \
      "SELECT count() FROM anysentry.events WHERE eventKind='LlmInteraction' AND at > toUInt64(toUnixTimestamp(now() - INTERVAL 30 MINUTE)) * 1000" 2>/dev/null)
    echo "  近 30 分钟 LlmInteraction 事件数: ${now:-?}"
    "${CH[@]}" http://127.0.0.1:8123/ --data-binary \
      "SELECT count() FROM anysentry.agent_interactions_v1 WHERE positionCaseInsensitive(payload, 'ANYSENTRY_FD') > 0 AND at > toUInt64(toUnixTimestamp(now() - INTERVAL 30 MINUTE)) * 1000" 2>/dev/null | sed 's/^/  含标记交互数: /'
  fi
fi

# =========================================================================
step "S8. 归因抽查（最近事件是否带 agent 归属）"
"${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT eventKind, agentId, toDateTime(at/1000) FROM anysentry.events ORDER BY at DESC LIMIT 8 FORMAT TSV" 2>/dev/null | sed 's/^/   /'

echo
echo "########## 汇总 ##########"
echo "  PASS=$PASS FAIL=$FAIL WARN=$WARNN"
echo "  按阶段顺序定位：S1 服务 → S2 探针 → S3 审核 → S4 白名单 → S5 准入 → S6/S7 产出"
echo "  每一层 FAIL 时先修该层再往下；全部 PASS 但业务明文仍无 → 走 S7/S9 内核取证（bpf-inspect）"
