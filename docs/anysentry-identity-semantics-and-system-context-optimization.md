# AnySentry 身份语义与系统上下文闭环优化设计

状态：已审核实施方案

依据：2026-08-21 本地真实运行调研

关联文档：[可信关联身份、采集过滤与开发阶段设计](./anysentry-trusted-correlation-and-capture-roadmap.md)

后续设计：[统一资产生命周期、人工身份审核与采集规则治理优化设计](./anysentry-unified-asset-lifecycle-and-capture-rule-governance.md)

## 结论

本轮优化的目标不是继续扩大事件过滤范围，也不是通过增加更多静态规则压低 Unknown 数量，而是补齐两条目前尚未闭环的主链：

1. **身份与行为语义链**：准确区分 Agent、已有服务、普通进程和 Unknown；让一次 Agent 调用中的 Invocation、ToolCall、Process 与 Kernel Evidence 形成可持久查询的可信关系。
2. **服务上下文链**：在系统初始化和持续运行期间发现已有服务、指标、依赖和变更；即使服务 syscall 已被聚合，风险分析仍能获得与 Agent 行为相关的真实业务上下文。

全部完成后，AnySentry 应形成以下整体能力：

> Agent 高保真证据 + 服务聚合上下文 + Unknown 有界发现 + 可信 Invocation/ToolCall 语义 + 可跨冷热存储查询的证据关系 + 风险反馈驱动的安全采集闭环。

本设计只描述整体流程节点、职责、数据关系、状态变化和验收标准，不规定具体方法名、类名或局部代码组织方式。

---

## 一、背景与已确认问题

### 1.1 原始目标

AnySentry 的产品主旨包括三部分：

- 发现并定位 Agent Asset、Runtime 和 Process；
- 对每条 Agent 行为事件进行监控、关联和风险判断；
- 在初始化及持续运行中发现已有业务服务、基础设施、指标和依赖，将其作为 Agent 风险判断的上下文。

此前已经完成的 Ring 前采集优化解决了最危险的资源问题：高频 File、Network 等信号不再全部进入 Ring Buffer。真实五分钟窗口中，高频探针约 `308,627` 次决策只产生约 `37,424` 次 Ring submit，Ring 前减少约 `87.87%`，Ring、Collector 和队列均未发生物理丢失。

但“采集量下降”不等于“身份、语义和上下文正确”。当前仍存在以下已确认偏差。

### 1.2 当前实测偏差

| 问题 | 已确认事实 | 对主旨的影响 |
|---|---|---|
| Unknown 比例仍高 | 无人工 non-Agent 降级时，五分钟最终入库事件中 Unknown 占 `56.61%` | 绝对数量下降，但分类闭环没有完成 |
| Infrastructure 被误升为 Agent | 两个 ClickHouse、Kind 控制面和 Redis 被弱 behavior 证据提升为 probable_agent；behavior 来源占 probable_agent 的约 `98.24%` | 基础设施进入 agent_full，增加采集与模型研判成本，并造成误报 |
| 三轴语义部署接线不完整 | API 开启新语义但 Observer 未开启时，身份原因仍为 not_evaluated，角色和档位为空 | 静态实现存在，但部署后没有实际生成可用语义 |
| Invocation 被拆分 | 一次 Pi 用户任务中的 write、read、bash 落入多个 invocationId | 无法形成一次调用下的完整因果行为链 |
| 认证 Tool Span 未稳定归入 Asset/Runtime | Tool Span 有可信 Adapter correlation，但身份分类为空，workspace 与 Asset canonical workspace 不一致 | 语义证据与内核事实、资产、Runtime 不能稳定合并 |
| ToolEvidence 冷查询失败 | 热 Ring 淘汰后，ToolEvidence 查询返回 storage_unavailable；精确事件和 Invocation 查询出现超时或高内存 | 短 E2E 能通过，但真实高噪声环境无法稳定取证 |
| 服务上下文不完整 | Bundle 只有 Agent 自身事件计数，没有真实业务服务延迟、错误率、容量或依赖边 | 尚未实现“已有服务状态作为 Agent 风险上下文”的产品目标 |
| stale alert 进入上下文 | 当前 Coverage 已无对应问题，但历史“缺少 Collector 覆盖”告警仍进入 Bundle | 风险分析可能被已经失效的事实误导 |
| Unknown Learning 容量快速饱和 | cluster、family、dedupe 很快达到容量边界并产生 overflow | 有界性安全，但长期发现新 Agent 的能力下降 |
| Capture Profile 状态抖动 | profile epoch 高频变化，出现过期 snapshot、entry expiry 冲突和 LKG 降级 | 稳定 ACK/grant 难以形成，控制面噪声过高 |

以上问题中，前六项属于身份和语义正确性，后四项属于服务上下文、学习和运行稳定性。本设计优先解决前两组核心问题，不扩大 authoritative DROP 范围。

---

## 二、目标、范围与成功标准

### 2.1 总目标

实现以下完整结果：

```text
系统启动或新工作负载出现
  ↓
发现 Host / Cluster / Workload / Service / Agent 候选
  ↓
分别解析“是不是 Agent”“是什么服务角色”“应采用什么采集档位”
  ↓
生成稳定、可回滚、可解释的节点 Capture Profile
  ↓
Ring 前执行 FULL / AGGREGATE / SAMPLE / DROP
  ↓
Agent SDK / OTLP 提供 Invocation 与 ToolCall 语义
  ↓
内核事件提供 Process 与真实系统行为证据
  ↓
语义证据与内核证据通过可信 Asset / Runtime / Process 关系合并
  ↓
高保真证据、聚合服务上下文、Unknown 样本和质量指标分层存储
  ↓
按 Invocation / ToolCall / Process 跨冷热存储稳定查询
  ↓
构造 Agent → Service → Database 的两跳 System Context Bundle
  ↓
风险分析、告警、调查升档、Unknown 学习和人工反馈
  ↓
更新身份事实、服务事实和采集策略
```

