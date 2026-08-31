# AnySentry 通用 Agent 会话归因、控制流折叠与统一证据链 V4 设计

> 状态：Approved · Implementation in progress
>
> 日期：2026-08-31
>
> 性质：问题复盘、PRD、数据与归因架构、统一证据图、前端交互、迁移计划和验收标准一体化设计
>
> 首批验证对象：Codex、Claude Code、Pi
>
> 通用目标对象：Kimi CLI、Dify、LangChain 及其他 CLI、工作流、服务型 Agent
>
> 前置设计：[Agent 生命周期、会话归因与对话追踪 V3](./anysentry-agent-lifecycle-conversation-attribution-and-tracking-v3-design.md)

---

## 1. 连续 Goal

本阶段的目标是，在不依赖 SDK 或 Hook、不按 Agent 版本和官方域名建立脆弱白名单的前提下，以 Codex、Claude Code 和 Pi 为首批真实验证样本但面向 Kimi、Dify、LangChain 等所有智能体，建立由规范化运行实例、通用会话锚点、版本化 Thread 合并、上下文回放去重和技术控制流折叠组成的稳定会话归因体系，使跨进程恢复始终延续同一个 Canonical Thread、MCP initialize、tools/list 和启动工具清单不再污染用户会话目录、前端任意时刻的选中项与正文严格一致，同时把每个 TLS 明文工具调用通过可审计关系连接到 AnySentry 已有的内核事件、风险研判、告警、Incident 和处置链路，最终形成一份底层事实、两种面向机器与面向人的一致视图。

---

## 2. 结论

当前采集层已经能够稳定获得模型请求、模型响应、工具调用和工具结果；逻辑 Agent 与运行实例识别也基本准确。当前主要问题已经从“能不能采集”转移到“如何把传输事实组织成用户理解的对话与系统理解的证据图”。

本次现场数据确认，当前 Thread 混乱来自三个结构性原因：

1. **把传输级 Provider Chain 直接当成用户级 Conversation Thread。**
   - Responses 的 previous response 链、MCP JSON-RPC ID、一次连接或一次模型初始化都只是传输连续性。
   - 它们不能独立决定用户是否新建了一段对话。

2. **V1 持久绑定是单向终局决定，没有 Thread Alias、Merge 或 Supersede。**
   - 第一次投影产生的错误 Thread 会优先覆盖后续更完整的上下文。
   - 即使恢复请求随后提供了稳定会话锚点和完整历史，旧绑定也无法自动合并。

3. **前端使用多个松散 URL 参数与会保留旧数据的异步请求。**
   - Header 和下拉框来自新的 Conversation 选择。
   - Timeline 可能仍是上一个 Conversation 的旧响应。
   - 因此出现“标题已经切换，正文还没有切换”的可见错位。

第四个问题是两套观察结果尚未形成关系：

- TLS Interaction 和 Semantic Event 是 Agent 意图与上下文视图；
- ToolExec、FileAccess、Egress、DNS 等是内核事实与风险研判视图；
- 两者当前共享 Agent Runtime 身份，却没有稳定的 Relation Edge；
- 结果是对话追踪、事件列表、风险链路和 Incident 页面看起来像四套系统。

### 2.1 推荐方案

推荐实施 **方案 C：版本化会话解析图 + 技术活动层 + 统一证据关系图**。

核心原则：

- Interaction 与 JudgedEvent 保持不可变；
- Thread、Turn、Semantic Event、Technical Activity 和 Relation 是可版本化重投影；
- Provider ID 是证据，不是唯一规则；
- 时间只用于候选检索，不能单独触发 Thread 合并；
- 恢复请求中的历史上下文是 Replay Evidence，不是新发生的用户消息或工具结果；
- MCP 初始化和工具发现属于运行实例技术活动，不是用户 Conversation；
- 既有内核风险研判继续是唯一风险事实源，对话页面只读取并解释它。

---

## 3. 已确认事实、解释与待验证项

### 3.1 已确认事实

| 现场 | 已确认结果 | 说明 |
|---|---|---|
| Docker Codex 中断恢复 | 一个 Thread 跨三个 Runtime Instance，形成三个 Segment；六个用户轮次连续 | 当前强链路在该数据形态下有效 |
| Host Codex 中断恢复 | 旧 Thread 保存两个用户轮次和完整工具链；恢复后另建 Thread | Thread 合并失败 |
| Host 恢复请求 | previous response 被重置，但 continuity key、历史 message ID、turn ID、tool call ID 全部保留 | 存在比时间和进程更强的恢复证据 |
| Host 恢复 Thread | 历史用户消息和七个工具结果在恢复请求中再次出现 | 当前把 Context Replay 错当成新事件 |
| Codex 启动 | initialize、tools/list、开发者工具定义分别成为可见 Thread | 控制面流量污染用户目录 |
| V1 PostgreSQL Binding | 上述 Interaction 已分别绑定到多个 Thread，resolverVersion 为 1 | 当前绑定没有合并和别名机制 |
| 既有内核事实 | 同一工具轮次存在相同 Runtime、父子进程和命令内容的 ToolExec 事件 | TLS Tool 与 Kernel Event 可以严格关联 |
| 既有风险事实 | ToolExec 已拥有 eventId、Verdict、Tier、风险分数和风险名称 | 不需要重新建立风险引擎 |

### 3.2 根因解释

Host 恢复时，Agent 会将历史对话重新装入一次新的模型请求。该请求在传输层看起来像新的根请求，但包含：

- 跨启动稳定的 continuity key；
- 已出现过的 message item ID；
- 已出现过的 turn ID；
- 已出现过的 tool call ID 和 tool result；
- 一个真正新增的用户 turn。

V1 Resolver 先看到新的 Provider Chain，生成一个 Thread；后续请求又生成另一个 Thread，并将结果持久化。下一次读取时，applyPersistedBindings 会优先采用旧绑定，阻止更完整的重投影把两者合并。

### 3.3 待验证但不阻塞方案的事项

- Claude Code 在不同登录方式和中转 API 下可提供哪些稳定会话字段；
- Kimi CLI 是否直接携带 conversation、thread 或 session 标识；
- 不同 Dify 工作流模式是否复用 conversation_id，还是仅提供 workflow run ID；
- 部分远程 MCP 工具是否能够在主机内核侧观察到执行事实。

