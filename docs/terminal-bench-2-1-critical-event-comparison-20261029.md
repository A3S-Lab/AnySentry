# AnySentry 与 AgentSight 的 Terminal-Bench 2.1 进程证据完整性对照研究

日期：2026-10-29

## 1. 核心结果：全部事件与关键事件对照

下表依次列出全部 exec/exit、关键 exec/exit、相对结论和原因。总量用于观察采集范围，关键事件用于判断任务证据是否完整。

| 实验 | 任务/实例 | AnySentry 全部 exec / exit | AgentSight 全部 exec / exit | AnySentry 关键 exec / exit | AgentSight 关键 exec / exit | 谁更好 | 更好的原因 |
|---|---|---:|---:|---:|---:|---|---|
| 单任务 | `fix-git` | 70 / 68 | 69 / 56 | 14 Git exec | 21 Git exec | **AgentSight** | AgentSight 保留了更多真实 Git exec；AnySentry 在低负载下也出现漏采，因此该样本是重要反例。 |
| 单任务 | `db-wal-recovery` | **47 / 42** | 16 / 12 | **9 / 9** | 3 / 3 | **AnySentry** | 它完整保留 WAL 检查、备份、SQLite/Python 恢复和校验链；AgentSight 只留下部分检查进程。 |
| 单任务 | `polyglot-c-py` | **38 / 36** | 32 / 30 | 9 / 9 | 9 / 9 | **双方持平** | 双方都完整记录 9 组 `cmain` exec 和 exit，低负载下没有关键事件差异。 |
| S2-G | `fix-git` A | **101 / 86** | 74 / 57 | **28 / 28** | 27 / 24 | **AnySentry** | AgentSight 缺少 `git diff --exit-code` 及多条 Git exit，导致 Git 验证过程不完整。 |
| S2-G | `fix-git` B | **70 / 62** | 39 / 30 | **17 / 17** | 14 / 12 | **AnySentry** | AgentSight 缺少 `git status`、`git log`、`git maintenance` 及对应 exit。 |
| S2-G | 合计 | **171 / 148** | 113 / 87 | **45 / 45** | 41 / 36 | **AnySentry** | 它完整保留 Git 排查、合并和验证行为链，AgentSight 的关键 exec 和 exit 均有缺口。 |
| S2-P | `polyglot-c-py` B | **62 / 59** | 33 / 31 | 7 / 7 | 7 / 7 | **双方持平** | 7 组答案验证程序及退出码均完整。 |
| S2-P | `polyglot-c-py` C | **54 / 50** | 26 / 25 | 5 / 5 | 5 / 5 | **双方持平** | 5 组答案验证程序及退出码均完整。 |
| S2-P | `polyglot-c-py` D | **65 / 61** | 33 / 30 | **9 / 9** | 6 / 6 | **AnySentry** | AgentSight 缺少 `cmain 94`、`100`、`500` 及测试循环最终 exit 0，无法完整证明全部验证已经执行并成功结束。 |
| S2-P | 合计 | **181 / 170** | 92 / 86 | **21 / 21** | 18 / 18 | **AnySentry** | 它保留全部 21 组 `cmain` 及退出码；优势主要来自 D，并不意味着每个实例都领先。 |
| S2-D | `db-wal-recovery` A | **47 / 43** | 40 / 36 | 7 / 7 | 7 / 7 | **双方持平** | 关键恢复事件完整；A 为 verifier timeout，仅作采集证据。 |
| S2-D | `db-wal-recovery` B | **47 / 42** | 41 / 36 | **15 / 15** | 15 / 14 | **AnySentry** | AgentSight 虽有恢复命令 exec，但缺少恢复 Bash 最终 exit 0，不能完整证明恢复阶段成功结束。 |
| S2-D | `db-wal-recovery` C | **41 / 36** | 28 / 26 | **10 / 10** | 8 / 8 | **AnySentry** | AgentSight 缺少两个 Python 恢复/校验进程的 exec 和 exit 0。 |
| S2-D | `db-wal-recovery` D | **41 / 37** | 31 / 26 | **8 / 8** | 6 / 6 | **AnySentry** | AgentSight 缺少 `stat` 和一个 Python 校验进程的 exec/exit；D 为 verifier timeout，仅作采集证据。 |
| S2-D | 合计 | **176 / 158** | 140 / 124 | **40 / 40** | 36 / 35 | **AnySentry** | 它同时保留“开始恢复”和“恢复/校验成功结束”的证据，AgentSight 的恢复链存在进程和完成状态缺口。 |