### 2.2 第一优先级成功标准

- Agent recall：`100%`。
- 已知 ClickHouse、Postgres、Redis、容器运行时和集群控制面 false-Agent：`0`。
- Unknown `not_evaluated`：`0`。
- 每个保留的 Unknown 都有闭集原因码。
- 单次 Pi 用户调用中的 read、write、bash 共用一个 invocationId。
- 同一 Invocation 下每个 ToolCall 具有独立 toolCallId，并能关联到正确 Process generation。
- 认证 AgentTool 能归入正确 Agent Asset 和 Runtime，不依赖不可信 producer 自报身份。
- ToolEvidence 查询 P95 `< 2s`。
- ToolEvidence 在热 Ring 淘汰、API 重启和历史数据查询后仍可用。
- probable_agent 不再默认让整个 cgroup 进入无期限 agent_full。

### 2.3 第二优先级成功标准

- 自动建立 Host、Cluster、Workload、Service、Database 和 Agent Asset。
- 每个目标服务至少具备错误率、延迟、容量/饱和度中的两类真实指标。
- Agent 访问服务后，可以形成 Agent → Service → Database 的最多两跳依赖关系。
- 同期部署、配置和版本变化可以进入上下文。
- 已恢复的 Coverage 问题能够关闭或过期，不继续进入新 Bundle。
- Bundle 中每条事实都带来源、新鲜度、置信度和完整性状态。
- 未配置指标源时明确标记 partial，不生成虚假正常状态。

### 2.4 不在本轮扩大的范围

Unknown 比例是诊断结果，不是可以通过强制改分类完成的独立 KPI。后续比例下降必须来自可审计的 Service Role、Process ancestry、Runtime signature、Adapter 或人工事实；不能通过把 Unknown 批量改成 probable_agent 或 non_agent 获得表面改善。验收时应同时报告：

- Ring 前按 probe/action 统计的全部决策；
- Ring 后、用户态过滤前的身份分布；
- 过滤后的持久化身份分布；
- Unknown 的绝对数量、原因码、工作负载和信号构成。

- 不重命名、覆盖或重新计算旧 traceId、sessionId、runId、agentId 和 Incident/Alert key。
- 不把 Invocation 写回 traceId。
- 不允许 Unknown Learning 直接生成 authoritative DROP。
- 不因为新增服务角色识别就自动丢弃安全、Exec、Exit 和 Agent 证据。
- 不用扩大热 Ring 或 ClickHouse 内存代替正确的持久查询设计。
- 不通过宽泛的 node、bash、python、cat 等进程名规则把 Unknown 强行归为 Agent 或 non-Agent。

---

## 三、统一系统模型

### 3.1 需要独立维护的三类判断

身份、角色和采集档位必须分别计算，不能继续相互替代。

#### 身份：它是不是 Agent

```text
confirmed_agent
probable_agent
non_agent
unknown
```

#### 工作负载角色：它在系统里承担什么职责

```text
agent
anysentry_internal
platform_infrastructure
business_service
ordinary_process
unknown
```

#### 采集档位：当前应以什么精度观察

```text
agent_full
probable_investigation
security_full
investigation_full
business_context
infrastructure_aggregate
unknown_discovery
self_health
```

关键原则：

- “Agent 身份未知”不等于“服务角色未知”。
- 可以确认某个工作负载是 ClickHouse 或业务 API，同时仍不对它做 Agent 身份的负面判断。
- 服务角色可以触发 AGGREGATE，但只有经过安全流程的精确 non-Agent 事实才能触发 authoritative DROP。
- probable_agent 表达候选身份，不等于已确认 Agent，也不应自动获得整个 cgroup 的长期全量采集。

### 3.2 资产和运行关系

完整关系应为：

```text
Environment / Cluster / Host
  ├─ Service Asset
  │    ├─ Workload Revision
  │    ├─ Runtime Instance
  │    ├─ Service Metrics
  │    ├─ Deployment / Config Changes
  │    └─ Dependency Edges
  │
  └─ Agent Asset
       ├─ Agent Runtime Instance
       │    ├─ Process Instance 0..N
       │    ├─ Invocation 0..N
       │    │    ├─ Model Turn 0..N
       │    │    └─ ToolCall 0..N
       │    └─ Runtime 级事件 0..N
       └─ Workspace / Tenant / Environment Bindings
```

Service Asset 与 Agent Asset 可以指向同一个物理 workload，但语义职责不同。例如一个业务服务进程中嵌入 Agent Runtime 时：

- workload 仍是业务 Service Asset；
- Agent Runtime 是其内部受监控运行实例；
- 普通业务请求与 Agent Invocation 不能仅凭 cgroup 合并；
- 只有 SDK/OTLP 或强进程事实足够时，事件才能进入具体 Invocation。

### 3.3 Invocation 的正确语义

Invocation 表达一次外层 Agent 请求、任务或运行，不是一次模型响应回合。

```text
Conversation / Session
  └─ Invocation：一次用户请求或 Agent 任务
       ├─ Model Turn 1
       │    └─ ToolCall: write
       ├─ Model Turn 2
       │    └─ ToolCall: read
       ├─ Model Turn 3
       │    └─ ToolCall: bash
       └─ Final Response
```

约束如下：

- 同一次外层请求中的所有模型回合和工具调用共享 invocationId。
- 每个工具调用拥有独立 toolCallId。
- Model Turn 可以拥有独立 spanId，但不能替代 Invocation。
- Agent 长期运行、并发处理请求时，只能使用可信应用或 Adapter 上下文拆分 Invocation。
- 只有 Runtime 或 Process 证据时，保持 Runtime 级关联，不伪造 Invocation。

