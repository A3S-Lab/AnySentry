# AnySentry 可信关联身份、采集过滤与开发阶段设计

## 结论

你的担心是对的。前面那句话应当被解释为：

> 统一身份层级、可信来源、解析优先级和置信度，不是修改或重命名现有 Trace 字段。

我建议把“Trace 关联优先级”正式改称为“可信关联解析优先级”，避免误以为所有关联结果都要写入 `traceId`。

推荐采用永久兼容模式：

- 不重命名、不覆盖、不重新计算现有 `agentId`、`sessionId`、`traceId`、`runId`、`agentInstanceId`、`agentCorrelationId`。
- 不回写历史 `traceId`。
- 新增可选的 `invocationId`、`toolCallId` 和 `correlation` 解析结果。
- 现有页面、告警、Incident、Evidence Bundle、Flink 状态继续读取旧字段。
- 新身份先双写、影子比较，之后由具体功能逐步选择是否读取新字段。
- 即使未来新链路完全成熟，也不需要把 `invocationId` 写回 `traceId`。

原因是当前 `traceId` 已经参与事件检索、Timeline、Incident ID、Alert 去重、证据包、统计和流处理。直接覆盖会造成旧链接失效、Incident 分裂、重复告警和流状态切换。当前事件契约可见 [types.ts](../apps/api/src/security-monitoring/types.ts)，持久化结构可见 [clickhouse-store.ts](../apps/api/src/security-monitoring/clickhouse-store.ts)，现有 synthetic trace 生成逻辑可见 [sentry-judge.service.ts](../apps/api/src/security-monitoring/sentry-judge.service.ts)。

---

## 一、重新理解五层身份：它是关联图，不是字段替换链

原来的表达：

```text
AgentAssetId
  → AgentRuntimeInstanceId
    → InvocationId / TraceId
      → ProcessInstanceId
        → EventId
```

可以帮助建立高层认知，但实现时不应做成严格的数据库父子链。更准确的关系是：

```text
AgentAsset
  └─ AgentRuntime
       ├─ ProcessInstance 0..N
       ├─ Invocation 0..N
       │    ├─ Trace / Span 0..N
       │    └─ ToolCall 0..N
       └─ 无法定位 Invocation 的 Runtime 级事件

Event
  ├─ 必须关联 ProcessInstance
  ├─ 尽量关联 AgentRuntime
  └─ 只有证据足够时才关联 Invocation / ToolCall
```

原因是长期运行的 Agent 服务可能只有一个进程，却同时处理多个 Invocation。仅凭 PID、进程根或容器，无法正确区分并发调用。

### `TraceId` 与 `InvocationId` 不是同一个概念

- `traceId`：OpenTelemetry 或现有 AnySentry Trace 链路的标识，属于可观测性传输和查询语义。
- `invocationId`：一次 Agent 调用、一次任务执行或一次请求的业务语义标识。
- 一个 Invocation 可能包含多个 Trace。
- 一个 Trace 也可能包含 Agent 之外的服务 Span。
- 没有可信 Invocation 时，不能用 root PID、container ID 或时间窗口伪造一个 Invocation。

因此，可信关联优先级决定的是：

```text
这个事件最多可以被关联到哪一层，
关联方法是什么，
关联范围是什么，
置信度是多少。
```

它不决定“应该向 `traceId` 写什么”。

---

## 二、兼容优先的数据模型

### 1. 现有字段映射

| 概念 | 现有字段 | 处理方式 |
|---|---|---|
| Agent Asset | 查询时派生的 `agentAssetId`、`agentIdentityKey` | 保持现状；不要把可能因人工 merge/alias 变化的 Asset ID 固化成永远不变的事件事实 |
| Agent Runtime | `attribution.agentInstanceId`、`agentInstanceKey` | 保持原值和现有语义 |
| Invocation | 当前没有独立、稳定的统一字段 | 新增可选 `invocationId` |
| Tool Call | 当前没有统一字段 | 新增可选 `toolCallId` |
| Trace | `traceId/spanId/parentSpanId` | 完全保留，不覆盖 |
| Process Instance | `processIdentity.processInstanceId` | 复用；必要时在关联结果中引用 |
| Event | `eventId/sourceEventId` | 完全复用 |

