# AnySentry 智能体全链路可观测架构设计

> 状态：待评审设计稿
> 记录日期：2026-09-02
> 适用项目：`data-center/AnySentry`、`data-center/Observer`
> 本文目标：统一智能体、实例、Session、LLM 明文、工具调用和内核事件的建模与关联方式，并形成后续新增智能体、新功能和性能优化时必须遵循的开发手册。

---

## 1. 结论

AnySentry 当前最需要解决的，不是继续为 Codex、Claude Code 等产品各补一段解析代码，而是将系统重构为：

> 一个不可变原始事实流、三个可插拔注册表、一个异步关联引擎、两种面向不同使用者的读模型。

具体含义如下：

1. `Observer` 负责采集可信的运行时事实，包括进程、进程树、网络、TLS、文件、安全动作和可选的 LLM 明文。
2. `AnySentry` 负责把不同来源的事实统一成规范化记录。
3. `Agent Adapter Registry` 负责 Codex、Claude Code、Pi、Kimi、Dify、LangChain、LangGraph 等产品的特异性。
4. `LLM Format Registry` 负责 OpenAI、Anthropic、Gemini 以及 OpenAI-compatible 请求和响应格式。
5. `Runtime Adapter Registry` 负责宿主机、SSH、Docker、Kubernetes 和 MicroVM 等环境差异。
6. `Identity Registry` 负责逻辑智能体、智能体实例、运行时实例和 Session 生命周期。
7. `Correlation Engine` 负责把 LLM 明文、工具调用、进程、网络、文件和内核安全事件连接成可解释的证据关系。
8. `Detection/Judgment` 负责风险判断和候选智能体判断，但不能反过来决定原始事件是否存在。
9. 最终从同一套事实和关系中生成两种视图：
   - 面向人的会话和对话视图；
   - 面向机器、安全分析和审计的内核证据视图。

因此，新增一个智能体时，原则应当是：

> 只新增一个 Adapter、必要的 eBPF Capture Plan 和测试 Fixture；不重新编写一套检测链路，不修改 Observer 通用核心，不在 Controller 中增加产品分支。

---

## 2. 已确认的范围决策

本文冻结以下当前阶段决策。

### 2.1 推荐模块化单体，不引入 Kafka

当前不引入 Kafka、Pulsar、NATS 或其他分布式消息中间件，也不把 AnySentry 拆成大量微服务。

当前推荐形态是：

```text
Observer Node
  +
AnySentry Modular Monolith
  +
ClickHouse
  +
本地有界队列、WAL 和批量写入
```

原因是当前问题首先是模块边界、身份建模、事实和派生数据混合以及缺少可重放测试的问题。此时引入 Kafka 只会把模块问题放大成分布式一致性、事件版本和运维问题。

如果未来经过真实指标证明单进程管线不能满足吞吐和多租户隔离，再评估分布式消息架构。本文的契约和模块边界应当允许未来替换传输方式，但不为未来假设提前增加复杂度。

### 2.2 当前采集只采用 eBPF 非侵入路径

当前智能体观测坚持 eBPF 非侵入式实现，不要求修改被观察 Agent 的代码或配置。

允许的采集手段：

```text
eBPF tracepoint
eBPF kprobe / kretprobe
eBPF uprobe / uretprobe
eBPF socket/cgroup/LSM 相关能力
Observer 编译后二进制中的用户态协议重组和解析
```

当前不新增：

```text
Agent Hook
Agent SDK 埋点
ACP 注入接入
Agent-side 插桩脚本
strace 采集
Transcript 内容读取或 tail 脚本
LLM 代理或网关改造
通过修改 Agent Base URL 截获流量
业务代码内 OpenTelemetry 埋点
```

说明：

- uprobe/uretprobe 仍属于 eBPF 非侵入观测，因为它不修改 Agent 源码和配置，而是在用户态函数边界观察数据。
- 本文仍会研究 Hook、ACP、Transcript、OpenTelemetry 等框架的字段和生命周期模型，因为它们可以作为统一语义模型的参考；这些参考不代表当前要实施对应采集方式。
- 迁移期可以保留仓库中已经存在的 NDJSON Forwarder 兼容路径，但不新增用于注入 Agent、修改 Agent 或为某个 Agent 单独运行的脚本。目标路径应逐步收敛为 Observer Collector 内置的批量导出和本地 WAL。

### 2.3 eBPF-only 的能力边界必须如实展示

只使用 eBPF 时，并不能保证所有产品都能得到精确的原生 Session ID。

在当前约束下，Session 身份只能来自以下可观察事实：

1. CLI 启动参数中出现的 Session/Resume ID；
2. eBPF 文件事件中出现的 Session 文件路径；
3. TLS 或明文协议负载中出现的 thread/session/conversation ID；
4. 进程树、工作目录和连接连续性形成的推断；
5. AnySentry 为一次无状态调用创建的内部临时 Session Scope。

如果产品没有把原生 Session ID 暴露在上述任一边界，AnySentry 只能产生 `inferred` 或 `ephemeral` Session，不能宣称已经获得供应商真实 Session。

这是一项明确的产品边界，不应通过伪造 ID 或静默合并来掩盖。

---

## 3. 核心问题和根因

当前出现的三个主要问题，本质上不是独立 Bug，而是五类职责被压入同一条事件链造成的。

### 3.1 产品特异逻辑进入了通用核心

虽然以 Codex、Claude Code 为测试对象，但代码逐渐变成针对具体产品字段和事件格式的实现。结果是：

```text
测试哪个 Agent
  → 就为哪个 Agent 加一段逻辑
  → 其他 Agent 无法复用
  → 相同概念在多个项目中重复解析
```

### 3.2 原始事实、解析结果和风险判断混在一起

当前一条 `JudgedEvent` 同时承担：

```text
原始采集事实
身份信息
Session 信息
Trace/Run 信息
语义分类
风险判断
展示字段
```

当性能优化或新功能修改其中任一部分时，其他能力可能一起回退。

### 3.3 明文链路和内核链路没有共同的关联层

Observer 已有内核事件，也已有 `SslContent` 和 `LlmApi`，但这些事件最终只是分别进入同一个平面事件表，没有形成明确的：

```text
明文片段
  → 网络连接
  → LLM 请求/响应
  → ToolCall
  → ProcessTree
  → File/Network/Security Effect
```

### 3.4 身份概念被相互替代

当前实现中出现过：

```text
Agent 名称代替 Session
Pod 名称代替 Session
PID 代替 Task/Session
Session ID 代替 Run ID
Session 派生哈希代替 Trace ID
cwd 代替稳定 Workspace 身份
OS uid 代替真实业务用户
```

这些 fallback 可以临时让字段不为空，但会产生错误聚合和错误关联。

### 3.5 缺少可重放、跨产品的回归基线

现有测试更偏向 Ingest、Source、Forwarder、Dashboard API 是否可用，缺少：

```text
Session/Instance 生命周期测试
流式协议重组测试
跨来源关联测试
PID/FD 复用测试
HTTP/2 多路复用测试
未知 Agent 降级测试
旧能力重放对比测试
```

---

## 4. 术语和实体模型

建议将顶层模型定义为：

```text
AgentFamily
    └── LogicalAgent
          └── AgentInstance
                └── RuntimeInstance
                      └── Session
                            └── Turn / Run
                                  ├── LLM Call
                                  ├── Tool Call
                                  └── Kernel Effects
```

这些关系并不全部是一对多。特别是：

```text
一个 Session 可以跨多个 AgentInstance 恢复
一个 AgentInstance 可以托管多个 Session
一个 AgentInstance 可以运行在多个 RuntimeInstance 副本上
一个 RuntimeInstance 可以同时处理多个 Session
```

### 4.1 AgentFamily：产品族或实现类型

这是静态目录概念，用于选择 Adapter。

例子：

```text
codex
claude-code
pi
kimi-cli
dify
langchain
langgraph
custom-http-agent
unknown-cli-agent
```

它回答：

> 这类智能体大概属于什么产品或框架？

它不是一次运行，不是一个进程，也不是一个会话。

### 4.2 LogicalAgent：逻辑智能体

逻辑智能体是长期存在、可管理的智能体定义或配置。

例如：

```text
codex + /workspace/project-a + profile=default
claude-code + /workspace/project-b
dify + tenant-a + workflow=customer-support
langgraph + assistant=research-agent
```

它回答：

> 这是哪一个被管理的智能体定义？

它通常可以跨多个进程启动、多个 Pod 和多次 Session 存在。

### 4.3 AgentInstance：智能体实例

智能体实例表示一次具体的功能性启动或部署。

对于独立 CLI：

```text
Codex terminal A 第一次启动  → instance-I1
Codex terminal A 第二次启动  → instance-I2
Codex terminal B 第一次启动  → instance-I3
```

对于 Dify：

```text
customer-support workflow v1 / test  → instance-I-test-v1
customer-support workflow v1 / prod  → instance-I-prod-v1
customer-support workflow v2 / prod  → instance-I-prod-v2
```

对于 LangGraph：

```text
research graph / deployment revision 12 → instance-I12
```

它回答：

> 这一次实际运行的是哪一个版本、配置或启动代次？

### 4.4 RuntimeInstance：运行时实例

这是物理运行环境中的进程、容器、Pod 或虚拟机实例。

例如：

```text
host process pid=1001 + start_time=...
docker container abc123
k8s pod research-agent-7d8f...
a3s-box guest VM ...
```

它回答：

> 这条事件实际发生在哪个进程、容器、Pod 或节点中？

一个 Dify 或 LangGraph 的 AgentInstance 可能有多个 Pod 副本，而一个 CLI AgentInstance 通常只对应一个根进程树，因此 RuntimeInstance 必须独立存在。

### 4.5 Session：会话

Session 是能够恢复、继续、分支或清理的对话上下文。

它回答：

> 这些交互是否属于同一段可以继续的对话？

Session 可以跨多个 AgentInstance：

```text
Codex instance-I1 运行 session-S1
进程退出
Codex instance-I2 resume session-S1
```

因此：

```text
AgentInstance ≠ Session
```

### 4.6 Turn / Run：一次回合或执行

一次用户输入触发的一次完整处理过程，通常称为 Turn 或 Run。

一个 Turn 可以包含：

```text
用户输入
  → 一次或多次 LLM 调用
  → 多个工具调用
  → 多个子进程
  → 文件和网络操作
  → 最终回复
```

因此：

```text
Session 可以有多个 Turn
Turn 可以有多个 LLM Call 和 Tool Call
Tool Call 可以产生多个进程和系统效果
```

### 4.7 关于“不同终端”的最终定义

不同终端不等于不同 AgentFamily，也不必默认等于不同 LogicalAgent。

推荐默认规则：

```text
同一个产品 + 同一个配置档 + 同一个工作区
  → 同一个 LogicalAgent

每次启动
  → 新的 AgentInstance

启动时 resume 原 Session
  → 新 AgentInstance 绑定原 Session
```

如果业务未来确实要求两个终端作为不同 LogicalAgent，可以通过显式启动注册信息提供不同 `logical_agent_id`，不需要改变核心架构。

---

## 4.8 Session 生命周期

Session 不是一个静态字符串，而是一个有生命周期的实体。