### 3.4 证据层次

```text
Semantic Evidence
  Agent SDK / OTLP / first-party Adapter
  说明：谁发起、为什么发起、属于哪次 Invocation、哪个 ToolCall

Kernel Evidence
  eBPF / process lifecycle / file / network / security
  说明：真实发生了什么、由哪个 Process generation 执行、影响了哪个资源

System Context
  Service Asset / metrics / topology / changes / alerts
  说明：Agent 行为发生时，相关服务处于什么状态、影响范围是什么

Quality Evidence
  profile / sampling / aggregation / loss / freshness / confidence
  说明：当前结论的证据完整性和观测边界
```

四类证据共同形成风险结论，任何一类都不能单独伪造其不具备的语义。

---

## 四、完全实现后的 High-level 运行流程

最终系统应由五条互相连接的流程组成。

### 4.1 初始化与持续发现流程

```text
Host / Kubernetes / Docker / systemd Inventory
  + OTel Resource / Service 信息
  + Prometheus Target / Metric Metadata
  + Agent 标签、签名、Adapter 注册
        ↓
标准化物理身份
host / boot / cluster / namespace / workload / container / cgroup
        ↓
建立 Asset 图
Host Asset
Service Asset
Agent Asset Candidate
Database / Queue / External Dependency Asset
        ↓
独立解析三轴
Agent Identity
Workload Role
Capture Profile
        ↓
发布初始身份和服务快照
        ↓
持续接收 workload 创建、更新、重启、删除和配置变化
        ↓
增量更新 Asset、Runtime、Service 和 Profile
```

初始化完成不等于所有服务都被判定为 non-Agent。它至少应确认：

- 这是哪个物理 workload；
- 它是平台基础设施、业务服务、AnySentry 自身还是未知角色；
- 是否存在可信 Agent 证据；
- 当前允许 FULL、AGGREGATE 还是 SAMPLE；
- 哪些指标源和拓扑源可用。

### 4.2 控制与采集流程

```text
身份事实 + 服务角色 + 风险状态 + 人工审核
        ↓
编译 Capture Profile
scope / action matrix / version / epoch / TTL / authority
        ↓
节点 Preview
        ↓
Collector 安全应用并 ACK
        ↓
控制面验证 generation / intent / expiry
        ↓
必要时发放 activation grant
        ↓
内核探针提取最小稳定键
        ↓
Ring 前执行：
FULL       已确认 Agent、安全、临时调查
AGGREGATE  服务和基础设施重复信号
SAMPLE     probable / Unknown 有界发现
DROP       精确、审核、canary 后的低价值噪声
        ↓
Critical / Semantic / Bulk 有界隔离
        ↓
Collector 快速排空
```

控制面只在有效采集意图变化时更新策略 epoch。进程成员、PID 和短期缓存变化使用独立 generation-safe 状态，不应让整个节点策略高频重编译。

### 4.3 可信语义与内核证据合并流程

```text
Agent SDK / Adapter / OTLP
  ↓
认证 Source、Tenant、Environment、Workspace、Workload Binding
  ↓
Conversation / Invocation / Model Turn / ToolCall
  ↓
绑定 Agent Asset 与 Runtime
  ↓
绑定强 Process Instance
boot + pid namespace + namespace pid + start time + parent generation
  ↓
内核证据候选
file hash / command hash / network peer / process generation
  ↓
执行严格关系匹配
same process resource
direct child command
attested runtime fact
semantic only
  ↓
生成 ToolEvidence
Tool Span + Kernel Evidence + relation + confidence + quality
```

如果 Source 可信但 Process 证据不足：

- 可以确认 Invocation 和 ToolCall 语义；
- 可以确认它属于绑定的 Agent Asset/Runtime；
- 不能伪造具体 syscall 证据；
- ToolEvidence 应显示 semantic_only 和明确原因。

如果内核事件存在但没有 SDK：

- 可以关联到 Process 和 Runtime；
- 不能凭时间邻近伪造 ToolCall；
- 显示 runtime-level kernel evidence 或 unassigned ToolCall。

### 4.4 服务上下文流程

```text
Service Inventory
  + Prometheus / OTel Metrics
  + 聚合网络依赖
  + Trace Service Graph
  + Deployment / Config Changes
  + Alerts / Health
        ↓
标准化 Service Asset 与 Resource Identity
        ↓
按时间窗持续聚合服务事实
latency / error / throughput / saturation / availability
        ↓
Agent 与服务发生交互
Tool target / network peer / trace span / workload edge
        ↓
建立 Agent → Service → Database 最多两跳关系
        ↓
按 Invocation、时间和相关资源裁剪
        ↓
System Context Bundle
Agent / Runtime / Invocation
+ ToolEvidence
+ Service Health
+ Dependency Graph
+ Changes / Alerts
+ Collection Quality
```

服务 syscall 是否保存与服务上下文是否存在是两件独立的事。业务服务可以使用 infrastructure_aggregate，但其指标、拓扑、部署和告警仍必须进入独立上下文面。

### 4.5 风险、学习与反馈流程

```text
ToolEvidence + Kernel Evidence + System Context + Quality
        ↓
L1 本地规则与完整性判断
        ↓
必要时 L2 结构化研判
        ↓
必要时 L3 深度调查
        ↓
可追溯风险结论
        ↓
Alert / Incident / Investigation Promotion
        ↓
Unknown Family / Service Role / Human Review
        ↓
候选策略
candidate → shadow → replay → canary → enforce / rollback
        ↓
更新身份、角色、调查档位和采集策略
```

学习器只能提供 recommendation。任何 destructive action 都必须继续经过精确 inventory 绑定、人工审核、双人审批、canary、ACK 和 generation-bound grant。

---

## 五、第一优先级：恢复身份和语义正确性

