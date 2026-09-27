# 通用 Agent 服务发现、选择性采集与跨服务观测设计

状态：已审核，分阶段实现与验收中（真实服务、canonical durable point-read、classic SSL 仍有未完成闸门）
适用仓库：`AnySentry`、`Observer`
当前基线：AnySentry `976d0b0`，Observer `ece8e49`
日期：2026-09-11

## 1. 设计结论

本设计解决两个同时存在的问题：

1. 以 LangChain、LangGraph、LangServe 或自定义 HTTP Agent 为基础的服务，不能因为工具名称、Python 文件名、端口号或某个框架版本没有命中规则，就无法被发现和归因。
2. 为了“先把所有事件采上来”而开启全量采集，会使 eBPF Ring、Collector、Forwarder、WAL 和页面查询产生反压，最终出现丢失、卡顿、延迟和无法判断的观测空洞。

目标不是为每个框架增加一组产品规则，而是建立一条产品中立的运行时观测链路：

```text
内核事实与进程生命周期
  → 物理工作负载上下文
  → 通用行为窗口与候选评分
  → 可解释的 CandidateAgent / ConfirmedAgent
  → 有界、分层、可热更新的采集计划
  → HTTP/TLS/LLM 明文与内核事实独立留存
  → Session / Run / NodeRun / AgentInvocation
  → 父子 Agent 视图和 EvidenceLink
```

候选发现、采集规则、语义解析和风险判断必须保持边界：

- 候选发现可以提升采集优先级，但不能修改已经发生的原始事实；
- 规则系统决定事件在各阶段如何保留、聚合或采样，但不能把 Unknown 等同于 Non-Agent；
- 明文解析失败不应删除 KernelFact；
- 语义事件和内核事件可以关联，但不能以时间相近为唯一因果证据；
- 性能优化只能减少重复、低价值和可重建数据，不能以全局丢弃换取表面吞吐。

## 2. 当前事实、目标状态和未验证项

### 2.1 当前已确认事实

- AnySentry 已有 LogicalAgent、AgentInstance、RuntimeInstance、Session、Run、AgentInvocation 和 EvidenceLink 相关模型。
- AnySentry 已有统一过滤规则目录，并将规则投影到 F0 身份、F1 Ring 前、F2 Forwarder、F3 API/持久化阶段。
- Observer 已有进程代次、cgroup、FileAccess 独立过滤、capture profile、规则 epoch 和行为发现基础。
- `renameat`、`renameat2`、`linkat` 已被纳入写入型 FileAccess，和既有 FileAccess 规则共用。
- `probable_agent` 已有完整采集语义，候选身份不再默认代表低质量采集。
- LangGraph 跨 Agent hop 已有 `AgentInvocation` 和 delegation header 的协议基础。

### 2.2 当前限制

- Observer classic SSL WIP 仍在工作区，TLS/明文重组尚有 websocket idle、Rustls moved pointer 绑定和歧义处理失败项。
- LangChain/LangGraph 服务的“启动即发现”尚未形成与服务定义、监听生命周期和部署代次一致的通用路径。
- 某些行为判断仍可能依赖固定厂商域名、固定服务目录或具体产品提示，尚未全部抽象为 capability registry。
- canonical Session、EvidenceLink 在持久化压力下必须以 point-read 和 `coverage=complete` 验证，不能只根据健康检查、热环数据或页面计数判定成功。

### 2.3 本设计中的状态标记

本文使用以下标签：

- **已确认**：当前源码或当前测试已经直接证明。
- **目标行为**：设计完成后必须达到，但当前不表示已经实现。
- **待验证**：需要真实 Collector、Forwarder、API、存储或页面链路证明。
- **覆盖缺口**：系统明确知道某一层没有足够证据，必须展示 partial、ambiguous 或 unlinked。

## 3. 用户看到的实际效果

以下示例描述目标行为，不代表当前版本已经全部通过。

### 3.1 通用 HTTP Agent 服务

一个服务提供：

```http
POST /invoke
Content-Type: application/json

{"input":"分析订单异常并给出处理建议"}
```

