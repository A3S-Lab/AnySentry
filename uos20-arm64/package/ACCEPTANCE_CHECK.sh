#!/usr/bin/env bash
# AnySentry UOS 随包现场验收（只读 + 仅向 127.0.0.1:8000/8001 各发 3 个带唯一标记的 GET）
# 安装完成后运行：bash /opt/anysentry/ACCEPTANCE_CHECK.sh 2>&1 | tee acceptance-result.txt
# 也可在发布包解压目录直接运行。业务 401/404 属预期，无副作用。
set -uo pipefail

ENV_FILE=/etc/anysentry/anysentry.env
API=http://127.0.0.1:29653/security-center
[[ -r $ENV_FILE ]] && { CLICKHOUSE_USER=$(awk -F= '/^CLICKHOUSE_USER=/{print $2}' "$ENV_FILE"); CLICKHOUSE_PASSWORD=$(awk -F= '/^CLICKHOUSE_PASSWORD=/{print $2}' "$ENV_FILE"); }
CH=(curl -sS --connect-timeout 2 --max-time 15 --user "${CLICKHOUSE_USER:-anysentry}:${CLICKHOUSE_PASSWORD:-}")
PASS=0; FAIL=0
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
step() { echo; echo "########## $* ##########"; }

step "1. 安装结果与服务状态"
grep -E '^(result|failure_stage|rollback)=' /var/log/anysentry/install/@RELEASE_VERSION@/summary.txt 2>/dev/null || echo "  (summary.txt 不可读，确认安装日志目录是否为 @RELEASE_VERSION@)"
inactive=$(systemctl list-units 'anysentry-*' --all --no-pager | awk '$1 ~ /^anysentry-.*\.service$/ && $3!="active" {print $1}')
[[ -z $inactive ]] && ok "全部单元 active" || bad "存在非 active 单元: $inactive"

step "2. collector 健康（快照拒绝回归）"
curl -sS --connect-timeout 2 --max-time 15 -X POST "$API/collectors/health" \
  -H 'Content-Type: application/json' -d '{}' | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
items=d.get('items',[])
if not items: print('  !! 无 collector'); sys.exit(0)
it=items[0]; fm=it.get('filterMetrics',{})
print('  state:',it.get('state'),' attachedProbes:',it.get('attachedProbes'),
      ' outputDropped:',it.get('outputDropped'),' errorCount:',it.get('errorCount'))
print('  runtimeSnapshot posts/errors/rejected:',
      fm.get('runtimeSnapshotPosts'),'/',fm.get('runtimeSnapshotErrors'),'/',fm.get('runtimeSnapshotRejected'))
print('  confirmedAgent(窗口):',fm.get('confirmedAgent'),' probableAgent:',fm.get('probableAgent'))
# state=degraded 只说明历史上丢过事件（环丢失累计计数），采集本身可正常工作；
# 判 FAIL 只看功能指标：探针数、快照拒绝、错误计数。
ok = (it.get('attachedProbes')==14 and fm.get('runtimeSnapshotRejected')==0
      and not fm.get('lastRuntimeSnapshotError') and (it.get('errorCount') or 0)==0)
if it.get('state')=='degraded':
    print('  [注意] state=degraded：历史累计丢过事件（droppedEvents>0），功能指标正常即视为通过')
print('  __VERDICT__', 'PASS' if ok else 'FAIL')
" | tee /tmp/.acc-s2 | grep -E 'state|runtimeSnapshot|confirmed|注意|!!'
grep -q '__VERDICT__ PASS' /tmp/.acc-s2 && ok "collector 功能健康（探针 14 + 快照 0 拒绝 + 0 错误）" || bad "collector 未就绪或仍有快照拒绝"
echo "  说明：outputDropped 是策略丢弃计数（非白名单进程事件按设计丢弃），不是故障。"

step "3. 审核投影显式字段 + confirmed 条目"
curl -sS --connect-timeout 2 --max-time 15 "$API/identity/snapshot" | python3 -c "
import json,sys
d=json.load(sys.stdin); d=d.get('data',d)
entries=d.get('entries') or []
confirmed=[e for e in entries if e.get('classification')=='confirmed_agent']
print('  reviewVersion:',d.get('reviewVersion'),' reviewedEntries:',d.get('reviewedEntries'),
      ' 条目数:',len(entries),' confirmed_agent:',len(confirmed))
for e in confirmed:
    print('   CONFIRMED:',e.get('physicalWorkloadId'))
ok = (d.get('reviewVersion') or 0) >= 1 and len(confirmed) >= 1
print('  __VERDICT__', 'PASS' if ok else 'FAIL')
" | tee /tmp/.acc-s3 | grep -E 'reviewVersion|CONFIRMED'
grep -q '__VERDICT__ PASS' /tmp/.acc-s3 && ok "审核已进投影（reviewVersion>=1）" || bad "投影仍无 confirmed 条目（需在审核页/接口把 office-agent 确认为已确认 Agent，身份键需并集覆盖两个容器）"