### 5.1 功能一：统一部署开关和运行能力协商

#### 要解决的问题

API、Forwarder、Collector 和流处理消费者可能分别处于不同 rollout mode，导致代码已实现但运行态不生成新语义。

#### 目标流程

```text
部署配置
  ↓
API / Forwarder / Collector 分别声明能力和 rollout mode
  ↓
启动时互相校验兼容版本
  ↓
状态一致：进入 shadow 或 enforce
状态不一致：保持安全兼容模式并产生明确健康问题
  ↓
Collector Heartbeat 和控制台展示每一层真实模式
```

#### 功能要求

- 身份语义、Capture Profile 和可信关联仍是三个独立开关。
- canonical Kubernetes、Docker 和 Host 部署必须显式设置每个组件所需的 mode。
- 运行健康面展示“API 接受能力、Forwarder 生产能力、Collector 执行能力、Flink 消费能力”。
- 任何一层缺失时不得静默显示为已完成。
- 重新安装 canonical manifest 后，运行模式不能退回 legacy。

#### 验收

- 新部署产生的每个 Unknown 都有闭集原因码。
- role 和 capture profile 不再为空。
- 不再出现 API 为 enforce、Forwarder 为 legacy 的组合。
- 控制台能区分“代码支持”“配置开启”“真实产生数据”三种状态。

### 5.2 功能二：角色优先的身份解析，阻止 Infrastructure 被 behavior 提升

#### 要解决的问题

当前弱 behavior 证据可能覆盖稳定服务事实，使 ClickHouse、Redis、控制面等进入 probable_agent 和 agent_full。

#### 目标决策顺序

```text
强 Agent 证据
authenticated SDK / explicit Agent label / attested runtime root
        ↓
确认 Agent，永远优先于服务降档

否则：解析稳定 Workload Role
managed service / platform infrastructure / AnySentry internal / business service
        ↓
已知服务角色禁止弱 behavior 直接提升为 Agent

否则：评估 Agent 签名和行为候选
        ↓
产生 probable_agent 或 unknown

冲突：服务角色 + 强 Agent 证据
        ↓
身份保持 Agent；角色保持真实服务；采集进入安全 FULL 或调查档
```

#### 功能要求

- 稳定 inventory、image、workload controller 和受管服务标签用于解析角色，不直接产生 Agent 身份负面结论。
- 已知 platform/business/anysentry service 不参与普通 behavior promotion。
- behavior 只能在角色未知或 ordinary_process 范围内生成候选。
- behavior 证据必须表达具体可审核原因，而不是单一总分。
- 服务角色变化和 Agent 身份变化分别记录版本、来源和时间。
- 共享 workload 中出现强 Agent 证据时，不对 Agent 事件降档；同时不能把整个服务所有事件永久视为 Agent。

#### 验收

- ClickHouse、Postgres、Redis、CoreDNS、container runtime、Kind/Kubernetes control plane false-Agent 为 0。
- 真实 Pi、Codex 和已标记 Agent recall 为 100%。
- 同一 Service 内嵌 Agent 时，只提升强 Agent root 和后代，不提升无关服务线程或进程。
- 工作负载角色可以是 business_service，同时 Agent identity 仍为 unknown；两者不会互相覆盖。

### 5.3 功能三：probable_agent 使用有界调查档

#### 要解决的问题

probable_agent 代表候选身份，但当前等同于 agent_full，容易让误判工作负载产生无界高保真事件和模型研判。

#### 目标档位

| 身份和状态 | 默认档位 | 保留行为 |
|---|---|---|
| confirmed_agent | agent_full | Tool、关键 File/Network、Exec/Exit、安全证据高保真 |
| probable_agent | probable_investigation | root Exec/Exit、安全事件 FULL；普通 File/Network 有界 SAMPLE；TLS 明文交互 FULL；短 TTL |
| unknown | unknown_discovery | 关键生命周期、首批样本、周期样本、精确计数 |
| business_service | business_context | 指标、依赖、变化；syscall 聚合 |
| platform / infrastructure | infrastructure_aggregate | 重复信号聚合；安全和生命周期保留 |
| investigation promotion | investigation_full | 针对精确 Runtime/Process 临时升档 |

#### 功能要求

- probable_investigation 有固定容量、TTL 和升级条件。
- 候选首次出现时保留 root Exec、Process generation 和关键网络/文件样本。
- 出现 Adapter/OTLP/明确签名后立即升为 confirmed_agent。
- 候选长期没有新增 Agent 证据时自动恢复 unknown_discovery 或服务角色档位。
- 风险事件可以临时升为 investigation_full，但不永久改变身份。
- 原始 SecurityAction 自身在所有档位都必须 FULL 并进入安全研判，但单条原始事件不能直接授权整个 probable / unknown / Infrastructure cgroup 进入 investigation_full；升档必须来自已确认的风险研判或显式调查控制面，并绑定精确 Runtime / Process generation。
- 共享 cgroup 中只提升精确 root 及后代；无法精确隔离时优先安全，但必须暴露冲突和成本。

#### 验收

- probable false positive 不再导致整个 workload 长时间全量采集。
- probable 档位仍能 100% 捕获新 Agent 的 root、子进程和首批 Tool/Network/File 证据。
- 固定负载下，probable 档位事件量有明确上限。
- TTL 到期无需重启即可恢复安全 discovery 状态。

### 5.4 功能四：建立外层 Invocation 生命周期

#### 要解决的问题

一次用户请求包含多次模型回合和工具执行，当前每个 model turn 可能被当成独立 Invocation。

#### 目标流程

```text
用户请求 / Agent Task / RPC Run 开始
  ↓
创建或接收 invocationId
  ↓
Model Turn 1
  └─ ToolCall A
  ↓
Model Turn 2
  └─ ToolCall B
  ↓
Model Turn 3
  └─ ToolCall C
  ↓
最终响应、错误、取消或超时
  ↓
Invocation 结束
```

