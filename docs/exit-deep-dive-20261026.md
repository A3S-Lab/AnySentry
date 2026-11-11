# ProcessExit 单次缺失深入排查与修复

日期：2026-10-26。本文区分已证实原因、修复效果和仍未关闭的边界，不把数量改善写成全量修复。

## 原因证据

对首轮 PID 446982 的 `git diff --stat`，AnySentry 有 exec、AgentSight 有 exit，而 AnySentry 未找到 exit。为定位层级，使用独立 fork/wait 真值、同版原始 Collector NDJSON 和 AnySentry ClickHouse 做分层对比：

- 原始 Collector 能输出完整 exit，说明内核与 Collector 不是主要断点。
- 500 个 Bash 父子树产生 1000 个 exit 时，早期 AnySentry 只保留 807 个，证明损失发生在 Forwarder/API 路径。
- 原始顺序重放显示，exec 参数组装与 exit 存在乱序；部分第一种 Git 命令到达时父归属尚未建立，unknown 在 Agent 白名单处被过滤，后续兄弟命令更容易保留。
- 不能仅凭历史计数把单次缺失归因于 ring。对应窗口 exit ring 增量为 0。

曾验证“fallback 覆盖 fork 创建父关系”和“有界延迟归属”两条路径，但它们会引入错误归属或高并发队列问题，未作为最终修复保留。后几轮只按 PID 扩展范围还受到 PID 复用污染，相关扩大统计已作废；最终验收使用原始文件行号窗口。

## 最终实现

当前镜像：`anysentry-observer-wrapper:exec-compact-c20-20261026`。

- 保留 A/B 的完整 `start_boottime` 身份、父子代际和显式时间来源。
- `ProcessExit`、ToolExec、CollectorHeartbeat 分别使用独立有界输出通道，普通文件/网络洪峰不再直接挤占生命周期事件。
- HEADER/END/COMMIT 使用独立 512 KiB 控制 ring；ARG_CHUNK 与 compact 使用原参数 ring，按分片类型计数。
- 短命令最多 8 个参数、每个最多 15 字符时使用 compact 固定槽位，减少内核记录数；其他命令保留原分片与 `/proc` 补齐路径。
- 三类生命周期 ring 的轮询间隔由 20ms 降为 1ms，避免生产高峰下消费窗口溢出。
- WAL 重放保留评测 cgroup 和 unresolved exit 豁免，不再被 Agent 白名单二次过滤；评测 cgroup 内 non_agent 也按明确范围保留。
- ToolExec 去重按 confirmed、argv 完整度优先，避免旧的不完整重复记录覆盖完整记录。
- unknown `ProcessExit` 仅在显式配置非零 `ANYSENTRY_UNRESOLVED_EXIT_LIMIT` 后保留；默认 0 为关闭，不伪造 Agent 或 Session。
- 诊断包含分片丢弃、用户态分类丢弃、逐事件 classification 和实际 WAL 未确认状态。
- 精确代际匹配的 unknown 父链不受 negative TTL 过期影响；遍历缓存父级时重新评估其运行时签名，避免父进程退出后因果链永久停留在 unknown。代际不匹配仍保持 unresolved，不做全局放行。

## 高并发验收

C20 使用 64 并发执行 500 个 Bash 树，每个 Bash 并发启动两个 Git 子进程。fork/wait 真值覆盖全部 1500 个 PID；生产 Observer 与独立原始 Collector 同时观测，随后按 sourceEventId、进程身份和入库窗口核对 ClickHouse。

| 核对项 | 结果 |
| --- | ---: |
| 原始 confirmed exec | 1500 / 1500 |
| 原始 ProcessExit | 1500 / 1500 |
| ClickHouse confirmed exec | 1500 / 1500 |
| ClickHouse ProcessExit | 1500 / 1500 |
| argv、退出码、来源和捕获字节数不一致 | 0 |
| 缺 ProcessInstanceKey | 0 |

生产 Observer 最新心跳的内核与输出丢弃均为 0。未将启动窗口、错误 cgroup、容器 PID 命名空间或展示截断造成的无效对照计入缺陷。`argv` 的 ClickHouse 展示保留 300 字符上限，内容验收同时核对参数个数、原始捕获字节数和 incomplete 标记。

证据：`experiments/20261026-exit-deep-dive/exec-c20-e2e-result.json`。

### C3 基线