```text
new
  → active
    → idle
      → completed / failed / interrupted / archived

active
  → resumed
    （绑定到新的 AgentInstance）

active
  → forked
    （产生新的 Session，并保留 parentSessionId）

active
  → compacted
    （同一个 Session，产生新的上下文版本）
```

建议 Session 至少保存：

```text
session_id                  AnySentry 内部 ID
vendor_session_id           产品原生 ID（如果可见）
vendor_thread_id            产品原生 Thread ID（如果可见）
logical_agent_id
current_agent_instance_id
runtime_instance_ids
transcript_path_hint        仅作为观察到的路径，不等于内容已读取
resume_capability           load/resume/continue/none/inferred
parent_session_id
forked_from
identity_quality            confirmed/inferred/ephemeral/unknown
started_at
last_activity_at
ended_at
```

Session 与 AgentInstance 之间使用独立的绑定记录：

```text
Session S1
  ├── bound to AgentInstance I1  [active: 10:00–10:35]
  └── bound to AgentInstance I2  [resumed: 11:10–11:40]
```

### 4.9 ID 的职责不能混用

| ID | 表示什么 | 生命周期 |
|---|---|---|
| `observation_id` | 一条原始采集事实 | 永久不可变 |
| `logical_agent_id` | 一个逻辑智能体定义 | 长期稳定 |
| `agent_instance_id` | 一次功能启动/部署代次 | 启动或部署版本级 |
| `runtime_instance_id` | 一个进程/容器/Pod 运行代次 | 运行时级 |
| `session_id` | 一段可恢复对话 | 可跨实例 |
| `turn_id` | Session 内的一次回合 | 一次用户输入 |
| `run_id` | 一次执行树或工作流运行 | 一次调用 |
| `trace_id` | 一条分布式执行轨迹 | 一次端到端执行 |
| `span_id` | 一个操作节点 | 一个 LLM/Tool/Node 操作 |
| `llm_call_id` | 一次模型请求/响应 | 一个请求 |
| `tool_call_id` | 一次工具调用 | 从请求到结果 |
| `process_key` | 一个不会因 PID 复用而混淆的进程 | 进程生命周期 |
| `connection_id` | 一个网络连接 | Socket 生命周期 |
| `evidence_link_id` | 一条关联证据 | 关系版本级 |

特别注意：

```text
session_id ≠ turn_id ≠ run_id ≠ trace_id
pid ≠ process_key
fd ≠ connection_id
connection_id ≠ llm_call_id
```

---

## 5. 现有框架调研结论

截至 2026-09-02，主流 Agent 和可观测性框架虽然命名不同，但核心层级已经比较一致。

| 框架或标准 | 已确认的模型 | 对 AnySentry 的启示 |
|---|---|---|
| OpenTelemetry GenAI | 定义稳定的 `gen_ai.agent.id`、`gen_ai.conversation.id`、请求/响应消息、工具调用参数和结果；没有真实会话 ID 时，不应使用新 UUID、Trace ID 或请求哈希伪造 | AnySentry 内部可以生成临时 Session Scope，但必须标记为 `ephemeral/synthetic` |
| OpenInference | 将完整轨迹建模为 Span 树，区分 `AGENT`、`LLM`、`TOOL`、`RETRIEVER`、`CHAIN` 等操作 | 采用统一操作语义和父子关系，同时保留 AnySentry 的 KernelFact 和 EvidenceLink |
| OpenAI Agents SDK | 默认层级是 Task → Agent → Turn，LLM Generation、Function Tool、Guardrail、Handoff 为子 Span | `Session`、`Turn/Run` 和 `Trace` 必须分开 |
| Codex | App Server 区分 Thread、Turn、Item；支持 start、resume、fork | Thread 映射 Session，Turn 映射回合，Item 映射消息、工具和运行对象 |
| Claude Code | Session 持久化为 JSONL，可 continue、resume、fork；工具有 tool use ID | 其字段作为语义模型和测试 Fixture 参考；当前不接入 Hook/Transcript 采集 |
| Pi | Session 是 JSONL 树，每个节点有 `id` 和 `parentId`，支持 resume、fork、tree、compact | Session 不一定是线性日志，模型应支持分支关系 |
| Kimi Code | Session 目录有 `state.json`、`wire.jsonl` 和子 Agent 目录，可 continue/resume/fork | Session、Subagent 和 Resume 的字段作为协议解析参考；当前不接入 Hook/ACP/Transcript 采集 |
| Dify | Chat/Agent/Chatflow 使用 `conversation_id`、`message_id`、`task_id`；Workflow 使用 `workflow_id`、`workflow_run_id` 和节点事件 | Workflow 版本和环境映射 AgentInstance，Conversation 映射 Session，Workflow Run 映射 Run |
| LangGraph | `thread_id` 是持久状态和会话边界，`run_id` 是一次执行；流式事件有 `parent_ids` | `thread_id` 映射 Session，`run_id` 映射 Turn/Run，`parent_ids` 映射执行树 |
| LangServe | 可以暴露 invoke、stream 和事件流；有状态时可使用 `session_id`，否则通常是无状态调用 | 自定义 HTTP Agent 必须支持 `per_request` 和显式 Session 两种模式 |
| ACP | 标准化 Session 新建、恢复、加载、Prompt、Tool 和流式更新 | 只作为未来兼容和语义参考，当前不实施 ACP 接入 |
| AgentSight | 使用 boundary tracing，把 TLS 明文意图、进程、文件和网络事件放入同一个关联引擎 | 证明双链路方向可行，关键是进程血缘、连接标识和可解释关系 |

关键外部参考：