服务内部可能使用 LangChain，也可能使用自定义 Python、Rust 或 Node 工作流。AnySentry 不需要知道工具叫 `search_orders`、`lookup_customer` 还是 `tool_17`。它应看到：

```text
LogicalAgent: order-analysis-service
  definitionType: service
  identityAuthority: inferred | registered

AgentInstance: deployment-revision-42
RuntimeInstance: k8s pod UID + container ID + process generation

Session: per-request:9a...
Run: run:4f...

Turn 1
  inbound POST /invoke
  user input: 分析订单异常并给出处理建议
  outbound model interaction
  ToolCall: rawName=tool_17, canonicalKind=unknown_tool
  ToolExecution: process generation + Exec + Network + File evidence
  ToolResult
  model final output
```

如果请求携带真实 `thread_id`、`conversation_id` 或服务注册的 session key，则 Session 使用该稳定锚点；没有真实锚点时显示为 `per_request / ephemeral`，不伪造成可恢复会话。

### 3.2 LangGraph 循环工作流

对于一个包含 `planner → executor → verifier → planner` 的服务：

```text
LogicalAgent: research-graph
Session: thread-abc
Run: run-20260911-001

NodeRun 1: planner
  LLM call
NodeRun 2: executor
  ToolCall: rawName=internal_lookup
  ToolExecution: Exec / Egress / FileAccess
NodeRun 3: verifier
  LLM call
NodeRun 4: planner
  LLM call
NodeRun 5: finalizer
  final output
```

同一 `thread_id` 下的多个 `run_id` 进入同一 Session 的不同 Run；同一个 Run 的循环节点不会被拆成多个互不相关的对话。若 `thread_id` 不可见，则每次外部调用建立一个明确标记的 ephemeral Session，并保留 `identityQuality=ephemeral`。

### 3.3 父 Agent 调用子 Agent

父工作流调用另一个 HTTP Agent 时，父视图展示：

```text
NodeRun: planner
  AgentInvocation
    target: customer-research-service
    input: 查询客户最近三次投诉
    output: 返回 3 条摘要
    egress: parent process → target address:port
    evidence: kernel fact + delegation correlation
    childLink: 打开子 Agent 视图
```

父视图不复制子 Agent 内部的每个 LLM、Tool、File 和 Exec 事件。进入子 Agent 视图后，才能看到：

```text
子 Agent Session
  inbound request
  child LLM call
  child ToolCall / ToolResult
  child Exec / File / Network / TLS
  child final response
```

这样可以同时满足“父工作流知道自己调用了谁”和“子服务内部细节不被重复归因”。

### 3.4 证据不足时的展示

系统不得把缺少证据的情况显示为完整成功：

```text
Kernel: complete
Plaintext: partial
Session: ephemeral
Tool → Kernel: ambiguous
Persistence: canonical_store, coverage=complete
```

如果只有 egress，没有足够证据把它绑定到子服务的具体 Run，应显示 `AgentInvocation` 的目标和连接事实，同时将内部关联标记为 `unlinked`，而不是把子服务的事件强行挂到父 Run。

## 4. 通用身份模型

### 4.1 四层实体

```text
LogicalAgent
  稳定的服务/工作流/应用定义

AgentInstance
  一次部署、配置修订或注册代次

RuntimeInstance
  一个 Pod、容器或宿主进程代次

Session / Run / NodeRun
  一次外部交互、一次执行和执行树节点
```

稳定身份优先使用注册定义、工作流定义、服务配置指纹和平台元数据。以下内容不能单独生成稳定 LogicalAgent：

- PID、端口、TTY、Pod 名称、短容器 ID；
- Python 文件名或 `main.py`；
- 一个工具名称；
- 某个框架版本或包版本；
- 某个厂商域名；
- 最近一次事件的时间戳。

### 4.2 进程与工作负载键

宿主进程使用：

```text
ProcessGenerationKey = host_id + boot_id + pid + start_time_ticks
HostProcessTreeKey   = host_id + boot_id + root_pid + root_start_time_ticks + root_executable_digest
```