#### 功能要求

- first-party Adapter 优先使用外层任务/请求 ID。
- 没有外部 ID 时，在一次 Agent run 开始时生成 invocationId，并保持到 run 终止。
- model turn 使用独立 span，不重新生成 invocationId。
- ToolCall start/end 必须复用同一 toolCallId 和 invocationId。
- 并发 Invocation 使用各自上下文，不共享可变全局 currentInvocation。
- 取消、异常退出、进程崩溃和 Adapter 重启产生明确 incomplete 状态。
- 旧 sessionId、traceId 和 runId 保持原语义，不被新 Invocation 覆盖。

#### 验收

- 一次 Pi 用户请求的 read/write/bash/custom 共用一个 invocationId。
- 两次并发请求不互相串联。
- 多轮 model turn 保持父子关系，不能形成多个伪 Invocation。
- Adapter 丢失 end 时能够显示 incomplete，不静默合并到下一次调用。

### 5.5 功能五：认证 AgentTool 与 Asset/Runtime 合并

#### 要解决的问题

认证 Tool Span 当前只获得 correlation，但可能没有有效 Agent identity、Runtime 和 canonical workspace。

#### 目标合并链

```text
认证 Adapter / OTLP Source
  ↓
校验 tenant / environment / workspace / workload binding
  ↓
解析 Agent 业务身份
  ↓
与 Inventory 中 Agent label / Runtime root / physical workload 比较
  ↓
与强 Process tuple 比较
  ↓
绑定 Agent Asset
  ↓
绑定 Agent Runtime Instance
  ↓
绑定 Invocation / ToolCall
  ↓
生成服务器认可的 identity / role / profile / correlation
```

#### 功能要求

- producer 自报 agentId 不能单独创建 confirmed Agent。
- 认证 Source 的 scope binding、Kubernetes/Docker inventory、Agent label 和 Process tuple 共同决定 authority。
- Source workspace 与 Asset canonical workspace 使用明确 alias/binding 关系，不通过字符串偶然相等合并。
- Source、workspace、tenant 或 environment 冲突时拒绝高置信合并，并保留语义事件供审计。
- 服务器生成三轴语义，不能直接信任 producer 提交的分类。
- 认证语义事件即使没有 syscall，也应归入正确 Agent Asset/Runtime，并标为 semantic_only。

#### 验收

- 所有认证 Pi Tool Span 都能查询到 Agent Asset 和 Runtime。
- Asset inventory、Invocation 页面和 ToolEvidence 使用相同 canonical identity。
- 跨 workspace、跨 tenant 和恶意 producer claim 不会合并。
- AgentTool 不再落入 unclassified。

### 5.6 功能六：建立跨冷热存储的 ToolEvidence 索引

#### 要解决的问题

热 Ring 只适合低延迟展示；一旦事件被淘汰，按 invocationId、toolCallId 或 process tuple 查询宽表会扫描大量历史数据并失败。

#### 目标存储面

```text
Semantic Event Store
按 Invocation / ToolCall / Agent Runtime 查询

Kernel Evidence Index
按 Process generation / time / resource hash / command hash 查询

Tool Evidence Relation Store
保存 ToolCall 与 Kernel Evidence 的已验证关系、状态和版本

Raw / Canonical Event Store
保留兼容字段和完整事件事实
```

#### 目标查询流程

```text
invocationId / toolCallId
  ↓
读取语义事件和强 Process scope
  ↓
使用 Process generation + 有界时间窗查询 Kernel Evidence Index
  ↓
按 resource hash / command hash / parent relation 精确匹配
  ↓
读取或更新已验证 ToolEvidence relation
  ↓
返回 linked / semantic_only / unavailable
  + partial reason / freshness / storage source
```

#### 功能要求

- 热 Ring 和冷存储使用相同查询语义，不能返回不同的关系规则。
- invocationId、toolCallId、Agent Runtime、Process generation 成为可直接定位的查询键。
- 常用资源 hash、command hash 和 event time 具备有界查询路径。
- ToolEvidence relation 自身有版本和证据引用，不需要每次重新扫描全部事件。
- 历史查询不能依赖解析每一行 attribution JSON。
- 查询超时、索引延迟、存储不可用必须返回明确 partial，而不是空数组伪装“没有证据”。
- API 重启、热 Ring 淘汰和 ClickHouse merge 后结果保持一致。

#### 验收

- 最近一分钟、三小时、七天和三十天 ToolEvidence P95 均小于 2 秒。
- 热 Ring 淘汰后结果与热路径一致。
- 100 倍背景噪声下，无关事件不会耗尽 linker 候选预算。
- 同 PID 重用和同容器多 Agent 不发生跨 generation 错链。
- read、write、bash、custom 分别得到符合事实的 semantic_only 或 linked 状态。

---

## 六、第二优先级：完成服务上下文主旨

### 6.1 功能一：自动建立 Service Asset

#### 目标

系统初始化和持续运行时，将已有服务解析为稳定 Service Asset，而不是把它们长期留在 Agent Unknown 池。

#### 发现来源

- Kubernetes Service、Workload、Pod、Container、Owner Reference；
- Docker Container、Compose Project、Image、Label；
- systemd unit、主进程、cgroup；
- OTel Resource 中的 service、deployment、environment；
- Prometheus target 和 service discovery metadata；
- 受管数据库、消息队列、缓存和 AnySentry 自身组件。

#### 目标流程

```text
多源 Inventory
  ↓
物理 workload 归一化
  ↓
Service identity 合并
  ↓
建立 Service Asset
  ↓
关联 Runtime、Revision、Endpoint、Owner、Environment
  ↓
分配 workload role
  ↓
发布给身份解析、Capture Profile 和 System Context
```