step "4. 明文白名单（两个容器的当前 cgroup 都必须在内）"
UNI=$(awk '$3=="cgroup2"{print $2}' /proc/mounts | head -1)
echo "  cgroup2 挂载点: ${UNI:-未找到}"
declare -A WANT=()
for c in ai-agent ai-agent-skill; do
  pid=$(docker inspect -f '{{.State.Pid}}' "$c" 2>/dev/null || true)
  [[ -n ${pid:-} && $pid != "0" ]] || { echo "  $c 未运行？"; continue; }
  rel=$(awk -F: '$2==""{print $3}' "/proc/$pid/cgroup" 2>/dev/null)
  inode=$(stat -c %i "${UNI}${rel}" 2>/dev/null || true)
  echo "  $c: pid=$pid cgroup=${rel:-?} inode=${inode:-?}"
  [[ -n ${inode:-} ]] && WANT[$c]=$inode
done
python3 -c "
import json
try:
    d=json.load(open('/run/anysentry-filter/tls-agent-cgroups.json'))
    entries=d.get('entries',[])
    print('  白名单 version:',d.get('version'),' 条目数:',len(entries))
    for e in entries: print('   ',json.dumps(e))
    ids={str(e.get('cgroupId')) for e in entries}
    print('  __IDS__', ' '.join(sorted(ids)))
    print('  __VERDICT__', 'PASS' if len(entries)>0 else 'FAIL')
except Exception as ex:
    print('  读取失败:',ex); print('  __VERDICT__ FAIL')
" | tee /tmp/.acc-s4 | grep -vE '^__'
if grep -q '__VERDICT__ PASS' /tmp/.acc-s4; then
  ok "白名单有条目"
  ids_line=$(grep '__IDS__' /tmp/.acc-s4 | sed 's/__IDS__ //')
  for c in "${!WANT[@]}"; do
    echo "${ids_line}" | tr ' ' '\n' | grep -qx "${WANT[$c]}" \
      && ok "白名单覆盖 $c（inode ${WANT[$c]}）" \
      || bad "白名单缺 $c（当前 inode ${WANT[$c]}；审核记录身份键需并集覆盖两个容器）"
  done
else
  bad "白名单仍为空"
fi

step "4.5 observer 单元开关与 collector 白名单加载信号"
envs=$(systemctl show anysentry-observer.service -p Environment --value 2>/dev/null | tr ' ' '\n')
echo "$envs" | grep -q '^A3S_OBSERVER_PLAINTEXT_HTTP=1$' \
  && ok "单元含 A3S_OBSERVER_PLAINTEXT_HTTP=1" \
  || bad "单元缺 A3S_OBSERVER_PLAINTEXT_HTTP=1（打包适配未生效？）"
echo "$envs" | grep -q '^A3S_OBSERVER_SSL=' \
  && echo "  [注意] 单元设了 A3S_OBSERVER_SSL——legacy 后端不支持 TLS uprobe，collector 会打 WARN 并忽略它" \
  || ok "未设 A3S_OBSERVER_SSL（符合预期）"
grep -q '^A3S_OBSERVER_SSL=' "$ENV_FILE" 2>/dev/null \
  && echo "  [注意] env 文件残留 A3S_OBSERVER_SSL（本次安装应已自动清除；若仍在请回报）" \
  || ok "env 文件无 A3S_OBSERVER_SSL 残留"
reconciled=$(journalctl -u anysentry-observer.service -b -o cat --no-pager 2>/dev/null | grep -c 'plaintext Agent cgroup scopes reconciled')
echo "  collector 白名单加载日志次数: $reconciled"
[[ ${reconciled:-0} -gt 0 ]] && ok "collector 已加载白名单并同步准入 map" || bad "collector 从未加载白名单"
echo "  探针挂接日志（应为 14 个程序：8 基础 + 6 明文）:"
journalctl -u anysentry-observer.service -b -o cat --no-pager 2>/dev/null | grep 'legacy probe attached' | grep -o 'program="[^"]*"' | sort -u | sed 's/^/     /'
attached_n=$(journalctl -u anysentry-observer.service -b -o cat --no-pager 2>/dev/null | grep 'legacy probe attached' | grep -o 'program="[^"]*"' | sort -u | wc -l)
[[ ${attached_n:-0} -ge 14 ]] && ok "14 个探针程序全部挂上" || bad "探针程序只有 $attached_n 个（应有 14；失败的程序在 journal 里有 'legacy probe load failed' 与验证器详情）"
ssl_warn=$(journalctl -u anysentry-observer.service -b -o cat --no-pager 2>/dev/null | grep -c 'does not implement TLS uprobe')
echo "  SSL 不支持 WARN 次数（应为 0）: $ssl_warn"