容器和 Kubernetes 使用完整的物理标识：

```text
DockerRuntimeKey = host_id + container_id
KubernetesRuntimeKey = cluster_id + pod_uid + container_id
```

PID 只是索引，不能跨 start time 继承身份。父子关系必须优先使用 generation-safe process graph；只有缺少代次证据时，才保留低置信度的 legacy PID 关系。

## 5. 通用 Agent 发现算法

### 5.1 发现输入

算法只使用 Observer 已采集的内核事实、进程生命周期和受控明文元数据：

- ProcessExec、ProcessExit、Fork、父子进程关系；
- Connect、Egress、DNS、TLS/SNI 和连接方向；
- FileAccess、FileRead、FileDelete；
- SecurityAction；
- LLM/HTTP 明文的协议形状、请求响应方向、模型操作和 request/session 锚点；
- 监听 socket、入站连接和 HTTP 方法/路径形状；
- 物理工作负载和部署上下文。

解析器可以识别通用协议能力，例如 HTTP/1.1、HTTP/2、SSE、WebSocket、JSON-RPC 和 Anthropic-compatible message shape；具体厂商格式只能作为可插拔 Format Adapter，不能成为候选发现的必要条件。

### 5.2 有界行为窗口

每个 `ProcessGenerationKey` 或物理工作负载维护一个 bounded window：

```text
windowMs
maxWorkloads
maxUniqueTools
maxNetworkTargets
maxChildProcesses
probableTtlMs
```

窗口只保存计数、哈希、短摘要和有限集合，不保存无界的原始明文和完整事件历史。所有 map、queue、pending store 都必须有容量、字节数、TTL、LRU/淘汰和 drop reason 指标。

### 5.3 评分信号

建议将信号注册为版本化 `BehaviorSignalRegistry`，而不是把规则写在 LangChain/LangGraph 分支中：

| 信号 | 默认作用 | 说明 |
|---|---:|---|
| 可确认的模型/LLM 操作 | +4 | 来自协议形状或格式 registry，不依赖固定域名 |
| ToolExecution | +1 | 使用 canonical tool kind；未知工具也计入 |
| 不同工具集合 | +1/个，上限 3 | 工具名字仅是证据，不是身份规则 |
| LLM/Tool 交替 | +2/次，上限 6 | 反映决策与执行循环 |
| 网络决策后再次执行不同工具 | +4/次，上限 8 | 强行为序列 |
| 工具后工作区文件变化 | +1 | `/proc`、`/sys`、`/dev` 和服务状态目录排除 |
| 子进程扇出 | +1 | 只作辅助证据 |
| 单一基础设施进程、服务状态写入、无 Agent 循环 | 负向 | 只能降低概率或标记 infrastructure |

一个候选至少需要满足以下任一通用形状：

```text
LLM + Tool + (交替或多个不同工具)
```

或：

```text
Tool → Network/DNS/LLM decision → 不同 Tool → Workspace change
```

单纯文件抖动、单一工具、数据库状态写入、日志轮转或基础设施网络流量不能晋升 Agent。

### 5.4 状态和滞回

```text
unknown
  └─ score >= promoteThreshold 且满足行为形状
       → probable_agent

probable_agent
  ├─ TTL 内继续保留完整采集
  ├─ 新窗口无证据但未出现强负向证据 → 保留至 TTL 结束
  └─ 明确基础设施模式 → 取消候选并回到 unknown/infrastructure

confirmed_agent
  ← 注册、可信平台元数据、认证 Adapter 或人工确认
```

`probable_agent` 不是 `confirmed_agent` 的别名。候选必须保存 score、threshold、evidence、algorithmVersion、window 和 TTL，页面能够解释为什么晋升。

## 6. 三阶段过滤和采集计划

### 6.1 F0：身份与工作负载上下文

F0 不丢事件，只产生上下文：

```text
RawObservation
  → ProcessGeneration
  → WorkloadContext
  → IdentityClassification
```