### 1.1 关键事件覆盖率

以本轮实际发生的关键事件为参照：

- S2-G Git：AnySentry 为 **45/45 exec、45/45 exit**；AgentSight 为 41/45、36/45。
- S2-P `cmain`：AnySentry 为 **21/21、21/21**；AgentSight 为 18/21、18/21。
- S2-D 数据库恢复：AnySentry 为 **40/40、40/40**；AgentSight 为 36/40、35/40，即 90% exec、87.5% exit。

这些比例是特定实验窗口内的相对覆盖率，不是对全部 Terminal-Bench 任务或全部内核事件的总体估计。

## 2. 实验设置与评价原则

本研究比较两套系统在真实 Agent 任务中的进程执行、退出及关键事件覆盖能力，重点回答：关键进程是否保留、退出及退出码是否完整、原始采集与正式链路是否一致。

所有任务均来自 Terminal-Bench 2.1。AnySentry 与 AgentSight 同时观测同一次任务执行，并在主要实验中增加独立原始 Collector 和 Kimi 原生工具轨迹作为参照。

| 场景 | 任务与内容 | 并发设置 | 主要目的 |
|---|---|---|---|
| 单任务基线 | `fix-git`、`db-wal-recovery`、`polyglot-c-py` | 每次一个任务 | 排除高并发，检查基本覆盖和反例 |
| S1：异任务并发 | 上述三个不同任务 | 3 个容器同时运行 | 检查混合负载下的观测范围 |
| S2-G：同题 Git | `fix-git × 2` | 同题、同工作区路径、不同容器 | 检查短命 Git 进程及同 PID 多代 exec |
| S2-P：编译测试 | `polyglot-c-py × 4` | 4 个实例同时运行；3 个有效样本 | 检查编译、文件活动和集中退出 |
| S2-D：数据库恢复 | `db-wal-recovery × 4` | 4 个实例同时运行 | 检查恢复与校验事件及尾 exit |
| S3 候选：混合任务 | `configure-git-webserver`、`crack-7z-hash`、`polyglot-c-py` | 3 个容器同时运行 | 检查后台服务、破解链、编译测试及正式链路 |

### 2.1 指标定义

- **exec**：内核成功加载程序执行。一次 Agent 工具调用可以产生多条 exec；同一 PID 也可以通过多次 exec 更换程序。
- **exit**：进程结束。exit 与退出码用于判断进程是否完成以及完成状态。
- **关键 exec/exit**：直接参与任务恢复、修改、编译、验证或后台服务启动的生命周期事件，不包括 `sleep`、启动门控、普通 Hook 和准备事件。
- **原始覆盖**：独立 Collector 输出与产品数据库之间的逐事件对账结果。
- **正式链路覆盖**：AnySentry 的 Collector → Forwarder → API → ClickHouse，或 AgentSight 的 process JSON → SQLite 视图中的实际可用证据。

官方 reward 仅用于说明任务是否完成，不作为采集完整性的替代指标。事件数量是描述性指标，不等同于无偏的内核采集率；只有具备原始 Collector、原生工具轨迹或预定义关键行为参照时，才计算相对覆盖率。

## 3. 总事件数量：作为辅助而非核心证据

### 3.1 S1 异任务并发

三个任务官方 reward 均为 1.0。