需要特别注意：如果后续验证发现不同路径下的 `agentInstanceId` 有时代表进程根、有时代表容器或物理工作负载，不能直接改变它的含义。应新增明确字段，例如 `agentRootInstanceId`，而不是静默重新解释旧字段。

### 2. 推荐新增一个独立关联结果

第一版可以放入现有 `attribution` JSON 中，减少数据库和旧消费者的变化：

```text
attribution.correlation
  schemaVersion
  agentRootInstanceId?
  invocationId?
  toolCallId?
  processInstanceId?
  method
  scope
  confidence
  authority
  inferred
  traceOrigin
  identityVersion
  provenance[]
```

关键字段建议：

```text
method:
  application_trace
  agent_adapter
  runtime_root
  physical_workload
  inferred_episode
  unassigned

scope:
  invocation
  agent_session
  runtime
  workload
  event

traceOrigin:
  incoming
  adapter
  legacy_synthetic
  none
```

这里的 `correlation.confidence` 不能复用当前的 `attribution.confidence`：

- `attribution.confidence` 表达“这是不是某个 Agent”。
- `correlation.confidence` 表达“这个事件是否属于某次 Invocation/ToolCall”。

这两个判断可能完全不同。例如，一个文件写入可以 100% 确认属于 Pi Runtime，但只能 30% 推测属于某次具体 ToolCall。

### 3. 双写规则

| 证据 | 旧字段 | 新关联结果 |
|---|---|---|
| 可信应用或 OTel Trace | `traceId` 原样保存 | 填写 `invocationId`；`method=application_trace` |
| 可信 Agent SDK/工具适配器 | `sessionId/traceId` 原样保存 | 填写 `invocationId/toolCallId`；`method=agent_adapter` |
| 只有 Agent 根进程 | 旧字段不变 | `method=runtime_root`，`scope=runtime`；不能确认时 `invocationId` 留空 |
| 只有 cgroup/workload | 旧字段不变 | `method=physical_workload`，`scope=workload` |
| 只有时间邻近关系 | 旧字段不变 | 使用独立 `inferredEpisodeId` 或 `method=inferred_episode`，不得伪造真实 Trace |

### 4. 兼容迁移顺序

顺序不能反过来：

1. **Reader/schema first**

   先让 TypeScript 类型、API DTO、Web DTO、ClickHouse 和流消费者能够接受可选新字段，但生产者暂时不发送。

2. **Flink consumer first**

   当前 Canonical parser 使用 Java POJO，直接发送未知字段存在进入 DLQ 或反序列化失败的风险，见 [CanonicalEventParser.java](../streaming/flink/src/main/java/org/a3s/anysentry/streaming/CanonicalEventParser.java)。必须先升级消费者，再升级生产者。

3. **Dual-write shadow**

   旧字段和旧功能完全不动，同时生成新 `correlation`，比较：

   ```text
   coverage
   split rate
   merge rate
   collision rate
   runtime-only rate
   inferred rate
   ```

4. **Dual-read opt-in**

   新增独立 `invocationId` 查询参数，不能改变 `traceId` 参数含义。新行为链页面可以优先按高置信 `invocationId` 查询，旧 Trace 页面和旧书签永久继续工作。

5. **Streaming 单独迁移**

   如果未来要让 Invocation 成为 Episode 主键，应建立平行 shadow pipeline 和 versioned key，完成 savepoint 恢复测试后再切换，不能原地修改现有 keyed state。

6. **历史数据不破坏性回填**

   老数据缺少关联结果时显示：

   ```text
   method=legacy_fallback
   correlation unavailable
   ```

   不重算或覆盖历史 `traceId`。

---

## 三、AnySentry 应采用的过滤原则

其他项目值得借鉴的是热路径控制机制，而不是照搬它们的事件分类：

