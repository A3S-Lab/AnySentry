# S1 进程执行与退出差异排查

2026-10-26 复核 10 月 23 日的同次双观测工件，未重新运行任务、修改采集算法或重启服务。

**结论：差异包含启动准备行为，也包含实际任务事件。AnySentry 存在可复现的“短命进程缺少代际字段 → 归属链断裂 → Agent 白名单过滤”机制；同时，第三次编译附近发生过全局 ring 满丢弃。两种机制不能合并成一个漏采原因。**

## 1. 差在哪里

下表为归档短窗口内的 PID/条数对齐，不是通用的进程代际匹配器。exec 同 PID 可多次发生，使用每个 PID 的计数差；exit 用各 PID 集合对齐。

| 任务 | exec：AnySentry / AgentSight | 仅 AnySentry 的 exec | 仅 AgentSight 的 exec | exit：AnySentry / AgentSight | 仅 AnySentry 的 exit | 仅 AgentSight 的 exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fix-git | 38 / 40 | 0 | 2 | 25 / 34 | 0 | 9 |
| db-wal-recovery | 33 / 37 | 0 | 4 | 25 / 36 | 0 | 11 |
| polyglot-c-py | 52 / 62 | 2 | 12 | 22 / 60 | 1 | 39 |
| **合计** | **123 / 139** | **2** | **18** | **72 / 130** | **1** | **59** |

### exec 的逐项差异

- **fix-git：** 多出的 2 条全部是门控 `sleep 1`；排除它们后，双方均为 38 条，PID 计数一致。
- **db-wal：** 多出的 4 条中，2 条是 `sleep`，另 2 条是实际任务的 `xxd /app/main.db-wal`（3685763）、`head -60`（3685764）。AnySentry 记录了父 Bash（3685762），未找到这两个子进程 exec。
- **polyglot：** AgentSight 独有 12 条：2 条 `sleep`、第一次编译的 `ld`、第三次编译的 5 个程序（gcc、cc1、as、collect2、ld）、第三次测试的 4 次 `cmain`。AnySentry 独有 2 条：`sort -u`（3705033）和一个 Langfuse Hook shell（3705037）。所以双方均有对方未记录的事件。

6 条准备 exec 排除后为 **123 / 133**。不能把 AgentSight 余下的真实任务进程解释成 Harbor 污染。

### exit 的逐项差异

AgentSight 独有的 59 条 exit 中，只有 **3 条**是门控 sleep；不是 6 条，因为 exec、exit 的实际记录集合不同。单独排除这些准备 exit 后为 **72 / 127**。

**44 个 PID 已被 AnySentry 记录 exec，但没有对应 exit；AgentSight 有这些 exit。** 它们对应 AnySentry 的 45 条 exec（有 PID 执行过多次 exec）。包括：

| 例子 | PID | AnySentry exec | AnySentry exit | AgentSight exit |
| --- | ---: | --- | --- | --- |
| fix-git：`git log --oneline -3 master` | 3690510 | 有 | 未找到 | 有，code=0 |
| db-wal：`xxd /app/main.db` | 3684973 | 有 | 未找到 | 有，code=0 |
| polyglot：第一次 C 程序测试 N=0 | 3692782 | 有 | 未找到 | 有，code=0 |
| polyglot：第二次 C 程序测试 N=0 | 3708831 | 有 | 未找到 | 有，code=0 |

polyglot 第一次带参数 C 测试的 6 个 PID、第二次 C 测试的 8 个 PID（含无参数运行），均有上述现象。另有 AnySentry 独有的 Hook shell exit（3705037，code=127）。

### AgentSight 独有 exit 的任务相关性分类

逐 PID 回查成功 exec 的命令及 PPID，59 条独有 exit 分类如下；按语义归类，不是独立内核真值。

| 任务 | 直接任务执行 | 任务触发的自动维护 | Langfuse Hook | Shell 初始化 | 评测门控 sleep | 合计 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fix-git | 1 | 1 | 4 | 2 | 1 | 9 |
| db-wal-recovery | 5 | 0 | 3 | 2 | 1 | 11 |
| polyglot-c-py | 30 | 0 | 6 | 2 | 1 | 39 |
| **合计** | **36** | **1** | **13** | **6** | **3** | **59** |

36 条直接任务执行包括 git log、xxd/head 与 Bash、编译/链接程序、18 次 C 程序测试、which/ls/grep 检查 Python 环境。另 1 条 git maintenance 是 git commit 触发的辅助进程，不是模型直接决定的工具调用。13 条 Hook 均以 code=127 退出，记录的是 Hook shell 尝试失败，不表示成功上报。6 条初始化为 id/env、locale-check/mesg；它们与任务运行相关，但不能作为任务关键证据。3 条门控 sleep 属于评测准备，应从任务行为指标排除。

因此，至少 36 条属于有轨迹和进程链支撑的实际任务执行退出，另 1 条属于任务衍生维护；不能把全部 59 条称为任务关键事件，也不能把它们全称为 Harbor 污染。分类明细见 [exit 分类](experiments/20261023-s1-rerun/exit-classification.json)。

## 2. 最强原因证据：短命进程的身份信息缺失

重新查询 ClickHouse 的完整 process 字段发现：上述 **45 条 exec 全部没有 `startTimeTicks/startTimeNs`**。对照组双方均有 exit 的 exec 中，69 条有启动时间，7 条没有。缺失启动时间与 exit 缺失高度相关，但不是充分条件，不能仅凭相关性把所有事件归为同一原因。

两条直接证据：

- db-wal 缺失子进程的父 Bash 3685762 已落库，但没有启动时间。
- polyglot 第三次编译的父 Bash 3715795 已落库，也没有启动时间；前两次编译的父 Bash 则都有启动时间。

