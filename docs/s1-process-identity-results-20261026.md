# 进程身份修复 A/B 与 S1 验收

日期：2026-10-26。本文分别记录代码、独立用例和 S1 实测状态，不以构建成功代替缺陷验收。

## 实施边界

- A：内核 `group_leader->start_boottime` 纳秒代际、fork 创建父关系与 exec/exit 观察父关系分离、COMMIT comm、Collector 与 API 代际兼容。
- B：显式评测 cgroup 范围内的 unknown 生命周期保留；默认未配置、未扩大产品采集范围；有界用户态诊断与按类型 ring 丢弃计数。
- 未增加 ring 容量，未加入通用待归属缓冲，未全局放行 unknown。
- 新内核事件以 `startTimeSource=kernel_start_boottime` 选择 ns 身份；历史事件保留原 ticks 优先算法。

目标机为 Linux 6.17，BTF 可用，`USER_HZ=100`。BTF 运行时偏移为 `group_leader=2768`、`real_parent=2720`、`start_boottime=3056`、`pid=2704`；字段不可用时显式降级，不替换为其他时间语义。

## A：独立与部署验收

| 检查 | 独立 Collector NDJSON | 真实 AnySentry 链路 |
| --- | ---: | ---: |
| 范围内 PID | 19 | 19 |
| 成功 exec（同 PID 可多次） | 22 | 22 |
| 最终 exit | 19 | 19 |
| 缺 exit 的已观察 PID | 0 | 0 |
| 缺 `start_boottime_ns` | 0 | 0 |
| 父代际不一致 | 0 | 0 |
| ProcessInstanceKey 冲突 | 0 | 0 |

两轮 `gcc -> cc1/as/collect2 -> ld` 均完整；同一 PID 连续 exec 为 `bash -> bash -> echo`，代际不变。fork/wait 退出码一致，ticks 与目标 USER_HZ 转换一致。PID 复用仅完成模拟回归，未声称实机触发。

证据：

- `experiments/20261026-process-identity/a-independent-summary.json`
- `experiments/20261026-process-identity/a-deployed-summary.json`
- `Observer/scripts/verify-process-identity-live.py`
- `Observer/scripts/analyze-process-identity-live.py`

## B：保留与诊断验收

- Observer 工作区 88 项测试通过，eBPF release 构建通过。
- API 构建、Observer ingest 本地验证通过。
- 诊断不保存 argv 或交互正文；普通、已接纳生命周期、被过滤生命周期分栏限容，避免过滤噪声覆盖 queue/write 收据。
- 显式评测 cgroup 的 unknown exit 可保留并标记 `ancestry_incomplete`；非目标 cgroup 仍按原白名单过滤。
- 用户态可核对 filtered、queue_admitted、ingest_accepted/rejected/retry 等结果。
- ring 只提供按类型累计计数，不能为未输出的 PID 伪造逐事件收据。

证据：`experiments/20261026-process-identity/b-validation-summary.json`。

## S1 首轮：三个任务并发

Kimi Code 2.2.0，`kimi-code/k3-256k`，三个任务同窗口运行，AnySentry 与 AgentSight 观测同一次执行。三项官方 reward 均为 1.0。

| 任务 | exec：AnySentry / AgentSight | exit：AnySentry / AgentSight |
| --- | ---: | ---: |
| fix-git | 79 / 81 | 62 / 63 |
| db-wal-recovery | 36 / 39 | 34 / 36 |
| polyglot-c-py | 32 / 34 | 32 / 33 |
| 合计 | 147 / 154 | 128 / 132 |

- exec 的 7 条差异全部是启动准备 `sleep 1`，排除后为 **147 / 147**。
- db-wal 的 exit 差异为 2 条准备 sleep，polyglot 为 1 条准备 sleep。
- fix-git 的 `git diff --stat`（PID 446982）有双方 exec 和 AgentSight exit，但 AnySentry 未找到 exit。这是实际任务事件，不能归为准备噪声或 Git 自动维护。
- 排除 3 条准备 exit 后为 **128 / 129**，仍有上述 1 条实际任务退出缺口。
- 三项均无缺 `start_boottime_ns`、缺 ProcessInstanceKey、代际冲突或创建父代际不一致。
- 本轮原始 Collector 心跳中 exit ring 增量为 0，不能把该缺失直接解释为 ring 丢弃。

首轮统计与逐 PID 输出：`experiments/20261026-s1-identity-ab/`；原始工件：`terminal-bench/eval/s1-identity-ab-20261026-130140/`。

## 剩余缺口与复测

fix-git 单独复测完成，官方 reward 为 1.0：

- exec 为 62 / 64，差异仅为 2 条准备 sleep；
- exit 为 52 / 53，差异仅为 1 条准备 sleep；
- 非准备 exec、exit 全部对齐，缺 ns、缺 ProcessInstanceKey、代际冲突和创建父代际不一致均为 0；
- 首轮 PID 446982 的单次 exit 缺失未复现。

**结论：主要身份与真实任务生命周期缺陷已修复，并通过独立用例和 S1 复测。首轮仍保留一条未复现的单次缺失记录，因此不宣称任意负载下 100% 无事件丢失，也不把数量一致解释为所有采集层都有完整真值。** 复测明细：`experiments/20261026-s1-identity-ab/fix-retry-differences.json`。

## 既有非本次回归

`verify-s2-persistence-canonical.mjs` 的旧哈希断言在未修改 HEAD 基线上也以相同实际值失败，不是本次 ns/ticks 改动引入。该既有失败不用于抵扣本次验收。