#### 约束

- Service Asset 可以在 Agent identity 仍为 unknown 时建立。
- Service merge 必须基于稳定 inventory 和 resource identity，不基于进程名邻近。
- 重启产生新 Runtime Instance，但不应产生新的逻辑 Service Asset。
- 两个 workspace、tenant 或 cluster 的同名服务不能合并。
- 自动识别服务角色不自动授权 authoritative DROP。

### 6.2 功能二：接入真实 Prometheus / OTel 指标

#### 目标指标

每个目标服务至少覆盖以下两类，优先覆盖前三类：

```text
Traffic      request / message / operation rate
Errors       error rate / failed operations
Latency      P50 / P95 / P99
Saturation   CPU / memory / queue / connection pool / disk
Availability readiness / health / restart / replica availability
```

#### 目标流程

```text
Prometheus Target / OTel Resource Metrics
  ↓
校验数据源身份和 workspace / environment binding
  ↓
标准化 Metric Fact
service resource + metric name + value + unit + window
  ↓
计算 freshness、status 和 anomaly
  ↓
写入独立服务上下文面
  ↓
按 Agent 相关服务和时间窗进入 Bundle
```

#### 约束

- 指标缺失与指标正常必须严格区分。
- 不同单位和时间窗口不能直接合并。
- 原始高基数 label 不直接进入模型上下文。
- 只保留风险分析需要的有界摘要和来源引用。
- 没有配置 Prometheus/OTel 时，metrics domain 显示 partial 和明确原因。

### 6.3 功能三：构造 Agent → Service → Database 依赖边

#### 依赖来源优先级

```text
可信 Trace / Span service relationship
  ↓
认证 Tool target / application resource identity
  ↓
聚合网络边 + workload endpoint mapping
  ↓
Service inventory declared dependency
  ↓
仅时间邻近：不生成确定性依赖边
```

#### 目标关系

```text
Agent Runtime
  └─ calls → Business API
                 └─ queries → ClickHouse

Agent ToolCall
  └─ writes → Object Storage

Agent Runtime
  └─ publishes → Queue
```

#### 功能要求

- 依赖边包含 source、target、relation、event count、时间窗和置信度。
- 聚合网络边不要求保存每条服务 syscall。
- IP/port 必须解析到事件发生时的 endpoint generation，不能使用当前状态回写历史。
- 最多两跳进入风险 Bundle；完整图保留在服务拓扑面。
- 跨 workspace/tenant 的边必须有显式授权和来源。

### 6.4 功能四：同步部署、配置和版本变化

#### 目标事实

- workload revision、image digest、replica 变化；
- ConfigMap、Secret revision 变化的非敏感摘要；
- feature flag、runtime configuration 和依赖版本变化；
- 服务重启、迁移、扩缩容和 rollout；
- Agent Runtime 或 Adapter 版本变化。

#### 目标流程

```text
Deployment / Config Event
  ↓
绑定 Service Asset / Agent Runtime
  ↓
生成 Change Fact
  ↓
记录生效时间、来源、revision 和 freshness
  ↓
与 Agent Invocation / 服务异常时间窗比较
  ↓
相关变化进入 Bundle
```

不能把 Secret 内容写入上下文，只保留类型、版本、变更范围和安全摘要。

### 6.5 功能五：告警状态对账与过期

#### 要解决的问题

已恢复的 Coverage 或 Source 问题可能继续以 open alert 进入新 Bundle。

#### 目标生命周期

```text
问题检测
  ↓
Alert open
  ↓
持续对账当前事实
  ├─ 问题仍存在：refresh lastSeen
  ├─ 问题已恢复：resolved
  ├─ 目标被删除：closed / retired
  └─ 长期无法验证：stale / unknown
  ↓
Bundle 只纳入时间窗内有效状态
```

#### 功能要求

- Alert 不能只创建不关闭。
- 当前 Coverage、Collector、Source 和 Asset 状态是对账依据。
- Bundle 展示告警在事件时间点的状态，而不是只看当前 open 列表。
- stale 与 unresolved 分开表达。
- 被 supersede 的旧 Asset alert 不得污染新 Runtime。

### 6.6 功能六：构造有界 System Context Bundle

#### Bundle 内容

```text
Focus
Agent Asset / Runtime / Invocation / ToolCall

Evidence
Semantic + Kernel + relation confidence

Resources
相关 Service / Database / Queue / Storage

Topology
最多两跳依赖

Metrics
错误率 / 延迟 / 容量 / 健康

Changes
部署 / 配置 / 版本

Alerts
事件时间点有效告警

Quality
来源 / freshness / partial / aggregation / sampling / loss
```

#### 裁剪顺序

1. 精确 Tool target 和直接交互服务；
2. 直接依赖及其异常指标；
3. 第二跳关键依赖；
4. 同期变化和告警；
5. 采集质量；
6. 低相关背景事实在预算不足时优先省略。

#### 约束

- Bundle 必须按 workspace、tenant、environment 和时间窗隔离。
- 每条事实必须有 evidence source、freshness 和 association confidence。
- 已聚合的服务事件应显示 aggregated，不伪装为完整 raw evidence。
- 未配置数据源显示 partial；数据源明确返回健康才显示 normal。
- Bundle 大小、事实数、拓扑跳数和时间窗均有硬上限。

---

## 七、分层存储与查询职责

