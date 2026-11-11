# AnySentry 与 AgentSight 在 Terminal-Bench 2.1 中的 Agent 进程观测对比：描述性实验分析

## 摘要

本文比较 AnySentry 与 AgentSight 在 Terminal-Bench 2.1 三类 Agent 工作负载中的进程执行（exec）与进程退出（exit）观测结果。实验覆盖异任务并发（S1）、同题并发（S2）与长程并发（S3）。结果显示，两类系统具有场景依赖的相对优势：S1 中 AgentSight 在 fix-git 与 db-wal-recovery 的记录更多，而 AnySentry 在 polyglot-c-py 的 exec 更多；S2 中双方 exec 数量接近，但 AgentSight 的 exit 明显更多；S3 中 AnySentry 的 exec 与 exit 记录均显著多于 AgentSight。

上述结果不能简单解释为任一系统在所有场景中具有绝对采集优势。事件数量同时受到探针覆盖、去重方式、进程归属、任务执行路径、统计窗口与评测框架事件的影响。尤其需要区分“真实 Agent 任务行为”和 Harbor 等评测基础设施行为。本文因此将结果解释为不同观测模型和保留策略下的描述性差异，而非系统优劣的全局排序。

**关键词：** Agent 可观测性、eBPF、进程生命周期、Terminal-Bench、AnySentry、AgentSight、进程归属

## 1. 引言

Agent 的行为通常以自然语言工具调用呈现，但一次工具调用并不等价于一次系统执行。一个 Shell 命令可以派生多个子进程，同一 PID 也可以通过连续 exec 更换程序映像。因此，进程 exec 与 exit 提供了不同于 Agent 声明式工具轨迹的内核观测视角。

本报告分析以下问题：

1. AnySentry 与 AgentSight 在不同并发结构下记录的进程生命周期事件是否存在稳定差异？
2. 这些差异能否直接解释为采集覆盖率或系统能力差异？
3. Harbor 等评测框架进程被归入 Kimi Agent 时，会对结论产生何种影响？

## 2. 实验设置

| 场景 | 测试任务及内容 | 并发设置 | 任务结果 |
|---|---|---|---|
| S1：异任务并发 | `fix-git`：找回并合并 Git 修改；`db-wal-recovery`：恢复 SQLite WAL 数据；`polyglot-c-py`：编写 C/Python 双语言程序 | 3 个容器同时运行不同任务 | 3/3 评分通过 |
| S2：同题并发 | `fix-git` × 2，同题、同工作区路径、不同容器 | 2 个实例同时运行 | 2/2 评分通过 |
| S3：长程并发 | `music-harmony`：乐谱和声；`shadow-relay`：网络外传取证；`legacy-utility-triage`：通过 GUI 处理计费异常 | 3 个任务运行重叠，单任务约 48–82 分钟 | 未全部通过，作为压力测试样本 |

官方评分用于描述任务是否完成，不被用作采集完整性的替代指标。S3 的未全部通过仅说明其适合作为压力样本，不构成对任一观测系统的直接否定。

## 3. 指标与分析口径

- **exec：** 内核成功加载程序执行。一次工具调用可以产生多条 exec，同一 PID 也可以通过多次 exec 更换程序。
- **exit：** 进程结束。退出事件可以补充工具调用结果中缺失的短生命周期信息。
- **记录数量：** 表示在既定统计口径下保存的事件数，不自动等于独立真值意义上的覆盖率。
- **归属：** 事件被关联到 Kimi Agent 或其进程树的方式。归属错误可能将基础设施行为误计为 Agent 行为。

分析时将“任务完成”“事件是否被记录”“事件是否归属于正确 Agent”视为三个独立问题。

## 4. 核心结果

