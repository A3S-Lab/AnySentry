# UOS 20 ARM64 现场诊断规则（AnySentry）

> 本规则约束所有在客户机器 `xc-v-ct-dsjzx-map-app-56`（UnionTech UOS Server 20 ARM64）上的
> 排查动作。**任何会话接手现场时：先跑 `FIELD_DIAGNOSTIC.sh`（S0-S8 一次出全量），
> 再按所在阶段读对应小节。不要跳步，不要试错。** 本文件随包分发。

---

## 1. 铁律（不可违背）

1. **只读优先**：现场脚本一律只读。已授权的例外只有：审核 PUT（/security-center/agents/*/review）、
   合成 HTTP 探测（容器间/到 tarpit）、以及明确告知用户的临时开关（bpf_stats_enabled、tracefs 探针，
   用完必须恢复）。
2. **客户容器不可动**：不停、不重启、不 `docker exec` 写文件。`docker exec`/`nsenter -t <pid> -n` 的
   只读观测（ss、env、cat）是安全的，不会中断服务（它只是在容器里多开一个进程）。
3. **端口禁区**：9000/8000/8001/7998/7999/17862/8080 属客户业务；AnySentry 只用 29653（API）等自有端口。
   临时监听端口（tarpit 等）用 18099 这类高位冷门端口，用完即关。
4. **版本钉死**：`@a3s-lab/code=8.6.0`、`@a3s-lab/sentry=0.3.0`、BPF 内核代号 `0x0004135a`。升 compat
   号时这三个不许动。
5. **结果回传**：现场输出 tee 成 txt 原样传回，不删减、不截图。

## 2. 目标机器基线档案（2026-10 实测；接手时先跑 S0 复核）

| 项 | 值 | 复核命令 |
|---|---|---|
| 内核 | `4.19.90-2211.5.0.0178.57`（BPF 代号 0x0004135a） | `uname -r` |
| 架构/glibc | aarch64 / **glibc 2.28.15** | `uname -m`、`ldd --version` |
| 页大小 | **65536**（64K 页） | `getconf PAGE_SIZE` |
| cgroup | **hybrid**：cgroup2 挂在 `/sys/fs/cgroup/unified`（不是 /sys/fs/cgroup！） | `awk '$3=="cgroup2"{print $2}' /proc/mounts` |
| 能力 | root CapEff 全量；systemd 部署（非 k3s） | `grep CapEff /proc/self/status` |
| 内核缺失项 | **无** `kernel.bpf_stats_enabled`、**无** tracefs/kprobe_events、**无** bpftool | `sysctl -n kernel.bpf_stats_enabled` |
| 磁盘 | `/` 43G（紧）、`/data` 196G（Docker 数据在此，曾打满） | `df -h / /data` |
| machine-id | `8ce32b4b91b54790bda851fb55ff9f16` | `cat /etc/machine-id` |

**容器清单**（deploy_default 网桥 172.18.0.x）：

| 容器 | IP | 端口 | 角色 |
|---|---|---|---|
| ai-agent | 172.18.0.5 | 8000→8000 | Agent 主服务（python） |
| ai-agent-skill | 172.18.0.3 | 8001→8000 | Agent 技能服务（python） |
| ai-ai-java | 172.18.0.2 | 9000 | 业务后端（java） |
| ai-rag-server | 172.18.0.4 | 17862 | RAG 服务 |
| gdss-main / gdss-rabbit-http-bridge | **host 网络** | — | 集群数据/模型中转（**不是 Agent 资产**） |
| cadvisor | 172.17.0.2 | 8080 | 监控 |

**集群端点**（LLM/数据流量实际去向，全部在集群别机）：`172.22.17.201:5672`(RabbitMQ)、`:8888`、
`:18895`、`172.22.17.198:6379`(Redis)、`:9876`、`:10909`、`172.22.17.206:5236`(达梦库)、
`172.22.17.219:19530`(Milvus)、`172.22.17.189:10011`、`10.89.4.42:28088`。
**LLM 调用不从 agent 容器直连公网**；判定具体哪条腿走 S7 明文合成实验 + 业务窗口观测。

## 3. 分阶段诊断模型（判定树）

每一层 FAIL 时**先修该层再往下**。层间顺序即因果顺序。

| 阶段 | 内容 | 通过标准 | FAIL 定位方向 |
|---|---|---|---|
| **S0** | 机器基线档案复核 | 与第 2 节一致 | 换机器/换内核=全部重新评估 |
| **S1** | 服务存活 | 14 单元全 active；collector+forwarder 双进程在；CH 有新鲜事件 | 单元停了直接 start；**observer 停过会擦 /run/anysentry-filter（白名单文件消失）** |
| **S2** | 探针挂载 | journal `legacy probe attached` 去重 =14；健康 JSON attachedProbes=14 | 少了就查 journal 里 `legacy probe load failed` 的验证器日志 |
| **S3** | 审核与投影 | `identity/snapshot` reviewVersion≥1 且 confirmed 条目同时含两容器键 | 审核 PUT 400（assetId 与 workspace 不符）→ 去掉 agentAssetId 重试；容器行消失说明审核被置 unknown |
| **S4** | 白名单发布 | `/run/anysentry-filter/tls-agent-cgroups.json` 存在且条目 = 容器当前 cgroup inode | inode 用 `stat -c %i <cgroup2挂载点>/<proc的0::路径>` 现算；**容器重建会换 inode，属正常** |
| **S5** | 准入同步 | journal 有新鲜 `cgroup scopes reconciled cgroups=N pids=M`（N=白名单条数） | 无日志=明文开关没开（单元要 `A3S_OBSERVER_PLAINTEXT_HTTP=1`，**不要设 A3S_OBSERVER_SSL**） |
| **S6** | 采集产出 | CH 各类型事件持续入库；明文计数为目标指标 | 常规事件断流→Kafka/Flink 链路；仅明文为零→S7 |
| **S7** | 明文合成实验 | tarpit 慢动作（见第 5 节方法）后 CH 出现 tcp_plaintext 事件 | 不出→S9 内核取证；出了但业务没有→业务那条腿不是 HTTP 明文 |
| **S8** | 归因抽查 | 最近事件 agentId 归属正确 | 归因错乱查 workload-filter（cgroupId='0' 共享键已有防护） |
| **S9** | 内核取证 | bpf-inspect：程序 map_ids 引用正确、READ_ARGS 暂存随流量涨落、DROPS 不涨 | 引用错=重定位 bug；不触发=符号/内核兼容；详见交接文档 |

## 4. 方法论铁律（本次用十几个来回换来的，务必遵守）

1. **准入是 2 秒扫描制**：collector 每 2s 才把白名单 cgroup 解析成 pid。**短命测试进程会死在缝隙里**——
   测试进程必须先 sleep 8s 再发流量，并用 reconcile 日志 `pids=N` 上涨来自证被准入。
2. **python 带 timeout 的 socket 是非阻塞的**：recv 变成轮询，内核态暂存只活微秒。**观测实验用
   无超时的真阻塞 socket**（tarpit 慢动作法：服务端睡 12-15s，客户端 recv 阻塞全程可见）。
3. **宿主机 ss 看不见容器桥内直连**（netns 隔离）。要看容器内连接用 `nsenter -t <pid1> -n ss -tanp`。
   docker-proxy 转发腿会暴露在宿主 netns（这就是为什么发布端口的流量可见）。
4. **events 表是 Agent 安全视图，不是全机流水**：Egress/明文等只保留归因到 Agent 的；未归因事件被
   策略丢弃（`outputDropped` 就是这个计数，**它的波动是噪音水位，不是故障**）。
5. **诊断脚本自己会污染现场**：每秒循环调 docker top/ss/awk 会产生大量 ProcessExit/ToolExec 事件
   和 outputDropped——分析入库暴涨时先排除自己的脚本。
6. **docker exec 有双 pid 陷阱**：`docker exec` 在宿主机上有一个 CLI 代理进程，容器内才是真目标；
   pgrep -f 会先匹配到代理。核对 pid 用 bpf-inspect 的 ALLOWED_PID 或对进程组关系。
7. **observer 服务停止 = 白名单文件消失**（systemd 擦 RuntimeDirectory）；reconcile 日志停更 ≠ 服务死
   （reconcile 只在变化时打日志），用 S1 的 ps + CH 新鲜度判定。
8. **审核 PUT 的 400 处理**：带 agentAssetId 且与记录 workspace 不符会 400；去掉 agentAssetId 让服务端
   按身份键推导即可。**审核会覆盖同一 (agentId,workspace) 记录的键集合**——多容器必须并集键一次提交。
9. **HTTP 明文采集的方向语义**：采的是"Agent 作为 HTTP 客户端的出向腿"（write=请求车道、read=响应车道）。
   入向 curl 探针（打 8000/8001）方向相反，永远不出事件——这是设计，不是故障。
10. **glibc/页大小钉死**：所有现场二进制必须 aarch64/glibc-2.28/64K 页构建（打包机 zig cc 工具链），
    不要用开发机（glibc 2.39）的产物。

## 5. S7 明文合成实验（tarpit 慢动作法，标准做法）

1. 宿主机起 tarpit：`python3` 监听 18099，接连接 → 收请求 → **睡 12-15s** → 回 `HTTP/1.1 200` → 关。
2. ai-agent 容器内客户端：**睡 8s（过准入扫描）**→ connect 宿主机 IP:18099 → `sendall(带标记 HTTP)` →
   **无超时 recv 阻塞**（ tarpit 应答前全程在内核里睡着，READ_ARGS 暂存条目全程可见）。
3. 观测三件套（同时进行）：bpf-inspect 看 READ_ARGS 条目出现/消失；CH 查 tcp_plaintext 计数与标记串。
4. 判定：暂存出现+消失+CH 出事件=全通；出现+消失+CH 无=用户态/入库丢；出现+残留=kretprobe 坏；
   不出现=进入侧没触发（先核对客户端 pid 在 ALLOWED_PID 里）。

## 6. 工具箱

- **`FIELD_DIAGNOSTIC.sh`**（随包）：S0-S8 一次跑完，默认纯只读，`--with-http` 加跑 S7。
- **`bpf-inspect`**（随包 diagnostics 建议位）：自研静态 arm64 工具，直读 bpf() 枚举程序 run_cnt、
  程序引用的 map id 列表、PLAINTEXT_ALLOW 的 pid 键、READ_ARGS 暂存、DROPS。源码 `bpf-inspect.c`，
  构建：`zig cc -target aarch64-linux-musl -static -O2 -s -o bpf-inspect bpf-inspect.c`。
- **nsenter 读容器网络**：`nsenter -t $(docker inspect -f '{{.State.Pid}}' <容器>) -n ss -tanp`。
- **ClickHouse 直查**（凭据在 /etc/anysentry/anysentry.env 的 CLICKHOUSE_USER/PASSWORD）：
  ```bash
  curl -sS --user "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" http://127.0.0.1:8123/ --data-binary \
    "SELECT eventKind, count() FROM anysentry.events WHERE at > toUInt64(toUnixTimestamp(now() - INTERVAL 10 MINUTE)) * 1000 GROUP BY eventKind FORMAT TSV"
  ```
  明文事件：`WHERE source IN ('tcp_plaintext','tls_uprobe')`；时间列 `at` 是毫秒。
- **审核 PUT**（管理头 x-anysentry-admin-token，令牌在同 env 文件）：
  `PUT /security-center/agents/office-agent/review`，body 带并集 identityKeys、不带 agentAssetId。
- **现场状态打包**：`/opt/anysentry/collect-support-bundle.sh`（只读，脱敏）。

## 7. 交接与会话恢复

- 打包工作区：`~/.config/superpowers/worktrees/AnySentry/uos20-arm64-0.4.0`（分支 integration/uos20-arm64-0.4.0），
  Observer 同名 worktree。**不许动开发检出**、不推远程。
- 给开发的交接文档走开发检出 `docs/` 目录的 untracked 文件（不混入提交）。
- 打包手册：工作树根 `UOS20_ARM64_DEPLOYMENT_REVIEW.md`（每个 compat 版本的变更与验收都在表里）。