| 数据面 | 保存内容 | 主要查询键 | 目的 |
|---|---|---|---|
| 高保真 Agent Evidence | Agent semantic、关键 kernel、security、lifecycle | Asset、Runtime、Invocation、ToolCall、Process generation | 行为链和取证 |
| ToolEvidence Relation | 已验证的 semantic ↔ kernel 关系 | Invocation、ToolCall、relation version | 快速稳定取证 |
| Service Context | Asset、metrics、topology、changes、alerts | Service、resource、time window | 风险上下文 |
| Capture Aggregate | 精确计数、资源桶、窗口、profile | workload、probe、window | 降低 raw 量同时保留上下文 |
| Unknown Learning | family、cluster、count、first/reservoir samples | stable scope、reason、kind、window | 发现新 Agent 和规则候选 |
| Quality / Accounting | policy、epoch、ACK、loss、partial | collector、node、source、window | 解释数据完整性 |
| Canonical / Compatibility | 旧字段和可选新身份 | legacy trace/session/run + additive IDs | 保持现有消费者稳定 |

热 Ring 只承担短期低延迟缓存，不是任何证据关系的唯一事实源。

---

## 八、异常与降级流程

### 8.1 Inventory 不可用

```text
稳定历史角色仍在 TTL 内
  → 使用 LKG，显示 freshness

TTL 过期
  → 不执行 authoritative DROP
  → 服务角色降为 unknown / discovery-safe
  → 保留 Agent、安全和关键生命周期
```

### 8.2 SDK / OTLP 不可用

```text
保留 Process / Runtime 级 Kernel Evidence
  → Invocation / ToolCall 留空
  → 不使用时间邻近伪造调用
```

### 8.3 Process 证据不足

```text
保留认证 Tool Span
  → ToolEvidence = semantic_only
  → 明确 kernel evidence unavailable 原因
```

### 8.4 Metrics 数据源不可用

```text
保留最近有效事实及 freshness
  → 超过 TTL 后标记 stale
  → Bundle metrics domain = partial
  → 不生成“服务正常”结论
```

### 8.5 冷存储查询不可用

```text
返回 partial + storage_unavailable
  → 不把空结果解释为没有证据
  → 触发可观测性告警和有界重试
```

### 8.6 behavior 与服务角色冲突

```text
强 Agent 证据存在
  → Agent 身份优先，精确 root 升档

只有弱 behavior
  → 服务角色优先，不提升为 Agent
  → behavior 作为调查候选和审计事实保留
```

---

## 九、开发阶段与依赖顺序

### Phase A：部署和身份事实正确性

- 补齐所有组件 rollout mode 和能力协商。
- 建立稳定 Service Role，不让弱 behavior 覆盖 inventory。
- 增加 probable_investigation 档位。
- 验证 Host、Docker、Kubernetes 混合环境。

退出门槛：

- false-Agent 为 0；
- Agent recall 100%；
- Unknown 原因码覆盖 100%；
- canonical 重装后新语义仍开启。

### Phase B：Invocation 和持久 ToolEvidence

- 建立外层 Invocation 生命周期。
- 合并认证 Tool Span 与 Asset/Runtime。
- 建立 ToolEvidence 关系与冷存储查询面。
- 执行 PID reuse、并发 Invocation、同容器多 Agent 验证。

退出门槛：

- read/write/bash 共用一次 Invocation；
- 冷热路径结果一致；
- ToolEvidence P95 < 2s；
- 不发生跨 Process generation 误链。

### Phase C：Service Asset 与真实上下文

- 建立 Service Asset。
- 接入 Prometheus/OTel 指标。
- 建立最多两跳依赖。
- 同步部署和配置变化。
- 完成告警状态对账。

退出门槛：

- Agent → Service → Database 场景完整；
- 每个目标服务至少两类真实指标；
- Bundle 在缺失源时正确 partial；
- stale alert 不进入新风险结论。

### Phase D：总链路与长期稳定性

- 连续运行 24 小时以上。
- 执行峰值和两倍峰值负载。
- 验证控制面断连、TTL、LKG、存储阻塞和重启。
- 验证 Unknown Learning 长期容量。
- 验证风险升档、恢复和 rollback。

退出门槛：

- Ring/Collector/Critical 物理丢失为 0；
- 策略不变时 epoch 不随 PID churn 高频增长；
- Unknown 发现容量不被单一高频服务耗尽；
- Context、ToolEvidence 和风险结论在重启后仍可恢复。

---

## 十、端到端验收场景

### 场景一：基础设施不再误识别为 Agent

```text
启动 ClickHouse / Postgres / Redis / CoreDNS
  ↓
Inventory 建立 Service Asset 和 infrastructure role
  ↓
behavior 观察到工具、文件和网络活动
  ↓
角色优先，身份不提升为 Agent
  ↓
高频 File/Network 进入 AGGREGATE
  ↓
服务指标和健康仍进入 Context
```

验收：false-Agent 为 0，服务上下文仍可用。

### 场景二：发现新的真实 Agent

```text
启动无显式模板的新 Agent
  ↓
首次 Exec 和 Process generation 保留
  ↓
probable_investigation 有界采集
  ↓
观察到 Agent-like sequence / Adapter / Runtime signature
  ↓
确认 Agent Asset 和 Runtime
  ↓
精确 root 及后代升为 agent_full
```

验收：Agent recall 100%，背景 workload 不被整体升档。

### 场景三：一次 Pi 调用的完整行为链

```text
用户发起一次 Pi 请求
  ↓
创建 Invocation
  ↓
write → read → bash → custom
  ↓
每个工具独立 ToolCall，但共享 Invocation
  ↓
write 匹配 same_process_resource
bash 匹配 direct_child_command
read 无内核读探针时 semantic_only
custom 无本机 syscall 时 semantic_only
  ↓
热 Ring 淘汰
  ↓
冷存储仍能在 2 秒内返回同一 ToolEvidence
```

### 场景四：Agent 访问业务服务并影响数据库