F0 可合并注册定义、Kubernetes/Docker inventory、进程图、CandidateAgent 和基础设施事实。它不能在每个事件热路径上调用 Kubernetes API、Docker API、数据库或模型。

### 6.2 F1：eBPF Ring 前准入

F1 只能使用稳定键和已物化快照：

| 情况 | F1 动作 |
|---|---|
| confirmed Agent 根进程/代次 | 完整采集；生命周期和明文不得降级 |
| probable Agent 根进程/代次 | 完整采集；候选 TTL 内保持 Agent profile |
| Agent 冲突 | Agent keep wins；保留 conflict evidence |
| Unknown Exec/Exit/Security | 保留；这些是发现和审计基础 |
| Unknown TLS/LLM/Network | 保留必要发现信号，不能因未识别而全局 drop |
| 高频 FileAccess/FileRead | 仅按显式 file policy keep/sample；不影响其他 probe |
| stale epoch/map miss/config invalid | discovery-safe fail-open，记录 reason counter |

F1 不解析完整 HTTP JSON，不判断工具名称，不访问远端控制面。规则快照必须带 `epoch`、`generatedAt`、`expiresAt`、`contentHash` 和校验结果。

### 6.3 F2：Collector/Forwarder 语义分层

F2 对已经进入 Ring 的事件执行完整分层：

```text
Transport/Kernel decode
  → process/workload attribution
  → infrastructure facts
  → semantic parsing
  → CandidateAgent scoring
  → retention/aggregation decision
```

基础设施信号先于 Agent 行为晋升，避免数据库、消息队列和 AnySentry 自身服务制造候选。未知事件默认保留 bounded evidence；若进入兼容采样模式，必须保留采样计数、窗口、hash 和原因。

### 6.4 F3：API、持久化和查询投影

F3 负责：

- canonical Agent/Session/Run/NodeRun/AgentInvocation 写入；
- ToolCall、ToolExecution、KernelFact、PlaintextChunk 和 EvidenceLink 的独立证据保存；
- 明文 Parser 的 semantic projection；
- coverage、partial、ambiguous、unlinked 状态；
- Conversation View 与 Evidence View 的分离；
- 有界分页、时间窗口和 exact membership point-read。

读请求不得重新投影全量历史，不得因为页面轮询写回 PostgreSQL。缺少 canonical row 时只能显示 hot-ring 或 compatibility projection，并明确 `coverage=partial`。

## 7. HTTP 服务启动和每次调用的生命周期

### 7.1 启动识别

启动识别分为三种来源，优先级从高到低：

1. 注册的服务/工作流定义和部署配置；
2. 平台 inventory、监听生命周期、容器/Pod 元数据和可信标签；
3. 无注册时由监听 socket、HTTP server 生命周期、进程代次和后续入站 POST 产生 CandidateAgent。

端口本身只能是辅助事实，不能成为 LogicalAgent ID。服务启动时如果已具备定义或平台绑定，应立即创建 AgentInstance/RuntimeInstance；没有绑定时，应先显示 `candidate/unresolved`，而不是等第一条 LLM 明文才突然出现。

### 7.2 入站请求

每个入站 HTTP 请求记录：

```text
requestId / traceId / delegationId（如果存在）
method + normalized route shape
process generation + runtime instance
request/response timestamps
provider/session/thread/run anchors（如果可见）
```

路径匹配使用通用 route shape，例如 `/invoke`、`/runs`、`/stream` 或注册的 route manifest；不能要求某个服务文件名或某个工具名称。

### 7.3 Session 和 Run

| 观测到的标识 | AnySentry 实体 |
|---|---|
| `thread_id`、稳定 `conversation_id`、注册 session key | Session |
| `run_id`、workflow run id、一次外部 request id | Run |
| graph node、chain step、tool span | NodeRun / ToolCall |
| 没有真实会话标识 | per-request ephemeral Session |

Session、Run 和 RuntimeInstance 不得混为一个 ID。服务重启生成新的 AgentInstance/RuntimeInstance，但同一个真实 thread 可以跨 RuntimeInstance 继续，只要有明确 session anchor。