| 场景 | 任务/实例 | 关键事件 exec：AnySentry / AgentSight | 关键事件 exit：AnySentry / AgentSight | 关键事件说明 |
|---|---|---:|---:|---|
| S1 | fix-git | 29 / 36 | 14 / 30 | Git 修改找回、合并与检查相关进程：AgentSight 的 exec/exit 均更多 |
| S1 | db-wal-recovery | 21 / 30 | 7 / 22 | WAL 识别、恢复与校验相关进程：AgentSight 的 exec/exit 均更多 |
| S1 | polyglot-c-py | 397 / 240 | 112 / 218 | gcc 编译链及 C/Python 测试：AnySentry 的 exec 更多，AgentSight 的 exit 更多 |
| S2 | fix-git A | 32 / 32 | 16 / 25 | Git 命令 exec 持平，AgentSight 的退出记录更多 |
| S2 | fix-git B | 38 / 40 | 15 / 27 | Git 命令 exec 接近，AgentSight 的退出记录更多 |
| S3 | music-harmony | 85 / 27 | 61 / 18 | 长程乐谱处理相关进程：AnySentry 的 exec/exit 均更多 |
| S3 | shadow-relay | 117 / 24 | 75 / 12 | 网络外传与取证相关进程：AnySentry 的 exec/exit 均更多 |
| S3 | legacy-utility-triage | 1302 / 418 | 556 / 228 | GUI 与计费异常处理相关进程：AnySentry 的 exec/exit 均更多 |

“关键事件覆盖特征”是对当前记录所反映任务行为的概括，不是独立真值意义上的覆盖率，也不排除 Harbor、Hook 或其他辅助事件混入。关键行为的完整覆盖仍需按具体命令、进程代际和退出码逐项验证。

汇总观察：

- S1：双方各有优势。AgentSight 在 fix-git、db-wal 的记录更多；AnySentry 在 polyglot 的 exec 更多。
- S2：exec 接近，合计为 70 / 72；exit 差异明显，合计为 31 / 52。
- S3：AnySentry 合计 exec 为 1504 / 469，exit 为 692 / 258，分别约为 AgentSight 的 3.21 倍和 2.68 倍。

## 5. 分场景分析

### 5.1 S1：记录差异具有任务依赖性

fix-git 中，AgentSight 的 exec 比 AnySentry 多 24.1%，exit 多 114.3%；db-wal-recovery 中，exec 多 42.9%，exit 多 214.3%。这可能反映 AgentSight 对短命 Shell、Git 子进程和数据库辅助命令具有更充分的记录，也可能包含统计范围或归属差异。

polyglot-c-py 中，AnySentry 的 exec 比 AgentSight 多 65.4%，但 AgentSight 的 exit 比 AnySentry 多 94.6%。exec 与 exit 的方向不一致尤其说明：不能依据单一指标判断完整性。一个系统可能更善于保留程序加载事件，另一个系统可能保留更多终止事件，也可能存在 exec 与 exit 的匹配或去重差异。

因此，S1 更适合支持“不同系统具有互补的采集特征”，而不是支持单一系统全面领先。

### 5.2 S2：exec 接近不能推出生命周期一致性

S2 的 exec 合计仅相差 2 条（70 / 72），但 exit 相差 21 条（31 / 52）。AgentSight 的 exit 约为 AnySentry 的 1.68 倍。

这一现象表明，exec 数量接近并不保证后续生命周期记录一致。可能原因包括：

- 短生命周期进程的 exit 捕获和保留策略不同；
- 进程归属在 exit 到达时发生变化；
- 同一 exec 对应的退出事件去重方式不同；
- 统计窗口结束前后，部分 exit 尚未入库。

因此，S2 的主要价值在于揭示 exec 与 exit 应分别验收，不能只比较工具调用或 exec 数量。

### 5.3 S3：AnySentry 记录更多，但倍数不等于覆盖率倍数

S3 中 AnySentry 在三项任务上均记录更多。其合计 exec 约为 AgentSight 的 3.21 倍，exit 约为 2.68 倍，显示出长程、复杂工作负载下更丰富的观测输出。