| 任务 | AnySentry exec / exit | AgentSight exec / exit | 谁更好 | 更好的原因 |
|---|---:|---:|---|---|
| `fix-git` | **75 / 62** | 58 / 46 | **AnySentry 数量更多，但不构成关键事件优势** | 主要差异不是关键 Git 行为。 |
| `db-wal-recovery` | **62 / 58** | 45 / 42 | **AnySentry 数量更多，但需保留解释** | 总量差包含启动和准备事件，不能直接视为恢复事件更完整。 |
| `polyglot-c-py` | **47 / 45** | 31 / 30 | **AnySentry 数量更多，但不是核心证据** | 差异主要来自 `sleep`、门控和准备事件。 |
| 合计 | **184 / 165** | 134 / 118 | **AnySentry 观测范围更广** | 该表只说明总量覆盖，不作为关键任务完整性的核心证明。 |

### 3.2 S2 同题并发总量

| 实验 | AnySentry exec / exit | AgentSight exec / exit | 谁更好 | 更好的原因 |
|---|---:|---:|---|---|
| `fix-git × 2` | **171 / 148** | 113 / 87 | **AnySentry** | 排除准备事件后，Git 关键 exec/exit 差异仍然存在。 |
| `polyglot-c-py × 4`，3 个有效实例 | **181 / 170** | 92 / 86 | **AnySentry** | 总量差与 D 实例的关键验证缺失同时存在；B/C 的关键事件则持平。 |
| `db-wal-recovery × 4` | **176 / 158** | 140 / 124 | **AnySentry** | 关键恢复/校验事件为 40/40 对 36/35，总量差并非唯一依据。 |

## 4. S3 候选实验：原始采集与正式链路必须分开

三个任务官方 reward 均为 1.0，但实际 Agent 执行时间分别约为 163.0 秒、248.6 秒和 59.7 秒，三路共同重叠约 59.7 秒。因此，该实验只能称为短时混合并发，不能称为 40 分钟长程 S3。

| 任务 | AnySentry 原始全部 exec / exit | AgentSight 全部 exec / exit | AnySentry 原始关键事件 | AgentSight 关键事件 | AnySentry 正式关键事件 | 谁更好 | 更好的原因 |
|---|---:|---:|---:|---:|---:|---|---|
| `configure-git-webserver` | **446 / 447** | 278 / 264 | **12 exec / 11 exit** | 11 exec / 10 exit | **0 / 0** | **AnySentry 原始层更好，正式链路未通过** | 原始层记录了 AgentSight 漏掉的 nginx daemon；Git/curl 和 `nginx -t` 双方均有。关键事件为 11 个 Git/curl 加 1 个 nginx。 |
| `crack-7z-hash` | **95 / 88** | 66 / 58 | **3 / 3 关键环节** | 3 / 3 关键环节 | **0 / 0** | **关键事件双方持平，AnySentry 原始总量更多但正式链路未通过** | 双方都完整覆盖 `7z2john`、John 和 `7z x` 三个环节，只是包装 exec 形式不同，因此不强行比较包装层 exec 数量。 |
| `polyglot-c-py` | **38 / 37** | 31 / 28 | **7 / 7** | 7 / 7 | **0 / 0** | **关键事件双方持平，AnySentry 原始总量更多但正式链路未通过** | 双方都保留 7 组 `cmain` exec 和 exit 0。 |

AnySentry 原始 Collector 在三项任务中均记录了更多生命周期事件，但正式链路同窗口没有 ToolExec。诊断显示：

- Forwarder 曾将大量 ToolExec 按 `agent_allowlist` 过滤；
- Forwarder 同时出现批次拒绝；
- API 出现 request aborted；
- 因而不能用原始 Collector 数据替代正式产品结果。

本轮的正确结论是：**AnySentry 原始采集具有优势，但正式产品链路未通过验收。**

## 5. 机制分析

### 5.1 AgentSight 的潜在丢点

代码审查确认以下风险：