## 8. 跨 Agent 关联

### 8.1 关联条件

父 Agent 调用子 Agent 时，关联优先级为：

1. 显式 `delegationId` 或可信 trace/span parent-child；
2. 父 outbound request 与子 inbound request 的连接、时间、请求标识和目标工作负载共同证明；
3. 只有 egress 和时间相近时，保留 `possible_delegation` 或 `unlinked`，不强行合并。

### 8.2 事件边界

```text
父 Agent
  AgentInvocation(send)
  egress KernelFact

子 Agent
  AgentInvocation(receive)
  inbound request
  child Session / Run / NodeRun
  child Tool / Kernel / Plaintext facts
  AgentInvocation(reply)
```

父视图只展示父侧调用摘要和子 Agent deep link；子视图展示子侧完整细节。EvidenceLink 中保存 `method`、`confidence`、`authority`、`algorithmVersion`、时间差和 competing candidates。

## 9. 性能和稳定性设计

### 9.1 不允许的优化方式

- 为了减少延迟，关闭所有未知事件；
- 为了提高识别率，把所有 probe 设成 FULL；
- 用全局 `clear()` 清空 pending map；
- 在 eBPF 或每事件路径访问 API、Docker、Kubernetes、数据库或模型；
- 用产品名、端口、工具名增加越来越多特例；
- 用页面显示数量代替 durable delivery 和 coverage 证明。

### 9.2 分层预算

每个 Observer 节点需要暴露并设置可配置预算：

```text
Ring capacity / per-lane reserve
Collector channel capacity
Forwarder queue bytes and events
WAL/spool max bytes
pending plaintext bytes and records
per-connection fragment limit
per-workload behavior window size
per-session semantic items
API query rows and time span
```

所有预算耗尽都必须产生独立指标：

```text
ring_dropped
collector_queue_dropped
forwarder_queue_dropped
plaintext_evicted
behavior_window_evicted
wal_write_failed
wal_spool_at_capacity
query_scan_limited
canonical_persistence_dropped
```

不能把采样、聚合、Ring 丢失、WAL 丢失和 API 查询截断合并成一个 `dropped`。

### 9.3 运行时控制策略

规则更新采用 snapshot + epoch + ACK：

```text
Candidate/Identity change
  → compile F1/F2/F3 projections
  → atomic snapshot write
  → Observer load + validate
  → ACK loaded epoch
  → Forwarder marks effective
```

新规则未 ACK 前不能宣称已经生效。规则过期、版本不一致、ACK 超时和快照损坏时回退到最后有效快照或 discovery-safe；不能静默使用一个可能造成破坏性丢失的空规则。

## 10. 实现拆分

### Phase A：通用发现合同

新增或收敛以下合同：

```text
BehaviorSignalRegistry
BehaviorWindow
CandidateAgentFact
FilterRuleSnapshot
FilterDecisionReceipt
WorkloadContext
CoverageGap
```

目标：移除算法对具体工具名称、固定服务文件和具体版本的必要依赖；保留产品 Adapter 作为可选语义增强。

### Phase B：Observer F1 和采集预算

- 核对 confirmed/probable 根进程的 generation fence；
- 确保 Unknown lifecycle/security/non-file discovery 信号不会被全局 drop；
- 保持 FileAccess、FileRead、FileDelete 独立控制；
- 增加每类 Ring、Collector、Forwarder、WAL drop reason；
- 对 plaintext pending、connection fragment 和 behavior window 增加容量/TTL/淘汰指标；
- 在 classic SSL WIP 通过前，不宣称 TLS 全链路 complete。

### Phase C：通用服务生命周期

- 监听生命周期和服务定义进入 AgentInstance/RuntimeInstance；
- generic HTTP route shape 和请求边界进入 Session/Run；
- 支持 `thread_id`、`conversation_id`、`run_id`、per-request fallback；
- graph node 与工具调用作为 NodeRun/ToolCall，不按工具名建立硬编码身份。

### Phase D：跨 Agent hop 和双视图