C3 使用 32 并发执行 500 个 Bash 树。每个 Bash 并发启动两个 Git 子进程，fork/wait 独立收据覆盖全部 1500 个 PID；本轮原始 NDJSON 严格按行号限定窗口，不做全文件 PID 闭包扩展。

| 核对项 | 结果 |
| --- | ---: |
| 独立 fork/wait 真值 | 1500 |
| 原始 Collector exit | 1500 / 1500 |
| ClickHouse exit | 1500 / 1500 |
| 退出码不一致 | 0 |
| 缺完整进程身份 | 0 |
| ClickHouse 缺 ProcessInstanceKey | 0 |
| 本轮 exit ring 丢弃增量 | 0 |

本轮仍有普通事件输出丢弃，exec ring 全局计数由 456 增至 1019；exit 独立通道下目标终态仍全部保留。不能把普通 exec 的丢弃量算作 exit 丢失，也不能据此宣称 exec 已完整。压力脚本新增可选 `--record-tree` 收据；不传时保留原工作负载。

证据：`experiments/20261026-exit-deep-dive/high-concurrency-{truth,raw-result,clickhouse-result,clickhouse-content-result}.json`。

## S1 验收

C3 三任务并发回归中，exit 为 fix-git 43/44、db-wal 50/51、polyglot 41/41；AgentSight 多出的三条都是启动门控 sleep，排除后 **134/134 对齐**，四项代际检查均为 0。三项准备 sleep 及一条 Hook exec 的差异不属于 exit 缺口。

本轮 fix-git、polyglot 的 reward 为 1.0；db-wal 首轮为 0.0。失败日志显示 Agent 直接打开 SQLite 后加密 WAL 被删除，随后猜测值而未应用 `id=1 value=150`；这是解题行为失败，不能记为采集回归。首轮工件已保留。

db-wal 独立复测 reward 为 **1.0**，exit 为 36/38，差异仍是两条启动门控 sleep，排除后 **36/36 对齐**，四项代际检查均为 0。至此三项任务均有通过的 S1 结果，本轮创建的全部 recorder 已停止。

证据：`terminal-bench/eval/s1-high-concurrency-20261026-160601/`，复测位于其 `wal-retry/` 子目录。

### 缓存父级身份修复复测

重新部署归属逻辑后，polyglot 官方 reward 为 **1.0**。AnySentry 27 条 confirmed exec 与 AgentSight 的 27 条实际任务 exec 对齐；AgentSight 另有两条评测准备 sleep 和一条 Langfuse Hook。exit 为 **29/29，全部对齐**。缺 `start_boottime_ns`、缺 ProcessInstanceKey、代际冲突和创建父代际不一致均为 0。本轮没有重复执行前一轮的三条具体命令，因此该结果证明本轮实际执行路径无任务 exec 缺失；缓存签名提升和错误代际拒绝另由确定性回归覆盖。

证据：`terminal-bench/eval/s1-cached-signature-20261026-203118/`，包括 `kernel-summary.json`、`process-differences.json` 和逐事件 evidence。

### 前一轮 C2 基线

C2 首轮三个任务并发执行，官方 reward 均为 1.0：

| 任务 | exec：AnySentry / AgentSight | exit：AnySentry / AgentSight |
| --- | ---: | ---: |
| fix-git | 53 / 56 | 46 / 47 |
| db-wal-recovery | 32 / 34 | 30 / 31 |
| polyglot-c-py | 85 / 86 | 84 / 84 |
| 合计 | 170 / 176 | 160 / 162 |

- exit 的两条差异均为评测准备 sleep；排除后为 **160 / 160，全部对齐**。
- 三项缺 `start_boottime_ns`、缺 ProcessInstanceKey、代际冲突和创建父代际不一致均为 0。
- exec 差异中有 5 条准备 sleep，另有 1 条真实 `git status --short --branch` 未在 AnySentry 找到。**exit 修复不等于 exec 已完整。**

证据：`experiments/20261026-exit-deep-dive/process-differences.json`、`experiments/20261026-exit-deep-dive/kernel-summary.json`。

## 未关闭边界

高并发下的目标 exec 与 ProcessExit 均已通过完整进程树验证。这里的 1500/1500 只代表上述已执行场景，不是任意并发强度下的绝对完整性保证；ring 丢弃只提供分类型区间计数，不能充当全局逐事件完整性的证明。Observer ingest 回归在管理鉴权 401 处停止，不能记为全套通过。