然而，1504 / 469 和 692 / 258 只是记录数量比，不能直接表述为“覆盖率是 3.21 倍”或“漏采率降低 3.21 倍”。在缺少独立、完整进程真值的情况下，还可能存在以下影响因素：

- 双方对重复事件和聚合事件的定义不同；
- 长任务中 Agent 的执行路径不同；
- AnySentry 可能保留更多基础设施、后台或辅助进程；
- AgentSight 可能采用更严格的归属过滤；
- 双方统计窗口和延迟入库处理不同。

S3 支持“AnySentry 记录更丰富”，但不能单独证明“AnySentry 的真实任务覆盖率必然更高”。

## 6. Harbor 归属污染的专门讨论

AgentSight 将部分 Harbor 评测框架进程归属到 Kimi Agent，属于构造效度问题：测量对象不再完全是“Agent 任务行为”，而变成“Agent 与评测基础设施的混合行为”。

该问题具有双向影响：

1. 它可能使 AgentSight 看起来记录了更多 Agent 事件，从而夸大其任务覆盖能力。
2. 如果 AnySentry 排除了更多 Harbor 事件，其较低的原始计数也可能源于更严格的归属，而非漏采。
3. 将 Harbor 事件剔除后，AnySentry 与 AgentSight 的相对优势可能缩小、消失，甚至反转。

因此，准备 sleep、启动门控、评测辅助 Shell、Hook 和框架维护进程应单独标记，不能直接计入 Agent 任务 exec/exit。与此同时，这些事件在评测系统调试中仍有价值，不应简单从底层证据中删除。

## 7. 效度与结论边界

### 7.1 构念效度

exec/exit 数量是观测输出指标，不是完整的任务行为真值。必须区分记录数量、独立覆盖率、归属准确率和事件语义完整度。

### 7.2 内部效度

即使两系统观察同一次运行，也可能因探针开销、启动时序和共享宿主资源而相互影响。若没有独立 Collector 或 fork/wait 真值，无法排除部分事件由观测系统自身引入。

### 7.3 统计结论效度

当前结果属于描述性比较。任务执行具有随机性，尤其 S3 的长任务路径可能显著变化。未提供重复轮次、方差或置信区间时，不应给出稳定的总体优劣推断。

### 7.4 外部效度

实验仅覆盖特定 Terminal-Bench 2.1 任务、宿主环境和模型配置。结论不能直接推广到所有 Agent、操作系统、内核版本、容器规模或生产工作负载。

## 8. 后续验证建议

1. 以 fork/wait 收据和独立原始 Collector 建立进程级真值。
2. 按 PID、启动代际、exec 内容和退出码逐项核对，避免重复行虚增。
3. 将 Agent 任务、Agent 启动、Harbor 准备、Hook 和后台维护事件分层统计。
4. 分别报告任务结束后 10 秒、60 秒和最终入库结果，区分延迟与永久缺失。
5. 增加同题多实例并发，检验跨容器、跨 Session 和 PID 复用错归。
6. 对 fix-git、db-wal、polyglot 分别建立关键行为集合，避免用总事件数替代关键证据覆盖率。
7. 进行多轮重复实验，报告中位数、最差结果和全部反例，而非只选择有利轮次。
8. 同时记录 CPU、内存、ring 丢弃和输出背压，区分探针能力、容量和归属问题。

## 9. 结论

AnySentry 与 AgentSight 的进程观测结果呈现明显的场景依赖性。S1 不支持单一系统全面占优；S2 表明 exec 接近时 exit 仍可能显著不同；S3 则显示 AnySentry 具有更丰富的事件记录。

更严格的结论应是：**AnySentry 在本实验的长程复杂负载中表现出更高的观测产出，而 AgentSight 在部分短任务和退出记录上具有优势。两者差异同时受到采集容量、归属策略、事件语义和评测框架行为影响。**

因此，现阶段不宜给出全局系统排名。更有价值的后续工作，是以独立真值和关键任务行为集合分别验证采集完整性、归属准确性和生产链路可靠性。