这些差异只影响 Anchor 提取数量，不改变 Resolver、Alias、Replay 和 Evidence Relation 的总体设计。

---

## 4. 当前链路与偏差

### 4.1 当前链路

~~~text
TLS/HTTP 明文
   │
   ▼
AgentInteraction
   │
   ├─ providerConversationId
   ├─ providerResponseId / previousResponseId
   ├─ runtimeSessionId
   ├─ messages
   └─ tool calls / results
   │
   ▼
projectAgentConversations
   │
   ├─ 一个 Provider Chain → 一个 Thread
   ├─ 一个 MCP Request ID → 一个 Thread
   └─ 无显式 ID时才使用 message lineage
   │
   ▼
Persisted Binding V1
   │
   └─ 下一次读取优先使用旧 binding
   │
   ▼
Conversation Timeline
~~~

### 4.2 恢复场景中的实际偏差

~~~text
Runtime Instance A
  Seed request
    continuity_key = K
    first human turn = H0
  User turn H1
  User turn H2 + Tool C1..C7

退出 Instance A

Runtime Instance B
  Resume request
    previous_response_id = empty
    continuity_key = K                 ← 强恢复锚点
    replay message IDs = H0,H1,H2      ← 历史
    replay tool IDs = C1..C7            ← 历史
    new human turn = H3                 ← 真正新增

当前结果：
  Thread T1 = H1,H2,C1..C7
  Thread T2 = H0,H1,H2,C1..C7,H3

目标结果：
  Canonical Thread T
    Segment 1 / Instance A = H0,H1,H2,C1..C7
    Segment 2 / Instance B = Resume marker,H3
~~~

### 4.3 初始化流量中的实际偏差

~~~text
Runtime Instance A
  MCP initialize     → 当前被投影为 Thread 1
  MCP tools/list     → 当前被投影为 Thread 2
  Tool definitions   → 当前被投影为 Thread 3
  Human prompt       → 当前被投影为 Thread 4
~~~

其中 initialize 是协议版本与能力协商，tools/list 是工具发现。MCP 官方规范也将 initialize 定义为连接生命周期的初始化阶段，将 tools/list 定义为工具发现操作，而不是用户对话：