```text
Agent ToolCall 调用 Business API
  ↓
Trace / Network Aggregate 建立 Agent → API 边
  ↓
Service Graph 建立 API → ClickHouse 边
  ↓
API 同期 error rate、P95 latency 异常
  ↓
同期发生 deployment revision 变化
  ↓
Bundle 包含两跳资源、指标、变化、ToolEvidence 和采集质量
  ↓
风险分析给出可回指证据的结论
```

### 场景五：数据源缺失

```text
未配置 Prometheus
  ↓
Inventory 和 Kernel Evidence 正常
  ↓
Bundle metrics domain = partial
  ↓
风险结论明确“指标不可用”，不能声称服务正常
```

### 场景六：历史告警已经恢复

```text
Collector 覆盖问题产生告警
  ↓
Collector 恢复并持续健康
  ↓
Coverage 对账关闭旧告警
  ↓
后续 Bundle 不再把旧告警作为当前风险事实
```

---

## 十一、最终验收矩阵

| 维度 | 指标 | 必须结果 |
|---|---|---|
| Agent 召回 | 已知和新 Agent root/tool marker recall | 100% |
| false-Agent | ClickHouse/Postgres/Redis/control plane | 0 |
| Unknown 语义 | not_evaluated | 0 |
| Unknown 完整性 | 闭集原因码覆盖 | 100% |
| probable 成本 | 每 workload 原始事件上限 | 有界且可观测 |
| Invocation | 单次 Pi read/write/bash invocationId | 完全一致 |
| 并发隔离 | 两次 Invocation 串链 | 0 |
| Asset 合并 | 认证 AgentTool 无 Asset/Runtime | 0 |
| ToolEvidence | 热/冷 P95 | < 2s |
| ToolEvidence 正确性 | PID reuse / 跨 Agent 误链 | 0 |
| 服务资产 | 目标服务自动建模覆盖 | 100% |
| 服务指标 | 每服务指标类型 | 至少 2 类 |
| 依赖上下文 | Agent → Service → DB | 最多两跳完整可见 |
| 变化上下文 | 部署/配置变化关联 | 可回指来源和 revision |
| 告警对账 | 已恢复 stale alert 进入新 Bundle | 0 |
| Bundle 质量 | source/freshness/confidence/partial | 100% |
| Ring 安全 | Ring/Collector/Critical drop | 0 |
| 控制稳定性 | 无策略变化时高频 epoch churn | 0 |
| API 资源安全 | 资产/规则/事件三页并行 15 分钟 | 无 OOM、无重启、RSS 稳态低于容器预算 75% |
| 历史读取 | 聚合资源不足后的同请求全窗重扫 | 0；返回 LKG 或明确 hot/partial |
| 心跳状态 | Collector heartbeat 热状态 | 增量持久化；条数和字节双重有界 |
| 健康检查 | readiness/liveness 复杂度 | O(1)，不扫描事件或关联图 |
| 学习器 | 单一噪声耗尽新 Agent 发现容量 | 不允许 |
| 兼容性 | 旧 Trace/Incident/Alert/Flink key | 保持原值和行为 |

### 运行资源边界

数据闭环降低 Ring 压力后，不能把相同压力转移到 API 和历史查询。目标运行链路还必须满足：

```text
Collector Heartbeat
  → 逐条写入时序事实表
  → API 只保留近期、条数和字节双重有界的工作集
  → 不再周期性序列化或恢复整个历史数组

Dashboard / Asset 历史读取
  → 只用窄字段折叠最新 decision revision
  → 使用明确的查询内存、线程和执行时间预算
  → reusable history 失败时返回 LKG 或 hot/partial
  → 不在同一请求继续启动第二次完整历史扫描

readiness / liveness
  → 只读取写入时维护的常数时间计数
  → 不扫描事件 Ring，不构建 correlation Map/Set
```

这条边界保证观测页面、身份快照和采集控制面不会互相拖垮；否则 API 失去响应会进一步使 activation grant 失效，最终让 Ring 前策略反复进入 discovery-safe，形成资源正反馈。

---

## 十二、完成后的最终运行示例

一个完整的目标场景应当这样运行：

```text
1. AnySentry 启动
   发现 Kubernetes 中的 Pi Agent、Business API 和 ClickHouse。

2. 建立资产
   Pi → Agent Asset / Runtime
   Business API → Service Asset
   ClickHouse → Database Service Asset

3. 获取服务上下文
   API 的请求量、错误率、P95 延迟和容量进入服务上下文面；
   ClickHouse 的连接、查询失败和磁盘/合并饱和度进入上下文面。

4. 编译采集档位
   Pi 精确 root 为 agent_full；
   Business API 为 business_context；
   ClickHouse 为 infrastructure_aggregate；
   其余未知进程为 unknown_discovery。

5. 用户发起一次 Pi 请求
   创建一个 Invocation；多次模型回合和 write/read/bash 共用该 Invocation。

6. 采集真实行为
   Tool Span 说明 Pi 为什么调用工具；
   Kernel Evidence 证明 write/bash 实际执行；
   业务服务高频 syscall 在 Ring 前聚合。

7. 建立依赖
   Pi 调用 Business API；Business API 查询 ClickHouse；形成最多两跳关系。

8. 构造上下文
   选取该 Invocation、ToolEvidence、API 异常指标、ClickHouse 饱和、同期部署变化和采集质量。

9. 风险分析
   L1/L2/L3 基于真实证据和服务状态判断风险，并能回指每个事实来源。

10. 反馈闭环
    如果发现新 Agent，进入 probable_investigation 再确认；
    如果确认服务噪声，只生成安全候选策略；
    任何 DROP 仍经过审核、canary、ACK 和 grant。
```

最终状态不再是“把所有事件永久保存后再尝试理解”，而是：

> 先识别对象和职责，再决定采集精度；用 SDK 提供语义、内核提供事实、服务数据提供环境；通过可持久查询的关系把它们组织成一次真实 Agent 行为及其业务影响。