- Tetragon 支持在内核侧按事件参数、进程、namespace 等 selector 匹配，并提供进程级、线程级和全局 rate limit，适合借鉴“进入 Ring 前决定是否提交”的机制。[Tetragon Selectors](https://tetragon.io/docs/concepts/tracing-policy/selectors/)
- Tracee 支持按 PID、进程树、可执行文件和容器限定 scope，并跟随子进程，适合借鉴 Agent root → descendant 的动态采集范围。[Tracee Scopes](https://aquasecurity.github.io/tracee/dev/docs/policies/scopes/)
- Falco 默认只启用一组更有价值的 syscall，显式打开全部 syscall 会带来性能成本；同时对 kernel drop 有独立指标和处理策略。[Falco Supported Events](https://falco.org/docs/reference/rules/supported-events/)、[Falco Dropped Events](https://falco.org/docs/concepts/event-sources/kernel/dropped-events/)
- Inspektor Gadget 明确推荐尽量在 eBPF 内过滤，因为把事件全部送到用户态再过滤成本更高。[Inspektor Gadget Filters](https://inspektor-gadget.io/docs/v0.51.1/spec/operators/filter/)

AnySentry 的差异在于：

> 其他项目主要回答“哪些系统事件值得采”，AnySentry 还要回答“这是哪个 Agent、哪次运行、哪次 Invocation、哪个 ToolCall，以及它当时影响了哪些业务服务”。

因此应该把三个概念彻底分开。

### 1. 身份分类

```text
confirmed_agent
probable_agent
non_agent
unknown
```

### 2. 工作负载角色

```text
agent
anysentry_internal
platform_infrastructure
business_service
ordinary_process
unknown
```

### 3. 采集档位

```text
agent_full
security_full
investigation_full
business_context
infrastructure_aggregate
unknown_discovery
self_health
```

“这是业务服务”不等于“完全不采集”；它意味着：

- 不需要保存全部文件和网络 syscall；
- 但需要保留服务健康、依赖边、错误率、延迟、部署变化；
- Agent 与该服务发生交互时，仍能作为风险上下文被查询。

同样，“Unknown”也不应等于“永久全量 KEEP”。推荐的 `unknown_discovery` 是：

```text
关键 Exec/Exit 和进程关系：保留
首次发现样本：保留
周期样本：保留
事件精确计数：保留
高频重复原始事件：采样或聚合
可信度不足：禁止 authoritative DROP
```

这样既保留发现新 Agent 的能力，又不会让 Unknown 形成无界 Ring 和存储流量。

---

## 四、完整开发阶段

建议阶段依赖如下：

```text
S0 兼容基线
  → S1 端到端可测量性
    → S2 可信身份双写
      → S3 Unknown / Infrastructure 正确性
    └→ S4 Collector 排空与背压
          S3 + S4 → S5 Ring 前 Capture Profile

S2 → S6 Agent Tool / Invocation 语义
S3 + S5 → S7 System Context
S5 + S6 + S7 → S8 Unknown 学习、灰度与总验收
```

S2、S3、S4 可以部分并行，但 S5 的真实 Ring 前丢弃，必须等 S1—S4 的关键验收通过。

### S0：兼容基线与变更护栏

**开发内容**

- 建立字段消费者矩阵：Observer、Forwarder、API、ClickHouse、Kafka、Flink、Web、Alert、Incident、Evidence、Remediation。
- 固化 Host、Docker、Kubernetes 的黄金事件和回放集。
- 为新身份、新 Capture Profile、新 Unknown 保留策略分别设置独立开关。
- 明确旧字段只读兼容政策。
- 固化旧 Trace 查询、Incident ID、Alert 去重、Web 深链和 Flink 状态行为。

**验收门槛**

- 所有新开关关闭时，API、查询结果、页面链接、统计和流处理结果与当前版本一致。
- 老消费者能够读取带可选新字段的事件。
- 不改变任何历史 Trace。

---

### S1：端到端可测量性

这是最先应该开发的功能，先回答“事件到底少在了哪里”。

**开发内容**

每个事件种类、每个 Ring、每个采集档位增加计数链：

```text
probe_attempted
  = prefiltered
  + aggregated
  + sample_rejected
  + ring_submitted
  + ring_dropped
  + probe_error

ring_submitted
  → collector_received
  → collector_enqueued / collector_dropped
  → forwarder_received
  → forwarded / filtered / queue_dropped
  → API received
  → persisted / duplicate / rejected / delivery_pending
```

同时记录：

- 策略 version、epoch、TTL、节点 ACK；
- identity snapshot age；
- root/process cache hit/miss；
- 关联 method、scope、confidence；
- Unknown 原因码；
- 新旧关联 split/merge；
- 过滤前分类比例；
- 过滤后留存比例。

当前入库中的 Unknown 比例只能反映“经过现有保留策略后的数据分布”，不能直接代表探针看到的真实 Unknown 率。

**验收门槛**

- 任意窗口内计数能够守恒。
- 能明确区分策略过滤、聚合、Ring overflow、Collector 丢失、队列丢失和存储拒绝。
- 指标按枚举维度聚合，不使用 PID、路径等高基数字段作为 metric label。
- 通过当前峰值和两倍峰值压测。

---

### S2：兼容式可信身份叠加层

**开发内容**

- 新增 `correlation`、`invocationId`、`toolCallId`。
- 保持所有旧字段不变。
- 对应用、SDK 来源进行认证和 tenant/workload 绑定，不能盲目信任任意进程提交的 trace/session。
- 采用可信解析优先级：

```text
应用 Trace / Invocation
→ Agent SDK / Tool Adapter
→ Agent root ProcessKey
→ physicalWorkloadId
→ inferred episode / unassigned
```

- 建立新旧身份 shadow 比较。
- 资产身份和 Invocation 身份分别计算，不再把“确认是 Agent”误等同于“确认属于某次调用”。

**验收门槛**

- PID 重用不会继承旧 Runtime。
- Agent 重启产生新 Runtime，但仍归入原 Asset。
- 同一个容器中的两个 Agent 不会合并。
- 长期运行 Agent 的并发请求只有在有可信应用上下文时才拆分为 Invocation。
- 没有可信上下文时明确显示 Runtime 级或 inferred，不伪造精确调用。
- 旧 Trace、Incident、Alert 和 Flink 结果不变。

---

### S3：Unknown、Infrastructure 和现有归因缺口修复

这一阶段先修事实，不立即扩大 DROP。

**开发内容**

- 拆分身份分类、工作负载角色和采集档位。
- 将笼统的 Unknown 拆成可行动原因：

```text
snapshot_not_ready
snapshot_miss
container_identity_missing
container_name_missing
parent_missing
process_exited_before_enrichment
ancestry_incomplete
pid_reuse_ambiguous
signature_miss
template_conflict
policy_expired
shared_scope_ambiguous
unsupported_agent_adapter
```

- 修复当前已发现的问题：
  - `a3s-registry` 已有精确 Infrastructure 规则，但事件缺少 containerName 时无法匹配；应修容器元数据和 cgroup/container 绑定，不能再加宽泛 `comm/path` 规则。
  - 短命 ProcessExit 出现 `ppid=0` 时，从 Exec tombstone 和 ProcessKey 恢复原始进程关系。
  - AnySentry 自身 API、Observer、ClickHouse 等从部署 inventory 自动识别。
  - 人工 non-Agent 审核结果必须反馈给 Forwarder 和节点采集控制面，而不只停留在页面或数据库。
  - Agent 与 Infrastructure 规则冲突时，Agent KEEP 始终优先。
  - Unknown 配置和实际保留行为保持一致。

**验收门槛**

- `a3s-registry` 稳定归入正确 container 级角色。
- AnySentry 自身噪声可识别，但健康和安全信号仍保留。
- Host、Docker、Kubernetes、同 Pod sidecar 场景分类正确。
- Unknown 大部分都具有具体原因码，不再集中落入 `not_evaluated`。
- 不用 `node/bash/python/cat` 等宽泛可执行文件规则解决 Unknown。

---

### S4：Collector 快速排空、优先级和背压

这一步解决“即使 Ring 还没满，Collector 也可能消费不够快”。

**开发内容**

- 从固定周期顺序轮询演进为事件驱动消费。
- Ring 消费热路径只做：

```text
读取固定记录
→ 最小校验
→ 复制到有界队列
→ 立即继续排空
```

- `/proc` 查询、容器补全、规则计算、JSON 序列化和发送放到后续工作线程。
- 隔离三类服务等级：

```text
critical：安全事件、Agent root Exec、关键生命周期
semantic：Agent 文件、网络、LLM、工具证据
bulk：服务摘要、Infrastructure 聚合、Unknown 样本
```

- Bulk 饱和时不能占满 Critical 的处理能力。
- 所有队列有固定上限和明确降级策略。

**验收门槛**

- 两倍目标峰值下，Critical 事件物理丢失为零。
- 下游 API 或 Forwarder 暂停不会阻塞 Ring 排空。
- RSS 不随时间线性增长。
- 事件重排可以通过事件时间和 ProcessKey 正确处理，不依赖跨 Ring 读取顺序。

---

### S5：统一 Capture Profile 和 Ring 前决策

这是解决 Ring Buffer 问题的核心阶段。

**开发内容**

控制面将身份、角色和风险状态编译成节点本地 Capture Profile：

```text
cgroup / root ProcessKey
+ profile
+ policy version
+ epoch
+ TTL
+ authority
+ reason
```

每个高频探针在构造完整 payload 和 reserve Ring 之前执行：

```text
FULL       高保真提交
AGGREGATE  累计精确摘要
SAMPLE     发送有界发现样本
DROP       仅抑制已确认且无需原始证据的噪声
```

核心安全规则：

- Security、关键生命周期、Agent root Exec 永不因普通 profile 被丢弃。
- 新 cgroup、快照过期、策略冲突或未 ACK 时，不能 authoritative DROP。
- 新 Agent 的首次 Exec 必须进入基础高优先级通道。
- 本地命中 Agent 签名后，立即临时提升该 root 及其后代。
- 控制面中断时使用 last-known-good，不回退成“全探针全量输出”。
- 已确认风险或显式调查操作可把精确 Runtime / Process generation 临时升到 `investigation_full`，TTL 到期自动恢复；原始 SecurityAction 自身始终 FULL，但不能单独授权整个 probable / unknown / Infrastructure cgroup 全量升档。

建议扩展顺序：

```text
FileAccess / FileDelete
→ Connect / DNS
→ TLS / LLM 元数据
→ 其他高频探针
```

**验收门槛**

- 被 Ring 前过滤的事件不增加 raw ring submit/reserve 数。
- Ring 提交量和输出字节显著下降。
- Agent marker 事件召回率保持 100%。
- 新 Agent 仍可被发现。
- 同一共享 cgroup 内多个 Agent 不会因为 workload 粗粒度规则被一起抑制。
- 策略 TTL 过期或回滚一个 epoch 后，无需重启即可恢复安全 discovery 状态。

---

### S6：Agent Tool 和 Invocation 语义

**开发内容**

- 为 Pi 提供 first-party adapter，同时提供通用 SDK/OTLP 接口。
- 采集：

```text
invoke_agent
execute_tool
session / invocation
toolCallId
toolName
runtime/process identity
start/end/error
```

- 构建双层证据：

```text
ToolCall Span：Agent 语义，解释“为什么做、哪个工具做”
Kernel Evidence：系统事实，证明“实际发生了什么”
```

OpenTelemetry GenAI 已定义 Agent/Tool Span 语义，包括 `execute_tool`，适合作为兼容入口。[OpenTelemetry GenAI Span Conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)

当前 Pi 问题需要分别处理：

- **read**：当前文件探针对 `O_RDONLY` 明确跳过，所以这是“没有生成内核事件”，不是后续归因丢失，见 Observer 仓库中的 `a3s-observer-ebpf/src/main.rs` 文件探针。Pi adapter 至少要提供 Tool Span；如果确实需要内核读证据，只对 Agent/Investigation profile 定向开启，不能全局开启。
- **write**：同 PID 文件写事件可以关联到 Agent root，但无法仅凭内核事件确定属于哪个 ToolCall；需要 adapter 提供 `toolCallId`。
- **bash**：子进程通过 ProcessKey 和父子进程树归入 Runtime，再通过 adapter 归入 Invocation。
- **远端或纯应用内自定义工具**：如果不产生本机 syscall，内核探针无法观察，必须依赖 SDK/adapter。

**验收门槛**

- Pi `read/write/bash/custom tool` 都有 Tool Span。
- write 和 bash 内核证据链接到正确 ToolCall。
- 同 PID 并发 ToolCall 不靠纯时间窗口猜测。
- 没有 SDK 时只表达 Runtime 级 `kernel_inferred`，不虚构 ToolCall。
- 工具参数、路径、命令和结果按策略裁剪、哈希或脱敏。

---

### S7：系统与业务服务上下文面

**开发内容**

系统上下文不应依赖“保存所有服务的全部 syscall”，而应建立独立数据面：

- Kubernetes、Docker、systemd inventory；
- Host/cgroup 指标；
- Prometheus/OTel 服务指标；
- 聚合网络依赖边；
- 服务告警；
- 部署和配置变化；
- 错误率、延迟、容量和健康状态。

风险分析构造有界上下文包：

```text
Agent Asset / Runtime / Invocation
+ ToolCall 与关键内核证据
+ 被访问的业务服务
+ 服务当时的指标和异常
+ 相邻拓扑
+ 同期部署或配置变化
+ 关联置信度
+ 数据完整性和丢失情况
```

**验收门槛**

- “Agent → 业务 API → ClickHouse”场景能够看到交互关系、服务健康和同期变化。
- 即使业务服务原始 syscall 已聚合，服务上下文仍存在。
- 上下文按相关资源和时间窗口裁剪，不能把整个集群全部交给风险分析 Agent。
- 每份上下文都有来源、新鲜度和关联置信度。

---

### S8：Unknown 学习、灰度和总验收

**开发内容**

Unknown 按稳定对象聚类，而不是逐条人工审核：

```text
Agent root / physical workload
+ Unknown reason
+ event kind
+ path/target bucket
+ time window
```

每个聚类保存：

- 精确计数；
- 首批样本；
- 周期 reservoir 样本；
- 元数据补全状态；
- 人工审核结果。

策略演进必须经过：

```text
candidate
→ shadow
→ 历史回放
→ canary
→ enforce
→ rollback
```

学习器不能直接生成 authoritative DROP。

最终发布顺序：

```text
功能关闭
→ identity shadow
→ capture profile shadow
→ 单节点/单 workload canary
→ 精确 Infrastructure enforce
→ Unknown discovery budget
→ Agent 动态升档
→ Host/Docker/Kubernetes 混合环境默认启用
```

所有阶段保留 kill switch。

---

## 五、完全实现后的 High-level 服务流程

最终的 AnySentry 应当是“两条闭环”，而不是“所有事件先采集，再统一过滤”。

```text
                     控制与学习闭环
┌─────────────────────────────────────────────────────────┐
│ Host / K8s / Docker / systemd Inventory                  │
│ Agent 注册、签名、人工审核、历史规则                       │
│ Agent SDK / OTLP Invocation / ToolCall                   │
│ Unknown 聚类与风险反馈                                    │
│                         │                                │
│                         ▼                                │
│              可信身份与关联解析控制面                     │
│        Asset / Runtime / Process / Invocation            │
│                         │                                │
│                         ▼                                │
│              Capture Profile 策略编译                    │
│        version / epoch / TTL / authority / scope         │
│                         │                                │
│                         ▼                                │
│               节点原子应用并返回 ACK                     │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
                     快速数据闭环
┌─────────────────────────────────────────────────────────┐
│ 内核事件                                                  │
│   ↓                                                      │
│ 提取最小稳定身份键                                        │
│ host / boot / cgroup / pid / process-start / parent      │
│   ↓                                                      │
│ Ring Buffer 前决策                                        │
│   ├─ FULL：Agent、安全、临时调查                          │
│   ├─ AGGREGATE：业务服务、平台基础设施重复信号             │
│   ├─ SAMPLE：Unknown、普通进程发现                        │
│   └─ DROP：AnySentry 自噪声和已确认低价值信号              │
│   ↓                                                      │
│ Critical / Semantic / Bulk 优先级隔离                     │
│   ↓                                                      │
│ Collector 快速排空                                       │
│   ↓                                                      │
│ 异步标准化、容器/进程/服务补全、去重、质量标记             │
│   ↓                            SDK/OTLP Span ───────┐     │
│ Process → Agent Runtime → Invocation 可信归因  ←────┘     │
│   ↓                                                      │
│ ToolCall + Kernel Evidence + 服务上下文                   │
│   ↓                                                      │
│ Agent 因果行为图                                          │
│   ↓                                                      │
│ 分层存储：高保真证据 / 聚合上下文 / Unknown 样本 / 质量指标 │
│   ↓                                                      │
│ Risk Context Bundle → 风险分析 → 可追溯结论               │
└─────────────────────────┬───────────────────────────────┘
                          │
             Unknown / 新 Agent / 风险 / 人工审核
                          │
                          └────────→ 更新控制与学习闭环
```

这个流程中的关键变化是：

1. 不再让全部事件先进入 Ring。
2. 先用最小身份键决定采集精度，再构造完整事件。
3. Agent 和安全证据保持高保真。
4. 业务服务保留上下文，不保留无界 syscall 明细。
5. Unknown 保留发现能力，但原始数据有上限。
6. 应用/SDK 提供语义，内核探针提供事实，两者共同组成行为链。
7. 所有过滤、聚合、丢失和归因都有版本、原因和指标。

---

## 六、开发完成后的关键检测点

| 检测节点 | 必须得到的结果 |
|---|---|
| 兼容性 | 旧 `traceId` 查询、页面深链、Incident、Alert、Evidence 和 Flink 状态行为不变 |
| 策略控制面 | 每个节点都能看到身份版本、策略版本、TTL、ACK 和 last-known-good |
| Ring 前决策 | 被 DROP/AGGREGATE/SAMPLE 的事件不增加 raw ring submit |
| 全链路计数 | 能区分策略过滤、Ring 丢失、Collector 丢失、队列丢失和存储拒绝 |
| 过载隔离 | Bulk 压满时，Security 和 Agent root Exec 仍无物理丢失 |
| Process 归因 | PID 重用、短命进程、晚到 Exit、容器重建不发生错误继承 |
| Runtime 归因 | 同一容器多个 Agent 不合并；Agent 子进程正确继承 Runtime |
| Invocation 归因 | SDK/Application 优先；无可信上下文时保持 Runtime/inferred，不伪造 Invocation |
| Tool 证据 | Pi read/write/bash/custom 能区分 Tool Span、内核证据和推断关系 |
| Unknown | 每个 Unknown 有原因码；原始数据有上限；计数和样本仍能发现新 Agent |
| 服务上下文 | Infrastructure syscall 被聚合后，服务健康、拓扑和 Agent 交互边仍存在 |
| 故障恢复 | 控制面断连、策略过期、下游阻塞和 Ring burst 时按优先级可解释降级 |
| 风险结论 | 每个结论都能回指证据，并显示关联置信度和采集丢失情况 |

最后收敛为一句话：

> AnySentry 不应通过“全量内核事件永久保留”来实现全系统上下文，而应通过“Agent 高保真证据 + 服务聚合上下文 + Unknown 有界发现 + 动态调查升档”实现；同时用新增的可信关联视图统一身份，不破坏现有 Trace 体系。

本轮只完成了架构和阶段收敛，没有修改代码。建议真正开发时从 **S0 兼容基线和 S1 全链路可测量性** 开始，而不是先改过滤规则或扩大 Ring Buffer。