- [MCP Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

---

## 5. 目标领域模型

### 5.1 身份和关系

~~~text
Logical Agent
  │
  ├─ Runtime Instance
  │    └─ Run Technical Activity
  │         ├─ MCP initialize
  │         ├─ tools/list
  │         ├─ tool definition refresh
  │         └─ capability / model bootstrap
  │
  └─ Canonical Conversation Thread
       ├─ Thread Alias 1
       ├─ Thread Alias 2
       ├─ Instance Segment A
       ├─ Instance Segment B
       └─ Turn
            ├─ User Event
            ├─ Model Event
            └─ Tool Invocation
                 ├─ Tool Call
                 ├─ Tool Result
                 ├─ Kernel Event Relation
                 ├─ Risk Judgment
                 ├─ Alert / Incident
                 └─ Remediation
~~~

### 5.2 关键概念

| 概念 | 定义 | 是否在用户会话目录中计数 |
|---|---|---:|
| Runtime Instance | 一次真实 Agent 根进程 | 否，作为实例层 |
| Run Technical Activity | 启动、能力协商、工具发现、连接维护 | 否 |
| Canonical Thread | 用户认知中的可继续上下文 | 是 |
| Thread Alias | 历史错误 ID、Provider Chain ID 或旧深链接 | 否 |
| Segment | Thread 在某 Runtime Instance 上承载的一段 | 否，显示在线程内部 |
| Turn | 一次新增用户意图到模型终态 | 是 |
| Context Replay | 恢复请求携带的历史消息和工具结果 | 否，不重复计数 |
| Recovered History | 以前未采集、但在恢复请求中首次看到的历史上下文 | 可显示，但明确标注为补录 |
| Semantic Event | 用户、模型、工具三类人类可读事件 | 是 |
| Kernel Relation | Semantic Tool 与内核事实的关系 | 显示为证据和风险摘要 |

### 5.3 与 OpenTelemetry 的对齐

OpenTelemetry 将 gen_ai.conversation.id 定义为用于关联同一 Conversation、Session 或 Thread 消息的唯一标识，并将 tool call ID、参数和结果作为独立语义字段。V4 沿用这一区分：Conversation ID 表达用户上下文，Tool Call ID 表达一次工具调用，模型物理请求和重试不自动成为新会话。

- [OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

AnySentry 不要求被观测 Agent 实现 OpenTelemetry；这里只用相同的语义边界组织 eBPF 采集事实。

---

## 6. 方案比较

### 6.1 方案 A：为每个产品补字段并隐藏已知控制请求

做法：

- Codex 把 prompt_cache_key 当 Conversation ID；
- Claude、Pi、Kimi 分别寻找各自字段；
- initialize 和 tools/list 从目录过滤。

优点：

- 开发快；
- 能快速修复当前 Codex 样本。

缺点：

- V1 Binding 仍然不可合并；
- 上下文回放仍会重复；
- 新 Agent 或新协议仍需增加完整分支；
- 无法解决前端异步错位和内核证据分离；
- prompt_cache_key 在其他系统可能只是缓存亲和键，不能无条件当作精确 Conversation ID。

结论：只适合作为临时实验，不建议作为交付架构。

### 6.2 方案 B：每次查询时重新做全量启发式聚合

做法：

- 不新增持久关系；
- 每次读取时扫描 Interaction，根据内容、时间、进程和工具 ID 重新分组。

优点：

- 不需要数据迁移；
- 算法调整后历史结果立即变化。

缺点：

- Conversation ID 和页面深链接不稳定；
- 查询成本随数据量增长；
- 同一页面两次轮询可能得到不同分组；
- 无法审计为什么两个 Thread 被合并；
- 前端更容易在轮询期间跳转。

结论：适合离线实验，不适合运维平台的主读模型。

### 6.3 方案 C：版本化解析图与持久 Alias，推荐

做法：

- Observer 提取通用 Conversation Anchors、稳定消息身份和 Traffic Role；
- API 在 Logical Scope 内建立 Anchor Graph；
- Resolver V2 根据带强度的关系边决定 Canonical Thread；
- 旧 Thread 通过 Alias 指向 Canonical Thread；
- Interaction Membership 采用版本化决定，不修改原始 Interaction；
- Context Replay 只形成 Replay Evidence；
- Technical Activity 从用户 Thread 目录分离；
- Semantic Tool 和 Kernel Event 建立持久关系边。

优点：

- 通用、可解释、可迁移；
- 支持错误绑定修复和历史深链接；
- 能同时解决会话混乱、恢复重复、前端错位和证据分离；
- 新 Agent 通常只需增加 Anchor Extraction，不重写 Resolver。

代价：

- 需要一次数据模型升级和后台 Reprojection；
- 需要补充冲突保护和迁移测试；
- 开发量高于局部补丁。

结论：采用方案 C。

---

## 7. Observer 采集合同 V2

### 7.1 保留现有事实

以下内容继续保持不可变：

- 完整有界 Request 和 Response；
- provider response ID 与 previous response ID；
- Tool Call 和 Tool Result；
- 进程、连接、TLS Adapter 和精确时间；
- 原始语义项目。

V2 只增加派生索引，不删除 V1 字段。

### 7.2 Conversation Anchor

新增 ConversationAnchor：

~~~text
ConversationAnchor {
  kind:
    provider_conversation
    provider_thread
    runtime_session
    continuity_key
    response_id
    previous_response_id
    message_item_id
    turn_id
    tool_call_id

  namespace
  valueHash
  strength: exact | strong | supporting
  sourcePath
  observedAtUnixNs
}
~~~

约束：

- 派生存储默认保存 namespaced hash，不复制原始内容；
- 原始值仍只存在于有界 Interaction Raw Evidence；
- Anchor 不能单独携带授权或身份权限语义；
- Anchor 只在同一 tenant、environment、Logical Scope 中参与解析。

### 7.3 通用提取优先级

| Anchor | 示例字段 | 强度 | 用途 |
|---|---|---:|---|
| Provider Conversation | conversation_id、thread_id、显式 session_id | exact | 直接建立 Thread |
| Provider Response Edge | response.id ↔ previous_response_id | exact | 连接模型调用链 |
| Continuity Key | prompt cache/session continuity key | strong | 恢复和跨连接连续性 |
| Message Item ID | message.id、content block id | strong | 识别累计上下文重放 |
| Turn ID | message metadata turn id | strong | 稳定 Turn 身份 |
| Tool Call ID | call_id、tool_use_id | exact for invocation | 配对调用、结果与回放 |
| Runtime Instance | canonical instance ID | supporting | 限定候选范围 |
| 时间邻近 | bounded time window | supporting | 只用于候选检索 |

### 7.4 产品只负责归一化，不负责会话决策

| Agent/API 形态 | 可归一化证据 | Resolver 仍采用的通用规则 |
|---|---|---|
| Codex Responses | continuity key、response chain、message ID、turn ID、call ID | Anchor Graph |
| Claude Messages | 显式 metadata、累计 message/tool_use/tool_result 身份 | Anchor Graph |
| Pi / OpenAI-compatible | conversation/session 字段、累计消息、tool call ID | Anchor Graph |
| Kimi CLI | 请求中实际存在的 conversation/thread/session 或消息身份 | Anchor Graph |
| Dify | conversation_id、workflow run、task/run identity | Conversation 与 Run 分离 |
| LangChain | thread_id、run_id、trace/span identity | Thread 与 Execution Run 分离 |

不建立：

- Codex 0.151 分支；
- Claude 某一版本分支；
- 官方域名白名单；
- 中转 API 拒绝规则；
- 模型名称决定会话的规则。

### 7.5 Traffic Role

每个 Interaction 增加 trafficRole：

| Role | 含义 | 主对话可见性 |
|---|---|---|
| conversation | 新用户意图、模型处理、真实工具循环 | 显示 |
| bootstrap | System、Developer、工具定义和模型启动准备 | 默认折叠 |
| control | initialize、tools/list、resources/list、capability notification | 默认折叠 |
| context_replay | Resume 时重新发送的历史上下文 | 只显示恢复摘要 |
| background | 心跳、遥测、标题生成等非用户任务 | 技术详情 |
| unclassified | 尚未确认 | 技术详情并标记 |

判断必须基于协议语义和内容结构，而不是域名。

---

## 8. Resolver V2：版本化会话解析图

### 8.1 解析范围

所有决策先限制在 Logical Scope：

~~~text
tenant
  + environment
  + canonical logical agent
  + real workspace / workflow tenant
~~~

不再用 raw agentAssetId 作为 Provider Conversation Hash 的唯一命名空间。运行实例身份变化或资产别名修正不能切断 Thread。

### 8.2 图节点

- Interaction Node；
- Provider Chain Cluster；
- Runtime Instance；
- Existing Thread；
- Anchor；
- Human Turn；
- Tool Invocation。

### 8.3 关系边

| Edge | 权重 | 说明 |
|---|---:|---|
| 相同显式 Provider Conversation | exact | 直接 Union |
| previous response 指向已知 response | exact | 直接 Union |
| 相同 continuity key 且 Logical Scope 相同 | strong | 可 Union，但应用冲突屏障 |
| Resume 请求包含先前稳定 message/turn/tool tail | strong | 可 Union |
| Tool Result 指向先前 Tool Call | exact | Tool Loop 连续 |
| 同一 Runtime Instance | supporting | 不能单独 Union |
| 相同 workspace | supporting | 不能单独 Union |
| 时间接近 | supporting | 不能单独 Union |

### 8.4 冲突屏障

以下任一条件阻止自动合并：

- 不同 tenant 或 environment；
- 不同 Canonical Logical Agent；
- 两个不同的显式 Provider Conversation ID；
- 明确的新建会话操作；
- 相同历史根之后出现两个并发、互不包含的分支；
- 同一 continuity key 被多个同时活跃且无法用 message tail 区分的 Thread 复用；
- Anchor 仅有时间、workspace 或进程相同。

冲突时：

- 不强行合并；
- 生成 correlation_gap；
- 在技术详情显示“可能为同一会话”；
- 不增加普通用户目录中的虚假高置信 Thread 标识。

### 8.5 Canonical Thread 选择

迁移已有数据时：

1. 优先保留最早且包含 Human Turn 的现有 Thread ID；
2. 其他旧 ID 写入 Thread Alias；
3. Control-only Thread 不竞争 Canonical User Thread；
4. 深链接访问 Alias 时返回 Canonical ID 并保留 aliasFrom；
5. 前端使用 replace 更新 URL，不增加浏览器回退噪声。

新数据时：

- exact Provider Conversation 存在：以 Logical Scope + Provider ID 生成；
- 只有 strong continuity anchor：以 Logical Scope + Anchor Hash 生成；
- 只有 inferred evidence：以第一个稳定 Human Turn Anchor 生成；
- Conversation ID 不包含可变 raw agentAssetId。

### 8.6 Versioned Membership

V1 的 interaction_id 单行覆盖无法审计历史决定。V2 使用版本化 Membership：

~~~text
ConversationMembershipV2 {
  membershipId
  interactionId
  canonicalConversationId
  segmentId
  role: conversation | bootstrap | control | context_replay | background
  turnId?
  resolutionRevision
  resolverVersion
  confidence
  evidence[]
  supersedesMembershipId?
  decidedAt
}
~~~

当前有效 Membership 通过最高 resolutionRevision 读取；旧决定保留用于审计。

### 8.7 Thread / Route Alias

~~~text
ConversationRouteAlias {
  aliasConversationId
  targetType: conversation | technical_activity
  targetId
  canonicalConversationId?
  technicalActivityId?
  reason:
    provider_chain_merge
    continuity_anchor_merge
    replay_lineage_merge
    control_activity_fold
    manual_reconciliation
  evidence[]
  resolverVersion
  resolutionRevision
  createdAt
}
~~~

Alias 不复制 Timeline。目标为 conversation 时，查询解析到 Canonical ID；目标为
technical_activity 时，API 返回明确的 redirectTarget，前端打开对应 Runtime
Instance 的“启动与能力协商”，而不是制造一个空 Conversation。

---

## 9. Resume 与 Context Replay

### 9.1 为什么不能把累计请求全部显示成新事件

恢复请求的 input 往往包含：

- 旧用户消息；
- 旧模型回复；
- 旧 Tool Call；
- 旧 Tool Result；
- 新用户消息。

这些内容的传输时间确实是当前 Resume 时间，但其业务发生时间属于历史。若全部作为当前新事件，会产生：

- 重复用户轮次；
- “没有调用但观察到结果”；
- 工具数量翻倍；
- 风险事件时间错位；
- 用户误以为 Agent 再次执行了历史工具。

### 9.2 Delta 规则

Resolver 为每个 Canonical Thread 维护已知 Source Item ID、Turn ID 和 Tool Call ID 集合。

~~~text
Resume Request Items
  ├─ 已知 item / turn / call ID → Context Replay
  ├─ 未知但属于历史且带原始时间 → Recovered History
  └─ 新 Human Turn → New Turn
~~~

Context Replay：

- 不生成新的 User、Model、Tool 主时间线事件；
- 不覆盖原事件时间；
- 只更新“本次模型实际接收了哪些历史上下文”的证据；
- 在 Segment 开头显示恢复摘要。

Recovered History：

- 仅当历史项此前没有被采集时产生；
- 明确标记“上下文补录”；
- 有 Provider create_time 时使用该时间；
- 没有原始时间时使用 timeQuality=context_replay，不伪造精确时间；
- 不与真实实时 Tool Execution 混淆。

### 9.3 页面表示

~~~text
──── Instance Segment 2 · 恢复于 09:10:03 ────

  恢复上下文
  已加载 3 个历史轮次、7 个工具结果
  这些内容未重复计为新事件                     [查看证据]

  用户  这是终端恢复测试
  模型  已恢复之前的工具执行状态……
~~~

---

## 10. 启动和控制流如何归因与展示

### 10.1 推荐：不删除、不建 Thread、默认折叠

initialize、initialized、tools/list、resources/list、prompts/list、工具定义刷新等内容归入 Runtime Instance 的 Technical Activity。

它们：

- 保留完整 Interaction 和 Raw Evidence；
- 保留时间、MCP Server、协议版本和能力摘要；
- 不进入普通 Conversation Count；
- 不作为 User、Model、Tool 三类主时间线事件；
- 在 Segment 或 Instance Overview 中以一个折叠行展示。

### 10.2 技术活动摘要

~~~text
启动与能力协商 · 1.4s
MCP Server 2 · Tool definitions 48 · Control exchanges 6 · 全部成功
                                                        [展开]
~~~

展开后：

~~~text
05:30:04.220  MCP initialize       success  329ms
05:30:04.873  MCP tools/list       success  607ms
05:30:06.006  Model bootstrap      success  1.0s
~~~

### 10.3 Resume 时

每次新 Runtime Instance 都可拥有自己的 Technical Activity，但它不复制 Thread：

~~~text
Thread T
  Segment 1 / Instance A
    启动与能力协商
    Turn 1..3

  Segment 2 / Instance B
    启动与能力协商
    恢复上下文
    Turn 4
~~~

---

## 11. 稳定 Turn 与 Semantic Event 身份

### 11.1 当前问题

当前 Turn ID 使用 Conversation ID + ordinal；Semantic Event ID 又包含 Conversation ID。Thread 合并后，这些 ID 会变化，从而破坏事件深链接和内核关系。

### 11.2 V2 稳定身份

Turn ID 优先使用：

1. Provider Turn ID；
2. 第一个新 Human Message Item ID；
3. Logical Scope + 第一个新 Human Semantic Item；
4. 最后才使用稳定内容摘要与首次观察身份。

Semantic Event ID 使用：

~~~text
interactionId
  + sourceItemId
  + semantic kind
  + stable provider item identity
~~~

不再包含可变 Canonical Conversation ID。

Thread 合并只改变 Membership，不改变：

- Interaction ID；
- Tool Invocation ID；
- Stable Turn ID；
- Stable Semantic Event ID；
- Kernel Event ID。

旧 Semantic Event ID 可通过 alias 或 interactionId + sourceItemId 兼容解析。

---

## 12. 统一语义工具与内核证据图

### 12.1 目标

不是把 TLS 事件和内核事件复制到同一张大表，而是让它们成为一张关系图中的不同事实节点：

~~~text
User Intent
  │
  ▼
Model Interaction
  │
  ▼
Semantic Tool Invocation
  │
  ├─ Tool Result
  │
  └─ Kernel Relation
       ├─ ToolExec
       ├─ FileAccess / FileDelete
       ├─ Egress / DNS / TLS
       └─ Pipe / Process lifecycle
             │
             ▼
        Existing Judgment
          Verdict / Tier / Risk
             │
             ├─ Alert
             ├─ Incident
             └─ Remediation
~~~

### 12.2 不改变风险权威

- Kernel JudgedEvent 继续是 Verdict、Tier、Risk Score 和 Reason 的权威；
- Semantic Tool 不重新计算一个平行风险分数；
- 对话页面聚合关联 Kernel Event 的现有结果；
- 多个 Kernel Event 时显示最高风险和分布；
- 无关系时显示“仅语义证据”，不猜测风险。

### 12.3 稳定 Tool Invocation

TLS Tool Call 新增 Server-derived toolInvocationId：

~~~text
canonical runtime instance
  + provider tool call id
  + first observed interaction
~~~

注意：

- 不复用 trusted invocationId；
- trusted invocationId 继续专用于认证 Adapter 或 OTel；
- TLS 派生身份明确标记 authority=attested_tls_plaintext；
- 避免把推断关系伪装成 SDK 认证声明。

### 12.4 关系匹配方法

时间只用于有界候选范围，不能单独建立关系。

| Tool 类型 | 必要强证据 | 可关联内核事实 |
|---|---|---|
| Bash / exec | Canonical Runtime + 进程祖先 + normalized command hash | ToolExec、ProcessExit |
| Read | Runtime + canonical path hash + read operation | FileAccess |
| Write / Edit | Runtime + canonical path hash + write operation | FileAccess、FileDelete |
| Search / HTTP | Runtime + endpoint/host/port +连接或 DNS 事实 | Egress、DNS、TLS |
| MCP | Runtime + connection/pipe/server identity + tool name | Pipe I/O、Egress、子进程 |
| Remote-only Tool | 无本地执行事实 | semantic_only |

### 12.5 关系状态

| 状态 | 含义 |
|---|---|
| linked_exact | 精确进程、资源或命令一致 |
| linked_strong | Canonical Runtime、祖先和协议身份一致 |
| semantic_only | 工具语义已确认，未观察到可关联内核事实 |
| kernel_only | 有内核行为，但没有可确认 Tool Call |
| ambiguous | 多个工具竞争同一强证据 |
| coverage_gap | 对应采集能力或时间窗口不完整 |

### 12.6 持久关系

~~~text
SemanticKernelRelation {
  relationId
  stableSemanticEventId
  toolInvocationId
  kernelEventId
  linkMethod
  confidence
  authority
  relationStatus
  resolutionRevision
  relationVersion
  createdAt
}
~~~

可复用现有 tool-evidence-linker 的命令、资源、进程和时间窗口匹配逻辑，但将 Claim Source 抽象为：

- authenticated_agent_adapter；
- attested_tls_plaintext；
- otel_span；
- kernel_inferred。

不同 Source 使用不同 Authority 和 Confidence，不能互相伪装。

### 12.7 双向导航

从 Conversation：

- Tool Card → 内核证据；
- Kernel Evidence → 原始事件；
- Risk Summary → 风险链路或 Incident；
- Incident → 处置。

从事件和风险页面：

- Kernel Event → 关联 Agent Thread；
- Incident → 触发该风险的用户轮次与工具调用；
- Evidence Bundle → 同时包含语义上下文和内核事实。

---

## 13. 前端信息架构

### 13.1 保留三栏，不推倒现有布局

~~~text
┌────────────────────┬──────────────────────────────────┬──────────────────────┐
│ Agent / Instance   │ Overview 或 Conversation          │ Event / Evidence      │
│ / Thread Navigator │ Timeline                          │ Inspector             │
├────────────────────┼──────────────────────────────────┼──────────────────────┤
│ Logical Agent      │ Agent Overview                    │ 未选事件时显示摘要     │
│  ├ Instance A      │ 或 Instance Overview              │                      │
│  │  ├ Thread T     │ 或 Canonical Thread T             │ 内容                  │
│  │  └ 技术活动 3   │   Segment / Resume marker         │ 内核证据              │
│  └ Instance B      │   User / Model / Tool             │ 风险研判              │
│     └ Thread T     │                                   │ 原始                  │
└────────────────────┴──────────────────────────────────┴──────────────────────┘
~~~

### 13.2 左栏层级

点击对象决定中栏模式：

| 点击对象 | 中栏显示 |
|---|---|
| Logical Agent | Agent Overview |
| Runtime Instance | Instance Overview |
| Canonical Thread | 完整 Conversation Timeline |
| 技术活动 | Instance Technical Activity |

不再在选择 Logical Agent 时静默打开第一个 Thread。

### 13.3 Agent Overview

用户说“只关心整体”，不代表把独立 Thread 的正文混成一条对话。Agent Overview 展示：

- 当前运行实例；
- 当前活跃 Thread；
- 最近用户对话摘要；
- 最近工具行为；
- 最高风险和未处理 Incident；
- 技术活动健康状态；
- 采集覆盖状态。

点击具体 Thread 后才进入完整正文。

### 13.4 Instance Overview

展示：

- 实例开始、空闲、退出状态；
- 本实例承载过的 Thread Segment；
- 启动与能力协商；
- 该实例的工具和内核风险摘要；
- 无正文时解释“仅有资产/传输/技术活动”，不制造空 Conversation。

### 13.5 Thread Timeline

保留用户、模型、工具三类主颜色：

- 用户：Sky；
- 模型：Teal；
- 工具：Violet。

风险不改变 Actor 颜色，只增加独立语义标签：

~~~text
工具  bash · exec_command · 成功
printf ...

内核证据 3    风险 0 正常    Rules
~~~

高风险示例：

~~~text
工具  bash · exec_command · 失败
...

内核证据 2    风险 86 高危    Incident INC-...
~~~

### 13.6 右侧 Inspector

推荐四个 Tab：

1. **内容**：结构化用户、模型或工具内容；
2. **内核证据**：关联事件、进程、命令、文件、网络；
3. **风险研判**：Verdict、Tier、Reason、Alert、Incident、Remediation；
4. **原始**：Request、Response、Interaction 与 Raw Event。

未选择事件时，右栏显示当前 Agent、Instance 或 Thread 的证据摘要，而不是纯空白。

### 13.7 技术活动显示策略

默认：

- 从 Conversation 下拉列表排除；
- 不计入 Conversation Count；
- 在实例旁显示“技术活动 N”；
- Segment 顶部折叠显示；
- 搜索和筛选可以明确开启“技术活动”。

这样既不丢证据，也不会让普通用户看到 dozens of initialize/tools/list Thread。

---

## 14. 前端选择一致性状态机

### 14.1 当前根因

当前页面同时维护：

- logicalAgentId；
- instanceId；
- conversationId；
- semanticEventId；
- interactionId。

Timeline 请求在 selection 变化后会保留旧 data。组件又使用新的 selectedConversation Header 配旧的 timeline.turns，因此发生错位。

### 14.2 单一 Selection Target

内部状态改为判别联合：

~~~text
SelectionTarget =
  { type: agent, logicalAgentId }
  { type: instance, logicalAgentId, canonicalInstanceId }
  { type: thread, logicalAgentId, canonicalConversationId }
  { type: event, logicalAgentId, canonicalConversationId, semanticEventId }
~~~

URL 仍可保留查询参数，但必须通过一个 Resolver 原子解析为 SelectionTarget。不能让不一致的参数分别驱动不同组件。

### 14.3 Request Key

每次 Timeline 请求生成：

~~~text
requestKey =
  canonicalConversationId
  + logicalAgentId
  + timeRange
  + snapshotAsOf
  + resolutionRevision
~~~

API 响应返回：

- requestKey；
- requestedConversationId；
- canonicalConversationId；
- resolutionRevision；
- timelineVersion。

前端只有在以下条件全部满足时才提交数据：

~~~text
response.requestKey == activeRequestKey
AND
response.canonicalConversationId == selected canonicalConversationId
~~~

### 14.4 切换过程

~~~text
用户点击 Thread B
  │
  ├─ 原子更新 SelectionTarget
  ├─ 清空 Event Selection
  ├─ Abort Thread A 的请求
  ├─ Header、Dropdown 立即显示 B + loading
  └─ 中栏不再显示 A 的正文

Thread B 响应
  │
  ├─ requestKey 匹配 → 显示
  └─ 不匹配 → 丢弃
~~~

同一 Thread 的轮询失败时可以保留旧正文，并显示“数据较旧”；不同 Thread 之间绝不复用正文。

### 14.5 Live Follow 与 Pinned

当前 realtime polling 可能因目录排序变化改变选择。V4 明确两种模式：

- Follow：自动跟随最新用户可见 Thread；
- Pinned：用户手动选择后保持该 Agent、Instance 或 Thread。

规则：

- 用户点击任何导航项后进入 Pinned；
- 点击“实时跟随”才回到 Follow；
- polling 只更新数据，不覆盖 Pinned Selection；
- Control-only Activity 不参与 Follow 的“最新 Thread”判断。

### 14.6 Dropdown 一致性

- Dropdown value 必须来自 SelectionTarget；
- Timeline Header 必须来自同一 Timeline Response；
- Alias URL 解析后以 replace 更新为 Canonical ID；
- 不允许 Dropdown 显示 B，而 Timeline Response 的 Thread ID 是 A；
- 若 Thread 被合并，展示“已合并到会话 T”，不中断阅读。

---

## 15. API 设计

### 15.1 Conversation Directory V3

推荐新增而不是破坏 V2：

~~~text
POST /security-center/agents/conversation-directory-v3
~~~

返回：

~~~text
{
  resolutionRevision,
  logicalAgents: [
    {
      logicalAgentId,
      instances,
      userThreads,
      technicalActivitySummary,
      riskSummary,
      coverage
    }
  ]
}
~~~

userThreads 只包含 Canonical Human-visible Thread。

### 15.2 Timeline V3

~~~text
POST /security-center/agents/conversations/timeline-v3
~~~

返回：

~~~text
{
  requestKey,
  requestedConversationId,
  canonicalConversationId,
  aliasFrom?,
  resolutionRevision,
  timelineVersion,
  thread,
  segments,
  turns,
  contextReplaySummaries,
  technicalActivitySummaries,
  evidenceSummary,
  updateTime
}
~~~

### 15.3 Overview

~~~text
POST /security-center/agents/activity-overview
~~~

支持 Logical Agent 和 Runtime Instance 两种 scope，避免前端自行拼接多个不一致接口。

### 15.4 Semantic Evidence

~~~text
POST /security-center/agents/semantic-events/evidence
~~~

输入 stableSemanticEventId 或 toolInvocationId。

返回：

- Interaction Evidence；
- Kernel Relation；
- Kernel Event；
- Existing Judgment；
- Alert、Incident、Remediation 引用；
- coverage 和 relation status。

详细正文按需加载，Timeline 首屏只返回摘要。

---

## 16. 持久化设计

建议新增：

1. anysentry_agent_conversation_anchors_v1
2. anysentry_agent_conversation_memberships_v2
3. anysentry_agent_conversation_route_aliases_v1
4. anysentry_agent_run_technical_activities_v1
5. anysentry_agent_semantic_kernel_relations_v1

继续复用：

- anysentry_agent_runtime_instances_v2；
- anysentry_agent_conversation_threads_v1；
- anysentry_agent_conversation_segments_v1；
- Agent Interaction 存储；
- JudgedEvent、Alert、Incident 和 Evidence Bundle 存储。

### 16.1 索引

- Anchor：logical_scope_key + anchor_kind + anchor_hash；
- Membership：interaction_id + resolution_revision；
- Route Alias：alias_conversation_id；
- Segment：canonical_conversation_id + ordinal；
- Relation：stable_semantic_event_id；
- Relation：kernel_event_id；
- Relation：tool_invocation_id。

### 16.2 有界性

- 不将完整 Request Body 复制进 Anchor 表；
- 单 Interaction 的 Anchor 数量有上限；
- Message ID、Turn ID、Tool Call ID 去重；
- Technical Activity 只存摘要和 Interaction 引用；
- Relation 只存 ID、方法和置信度，不复制 Kernel Event。

---

## 17. 历史迁移与兼容

### 17.1 Resolver V2 Backfill

按 Logical Scope 分批重投影：

1. 读取 Interaction；
2. 提取 V2 Anchors；
3. 分类 Traffic Role；
4. 构建 Anchor Graph；
5. 产生 Canonical Thread；
6. 生成 Membership V2；
7. 生成 Thread Alias；
8. 重建 Segment；
9. 生成 Replay Summary；
10. 异步建立 Semantic-Kernel Relation。

### 17.2 当前 Host 测试的预期迁移

迁移前：

~~~text
User Thread A
User Thread B
MCP initialize Thread
MCP tools/list Thread
Bootstrap Thread
~~~

迁移后：

~~~text
Canonical User Thread T
  Segment 1 / Instance A
  Segment 2 / Instance B

Technical Activity / Instance A
  initialize
  tools/list
  bootstrap

Technical Activity / Instance B
  initialize
  tools/list
  bootstrap

Aliases
  old Thread A → T
  old Thread B → T
  control-only Thread → Technical Activity
~~~

### 17.3 深链接

- V2 Conversation URL 继续可用；
- API 解析 Alias；control-only 旧链接返回 technical_activity redirectTarget；
- 页面 replace 到 Canonical ID；
- 已收藏的 Event Link 通过 stable Semantic Event ID 或 Interaction fallback 恢复；
- 不删除原始 Interaction 和 Kernel Event。

### 17.4 回滚

- V3 API 与 V2 并行；
- V2 Binding 不删除；
- 前端 Feature Flag 切换 Directory/Timeline V3；
- Resolver V2 只写新表和 Alias；
- 回滚不会损坏 V1 读取。

---

## 18. 开发阶段

### Phase A：Anchor 与 Traffic Role

- Observer 新增 Anchor、Message Item ID、Turn ID、Content Kind；
- 提取 continuity key、response edge、message/turn/tool identities；
- 分类 conversation、bootstrap、control、context_replay；
- 保留原始 evidence；
- 建立 Codex、Claude、Pi、OpenAI-compatible、MCP Golden Fixtures。

### Phase B：Resolver V2 与迁移

- 新增 Membership V2、Thread Alias 和 Anchor Store；
- 使用 Canonical Logical Scope；
- 实现 Union、Conflict Barrier、Canonical Selection；
- 实现 Context Replay Delta；
- 后台 Backfill；
- V2 深链接兼容。

### Phase C：前端一致性与 Overview

- SelectionTarget；
- Request Key；
- Abort 和 stale response guard；
- Follow / Pinned；
- Agent Overview、Instance Overview；
- Technical Activity 折叠；
- Resume Marker；
- Context Replay Summary；
- Rapid switching 浏览器测试。

### Phase D：统一证据图

- Interaction 保存源 LlmInteraction eventId；
- Stable Semantic Event 和 Tool Invocation；
- 抽象 Evidence Claim Source；
- TLS Tool ↔ Kernel Event Relation；
- 风险、Alert、Incident 引用；
- Conversation 与 Event 页面双向跳转。

### Phase E：集成验收

- Host 与 Docker 的真实 Resume；
- Codex 不同版本；
- Claude Code；
- Pi；
- Kimi 或 OpenAI-compatible Fixture；
- Dify 和 LangChain 并发 Thread；
- 跨天等待、重启、分支、失败、缺口；
- 1440、1024、390 View。

---

## 19. 测试矩阵

### 19.1 Thread 归因

| 用例 | 预期 |
|---|---|
| 同实例连续多轮 | 一个 Thread，多 Turn |
| 同实例显式 New Chat | 两个 Thread |
| 新实例 Resume，previous response 保留 | 一个 Thread，多 Segment |
| 新实例 Resume，previous response 重置但 continuity key 保留 | 一个 Thread，多 Segment |
| 新实例 Resume，仅累计 message/turn tail 保留 | 一个 Thread，多 Segment，标记 strong |
| 两个并发新 Thread，同 workspace | 不合并 |
| 同一历史根产生两个分支 | 不合并，建立 fork/correlation gap |
| 相同 prompt cache key 但显式 Conversation ID 不同 | 不合并 |
| 跨天 idle 后继续 | 同实例、同 Thread、新 Turn |
| Agent 版本升级后 Resume | 不按版本切 Thread |
| 官方 API 改为中转 API | 不按域名切 Thread |

### 19.2 Control 与 Replay

| 用例 | 预期 |
|---|---|
| MCP initialize | Technical Activity，不新增 Thread |
| tools/list 多页 | 一个 Technical Activity Group |
| tool definitions 刷新 | Technical Activity |
| Resume 累计历史消息 | 不重复 User/Model Event |
| Resume 累计历史 Tool Result | 不产生 result-only 告警 |
| Observer Attach 前缺失历史 | Recovered History，时间质量明确 |

### 19.3 前端

| 用例 | 预期 |
|---|---|
| A → B 快速切换，A 后返回 | B Header 与 B Timeline 始终一致 |
| A → B → A，响应乱序 | 只接受当前 requestKey |
| Directory polling 排序变化 | Pinned Selection 不变 |
| Alias Thread 深链接 | 自动跳 Canonical Thread |
| Timeline 同 Thread 轮询失败 | 保留同 Thread 旧数据并提示 stale |
| Timeline 不同 Thread 加载 | 不显示上一 Thread 正文 |
| Control-only Instance | 显示实例概览，不制造空 Thread |

### 19.4 内核证据

| Tool | 预期 |
|---|---|
| exec_command | 通过 Runtime、祖先和 command hash 关联 ToolExec |
| read | 通过 path hash 和 read operation 关联 FileAccess |
| write/edit | 通过 path hash 和 write operation 关联 FileAccess |
| web search | 有本地 Egress/DNS 时关联；远程执行时 semantic_only |
| 多个候选命令 | ambiguous，不强归因 |
| 无内核覆盖 | coverage_gap，不伪造事件 |
| Kernel Event 已产生 Incident | Tool Card 可跳 Incident |

---

## 20. 验收标准

### 20.1 当前现场必须通过

1. Host Codex 退出后 Resume：
   - 旧会话和恢复会话解析为一个 Canonical Thread；
   - 两个 Runtime Instance 对应两个 Segment；
   - 历史用户消息、Tool Call、Tool Result 不重复；
   - 恢复后的新用户输入形成一个新 Turn；
   - 不再出现“调用证据缺失，但观察到工具结果”的错误提示；
   - 原两个 Conversation URL 均能跳转到 Canonical Thread。

2. Docker Codex：
   - 现有一个 Thread、三个 Segment 的正确结果不回退；
   - 不因 V2 Resolver 产生错误拆分或合并。

3. initialize、tools/list 和 Bootstrap：
   - Conversation Count 中为 0；
   - Technical Activity 中可查；
   - 原始证据仍可打开。

### 20.2 前端一致性

- 连续执行 100 次 A/B Thread 快速切换，不出现 Header、Dropdown、Timeline ID 不一致；
- polling 和慢查询不覆盖 Pinned Selection；
- 不同 Thread 加载期间不显示旧正文；
- URL、左栏高亮、中栏 Header、Dropdown 和 API Canonical ID 始终一致；
- 1440、1024、390 无横向溢出；
- 鼠标、键盘和触屏均可切换；
- runtime exception 和不可解释网络失败为 0。

### 20.3 统一证据

- 现场命令工具能够关联到已有 ToolExec eventId；
- 对话页面展示的 Verdict、Tier、Risk Score 与事件页面完全一致；
- Tool Card 能跳转到 Kernel Event；
- Kernel Event 能返回关联 Thread 和 Turn；
- Existing Incident 能看到触发它的用户意图和工具上下文；
- 关系不确定时显示 ambiguous 或 semantic_only，不以时间单独猜测；
- 不产生第二份独立风险判断。

### 20.4 数据不变量

~~~text
Raw Interaction Count
  =
Conversation Membership
  + Technical Activity Membership
  + Background Membership
  + Unclassified Membership
~~~

- 一个 Interaction 在同一 resolutionRevision 中只有一个有效 Membership；
- 一个 Alias 只能指向一个 conversation 或 technical_activity 目标；
- Alias 链必须压缩且无环；
- 一个稳定 Semantic Event ID 不因 Thread Merge 改变；
- 一个 Kernel Event 若竞争多个 Tool Invocation，不自动分配；
- Backfill 重复执行结果幂等。

---

## 21. 风险与控制

### 21.1 错误合并

风险：

- 部分 API 可能复用 cache key；
- 两个 Thread 可能共享历史前缀；
- 并发分支可能携带相同历史。

控制：

- exact Provider ID 冲突屏障；
- continuity key 必须位于同一 Logical Scope；
- 使用稳定 message tail、turn ID 和 tool ID 交叉确认；
- 识别并发分支；
- ambiguous 不强行合并。

### 21.2 错误拆分

风险：

- Provider 在 Resume 时重置 response chain；
- Agent 资产 ID 在进程切换时发生别名变化。

控制：

- 使用 Canonical Logical Scope，不使用 raw asset ID；
- Continuity Anchor 和 Replay Lineage 跨实例；
- Thread Alias 和 Membership Supersede。

### 21.3 大请求性能

风险：

- Resume Request 可能携带大量历史和工具定义。

控制：

- Observer 只输出有界 Anchor 和稳定身份；
- Request Raw 继续受现有限额；
- Anchor 去重并设置数量上限；
- Incremental Resolver，不在每次目录请求中全量重算；
- Evidence Detail 按需读取。

### 21.4 隐私

风险：

- Conversation Anchor、消息和工具参数可能包含敏感信息。

控制：

- 派生索引保存 namespaced hash；
- 不记录 Authorization、Cookie 或 API Key；
- 技术活动默认折叠；
- Raw Evidence 继续使用平台已有访问边界和审计；
- 不在日志中输出正文、Anchor 原值或配置密钥。

### 21.5 关系误报

风险：

- 同一时间窗口存在多个相似命令；
- 远程工具没有本地执行事实。

控制：

- 时间不单独建立关系；
- 必须匹配 Canonical Runtime 与命令、资源、连接或进程祖先；
- 竞争关系标记 ambiguous；
- 远程执行显示 semantic_only。

---

## 22. 本阶段范围与非目标

本阶段包含：

- 通用 Anchor Contract；
- Resolver V2；
- Thread Alias 和迁移；
- Context Replay 去重；
- Technical Activity；
- 前端 Selection 一致性；
- Agent/Instance Overview；
- TLS Tool 与 Kernel Event 关系；
- 风险与 Incident 双向跳转；
- Codex、Claude Code、Pi 真实验证。

本阶段不包含：

- 要求 Agent 安装 SDK；
- Hook Agent 框架内部函数；
- 为每个版本维护模板矩阵；
- 依据官方域名决定是否采集；
- 删除原始 Interaction 或 Kernel Event；
- 重新设计风险研判算法；
- 将不确定关系伪装成精确 Trace；
- 在本方案审核前直接修改运行时代码。

---

## 23. 审核决策点

建议审核通过以下默认产品决策：

1. Logical Agent 默认进入 Agent Overview，不再自动打开排序第一的 Thread；
2. Runtime Instance 默认进入 Instance Overview；
3. 只有 Human-visible Conversation 进入 Thread 列表和计数；
4. initialize、tools/list、Bootstrap 默认折叠为 Technical Activity；
5. Resume Replay 只显示摘要，不重复产生主时间线事件；
6. Thread 合并保留 Alias 和旧深链接；
7. Risk Judgment 继续以 Kernel JudgedEvent 为唯一权威；
8. 对话页面通过 Relation 读取并展示已有风险，不建立第二套评分；
9. 不确定会话与内核关系显式显示 strong、ambiguous、semantic_only 或 coverage_gap；
10. Codex、Claude Code、Pi 是首批验收样本，不是产品硬编码边界。