- [OpenTelemetry GenAI Agent Spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
- [OpenInference Specification](https://arize-ai.github.io/openinference/spec/)
- [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex Rollout Trace](https://github.com/openai/codex/blob/main/codex-rs/rollout-trace/README.md)
- [Claude Code Sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Pi Sessions](https://pi.dev/docs/latest/sessions)
- [Kimi Sessions](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
- [Kimi Data Locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
- [Dify Workflow API](https://github.com/langgenius/dify/blob/main/web/app/components/develop/template/template_workflow.en.mdx)
- [Dify Advanced Chat API](https://github.com/langgenius/dify/blob/main/web/app/components/develop/template/template_advanced_chat.en.mdx)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph Streaming](https://langchain-ai.github.io/langgraph/cloud/concepts/streaming/)
- [LangServe](https://github.com/langchain-ai/langserve)
- [AgentSight Paper](https://arxiv.org/abs/2508.02736)
- [AgentSight View/Session/Process Model](https://github.com/eunomia-bpf/agentsight/blob/master/docs/design/view-session-process-model.md)

这些资料用于统一数据模型、字段命名、生命周期和测试样本，不代表当前要为被观察 Agent 增加 SDK、Hook 或协议接入。

---

## 5.1 当前阶段的方案取舍

### 方案 A：立即拆成 Kafka/消息队列 + 多微服务 + 图数据库

优点：

```text
理论吞吐高
服务边界明显
适合大型多租户平台
```

代价：

```text
部署和调试复杂
事件版本治理成本高
当前已有能力迁移风险大
会把“模块问题”放大成“分布式一致性问题”
```

当前不采用。只有在真实指标证明单进程管线和本地 WAL 无法满足需求后，才重新评审。

### 方案 B：模块化单体 + Observer Node + Typed Event Bus

优点：

```text
复用当前 AnySentry 部署方式
不需要立即增加基础设施
原始事实可以重放
模块边界可以先稳定
可以逐步迁移而不破坏旧接口
```

代价：

```text
初期仍然是一个 API 进程
需要重构 Controller 和 Store
需要严格执行模块依赖规则
```

这是当前推荐方案。

### 方案 C：只依赖 Agent SDK、Hook 或协作协议

优点：

```text
语义丰富
Session/Tool ID 通常准确
实现速度快
```

代价：

```text
无法覆盖未知 Agent
无法覆盖关闭或不支持这些能力的 Agent
无法看到真实的子进程、文件和网络效果
无法提供独立的机器侧安全证据
```

与当前 eBPF-only 约束不一致，只保留为未来可能的增强方向和语义参考。

---

## 6. 当前代码审计

当前代码已经具备较好的基础能力，但边界还不完整。

### 6.1 Observer 身份模型不足

`Observer/src/traits.rs` 中的 `Identity` 只有：

```text
agent
task
session
```

这无法表达：

```text
AgentFamily
LogicalAgent
AgentInstance
RuntimeInstance
ProcessTree
真实供应商 Session
临时 Session
```

### 6.2 SslContent 和 Egress 不能直接稳定关联

`Observer/a3s-observer-common/src/lib.rs` 中的 `SslEvent` 只有：

```text
pid
is_read
len
comm
data
```

缺少：

```text
fd
socket_cookie
ssl_context
connection_id
stream_id
request_id
monotonic timestamp
source sequence
```

Collector 当前使用 `(pid, fd)` 维护 Egress 和 LLM metric 的关联，但 `SslContent` 是另一条没有连接 ID 的事件流。

因此当前最多能得到：

```text
某个 PID 发生过 Egress
某个 PID 产生过 SSL 明文
某个 PID 关闭过一个可能的 LLM Socket
```

还不能严格得到：

```text
这段明文属于这个连接
这个连接中的这个请求属于这个 LLM Call
这个 LLM Call 产生了这个 ToolCall
这个 ToolCall 产生了这些内核事件
```

### 6.3 `(pid, fd)` 不是稳定连接身份

PID 和 FD 都会复用。至少需要：

```text
machine_id / boot_id
pid
process_start_time
tid
fd
socket_cookie 或连接生成号
netns
```

### 6.4 `deriveMeta` 混用了 Session、Agent 和 Run

当前 `apps/api/src/security-monitoring/security-monitoring.controller.ts` 的 `deriveMeta()` 在没有显式 Session 时会回退到 Agent，并以 Session/Agent 作为 Run fallback。

这会导致：

```text
同一个逻辑智能体的多个对话被合并
同一个 Session 的多个 Turn 没有区分
不同实例的事件被压到同一条 Trace
```

### 6.5 Kubernetes 身份补全覆盖了真实 Session

`apps/api/src/security-monitoring/kube-identity.service.ts` 当前会将：

```text
agentId   → pod.name
sessionId → pod.name
workspace → namespace/pod.name
```

Pod 是 RuntimeInstance，不是 Session。一个 Pod 可以处理多个 Dify 请求、多个 LangGraph Thread 或多个恢复的 CLI Session。

正确做法是保留原始 Agent/Session 身份，将 Pod 放入 `runtime_context`，再通过关系连接。

### 6.6 Judge 直接接收原始字符串

`apps/api/src/security-monitoring/sentry-judge.service.ts` 当前直接对原始 line 进行判断，同时生成 Trace、Span、Run 和风险字段。

目标应为：

```text
RawObservation
  → KernelFact / SemanticRecord
    → Judgment
```

Judge 不再理解某个产品的原始 JSON。

### 6.7 ClickHouse 只有单一宽泛事件表

当前 `apps/api/src/security-monitoring/clickhouse-store.ts` 的主表是单一 `events` 表，原始事实、语义信息、归因和风险被压缩为一个记录。

这无法支持：

```text
归因修正
关系边
原始证据重放
多版本判断
明文与内核一对多关联
```

### 6.8 产品解析已经重复出现

`terminal/cli/src/top/mod.rs` 又维护了一套 Claude 和 Codex JSONL 解析逻辑。这说明产品特异解析已经跨项目扩散，应当抽成共享 Adapter/Parser 契约，而不是让 AnySentry、Observer 和 TUI 各自维护一份。

---

## 6.9 当前实际调用链和偏差位置

当前主要链路可以概括为：

```text
eBPF probes
  → a3s-observer-collector
    → NDJSON / Forwarder
      → AnySentry /security-center/ingest
        → deriveMeta()
          → KubeIdentityService.enrich()
            → SentryJudgeService.judge(raw line)
              → one JudgedEvent
                → ClickHouse events + in-memory ring
                  → AggregationService / Dashboard
```

这条链路中从一开始就存在以下偏差：

```text
原始事实没有独立存储
明文片段没有独立存储
Session/Instance 没有实体注册
Egress/SSL/LLM/Tool 没有 EvidenceLink
Judge 直接理解原始字符串
Aggregation 只能扫描平面事件
```

目标链路应变为：

```text
eBPF probes
  → RawObservation + WAL
    → KernelFact / TransportFrame
      → LLM Format Adapter / Agent Adapter
        → SemanticRecord + LifecycleFact
          → Identity Registry
            → Correlation Engine
              → EvidenceLink
                → Judgment + Materialized Projection
                  → Conversation View / Evidence View / Dashboard
```

两条链路的根本差别是：

```text
当前：每条输入直接变成一个平面 JudgedEvent
目标：每条输入先成为不可变事实，再由多个可重放投影产生结果
```

---

## 7. 总体目标架构

```text
┌───────────────────────────────────────────────────────────────┐
│                       Agent / Workload                         │
│  Codex · Claude · Pi · Kimi · Dify · LangGraph · custom agent │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                │ 仅 eBPF 非侵入观测
                                ▼
┌───────────────────────────────────────────────────────────────┐
│ Observer Capture Plane                                         │
│                                                               │
│ Kernel eBPF                                                   │
│   exec/fork/exit · connect/DNS · file · security · resource   │
│                                                               │
│ User-space eBPF uprobes                                       │
│   OpenSSL/BoringSSL/... plaintext · selected socket payload   │
│                                                               │
│ Runtime discovery                                             │
│   host · ssh · docker · k8s · microvm                         │
└───────────────────────────────┬───────────────────────────────┘
                                ▼
                     RawObservation + local WAL
                                │
                                ▼
                    AnySentry Ingest Pipeline
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
       Transport Decoder   Kernel Fact       Agent/LLM Parser
       HTTP/SSE/WS         Normalizer        Registry
              │                 │                 │
              └─────────────────┼─────────────────┘
                                ▼
                    Identity Registry
              logical/instance/runtime/session
                                │
                                ▼
                     Correlation Engine
          process · connection · stream · session · tool
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
          Human Projection                Machine Projection
        conversation timeline             evidence graph
                 │                             │
                 └──────────────┬──────────────┘
                                ▼
                 Judgment / Alert / Coverage / API / UI
```

核心不变量：

```text
KernelFact 和 SemanticRecord 可以独立存在
Correlation Engine 负责连接二者
缺少明文 Parser 不会阻断 KernelFact
```

因此：

```text
Z.ai CLI 没有明文 Adapter
  ≠
Z.ai CLI 没有内核观测
```

---

## 8. 四个逻辑平面

### 8.1 Data Plane：事实采集平面

当前只接受 eBPF 采集来源：

```text
kernel tracepoints/kprobes
socket/cgroup probes
SSL/TLS uprobes
selected plaintext socket capture
```

这个平面只回答：

```text
什么时候发生了什么
在哪个进程、连接、文件、网络或 Runtime 中发生
原始字节和元数据是什么
数据来自哪个 Probe、Collector 和序列
```

它不负责：

```text
判断是不是 Codex
判断是不是同一个 Session
判断是不是攻击
决定是否显示在 Dashboard
```

### 8.2 Semantic Plane：语义转换平面

它在 Observer Collector/AnySentry 用户态中处理 eBPF 捕获的明文和运行时事实，不修改 Agent。

支持的协议和格式包括：

```text
HTTP/1.1
chunked encoding
SSE
HTTP/2 stream
WebSocket
OpenAI Chat Completions
OpenAI Responses
Anthropic Messages
Gemini GenerateContent
Gemini Interactions
Dify API/SSE
LangChain/LangGraph HTTP 和模型流量
```

统一输出：

```text
UserMessage
SystemInstruction
DeveloperInstruction
AssistantMessage
ReasoningSummary
LlmRequest
LlmResponse
ToolCall
ToolResult
Retrieval
AgentLifecycle
SessionLifecycle
```

### 8.3 Identity and Correlation Plane：身份和关联平面

负责：

```text
进程属于哪个 RuntimeInstance
RuntimeInstance 属于哪个 AgentInstance
AgentInstance 属于哪个 LogicalAgent
本次请求属于哪个 Session
本次操作属于哪个 Turn/Run
这段明文和哪个网络连接对应
这个 ToolCall 产生了哪些进程和文件效果
```

这是当前系统最缺失的一层。

### 8.4 Control and Presentation Plane：控制与展示平面

控制包括：

```text
策略
鉴权
数据保留
Adapter 开关
eBPF 深度采集开关
字段可见性
告警
维护窗口
```

展示包括：

```text
智能体目录
实例目录
Session 列表
对话时间线
工具调用详情
内核证据图
风险和告警
采集覆盖率
```

这些逻辑可以继续部署在当前 AnySentry API 中，当前不拆微服务。

---

## 9. 统一层和特异性层

### 9.1 必须统一的层

这些层不能出现 Codex、Claude、Dify 等硬编码分支。

| 统一模块 | 统一职责 |
|---|---|
| `RawObservation` | 所有 eBPF 来源的原始事实外壳 |
| `RuntimeContext` | 主机、SSH、容器、Pod、进程、cgroup、netns |
| `ProcessKey` | 主机 + PID + 进程启动时间 |
| `ConnectionKey` | Socket Cookie/连接代次/FD/Network Namespace |
| `SessionLifecycle` | start/resume/fork/clear/compact/end/interrupted |
| `ConversationMessage` | user/assistant/tool/system 等消息角色 |
| `LlmCall` | 请求、响应、模型、Token、流式状态 |
| `ToolCall` | 工具名称、参数、结果、状态 |
| `KernelFact` | exec、exit、file、network、DNS、security |
| `EvidenceLink` | 关联关系、方法、置信度、证据来源 |
| `Judgment` | allow/block/escalate、风险、规则版本 |
| `Coverage` | kernel/plaintext/identity/correlation 覆盖率 |
| 存储和查询 | ClickHouse、WAL、索引、聚合、分页 |
| UI | 读取投影，不解析原始产品日志 |

### 9.2 允许特异的层

这些内容放入 Adapter 或 Registry。

| 特异模块 | 例子 |
|---|---|
| Agent 进程发现 | `codex`、`claude`、`kimi`、`pi` 的命令、路径、启动方式 |
| 进程根匹配 | 实际 ELF、父进程、容器入口、工作目录 |
| Resume 参数提取 | CLI argv 中的 resume/continue/session ID |
| Session 文件路径观察 | eBPF 捕获的 session/rollout/wire 文件路径，不读取内容 |
| LLM 请求字段 | OpenAI/Anthropic/Gemini 的 JSON 结构 |
| 工具名称字段 | `tool_name`、`toolName`、`name`、`node_type` |
| 工具参数字段 | `tool_input`、`input`、`arguments`、`args` |
| 工具结果字段 | `tool_output`、`result`、`output` |
| SSL 目标 | 系统 OpenSSL、静态 Node、BoringSSL、特定 ELF |
| 产品版本差异 | 版本范围、符号/偏移变化、兼容策略 |
| 端点模式 | 公有 LLM、自建 LLM、Dify 服务、LangGraph 服务 |

---

## 10. 原始事实模型

建议定义语言无关的 JSON Schema，并生成 TypeScript 和 Rust 类型，避免两边手写漂移。

```typescript
interface RawObservation {
  schemaVersion: "anysentry.observation.v1";
  observationId: string;

  eventTime: {
    wallMs?: number;
    monotonicNs?: number;
  };

  ingestTime?: number;

  source: {
    sourceId?: string;
    collectorId?: string;
    sourceType: "kernel" | "uprobe" | "socket_payload";
    probeId?: string;
    sourceSequence?: number;
  };

  runtime: {
    runtimeInstanceId?: string;
    environment: "host" | "ssh" | "docker" | "kubernetes" | "microvm";
    machineId?: string;
    bootId?: string;
    clusterId?: string;
    namespace?: string;
    podUid?: string;
    containerId?: string;
    cgroupId?: string;
    netnsId?: string;
    sshConnectionId?: string;
  };

  process?: {
    pid?: number;
    tid?: number;
    processStartTime?: number;
    parentPid?: number;
    parentStartTime?: number;
    executable?: string;
    comm?: string;
    argv?: string[];
    cwd?: string;
    osUid?: number;
  };

  connection?: {
    connectionId?: string;
    socketCookie?: string;
    fd?: number;
    protocol?: "tcp" | "udp" | "unix" | "websocket";
    localAddress?: string;
    localPort?: number;
    peerAddress?: string;
    peerPort?: number;
    tlsContextId?: string;
    httpStreamId?: string;
  };

  raw: {
    kind: string;
    encoding?: string;
    payloadRef?: string;
    payloadHash?: string;
    payloadBytes?: number;
    truncated?: boolean;
    redactionState?: "none" | "partial" | "full" | "hash_only";
    preview?: string;
  };

  vendor?: {
    familyHint?: string;
    versionHint?: string;
    recordTypeHint?: string;
    ids?: Record<string, string>;
  };
}
```

关键约束：

- 原始事件不可变；
- 明文不默认放入宽表，使用受控 `payloadRef`；
- `preview` 必须脱敏且不能代替原始证据；
- 同时保存 event time、ingest time、source sequence；
- 原始记录和归因结果不能混成一个对象；
- 重试时使用稳定 idempotency key，不重复创建事件；
- 如果发生丢包或序列缺口，必须产生明确的 gap/coverage 记录。

---

## 11. 统一语义模型

### 11.1 ConversationMessage

```typescript
interface ConversationMessage {
  recordId: string;
  kind:
    | "user_message"
    | "system_instruction"
    | "developer_instruction"
    | "assistant_message"
    | "reasoning_summary"
    | "tool_call_message"
    | "tool_result_message";

  logicalAgentId?: string;
  agentInstanceId?: string;
  runtimeInstanceId?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;

  traceId?: string;
  spanId?: string;
  parentSpanId?: string;

  vendorMessageId?: string;
  at: number;

  parts: Array<{
    type: "text" | "image" | "file" | "json" | "thinking" | "tool_call" | "tool_result";
    text?: string;
    payloadRef?: string;
    toolCallId?: string;
    toolName?: string;
    argumentsRef?: string;
    resultRef?: string;
  }>;

  sourceRefs: string[];
  parserId: string;
  parserVersion: string;
  confidence: "confirmed" | "strong" | "probable" | "unknown";
}
```

### 11.2 LlmCall

```typescript
interface LlmCall {
  llmCallId: string;

  sessionId?: string;
  turnId?: string;
  runId?: string;
  traceId?: string;
  spanId?: string;

  provider?: string;
  model?: string;
  operation:
    | "chat"
    | "responses"
    | "generate_content"
    | "interactions"
    | "unknown";

  requestId?: string;
  responseId?: string;
  previousResponseId?: string;

  connectionId?: string;
  httpStreamId?: string;

  inputMessageIds: string[];
  outputMessageIds: string[];
  toolCallIds: string[];

  startedAt?: number;
  firstChunkAt?: number;
  finishedAt?: number;

  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };

  streamState: "non_streaming" | "streaming" | "complete" | "incomplete" | "failed";
  sourceRefs: string[];
}
```

### 11.3 ToolCall

```typescript
interface ToolCall {
  toolCallId: string;

  sessionId?: string;
  turnId?: string;
  runId?: string;
  llmCallId?: string;

  rawName: string;
  canonicalKind?:
    | "shell"
    | "file_read"
    | "file_write"
    | "file_edit"
    | "search"
    | "retrieval"
    | "browser"
    | "mcp"
    | "subagent"
    | "unknown";

  argumentsRef?: string;
  resultRef?: string;

  requestedAt?: number;
  startedAt?: number;
  finishedAt?: number;

  status:
    | "requested"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown";

  processTreeIds: string[];
  sourceRefs: string[];
}
```

`rawName` 和 `canonicalKind` 必须同时保留，例如：

```text
rawName = "WriteFile"
canonicalKind = "file_write"
```

前端默认展示 `WriteFile`，只有跨产品统计时才使用 `file_write`。

---

## 12. SSL/TLS 明文采集设计

### 12.1 原有理解中正确的部分

正确方向包括：

```text
在 SSL 加密前或解密后复制明文
在用户态完成协议解析
通过网络连接和进程上下文归因
只对目标 Agent 进行深度采集和长期保留
```

### 12.2 需要修正的部分

不能实现为：

```text
捕获明文
  → 等待 egress
  → 如果归因成功才保留
```

应实现为：

```text
捕获明文片段
  → 建立连接/请求上下文
  → 识别传输协议
  → 识别 LLM 格式
  → 聚合完整请求/响应
  → 解析 Session/Turn/Tool
  → 和 KernelFact 关联
  → 根据隐私策略晋级、脱敏或过期
```

原因如下。

#### Egress 是连接级事件，不是 LLM 请求级事件

一个 TCP/TLS 长连接可能承载多个请求，HTTP/2 还可能并发多个 Stream。

```text
Egress ≠ LlmCall
Connection ≠ Request
Request ≠ Session
```

正确层次是：

```text
Socket/Connection
  → HTTP request 或 HTTP/2 stream
    → LlmCall
      → ConversationMessage
```

#### 事件到达顺序不可靠

Observer 使用多个 Ring Buffer，Collector、网络和批量写入也会带来延迟。可能出现：

```text
先收到 SSL response
后收到 TLS/SNI
再收到 connect
最后收到 close
```

因此明文需要进入有界 Pending Store，而不是因为暂时没有 Egress 就被丢弃。

#### 归因不是保留与否的唯一条件

即使暂时不知道是哪一个 Agent，也应保留至少：

```text
payloadHash
payloadSize
direction
connectionId
processKey
peer
timestamp
parser status
```

如果策略允许，可短期保存加密正文；如果不允许，只保留 hash 和元数据。

### 12.3 Pending Plaintext Store

建议状态：

```text
captured
  → protocol_candidate
    → attributed
      → parsed
        → promoted / redacted / expired / rejected
```

建议字段：

```text
capture_id
connection_id
process_key
direction
chunk_sequence
monotonic_ns
payload_ref
payload_hash
ttl
state
```

Pending Store 必须有：

```text
总容量上限
单连接上限
单 Session 上限
TTL
淘汰指标
序列缺口指标
```

---

## 13. Observer 结构性改造

### 13.1 Kernel Core 只采集稳定事实

Observer eBPF 核心负责：

```text
process.exec
process.fork
process.exit
network.connect
network.close
network.dns
network.tls_client_hello
file.open/write/delete/rename
security.action
resource.sample
```

不应把以下解析写进 eBPF 内核程序：

```text
Codex JSON
Claude JSON
Dify 字段
OpenAI 字段
Anthropic 字段
Gemini 字段
```

内核只采集有界字节和元数据，语义解析在用户态进行。

### 13.2 稳定 ProcessKey

至少增加：

```text
machine_id
boot_id
pid
process_start_time
tid
parent_pid
parent_start_time
cgroup_id
netns_id
```

进程身份：

```text
ProcessKey = machine_id + boot_id + pid + process_start_time
```

不能只使用 PID。

### 13.3 稳定 ConnectionKey

建议尽量获取：

```text
connection_id
socket_cookie
fd
netns_id
tls_context_id
```

如果 SSL 层不能直接得到 FD，可以：

```text
记录 SSL* 指针
在 SSL_set_fd / BIO 相关位置建立 SSL* → fd 映射
在用户态维护 tls_context_id → connection_id
```

OpenSSL、BoringSSL、Node 内嵌 OpenSSL 可以对应不同 Capture Provider，但统一输出 `connectionId`。

### 13.4 SslEvent 扩展字段

至少需要：

```text
pid
tid
process_start_time
fd 或 tls_context_id
connection_id
is_read
capture_seq
monotonic_ns
payload_offset
payload_length
truncated
```

### 13.5 二进制和 TLS 实现发现

不能只 attach：

```text
/usr/lib/x86_64-linux-gnu/libssl.so.3
```

Claude Code/Bun 可能使用静态链接的 BoringSSL，Node.js 可能把 OpenSSL 嵌入 Node 二进制中。类似 AgentSight 的实践也说明，静态链接、符号裁剪和网络线程差异是常见问题。[AgentSight Agent-specific Capture](https://github.com/eunomia-bpf/agentsight/blob/master/docs/agents.md)

建议实现编译在 Observer 内的 `BinaryDiscovery`：

```text
命令路径
  → 解析软链接
  → 解析 shebang
  → 查找真实 ELF
  → 查看 /proc/<pid>/maps
  → 判断动态库或静态链接
  → 选择符号探针或版本化字节模式
```

这不是外部脚本注入。Agent Adapter 只提供版本化提示和 Capture Plan，真正的发现、attach、失败降级和清理由 Observer Collector 完成。

### 13.6 关联状态不能整体 clear

当前 Collector 在 map 超限时存在直接 `clear()` 的做法，这会切断仍在进行的关联。

应改为：

```text
TTL
LRU
close-driven cleanup
process-exit cleanup
per-key eviction
```

并记录：

```text
evicted_connections
expired_captures
correlation_state_overflow
orphan_ssl_chunks
orphan_llm_calls
```

### 13.7 Probe 丢包需要分类型可见

当前全局 drop count 不能说明是哪类事件丢失。建议按 Ring/Signal 分类：

```text
exec_dropped
exit_dropped
network_dropped
file_dropped
ssl_dropped
security_dropped
export_dropped
wal_dropped
```

---

## 14. Transport Decoder 和 LLM Format Adapter

### 14.1 Transport Decoder

只处理传输协议：

```text
HTTP/1.1
chunked encoding
SSE
HTTP/2 stream
WebSocket
plain HTTP socket payload
```

输出：

```typescript
interface TransportFrame {
  connectionId: string;
  streamId?: string;
  direction: "request" | "response";
  sequence: number;
  timestamp: number;
  headers?: Record<string, string>;
  bodyChunk?: Uint8Array;
  endOfMessage?: boolean;
}
```

Transport Decoder 不知道这是 OpenAI 还是 Anthropic。

### 14.2 LLM Format Adapter

处理供应商格式：

```text
OpenAI Chat Completions
OpenAI Responses
Anthropic Messages
Gemini GenerateContent
Gemini Interactions
OpenAI-compatible profiles
```

推荐接口：

```typescript
interface LlmFormatAdapter {
  id: string;
  version: string;

  detect(frame: TransportFrame): number;
  consume(frame: TransportFrame, state: unknown): ParserOutput;
  finalize(state: unknown, reason: string): ParserOutput;
}
```

### 14.3 OpenAI

Responses API 中函数调用参数和文本都可能分片发送，需要识别：

```text
response.created
response.output_text.delta
response.output_item.added
response.function_call_arguments.delta
response.function_call_arguments.done
response.completed
```

参考：[OpenAI Responses Streaming API](https://platform.openai.com/docs/api-reference/responses-streaming/response/function_call_arguments/done)

### 14.4 Anthropic

Anthropic 流式响应采用：

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
```

工具输入可能由多个 `input_json_delta` 组成，只有 block 结束后才是完整 JSON。

参考：[Anthropic Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)

### 14.5 Gemini

Gemini GenerateContent/Interactions 需要保留：

```text
responseId
candidate index
part index
functionCall
functionResponse
thought signature
step type
```

参考：[Gemini Text Generation](https://ai.google.dev/gemini-api/docs/generate-content/text-generation)、[Gemini API Reference](https://ai.google.dev/api)

### 14.6 流式聚合规则

必须按以下 Key 聚合：

```text
llmCallId
或
connectionId + streamId + requestSequence
```

不能使用：

```text
仅 PID
仅到达时间
最近一次 LLM 事件
```

流式聚合器需要支持：

```text
chunk 顺序检查
重复 chunk 去重
断流标记
超时结束
累计 Token 去重
多候选结果
多工具并行调用
HTTP/2 多路复用
SSE ping/comment
UTF-8 跨 chunk 拆分
```

---

## 14.7 eBPF-only 下的字段来源优先级

当前不使用 Hook、SDK、ACP、Transcript 内容读取、代理或网关改造，因此每类字段都必须标明“能否从 eBPF 边界获得”。

| 字段 | eBPF-only 优先级 | 不可见时的结果 |
|---|---|---|
| Session ID | TLS/明文协议字段 > CLI argv > 文件路径元数据 > ProcessTree/连接连续性 | `inferred` 或 `ephemeral` |
| Turn/Run ID | TLS/明文协议 request ID > 请求序号 > 时间和连接推断 | `probable` 或缺失 |
| 用户 Prompt | SSL_write/socket payload 中的请求正文 | `content_unavailable` |
| LLM Response | SSL_read/socket payload 中的响应正文 | `content_unavailable` |
| Tool Intent | LLM 响应中的 ToolCall 结构 > 进程 argv 推断 | `partial` 或 `inferred` |
| Tool Result | 子进程 stdout/exit/file/network 事实 > 协议响应 | `partial` |
| Agent 类型 | 根进程/ELF/命令指纹 > endpoint/SNI/DNS > 行为序列 | `unknown-agent` |
| 业务 User ID | 协议正文或请求字段中真实出现的 ID | 不使用 OS uid 代替 |
| Workspace | cwd、路径和命令参数 | 仅作为 context hint |
| 机器侧效果 | KernelFact | 以 KernelFact 为权威 |

特别注意：

```text
OS uid 是运行时权限主体，不等于业务 user_id
cwd 是环境提示，不等于稳定 workspace identity
endpoint/SNI 能识别服务类型，不一定能识别 Agent 产品
```

---

## 15. Agent Adapter

Agent Adapter 不负责整个观测链路，只提供产品特异信息。

当前 eBPF-only 约束下，推荐接口：

```typescript
interface AgentAdapter {
  id: string;
  family: string;
  versionRange?: string;

  capabilities: {
    processDiscovery: boolean;
    tlsPlaintext: "full" | "partial" | "none";
    toolIntent: "full" | "partial" | "none";
    sessionIdentity: "explicit" | "path" | "argv" | "inferred" | "none";
    resumeInference: "explicit" | "path" | "argv" | "inferred" | "none";
    subagents: boolean;
  };

  discover(context: RuntimeContext): Promise<AgentCandidate[]>;

  identifyProcessRoot(fact: KernelFact): IdentityHint[];

  decodeCapturedProtocol(
    frames: TransportFrame[],
  ): SemanticRecord[];

  extractIdentity(
    record: RawObservation | SemanticRecord,
  ): IdentityHint[];

  extractLifecycle(
    record: RawObservation | SemanticRecord,
  ): LifecycleFact[];

  extractTool(
    record: SemanticRecord,
  ): ToolFact[];

  buildCapturePlan(
    candidate: AgentCandidate,
  ): CapturePlan;
}
```

Adapter 只能输出：

```text
IdentityHint
LifecycleFact
SemanticRecord
ToolFact
CapturePlan
```

禁止 Adapter 直接：

```text
写 ClickHouse
调用 Sentry Judge
修改 Dashboard
修改其他 Agent 状态
启动外部注入脚本
修改被观察 Agent 配置
```

---

## 16. 四类 CLI Agent 的统一映射

统一模型：

```text
AgentFamily       = cli-agent 产品类型
LogicalAgent      = 产品 + 工作区 + 配置档
AgentInstance     = 每次 CLI 启动
RuntimeInstance   = CLI 根进程和进程树
Session           = 产品自己的 thread/session；不可见时为 inferred/ephemeral
Turn              = 一次用户输入处理
```

### 16.1 Codex

语义参考：

```text
thread.id / conversation_id → Session
turn.id                     → Turn
item.id/type                → ConversationItem / ToolCall / Message
thread/resume               → Session resumed
thread/fork                 → New Session + parentSessionId
```

当前 eBPF-only 识别路径：

```text
进程命令和 ELF
启动 argv 中的 resume/session 参数
Codex session/rollout 文件路径的 eBPF file-open 事件
捕获的 OpenAI/兼容 API 请求响应
进程树和连接连续性
```

说明：当前 Observer 默认主要采集写入型文件事件；要通过文件路径辅助识别 Session，需要新增低开销、按路径过滤的文件打开元数据 Probe。该 Probe 只采集路径和进程上下文，不读取文件内容。

如果上述边界中没有出现真实 thread/session ID，则 Session 只能标记为 `inferred`。

### 16.2 Claude Code

语义参考：

```text
session_id       → Session
prompt_id        → Prompt/Turn correlation
tool_use_id      → ToolCall
tool_name        → rawName
tool_input       → arguments
agent_id         → subagent instance
agent_type       → subagent logical type
```

当前 eBPF-only 识别路径：

```text
Claude/Bun 根进程及其 HTTP Client 线程
启动 argv 的 resume 参数
Claude session JSONL 路径的 eBPF file-open 事件
捕获的 Anthropic Messages API 请求响应
进程和连接连续性
```

文件路径识别依赖后续增加只读文件打开元数据 Probe；当前实现的写文件 Probe 不能自动覆盖该场景。

当前不读取 Claude Transcript 内容，也不安装 Claude Hook。

### 16.3 Pi

语义参考：

```text
session file / session id → Session
id + parentId             → Session tree
turn_start/end            → Turn
tool_execution_*          → ToolCall lifecycle
fork/tree                 → Session branching
```

当前 eBPF-only 识别路径：

```text
Pi 根进程和 argv
Pi session 文件路径的 file-open 事件
捕获的 LLM API 流量
进程树和连接连续性
```

这里的 `file-open` 指只观察路径和元数据，不读取 Session 文件正文；如果未部署对应的只读路径 Probe，则 Session 只能使用协议、argv 或进程连续性推断。

无法从文件路径或协议中恢复树节点时，不伪造精确分支关系。

### 16.4 Kimi

语义参考：

```text
sessionId                  → Session
state.json                 → session metadata
agents/main/wire.jsonl     → main conversation
agents/agent-*/wire.jsonl  → subagent sessions
tool_name/tool_call_id     → ToolCall
--continue/--session       → resume
```

当前 eBPF-only 识别路径：

```text
Kimi 根进程和 argv
session directory/wire.jsonl 路径的 eBPF file-open 事件
捕获的 LLM 请求响应
子 Agent 进程树
```

同样，当前范围只允许观察文件路径元数据，不读取 `wire.jsonl` 内容；只读路径 Probe 尚需单独实现和性能验证。

当前不安装 Kimi Hook，不使用 ACP，不读取 `wire.jsonl` 内容。

---

## 17. Dify 模型

推荐映射：

```text
AgentFamily       = dify
LogicalAgent      = Dify tenant + app/workflow definition
AgentInstance     = workflow/app version + environment + published state
RuntimeInstance   = Dify API/worker/plugin Pod 或进程
Session           = conversation_id，或每次调用的临时 Session
Turn/Run          = workflow_run_id / task_id
NodeRun           = node_id + node execution
ToolCall          = Dify plugin/tool/node invocation
```

### 17.1 Chat/Agent/Chatflow

```text
conversation_id → Session
message_id      → Message/Turn
task_id         → execution task
workflow_run_id → nested workflow run
```

### 17.2 纯 Workflow

```text
workflow_id
workflow_run_id
task_id
node_started
node_finished
workflow_finished
```

纯 Workflow 不一定有 `conversation_id`。

建议 Dify Adapter 支持：

```text
sessionMode:
  vendor_conversation
  per_invocation
  trace_group_only
```

含义：

```text
vendor_conversation
  观察到 conversation_id 时复用 Session

per_invocation
  每次 POST 创建新的 AnySentry ephemeral Session
  workflow_run_id 作为 Run

trace_group_only
  trace_session_id 只用于观测分组
  不认为它能够恢复对话
```

### 17.3 测试和生产必须分开

```text
Dify Workflow logical definition
  ├── test instance
  ├── draft instance
  └── published production instance
```

至少通过以下字段区分：

```text
environment
deployment_id
workflow_version
published_revision
runtime_instance_id
```

### 17.4 eBPF-only 的 Dify 采集路径

当前不增加 Dify 插件、SDK 或网关。采集来自：

```text
Dify API/worker 进程的入站和出站 socket/TLS 明文
Dify 调用 LLM 的出站 TLS 明文
Dify 插件或代码节点产生的进程、文件和网络事实
容器/Pod/cgroup 运行时身份
```

其中“入站和出站 socket/TLS 明文”是目标 Capture Extension 的能力描述，不表示当前版本已经覆盖所有 Dify 进程和所有 TLS 实现。实际结果必须以 Collector 的 Probe attach 状态和 Coverage 记录为准；如果 TLS 在未被支持的静态库中，仍然保留连接、进程和网络元数据，不把缺少明文解释成没有请求。

如果 Dify 外层有独立 Nginx/Ingress 终止 TLS，必须明确采集点：

```text
Ingress 只负责外部 API 明文
Dify worker 负责内部 LLM 明文和工具效果
```

二者通过请求 ID、连接、RuntimeContext 和时间关系连接。

---

## 18. LangChain / LangGraph / LangServe 模型

推荐映射：

```text
AgentFamily       = langchain / langgraph
LogicalAgent      = chain/graph/assistant definition
AgentInstance     = deployed graph/config/version
RuntimeInstance   = 进程、容器、Pod、Replica
Session           = thread_id 或 session_id；不可见时为 per-request ephemeral
Turn/Run          = run_id
NodeSpan          = parent_ids + node name
ToolCall          = tool run / tool_call_id
```

### 18.1 LangGraph

语义参考：

```text
assistant_id / graph_id → LogicalAgent 或 AgentInstance
thread_id               → Session
run_id                  → Turn/Run
parent_ids              → Span parent chain
checkpoint_id           → Session state revision
interrupt               → paused/resumable lifecycle
```

### 18.2 LangServe 或自建 HTTP 服务

如果协议中没有：

```text
thread_id
session_id
conversation_id
```

默认：

```text
每次 POST = 一个新 Run + 一个 ephemeral Session
```

并写明：

```text
sessionIdentity = synthetic
vendorSessionKnown = false
```

如果捕获的请求体或 Header 中有稳定 Session 字段，则复用相应 Session。

### 18.3 eBPF-only 的服务采集路径

当前不要求 LangChain/LangGraph 应用增加 OTel、Callback 或 SDK。

采集来自：

```text
服务进程入站 HTTP/TLS 明文
服务进程出站 LLM TLS 明文
工具调用产生的进程、文件、网络事实
Pod/Container/cgroup 身份
```

这些内容通过服务进程的 eBPF socket/TLS 边界观察获得，属于按进程、端口和 RuntimeInstance 配置的可选深度采集；当前不改变应用的 Base URL，也不部署独立代理或网关。

---

## 19. Kernel Candidate Agent 检测

内核候选判断必须独立运行。

```text
所有内核事件
  → ProcessTree
  → RuntimeActivityWindow
  → CandidateAgentDetector
  → KernelRiskDetector
  → Kernel Evidence Graph
```

这条链路不需要先知道：

```text
是不是 Codex
是不是 Claude
是不是 Dify
是不是 OpenAI 格式
```

候选信号包括：

```text
根进程命令和 ELF
进程血缘
LLM endpoint/SNI/DNS
TLS 请求响应节奏
已知 Session 文件路径访问
工具子进程模式
文件和网络活动
安全敏感动作
```

定义：

```typescript
interface AgentCandidate {
  candidateId: string;
  familyGuess?: string;
  logicalAgentId?: string;
  agentInstanceId?: string;
  runtimeInstanceId: string;
  processTreeId: string;
  confidence: "confirmed" | "strong" | "probable" | "unknown";
  evidenceObservationIds: string[];
  detectionVersion: string;
  status: "candidate" | "bound" | "rejected" | "expired";
}
```

例如未知 Z.ai CLI：

```text
familyGuess = unknown-cli-agent
runtimeInstanceId = host-a/process-tree-123
providerHint = z-ai
confidence = probable
plaintextCoverage = unavailable/partial
kernelCoverage = available
```

以后出现更强证据时新增 `AttributionRevision`，不修改原始 KernelFact。

---

## 20. Correlation Engine

### 20.1 状态索引

```text
ProcessRegistry
  ProcessKey → ProcessNode
  Parent ProcessKey → Child ProcessKey[]

ConnectionRegistry
  ConnectionKey → peer/SNI/TLS/HTTP stream

CaptureRegistry
  captureId → pending plaintext chunks

SessionRegistry
  vendor session ref → AnySentry session

TurnRegistry
  vendor turn/run ref → AnySentry turn

ToolRegistry
  tool_call_id → ToolCall + process trees

PendingRelationRegistry
  unresolved record → candidate relations
```

### 20.2 关联证据强度

#### 已确认关联

```text
相同 vendor session/thread/conversation ID
相同 request_id
相同 tool_call_id
相同 trace/span ID
相同 socket_cookie + stream_id
```

#### 强关联

```text
相同 ProcessKey
相同 ProcessTree
父子进程关系明确
相同 ConnectionKey
相同 RuntimeInstance
```

#### 推断关联

```text
时间窗口接近
LLM 响应中的文件名出现在后续 FileFact
LLM 响应中的命令出现在后续 ProcessExec
LLM 响应中的 URL 出现在后续 NetworkFact
```

#### 不确定关联

```text
存在多个候选 Session
PID/FD 已复用
同一连接存在多个 HTTP/2 Stream
只有时间，没有参数或身份依据
```

最终关系必须带：

```text
method
confidence
evidenceObservationIds
algorithmVersion
timeDelta
ambiguousCandidates
```

### 20.3 关系类型

至少支持：

```text
contains
belongs_to
emitted_by
hosted_by
resumes
forked_from
calls
returns_to
executes_as
network_for
file_effect_of
caused_by
evidence_for
candidate_for
```

例如：

```text
LLMResponse(L1)
  -- proposes -->
ToolCall(T1)

ToolCall(T1)
  -- executes_as -->
ProcessTree(P1)

ProcessTree(P1)
  -- writes -->
FileFact(F1)
```

### 20.4 事件乱序

使用 Event-Time + Watermark：

```text
事件到达
  → 短期缓冲
  → 等待 watermark
  → 尝试关联
  → 输出 confirmed/inferred/ambiguous/unmatched
```

后续出现更强证据时，新增关系修正记录，不修改原始事件。

### 20.5 SessionProcessMatch

Session 和进程树之间必须使用显式关系：

```typescript
interface SessionProcessMatch {
  sessionId: string;
  processTreeId: string;
  confidence: number;
  evidenceType:
    | "argv_session_id"
    | "session_file_path"
    | "llm_traffic"
    | "command_match"
    | "process_lineage"
    | "temporal"
    | "sticky";
  evidenceSummary: string;
  firstSeenAt: number;
  lastSeenAt: number;
}
```

任何在 Session 下展示的 CPU、文件、网络或进程活动，都必须能指出是哪条 `SessionProcessMatch` 将它归入该 Session。没有足够证据时，保留为 Process-only 或 Unattributed。

---

## 21. 完整链路示例

```text
t0:
用户输入
  session=S1
  turn=T1

t1:
LLM Request
  llmCall=C1
  connection=K1
  model=gpt-5

t2:
LLM Response
  llmCall=C1
  tool_call_id=X1
  raw_name="Bash"
  arguments.command="npm test"

t3:
Kernel process.exec
  process=P1
  parent=Codex process
  argv=["bash", "-lc", "npm test"]

t4:
Kernel file.open/write
  process=P1
  path="/workspace/package-lock.json"

t5:
Kernel process.exit
  process=P1
  exit_code=0

t6:
Tool Result
  tool_call_id=X1
  status="succeeded"

t7:
下一次 LLM Request
  llmCall=C2
  input includes tool result
```

最终 AnySentry 应回答：

```text
用户说了什么？
LLM 收到了什么完整上下文？
LLM 返回了什么？
LLM 请求了哪个工具？
Agent 是否真的执行了这个工具？
工具产生了哪些进程？
进程改了哪些文件？
是否有外联？
是否有异常安全动作？
这些关系是明确关联还是推断关联？
Session 是否在另一个实例中恢复？
```

---

## 22. 工具名称展示规则

不同 Agent 的工具名不强制改写为同一个名称。

保留三层：

```text
rawName
displayName
canonicalKind
```

| Agent | 原始工具名 | 展示 | 统一分类 |
|---|---|---|---|
| Claude Code | `Bash` | `Bash` | `shell` |
| Claude Code | `Write` | `Write` | `file_write` |
| Kimi | `WriteFile` | `WriteFile` | `file_write` |
| Kimi | `StrReplaceFile` | `StrReplaceFile` | `file_edit` |
| Pi | `bash` | `bash` | `shell` |
| Dify | 插件或节点名 | 原始插件/节点名 | 可选 |
| LangChain | Tool name | Tool name | 可选 |
| Kernel-only | `bash -lc npm test` | 命令摘要 | `shell`，低置信度 |

Adapter 声明：

```typescript
interface ToolMapping {
  namePaths: string[];
  callIdPaths: string[];
  argumentPaths: string[];
  resultPaths: string[];
  statusPaths: string[];
}
```

新增 Agent 时重点研究：

```text
工具名在哪里
工具 ID 在哪里
参数在哪里
结果在哪里
状态在哪里
```

不重新编写工具检测链路。

---

## 23. 部署环境解耦

### 23.1 宿主机

```text
RuntimeAdapter = host
AgentAdapter   = codex / claude / pi / kimi / custom
```

### 23.2 SSH

SSH 是连接方式，不是另一种 Agent。

```text
本地 ssh client
  → transport metadata

远端 Agent process
  → 仍使用原 Agent Adapter
```

记录：

```text
ssh_connection_id
remote_machine_id
remote_user
remote_tty
```

不要把本地 SSH 客户端的网络事件误认为 Agent 行为。

### 23.3 Docker

RuntimeAdapter 负责：

```text
container_id
cgroup
PID namespace
image digest
host PID
```

Agent Adapter 不知道自己运行在 Docker 还是宿主机。

### 23.4 Kubernetes

RuntimeAdapter 负责：

```text
cluster_id
namespace
pod_uid
container_id
workload_owner
deployment_revision
node_name
```

一个 AgentInstance 可以有多个 RuntimeInstance：

```text
logical agent
  └── agent instance: workflow-v3-prod
        ├── pod-a
        ├── pod-b
        └── pod-c
```

一个 Pod 可以处理多个 Session：

```text
pod-a
  ├── conversation-1
  ├── conversation-2
  └── conversation-3
```

因此 Kubernetes Resolver 只能补充 RuntimeContext，不能覆盖 Agent/Session ID。

### 23.5 a3s-box / MicroVM

宿主机 Observer 可以看到 Box Egress，但 Guest 内 exec/file 需要 Guest Collector。

```text
Host Observer:
  网络边界事实

Guest Observer:
  进程、文件、工具、TLS 明文事实
```

通过：

```text
box_id
guest_machine_id
workload_id
```

合并，不重新定义 Agent 模型。

---

## 24. 风险判断分层

### 24.1 L1：确定性规则

输入：

```text
KernelFact
SemanticRecord
```

适合：

```text
云元数据访问
危险命令
凭据文件
已知反向 Shell
提权
进程注入
异常开放端口
```

### 24.2 L2：结构化语义判断

输入：

```text
一个 ToolCall
一个 LlmCall
一个 Session 片段
一个关系子图
```

适合：

```text
提示词注入
工具意图和实际效果不一致
异常数据外传
重复失败循环
```

### 24.3 L3：上下文深判

输入经过脱敏的 Session/Evidence Bundle，适合复杂因果关系和跨工具攻击链。

无论 L2/L3 是否可用，都不能影响：

```text
KernelFact 采集
CandidateAgent 生成
原始事实落盘
覆盖率记录
```

Judgment 应作为独立记录引用目标对象，而不是覆盖原事件。

---

## 25. 数据存储

### 25.1 `raw_observations`

存储：

```text
observation_id
event_time
ingest_time
source_id
collector_id
probe_id
source_sequence
runtime_instance_id
process_key
connection_key
raw_kind
payload_ref
payload_hash
payload_size
truncated
redaction_state
schema_version
```

特点：

```text
只追加
不修改
可重放
可按来源去重
```

### 25.2 `kernel_facts`

存储：

```text
process.exec/fork/exit
network.connect/close/dns/tls/bytes
file.open/write/delete/rename
security.action
resource.sample
```

KernelFact 不要求必须有 Session。

### 25.3 `semantic_records`

存储：

```text
ConversationMessage
LlmCall
ToolCall
ToolResult
Retrieval
AgentLifecycle
SessionLifecycle
NodeRun
```

### 25.4 `entities`

存储：

```text
agent_family
logical_agent
agent_instance
runtime_instance
session
turn/run
```

### 25.5 `relations`

```text
relation_id
from_id
to_id
relation_type
method
confidence
evidence_observation_ids
algorithm_version
created_at
```

### 25.6 `judgments`

```text
subject_type
subject_id
verdict
tier
severity
risk_category
reason
decision_version
```

可针对：

```text
单个 KernelFact
单个 ToolCall
单个 LlmCall
一个 Session
一段关系子图
```

### 25.7 Payload Store

大段明文、工具参数和结果不直接放 ClickHouse 主表。

```text
ClickHouse:
  元数据、索引、hash、引用、统计

本地加密文件/CAS/对象存储:
  原始正文、完整 chunk、必要的证据 Blob
```

不同 TTL：

```text
原始明文：短 TTL
脱敏语义记录：中 TTL
内核事实和风险摘要：长 TTL
审计记录：按合规要求
```

---

## 26. ClickHouse 渐进式迁移

当前不引入 Kafka，不进行大规模分布式改造。

```text
阶段 1:
  保留当前 AnySentry API
  增加 raw_observations / kernel_facts / semantic_records / relations
  保留 events 作为兼容投影

阶段 2:
  将实体注册和控制状态拆成 Repository
  仍可存 ClickHouse，必要时再引入 PostgreSQL/SQLite

阶段 3:
  只有真实指标证明需要时，再评估分布式传输
```

当前 `events` 表作为：

```text
anysentry.agent_event.v1 compatibility projection
```

旧字段映射：

| 当前字段 | 目标字段 |
|---|---|
| `agentId` | `logicalAgentId` 的兼容别名 |
| `sessionId` | 真实 `sessionId`；无真实值时记录 identity quality |
| `runId` | 拆为 `turnId` 和 `runId` |
| `traceId` | 每次执行 Trace；保留 `legacyTraceId` |
| `taskId` | `vendorTaskId` 或 node/task |
| `eventKind` | `KernelFact.kind` 或 `SemanticRecord.kind` |
| `attributes` | 类型化字段 + `extensions` |
| `rawPreview` | 脱敏 preview + `payloadRef` |
| `source` | kernel/uprobe/socket_payload/api projection |

---

## 27. AnySentry 模块重组

```text
apps/api/src/observability/
  contracts/
    observation.ts
    semantic.ts
    identity.ts
    relation.ts
    judgment.ts
    coverage.ts

  ingest/
    ingest.controller.ts
    ingest-pipeline.service.ts
    source-auth.service.ts
    wal.service.ts
    dedup.service.ts

  runtime/
    runtime-context.service.ts
    process-registry.service.ts
    process-lineage.service.ts
    runtime-adapters/
      host.adapter.ts
      ssh.adapter.ts
      docker.adapter.ts
      kubernetes.adapter.ts
      microvm.adapter.ts

  transport/
    http-decoder.ts
    sse-decoder.ts
    http2-decoder.ts
    websocket-decoder.ts

  llm-formats/
    llm-format-registry.ts
    openai-chat.adapter.ts
    openai-responses.adapter.ts
    anthropic-messages.adapter.ts
    gemini.adapter.ts
    openai-compatible.adapter.ts
    stream-assembler.ts

  agents/
    agent-registry.ts
    agent-adapter.ts
    codex/
    claude-code/
    pi/
    kimi-cli/
    dify/
    langchain/
    langgraph/

  identity/
    logical-agent-registry.ts
    instance-registry.ts
    session-registry.ts
    lifecycle.service.ts
    attribution.service.ts

  correlation/
    correlation-engine.ts
    connection-correlator.ts
    session-process-match.ts
    tool-process-correlator.ts
    evidence-link.service.ts
    watermark.service.ts

  detection/
    kernel-candidate-detector.ts
    kernel-sequence-detector.ts
    semantic-risk-detector.ts
    judgment.service.ts

  storage/
    raw-observation.repository.ts
    kernel-fact.repository.ts
    semantic-record.repository.ts
    relation.repository.ts
    entity.repository.ts
    payload.repository.ts

  projection/
    conversation-projection.service.ts
    evidence-projection.service.ts
    dashboard-projection.service.ts
    coverage-projection.service.ts

  query/
    agents.controller.ts
    instances.controller.ts
    sessions.controller.ts
    evidence.controller.ts
    coverage.controller.ts

  control/
    policy.service.ts
    retention.service.ts
    capability.service.ts
    audit.service.ts
```

当前模块迁移目标：

| 当前代码 | 目标职责 |
|---|---|
| `deriveMeta()` | `IdentityHintExtractor` |
| `canonicalEventKind()` | `Fact Normalizer` |
| `eventInner()` | `Source Adapter` |
| `SentryJudgeService.judge()` | `JudgmentService` |
| `AggregationService` | `ProjectionService` |
| `KubeIdentityService` | `RuntimeResolver`，不覆盖 Session |
| `ClickHouseStore` | 多个 Repository |
| `security-monitoring.controller.ts` | 薄路由和请求编排 |
| TUI 内产品解析 | 共享 Adapter/Parser Contract |

模块依赖规则：

```text
Capture       → RawObservation
Normalizer    → KernelFact
Parser        → SemanticRecord
Identity      → EntityBinding / IdentityHint
Correlator    → EvidenceLink
Judge         → Judgment
Projection    → ReadModel
Controller    → 只编排，不解析
```

---

## 28. 两种读模型

### 28.1 Conversation View：面向人

```text
Session 信息
  ├── Agent / Instance / Runtime
  ├── Session 新建、恢复、分支
  ├── 用户输入
  ├── LLM 请求和模型
  ├── LLM 响应
  ├── 工具调用
  ├── 工具结果
  ├── Token、延迟、TTFT
  ├── 中断、重试、压缩
  └── 最终回复
```

### 28.2 Evidence Graph：面向机器和安全分析

```text
Session
  └── Turn
        ├── LLM Request
        ├── LLM Response
        ├── ToolCall
        │     └── ProcessTree
        │           ├── ProcessExec
        │           ├── FileFact
        │           ├── NetworkFact
        │           └── SecurityFact
        └── Correlation Evidence
```

每条边显示：

```text
关联方式
置信度
来源事件
时间差
算法版本
歧义候选
```

前端不能自己按时间戳拼接关系。

---

## 28.3 API 和 UI 资源边界

现有 `/security-center/ingest`、`/ingest/events`、`/ingest/otel`、`/events/list`、`/events/timeline`、`/agents/inventory` 和 `/agents/topology` 继续作为迁移期兼容接口。

新接口按实体和视图分组，前缀可以继续使用 `/security-center`：

```text
GET  /v1/agent-families
GET  /v1/logical-agents
GET  /v1/logical-agents/:id/instances
GET  /v1/instances/:id/runtime-instances
GET  /v1/instances/:id/sessions
GET  /v1/sessions/:id/summary
GET  /v1/sessions/:id/timeline?view=conversation
GET  /v1/sessions/:id/timeline?view=evidence
GET  /v1/turns/:id
GET  /v1/llm-calls/:id
GET  /v1/tool-calls/:id
GET  /v1/evidence/:id/graph
GET  /v1/coverage
```

### 28.4 API 的职责

API 层只负责：

```text
鉴权
参数校验
查询已物化的数据
分页和过滤
字段可见性
输出兼容投影
```

API 层不负责：

```text
解析 Codex/Claude JSON
读取 eBPF Ring Buffer
重新匹配 PID 和 FD
根据时间戳临时建立因果关系
直接调用某个产品的解析函数
```

### 28.5 UI 的默认导航

```text
Agent Family
  → Logical Agent
    → Agent Instance
      → Runtime Instance
        → Session
          → Turn
            → LLM / Tool
              → Evidence Graph
```

UI 必须在详情页显示：

```text
数据来源
身份质量
采集覆盖率
关联置信度
解析器版本
是否为推断结果
是否存在数据缺口
```

---

## 29. 覆盖率模型

不能将“没有解析到”解释成“没有发生”。

```typescript
interface ObservationCoverage {
  kernel: "full" | "partial" | "none";
  processLineage: "full" | "partial" | "none";
  plaintext: "full" | "partial" | "disabled" | "unsupported";
  protocolSemantic: "full" | "partial" | "none";
  toolIntent: "full" | "partial" | "none";
  sessionIdentity: "confirmed" | "inferred" | "ephemeral" | "unknown";
  correlation: {
    confirmed: number;
    strong: number;
    probable: number;
    ambiguous: number;
    unmatched: number;
  };
}
```

例如：

```text
Z.ai CLI
  Kernel: full
  Process lineage: full
  Plaintext: unsupported/partial
  Tool intent: none/inferred
  Session identity: inferred
  Candidate Agent: yes
```

前端显示：

```text
内核观测正常，明文 Parser/Capture Plan 尚未覆盖
```

而不是：

```text
暂无数据
```

---

## 30. 隐私和明文策略

用户请求、系统 Prompt、工具参数和工具结果可能包含：

```text
API Key
Bearer Token
密码
源代码
个人信息
内部网络地址
系统提示词
业务数据
```

内容分级：

```text
metadata
semantic_summary
redacted_content
raw_content
```

权限分离：

```text
session.metadata.read
session.semantic.read
session.content.read
payload.raw.read
kernel.detail.read
```

关键规则：

1. 原始明文默认关闭或按环境显式开启。
2. eBPF 只做有界复制，不在内核保存无限正文。
3. 用户态先写入加密、短期、有容量限制的 Pending Store。
4. 解析前后都进行结构化脱敏。
5. 长期优先保留语义摘要、hash 和引用。
6. 查看原文需要单独权限和审计。
7. 不因 Judge 需要上下文就自动把完整明文发送给外部 LLM。
8. 必须区分 `capture_disabled`、`unsupported`、`parser_failed`、`redacted` 和 `no_event`。

---

## 31. 性能设计

### 31.1 事件优先级

```text
Priority 0：不能丢
  security.action
  process.exec/exit/fork
  instance/session lifecycle
  source heartbeat

Priority 1：尽量不丢
  network.connect/close
  DNS
  LLM call metadata
  tool lifecycle

Priority 2：可采样或短期丢弃
  高频 file event
  plaintext chunks
  大型 tool output
```

不应让安全事件和大块明文共享同一个无差别丢弃队列。

### 31.2 有界状态

所有状态必须配置：

```text
max entries
max bytes
TTL
LRU
per-process quota
per-connection quota
per-session quota
eviction metrics
```

### 31.3 两档采集

```text
Always-on cheap plane
  进程、网络、DNS、安全、心跳、候选 Agent

On-demand deep plane
  SSL/TLS 明文
  选定 socket payload
  文件高频事件
  完整工具参数
```

触发条件：

```text
指定 Agent
指定 Session/ProcessTree
风险候选
用户显式录制
调试模式
```

### 31.4 本地 WAL 和批量导出

在不引入 Kafka 的前提下：

```text
Observer Collector
  → 本地有界 WAL
  → 批量 HTTP/NDJSON/OTLP 导出
  → 重试 + idempotency key
  → AnySentry Ingest
```

迁移期可以兼容现有 Forwarder，但新增能力优先进入编译后的 Collector，而不是新增脚本链。

---

## 31.5 当前验证缺口

现有 AnySentry 验证脚本已经覆盖：

```text
observer ingest
generic JSON
OTLP
forwarder
source auth
dashboard/API contract
```

但仍缺少以下对目标架构至关重要的验证：

```text
Session/Instance 生命周期
明文流式聚合
跨连接和跨进程关联
PID/FD 复用
HTTP/2 多路复用
乱序和迟到事件
未知 Agent 降级
eBPF-only Session identity quality
新旧 Projection replay diff
```

当前 TUI 中已有部分 Codex/Claude JSONL 测试，但它们与 AnySentry 的 API 和存储契约没有共享 Fixture，后续应迁移到统一的 `contracts/fixtures`，由 Observer、AnySentry 和 TUI 共同回放。

---

## 32. 新增 Agent 开发手册

### 原则 1：先写身份和生命周期表

新增 Agent 前先填写：

```text
AgentFamily:
LogicalAgent:
AgentInstance:
RuntimeInstance:
Session:
Turn/Run:
ToolCall:
Resume:
Fork:
Subagent:
```

这些概念未说明清楚前，不开始编码。

### 原则 2：只使用 eBPF 可观察边界

先确定：

```text
根进程如何发现
实际 ELF 在哪里
使用哪种 TLS 实现
Session ID 是否出现在 argv、文件路径或协议明文中
工具调用字段是否出现在 LLM 响应中
子进程如何继承身份
```

不通过 Hook、SDK、strace、注入脚本或代理改造补齐缺失字段。

### 原则 3：Adapter 只产出标准记录

Adapter 不得直接修改：

```text
Judge
ClickHouse
Dashboard
其他 Agent
```

### 原则 4：产品名不能出现在核心模块

禁止核心代码出现：

```typescript
if (agentId === "codex") ...
if (agentId === "claude") ...
if (agentId === "kimi") ...
```

产品名只能存在于：

```text
AgentRegistry
AgentAdapter
Agent Manifest
Capture Plan
Fixture
```

### 原则 5：显式身份优先，推断身份降级

Session 身份优先级：

```text
协议中显式 session/thread/conversation ID
  > CLI argv 中的 resume/session ID
  > eBPF 观察到的 Session 文件路径
  > ProcessTree + Runtime + 时间连续性
  > ephemeral/unknown
```

Trace 身份优先级和 Session 身份分开，不使用 Trace ID 伪造 Session。

绝不能：

```text
用 Pod 名覆盖 Session
用 PID 作为 Session
用 Agent 名作为 Session
用 Trace ID 伪造 Conversation ID
```

### 原则 6：原始事件不可变

新功能读取旧 `RawObservation`，产生新的：

```text
KernelFact
SemanticRecord
Relation
Judgment
Projection
```

所有派生结果带：

```text
derivedFrom
parserVersion
correlatorVersion
projectionVersion
decisionVersion
```

### 原则 7：关联必须可解释

每条关联必须回答：

```text
为什么认为它们有关？
使用哪个 ID？
时间差是多少？
是否有进程父子关系？
是否有参数匹配？
是否有其他候选？
置信度是多少？
```

### 原则 8：工具名称原样保留

```text
rawName = 产品原始名称
canonicalKind = 跨产品辅助分类
```

### 原则 9：环境适配器不能复制 Agent 逻辑

新增 Docker/Kubernetes/SSH 支持时，只修改 RuntimeAdapter，不修改 Codex/Claude/Dify Adapter。

### 原则 10：解析失败不能阻断基础观测

即使：

```text
Parser 失败
Capture Plan 不支持该版本
Session 不明确
LLM 格式未知
```

也必须继续记录：

```text
KernelFact
CandidateAgent
Unmatched observation
Coverage gap
```

---

## 33. Agent Manifest 模板

```yaml
id: kimi-cli
family: cli-agent
versionRange: ">=1.0"

detection:
  commands:
    - kimi
  executableHints:
    - kimi
  sessionPathGlobs:
    - "~/.kimi-code/sessions/**/wire.jsonl"
  endpointHints:
    - "api.moonshot.cn"
    - "kimi.com"

identity:
  logicalAgentHints:
    - workspace
    - executable
  instanceHints:
    - process_tree
    - launch_time
  sessionHints:
    - argv_session_id
    - session_file_path
    - protocol_session_id
  turnHints:
    - protocol_request_id
    - inferred_request_sequence

lifecycle:
  resumeArgPatterns:
    - "--continue"
    - "--session"
  forkSupported: true
  compactSupported: true

tool:
  namePaths:
    - "tool_name"
    - "tool.name"
  callIdPaths:
    - "tool_call_id"
  argumentPaths:
    - "tool_input"
    - "arguments"
  resultPaths:
    - "tool_output"
    - "result"

capture:
  mode: ebpf-only
  processDiscovery: true
  sessionFilePathObservation: true
  plaintext:
    enabled: optional
    symbols:
      - SSL_write
      - SSL_read

limitations:
  - "Does not read wire.jsonl contents"
  - "Exact session identity depends on argv/path/protocol visibility"
  - "Plaintext capture depends on runtime TLS implementation"
```

Manifest 是接入契约和评审材料，不是任意脚本配置。

---

## 34. 新功能开发手册

新功能开始前必须说明：

```text
输入哪类 Canonical Record？
输出哪类 Canonical Record？
是否需要新字段？
是否需要新关系？
是否需要新存储表？
是否可从 RawObservation 重放？
是否影响现有 Projection？
是否引入新的敏感数据？
是否增加高频路径开销？
是否改变 eBPF-only 范围？
```

正确接入路径：

```text
RawObservation
  → Normalizer
  → Identity Registry
  → Correlation Engine
  → Feature Analyzer
  → Projection/Judgment
```

禁止绕过中间层：

```text
Controller 直接解析某产品 JSON
Service 自己重新查 PID 并建立私有映射
页面自己按时间戳拼关系
新功能直接写 events 宽表
新增脚本修改 Agent 配置或注入 Hook
```

---

## 35. 测试和验收矩阵

| 层级 | 必须覆盖的测试 |
|---|---|
| Schema | 版本兼容、未知字段、必填字段、事件去重 |
| Observer | exec/fork/exit/connect/TLS/file/security、序列号、丢包计数 |
| Process | PID 复用、父进程先退出、子进程继承、容器 namespace |
| Connection | FD 复用、Socket Cookie、TLS context、连接关闭 |
| Transport | SSE、chunked、HTTP/2、WebSocket、乱序、断流 |
| LLM Parser | OpenAI、Anthropic、Gemini、部分 JSON、重复 usage |
| Agent Adapter | Codex、Claude、Pi、Kimi 的进程、argv、Session path、Capture Plan |
| Session | 新建、resume、fork、clear、compact、identity unavailable |
| Dify | test/prod、conversation、workflow run、node events、pause |
| LangGraph | thread/run/assistant/checkpoint 可见与不可见两种场景 |
| Correlation | 显式 ID、进程血缘、时间窗口、参数匹配、歧义 |
| Unknown Agent | 无 Adapter 时仍有 KernelFact 和 CandidateAgent |
| Privacy | Token、密码、API Key、Prompt、工具参数不泄漏 |
| Performance | Ring drop、queue backpressure、LRU、WAL、批量写入 |
| Regression | 旧 `/ingest`、`/events/list`、Dashboard projection 不回退 |

### 35.1 必须加入 CI 的回归约束

每次修改 Parser、Observer、Judge 或性能路径，都执行：

```text
1. 原始 Fixture replay
2. 新旧 Projection diff
3. Agent capability matrix
4. Unknown-agent kernel-only test
5. Session resume cross-instance test
6. Out-of-order correlation test
7. Sensitive-data leak scan
8. bounded-memory / backpressure test
```

### 35.2 Capability Matrix

```text
agent × environment × capability
```

示例：

| Agent | Host | SSH | Docker | K8s | Kernel | Plaintext | Tool | Resume |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | ✓ | ✓ | ✓ | ✓ | ✓ | partial/full | partial/full | explicit/inferred |
| Claude Code | ✓ | ✓ | ✓ | ✓ | ✓ | partial | partial/full | explicit/inferred |
| Pi | ✓ | ✓ | ✓ | ✓ | ✓ | partial/none | partial | inferred |
| Kimi | ✓ | ✓ | ✓ | ✓ | ✓ | partial | partial | explicit/inferred |
| Dify | — | — | ✓ | ✓ | ✓ | API/TLS dependent | partial/full | conversation-dependent |
| LangGraph | — | — | ✓ | ✓ | ✓ | API/TLS dependent | partial/full | thread-dependent |
| Unknown CLI | ✓ | ✓ | ✓ | ✓ | ✓ | unknown | inferred | unknown |

任何能力从可用变成不可用，都必须在 PR 中说明，不能因切换测试 Agent 而静默退化。

---

## 36. 推荐迁移路线

### P0：冻结契约和基线

不改变业务行为，完成：

```text
定义 AgentFamily/LogicalAgent/AgentInstance/RuntimeInstance/Session/Turn
定义 RawObservation、KernelFact、SemanticRecord、EvidenceLink
定义字段来源和置信度
建立共享 Fixture 目录
记录当前旧接口 Projection
冻结 eBPF-only 和无 Kafka 范围
```

输出：

```text
contracts/
agent-adapter-guide/
capability-matrix/
replay-baseline/
```

### P1：建立不可变事实流

```text
Observer NDJSON 增加 source_sequence、event_time、process key
AnySentry 增加 raw_observations
增加 dedup 和 local WAL
保留旧 events 兼容投影
```

同时修复：

```text
KubeIdentityService 不再覆盖 sessionId
OS uid 不再直接作为业务 userId
workspacePath 改为 context hint
traceId/runId/sessionId 分开
```

### P2：重构 Observer 进程和连接关联

```text
ProcessKey
ProcessTree
ConnectionKey
socket cleanup
SSL context/fd mapping
SslEvent connection metadata
per-signal drop metrics
```

把整体 `clear()` 改为 TTL/LRU/close-driven eviction。

### P3：建立通用 Parser Registry

先实现：

```text
HTTP/SSE/chunked/HTTP2
OpenAI Chat
OpenAI Responses
Anthropic Messages
Gemini
stream assembler
```

输出统一 `LlmCall`、`ConversationMessage`、`ToolCall`、`ToolResult`。

### P4：接入四个 CLI Agent

顺序建议：

```text
Codex
Claude Code
Pi
Kimi
```

每个 Agent 只提交：

```text
Manifest
Adapter
eBPF Capture Plan
Process/Session path matcher
Tool mapping
Fixtures
Coverage declaration
```

不允许为单个 Agent 修改 KernelFact、Correlation Engine、Judgment 和 Dashboard 聚合规则。

### P5：接入 Dify 和 LangGraph

Dify：

```text
入站 API 明文
出站 LLM 明文
conversation_id
message_id
workflow_run_id
task_id
node execution
test/prod version
```

LangGraph：

```text
入站 API 明文
出站 LLM 明文
thread_id
run_id
assistant_id
parent relationship
checkpoint/interrupt when visible
```

### P6：重构风险判断和前端

```text
Agent Families
  → Logical Agents
    → Agent Instances
      → Runtime Instances
        → Sessions
          → Turns
            → LLM/Tools
              → Evidence Graph
```

旧页面继续通过兼容 Projection 工作，达到新旧一致后再下线旧字段。

### P7：根据指标决定是否需要分布式架构

只有出现以下证据时再评估 Kafka 或其他消息中间件：

```text
单节点 WAL 持续积压
ClickHouse 批量写入无法跟上
跨节点顺序和重放需求无法满足
多租户隔离需要独立消费组
单体部署成为已测量瓶颈
```

在此之前不实施 Kafka 相关改造。

---

## 37. 最优先修复项

按风险和收益排序：

1. 停止使用 Agent 名、Pod 名或 PID 充当 Session。
2. 拆分 `traceId`、`runId`、`sessionId`。
3. 给 Observer 原始事件增加 process start time、source sequence、runtime context。
4. 给 `SslEvent` 增加 FD/SSL context/connection ID。
5. 把 Controller 中的解析逻辑移到独立 Normalizer。
6. 增加 RawObservation、KernelFact、SemanticRecord、EvidenceLink 存储。
7. 建立 CandidateAgent，未知 Agent 仍走 Kernel 观测和风险检测。
8. 建立跨项目 Replay/Regression Fixture，保证优化不会让旧能力消失。
9. 将产品专用二进制发现和字段解析迁入 Adapter/Registry。
10. 为每个 Agent 和环境显示真实 Coverage，不用空值掩盖缺失能力。

---

## 38. 架构不变量

后续任何实现和评审必须满足：

1. 原始事实不能因为 Adapter 不认识而消失。
2. 明文解析失败不能影响内核事件判断。
3. Session 不能等同于 PID、Pod 或 Agent 名称。
4. Trace 不能等同于 Session。
5. Connection 不能等同于 LLM Call。
6. 一个 LLM Response 可以关联多个 ToolCall 和多个 KernelFact。
7. 一个 Session 可以跨多个 AgentInstance 恢复。
8. 一个服务 RuntimeInstance 可以同时处理多个 Session。
9. 环境适配和 Agent 适配相互正交。
10. 所有归因和关联必须带来源、方法、置信度和版本。
11. 所有派生结果必须可以从 RawObservation 重放。
12. Judge 不修改原始事实，只新增 Judgment。
13. 前端不负责解析、归因或建立因果关系。
14. 深度明文采集必须有明确权限、容量和 TTL。
15. 当前采集路径保持 eBPF-only，不通过 Hook、SDK、strace、Transcript 内容读取、注入脚本或代理改造补齐能力。
16. 当前不引入 Kafka；只有经真实指标证明必要后才能重新评审。

---

## 39. 最终目标

完成本方案后，新增：

```text
Codex
Claude Code
Pi
Kimi
Z.ai CLI
Dify
LangChain
LangGraph
新的自研 Agent
新的部署环境
新的 LLM 厂商格式
```

应当变成：

```text
注册一个 Agent Adapter
配置一个 eBPF Capture Plan
增加一个 LLM Format Adapter 或兼容 Profile
补充 Fixture 和 Capability Matrix
```

而不是：

```text
重新编写检测链路
在 Controller 增加产品分支
复制一套 Session Map
为新环境重复设计 Agent 解析
为性能优化删除旧能力
```

最终 AnySentry 应同时回答两类问题：

```text
面向人：
  用户说了什么？
  LLM 返回了什么？
  Agent 调用了哪些工具？
  Session 是否被恢复？

面向机器：
  哪个进程实际执行了什么？
  改了哪些文件？
  连接了哪些地址？
  是否有安全敏感行为？
  这些行为和哪个 LLM/Tool/Session 有什么证据关系？
```

这两种视图来自同一个不可变事实流和同一个关系引擎，而不是两套互不关联的观测系统。