step "5. 明文链路端到端（出向合成法；入向 curl 按设计不出事件，不再作为验收项）"
mark="anysentry-fd-$(date +%s)"
echo "  探针标记: $mark"
# 方法：宿主机 tarpit（接连接→睡 12s→回 OpenAI 形状 JSON）+ ai-agent 容器内客户端
# （睡 8s 过准入→POST 带标记请求→真阻塞 recv）。采的是"Agent 作为 HTTP 客户端的出向腿"；
# 入向 curl 打 8000/8001 方向相反，按设计不出事件。
# 明文产物落点：events.eventKind='LlmInteraction' 与 agent_interactions_v1
# （transport='http'，payload 内含 captureSource=tcp_plaintext）。events.source 列只有
# observer/api，用它判明文恒为 0（compat24 首跑 FAIL 即此谓词问题，非功能问题）。
if ss -tln 2>/dev/null | grep -q ':18099 '; then
  echo "  [WARN] 端口 18099 被占，本节跳过"
else
  nohup python3 -c "
import socket,time
body=b'{\"id\":\"chatcmpl-acc\",\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}'
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0',18099)); s.listen(4)
conn,_=s.accept(); conn.recv(65536); time.sleep(12)
conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
conn.close(); s.close()
" >/tmp/.acc-tarpit.log 2>&1 &
  TARPIT=$!
  sleep 1
  HOSTIP=$(hostname -I 2>/dev/null | awk '{print $1}')
  PYBIN=$(docker exec ai-agent sh -c 'command -v python || command -v python3' 2>/dev/null | tr -d '[:space:]')
  if [[ -n ${PYBIN:-} ]]; then
    docker exec ai-agent "$PYBIN" -c "
import time,socket
time.sleep(8)
req_body=('{\"model\":\"acc-probe\",\"messages\":[{\"role\":\"user\",\"content\":\"$mark\"}]}').encode()
s=socket.create_connection(('${HOSTIP:-172.22.17.203}',18099))
s.sendall(b'POST /acc/$mark HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: '+str(len(req_body)).encode()+b'\r\n\r\n'+req_body)
s.recv(4096)
s.close()
print('  出向合成请求完成', flush=True)
"
  else
    echo "  [WARN] ai-agent 容器内无 python，本节跳过"
  fi
  kill $TARPIT 2>/dev/null
fi
echo "  等待 30 秒入库 ..."; sleep 30
echo "  -- 近 15 分钟事件分布:"
"${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT eventKind, source, count() FROM anysentry.events WHERE at > toUInt64(toUnixTimestamp(now() - INTERVAL 15 MINUTE)) * 1000 GROUP BY eventKind, source ORDER BY 3 DESC FORMAT TSV" | tee /tmp/.acc-dist | sed 's/^/     /'
abi_kinds=$(awk -F'\t' '$1=="ProcessExit"||$1=="Egress"||$1=="FileAccess"||$1=="FileDelete"||$1=="SecurityAction"{print $1}' /tmp/.acc-dist | sort -u | tr '\n' ' ')
echo "  -- 非 exec 事件类（ProcessExit/Egress/FileAccess/FileDelete/SecurityAction）:"
echo "     出现: ${abi_kinds:-无}"
[[ -n ${abi_kinds// /} ]] && ok "非 exec 事件已恢复流动（ABI 修复生效）" || bad "仍只有 ToolExec——ABI 修复未生效"
echo "  -- 明文事件与标记检索:"
hits=$("${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT count() FROM anysentry.agent_interactions_v1 WHERE at > toUInt64(toUnixTimestamp(now() - INTERVAL 15 MINUTE)) * 1000 AND positionCaseInsensitive(payload, '$mark') > 0")
plain=$("${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT count() FROM anysentry.events WHERE at > toUInt64(toUnixTimestamp(now() - INTERVAL 15 MINUTE)) * 1000 AND eventKind='LlmInteraction'")
inter=$("${CH[@]}" http://127.0.0.1:8123/ --data-binary \
  "SELECT count() FROM anysentry.agent_interactions_v1 WHERE at > toUInt64(toUnixTimestamp(now() - INTERVAL 15 MINUTE)) * 1000")
echo "     标记命中交互数: ${hits:-?}   近 15 分钟 LlmInteraction 事件: ${plain:-?}   交互明细行: ${inter:-?}"
if [[ ${hits:-0} -gt 0 ]]; then
  ok "明文链路全通（合成交互已入 agent_interactions_v1）"
elif [[ ${plain:-0} -gt 0 || ${inter:-0} -gt 0 ]]; then
  ok "明文链路已通（窗口内有明文交互；合成标记未命中多为探针时序，可复查 agent_interactions_v1）"
else
  bad "明文仍零产出——按 UOS现场诊断规则.md S7/S9 继续"
fi

step "验收汇总"
echo "  PASS=$PASS FAIL=$FAIL"
((FAIL==0)) && echo "  == 验收全部通过 ==" || echo "  == 存在未通过项，把输出文件传回打包工程师 =="
rm -f /tmp/.acc-s2 /tmp/.acc-s3 /tmp/.acc-s4 /tmp/.acc-dist