### 代码如何导致这一现象

1. Observer 的 `ExitEvent` 在内核侧保存 PID、cgroup、comm、退出码、信号；**没有 PPID 和启动时间**。Collector 需要通过缓存或 `/proc` 补足。
2. exec 的 PPID 由内核记录，即使进程已退出，也可借父进程归到 Kimi。但启动时间由用户态读 `/proc`；短命进程被回收后就读不到。
3. Forwarder 的 `ProcessRecordStore.set()` 必须有有效 ProcessKey 才保存。缺少启动时间的进程可以在本次 classify 中借 PPID 得到 agent 结果，却无法成为可复用的代际缓存记录。
4. 后续孙进程需要沿这个短命父进程找 Kimi，或 exit 到达时需要恢复归属；如果 `/proc` 已消失，就可能得到 unknown。
5. 当时 Forwarder 启用了 Agent 白名单。`agentAllowlistMatch()` 位于生命周期 always-keep 逻辑之前，unknown 的 exec/exit 会被白名单排除；“生命周期保护”不会绕过这一关。

Collector 的另一个放大因素是 comm：exec 组装器初始保存 syscall-entry 的旧 comm，COMMIT 仅设置确认位、不更新 comm。实际记录中有 `exe=/app/polyglot/cmain` 而 `comm=bash` 的组合；exit comm 则是 `cmain`。Collector 的上下文缓存要求 comm 一致，这会触发重新读 `/proc`，而此时进程可能已经消失。

### 已做离线机制复现

相同父子链、相同 PPID/cgroup，假定 `/proc` 不可再读，只改变父进程是否提供启动时间：

| 父进程信息 | 父 exec 归属 | 孙进程 exec 归属 | 父 exit 归属 |
| --- | --- | --- | --- |
| 无启动时间 | agent | unknown | unknown |
| 有启动时间 | agent | agent | agent |

该实验复现当前代码机制，不是对历史缺失事件的逐条原始输入重放；历史每条丢弃前的原始流没有保存。因此，这是得到代码、数据和复现共同支持的主要原因，仍须新增逐事件丢弃收据来确认每条历史事件的终点。

## 3. 另一项实际损失：全局 ring 满

历史日志显示，16:56:31 至 17:00:31，累计 `dropped` 为 55154；17:01:32 升至 55830，**新增 676 次 ring 预留失败**。第三次编译发生在 17:01:00 左右，落在这一采样区间。

这支持该阶段存在采集端压力，但计数覆盖全宿主、多个事件 ring，可能包含 exec 分片，不能当作该任务 676 个进程或 exit 丢失。此前 fix-git、db-wal 及前两次 C 测试的 exit 缺失发生在计数未增长期间，所以 **ring 满不能解释所有差异**。

同一范围内 `output_dropped=4666` 未增长。Forwarder 心跳中的 queue_dropped、API rejected/retryable 均为 0，API 回执保留 651 个事件/心跳。白名单过滤有全局计数，但没有历史逐 PID 丢弃收据。这轮证据不支持把主要断点指向 API 写入失败。

## 4. 为什么 AgentSight 在这里更完整

AgentSight 先按目标范围跟踪，退出探针在 `sched_process_exit` 当场读取 PID、PPID、comm、exit_code 和时间，不需要先恢复成 AnySentry 的 Agent 语义才能记录原始 exit。双方均排除普通线程 exit，因此不是 AgentSight 把线程退出全算进来了。

AnySentry 使用 `do_exit` kprobe；这一附着点本身不能证明差距，主要证据指向**短命进程身份补全与白名单的耦合**。AgentSight 同样不是完整真值，本轮也缺少 AnySentry 保存的 sort 与 Hook 事件。

当前可下的结论是：**本轮指定任务中，AgentSight 保存的原始 exit 更完整；AnySentry 的原始采集与归属过滤需要分开核算。** 不是“AgentSight 多的都归错”，也不能推广成所有负载下的覆盖率排名。

## 5. 修复优先级（本次未修改运行代码）

1. 在内核生命周期事件中携带 PPID、启动代际和单调时间；fork/exec 时建立代际事实，避免退出后才依赖 `/proc`。
2. 分离原始生命周期保留与 Agent 白名单展示策略。unknown 生命周期要进入有界保留/待归属通道；不要仅用裸 PID 伪造确定归属。
3. COMMIT 更新成功执行后的 comm；上下文按同一代际跨 exec 更新，而非依靠 comm 判断是否同一进程。
4. ring 丢弃按事件类型分账并评估消费延迟，避免把本轮全部差异归结为扩容即可解决。
5. 修复后复跑相同 S1，并核对这些具体 PID 模式：短命 shell、编译链、连续 C 测试、Hook；同时比较原始采集、过滤、Session 归属三层。

## 工件及代码入口

- [逐 PID 差异](experiments/20261023-s1-rerun/process-differences.json)
- [只读差异统计脚本](experiments/20261023-s1-rerun/analyze-differences.py)
- [离线归属机制复现](experiments/20261023-s1-rerun/reproduce-missing-exit.cjs)
- [运行期诊断摘要](experiments/20261023-s1-rerun/difference-diagnostics.json)
- Collector：`Observer/a3s-observer-collector/src/main.rs`，`PendingExec.apply`、`ProcessContextCache.get`、`exec_process_context`、exit ring 消费。
- 内核出口：`Observer/a3s-observer-common/src/lib.rs:ExitEvent`、`Observer/a3s-observer-ebpf/src/main.rs:try_proc_exit`。
- Forwarder：`scripts/observer-agent-attribution.js:ProcessRecordStore.set/classify`、`scripts/observer-forward.js:agentAllowlistMatch`。
- AgentSight：`agentsight/bpf/process.bpf.c:handle_exit`。