1. **共享 ring 容量与背压。** exec、exit 和文件事件共享 1 MiB ring；`struct event` 实测约 4,440 字节，容量容易受到文件事件洪峰影响。
2. **生命周期静默丢弃。** exec/exit 在 `bpf_ringbuf_reserve` 失败时直接返回，缺少对应 drop 计数。
3. **严格父子跟踪。** parent 尚未 tracked 时 child exec 可能被过滤；PID 尚未 tracked 时 exit 也可能被过滤。

这些机制与 S2 中编译、Git 和数据库短进程的集中缺失一致。不过，除有专门扩容或丢点计数的实验外，不能把每一条历史缺失都唯一归因于 ring。

### 5.2 AnySentry 的相对优势

- 独立生命周期容量和背压保护降低普通事件挤掉 exec/exit 的风险。
- `pid + start time + generation` 的进程身份模型有利于保留同 PID 多代 exec。
- 对 exit 和退出码的保留使系统能够表达“执行是否完成”，而不只是“进程是否启动”。
- 原始 Collector 与正式链路可对账，有助于发现“采集成功但交付失败”的问题。

最后一项也是 AnySentry 必须继续改进的地方：可观测性不仅要求原始采集完整，还要求后续交付和归因可靠。

## 6. 讨论

### 6.1 可以支持的结论

在本文的 Terminal-Bench 2.1 同题并发样本中，AnySentry 对以下高价值证据的覆盖更好：

- Git 排查、合并和验证过程；
- 编译后的多组答案验证；
- 数据库恢复与校验过程；
- 与上述过程对应的 exit 和退出码。

因此，AnySentry 更适合用于重建 Agent 的任务执行链和结果证据，而不只是统计进程数量。

### 6.2 不能支持的结论

- 不能说 AnySentry 在所有单任务或低负载场景中领先。
- 不能说 AgentSight 在每个并发实例都会丢失关键事件。
- 不能用 S1 的总量差证明关键任务覆盖优势。
- 不能用 S3 候选实验的原始 Collector 结果证明 AnySentry 正式链路领先。
- 不能把当前样本外推为文件、网络、模型采集或全部任务上的全面领先。

## 7. 局限与后续工作

1. 多数场景只有一个有效轮次，缺少多轮方差和置信区间；事件条数不是独立实验重复数。
2. 模型行为具有随机性，不同轮次产生的命令并不完全相同，因此关键事件真值必须逐轮建立。
3. 双探针同时运行会共享宿主开销，资源采样还包含其他宿主工作，不能直接作为孤立产品性能对比。
4. AgentSight 缺少逐类生命周期 drop 计数，部分精确丢点只能定位到采集或过滤之前，不能全部完成内核级因果证明。
5. 最新 AnySentry 正式链路故障仍在修复与复测流程中；在修复版本通过相同 S3 验收前，本报告不将其列为已完成产品级优势。
6. 尚需完成真正的长程连续负载、对称停止 drain、归因误报率和孤立资源开销实验。

## 8. 结论

关键事件证据表明，AnySentry 在 Terminal-Bench 2.1 的同题并发和高负载任务中，比 AgentSight 更完整地保留了任务关键 exec、exit 和退出码，尤其适用于恢复、修改与验证过程的行为重建。

但严谨的产品结论必须同时满足原始采集完整、正式链路可靠和归因正确。当前证据支持 AnySentry 在多个 S2 场景中的关键事件优势，也暴露了单任务反例和 S3 正式链路失败。后续报告应在修复版本复测通过后更新，而不应预先宣称全面领先。

## 主要证据工件

- S1：`terminal-bench/eval/s1-c24-recheck-20261028-110213/`
- S2 Git：`terminal-bench/eval/s2-complete-20261027-210405/`
- S2 polyglot：`terminal-bench/eval/s2-poly4-gap-r2-20261028-172634/`
- S2 db-wal：`terminal-bench/eval/db4-lifecycle-20261028-184452/critical-analysis.json`
- S3 候选：`terminal-bench/eval/s3-mixed-20261028-213330/s3-analysis.json`
- S3 原始 Collector：`/tmp/anysentry-s3-mixed-raw.ndjson`