- 统一 delegation envelope；
- 父侧 AgentInvocation 与子侧接收/回复事件；
- 父视图只显示摘要和 deep link；
- 子视图显示完整内部 Kernel/Plaintext/Semantic evidence；
- EvidenceLink 采用 generation-safe ownership arbitration。

### Phase E：canonical 持久化和真实服务验收

- canonical Session/Run/AgentInvocation/KernelFact/EvidenceLink point-read；
- PostgreSQL/WAL 压力窗口验证；
- generic HTTP Agent fixture；
- graph loop fixture；
- parent → child Agent fixture；
- LangChain/LangGraph 作为适配验证样例，不作为实现边界。

## 11. 测试和验收矩阵

### 11.1 单元和合同测试

- 任意工具名、任意节点名仍能生成 ToolCall/ToolExecution；
- 改变进程名、端口、工作目录和服务文件名不改变候选算法结论；
- 同 PID 不同 start time 不继承 Agent 身份；
- 同一服务多容器、多 Pod、副本和重启不会合并 RuntimeInstance；
- 未知协议保留 RawObservation/KernelFact 并生成 CoverageGap；
- Candidate TTL、窗口淘汰和容量淘汰可解释；
- F1 snapshot epoch、stale、map miss、conflict 和 ACK 行为可重复验证。

### 11.2 过滤性能测试

至少执行：

```text
unknown host workload sustained window
high-volume FileAccess window
mixed Agent + Infrastructure window
LLM/TLS fragment burst
many concurrent HTTP sessions
WAL/spool pressure window
```

每个窗口必须同时记录：

```text
observed
selected
sampled
aggregated
filtered
ring dropped
collector dropped
forwarder dropped
WAL/spool backlog
query latency
canonical persistence coverage
```

不能只报告“事件数量下降”或“页面最终出现 Agent”。

### 11.3 服务级验收

使用至少三个不依赖具体产品名称的 fixture：

1. 无状态 HTTP Agent：每次 POST 一个 ephemeral Session；
2. 有状态 graph Agent：同一 thread 的多次 run 保持 Session，循环节点归入一个 Run；
3. 父 Agent 调用子 Agent：父子视图分离，delegation 和 egress 可追踪。

LangChain/LangGraph 原生服务作为真实技术栈验证样本，验收重点是通用能力是否工作，而不是是否命中 LangChain/LangGraph 专用分支。

### 11.4 放行标准

只有同时满足下列条件，才允许称为“该阶段完成”：

- Candidate/Confirmed identity 有可解释证据；
- F1/F2/F3 使用同一 rule lineage 和可追踪 epoch；
- Observer 没有新增不可解释的 Ring/Collector/Forwarder/WAL drop；
- LLM 明文、KernelFact、Session/Run 的覆盖状态分别报告；
- 父子 Agent 关系没有重复计数或错误合并；
- canonical point-read 返回 `coverage=complete`；
- 失败、歧义和未解析数据明确显示 partial/ambiguous/unlinked；
- 查询延迟和队列/WAL backlog 在既定预算内；
- 不依赖特定 Agent 名称、版本、工具名、文件名或固定端口。

## 12. 开发纪律

每次修复可观测性问题时，提交说明必须同时回答：

1. 这次改动扩大了哪类通用覆盖，而不是只修复哪个产品实例？
2. 它在哪个阶段改变了保留、采样、聚合或丢弃？
3. 它增加了哪些容量、延迟和 drop 指标？
4. 它是否改变了 LogicalAgent、AgentInstance、RuntimeInstance、Session 或 Run 边界？
5. 明文链路失败时，KernelFact 是否仍然保留？
6. 是否有非产品特定 fixture 和压力窗口证明没有通过全量采集掩盖性能问题？
7. 哪些结果是已确认，哪些仍是 partial、ambiguous 或未验证？

任何只增加工具名、路径名、端口号或具体版本判断的修复，必须先说明为什么 capability registry、进程代次、服务生命周期和协议形状不足以解决问题；否则不应合入主链。
