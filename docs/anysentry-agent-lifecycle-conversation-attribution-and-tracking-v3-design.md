# AnySentry Agent 生命周期、会话归因与对话追踪 V3 一体化设计

> 审核状态：已通过。首批实现对象为 Codex、Claude Code 与 Pi；协议、身份、Thread/Segment 和前端合同均按通用 Agent 能力设计。本文同时作为本阶段 PRD、开发设计与验收基线。

> - 状态：Draft for Review
> - 日期：2026-08-30
> - 首批范围：Codex CLI、Claude Code CLI；抽象同时适用于 Kimi CLI、Pi、Dify、LangChain 及其他 Agent 运行时
> - 前置设计：[`anysentry-discovery-first-agent-tls-observability-v2-design.md`](./anysentry-discovery-first-agent-tls-observability-v2-design.md)
> - 本文性质：PRD、生命周期与归因架构、数据模型、API、前端交互、开发计划和验收标准一体化文档

---

## 1. 一句话目标

**将“逻辑 Agent、物理载体、一次进程运行、可跨进程延续的对话线程、一次用户轮次和模型/工具事件”拆成明确层级，以 TLS 明文 Interaction 为证据源，稳定还原用户、模型、工具三类时间线，并让运维人员一眼判断哪个 Agent、哪个运行实例、哪段对话正在运行或已经结束。**

---

## 2. 结论与推荐方案

当前问题不能通过继续延长一个 TTL、把同名 Agent 再多合并一层，或为 Codex/Claude 增加更多产品模板解决。根因是当前系统同时用“进程、容器、workspace、provider response chain、时间窗口”表达多个不同概念，而产品和 API 没有给这些概念稳定命名。

本文推荐明确六个概念，但它们不是错误的单向父子树，而是以下关系图：

```text
逻辑 Agent Logical Agent
  Codex · AnySentry workspace · Host
  ├─ 启动为 → 运行实例 Runtime Instance
  │             一次真实根进程：host + boot + PID + start ticks
  │             └─ 位于 → 物理载体 Physical Workload
  │                         Host / Docker Container / Kubernetes Pod
  │
  └─ 拥有 → 对话线程 Conversation Thread
                可跨天、可 resume、可跨运行实例
                └─ 通过 Instance Segment 关联某个 Runtime Instance
                     └─ 包含 Turn → Semantic Event
                          用户 → 模型 → 工具调用/结果 → 模型最终回复
```

关键决策如下：

1. **退出 Codex/Claude 只结束运行实例，不自动结束宿主机、SSH 终端或 Docker 容器。**
2. **在同一终端再次执行 `codex` 是新的运行实例。**即使 PID 被系统复用，`startTimeTicks` 也必须不同。
3. **对话线程不等于运行实例。**`codex resume`、Claude resume 或明确 provider thread ID 可以让同一个对话线程跨新的运行实例继续。
4. **进程仍存活但一晚没有人工输入，只是 idle，不是 exited，也不应新建运行实例或对话。**第二天继续输入是同一实例、同一线程的新 Turn。
5. **Conversation 不再依赖固定 30 分钟空闲窗口切分。**时间只能作为弱证据，不能覆盖进程连续性、provider thread、response chain、tool call/result 等强证据。
6. **页面正文只使用三类 Actor：用户、模型、工具。**MCP、Skill、Bash、Read、Write、Search 均是“工具”的具体类型；异常和采集缺口是状态提示，不是第四类对话 Actor。
7. **Interaction 继续作为不可修改的传输证据；Thread、Turn 和三类事件是可重算的语义投影。**
8. **运行实例历史必须持久化。**当前约 1 小时的终态 TTL 只能作为热状态缓存，不能决定用户是否还能看到历史实例。

---

## 3. 术语与边界

“容器”“实例”“会话”“Session”在当前讨论中容易混用。后续产品、接口和文档统一使用以下术语。

| 术语 | 是什么 | 唯一身份 | 生命周期结束条件 | 示例 |
|---|---|---|---|---|
| 物理载体 `PhysicalWorkload` | Agent 进程所在的 Host、Docker 容器或 Pod | Host ID / Container ID / Pod UID + generation | Host/容器/Pod 真正停止或被替换 | `tender_jang` Docker 容器 |
| 逻辑 Agent `LogicalAgent` | 用户认知中的某类 Agent 安装或工作域 | product + environment + real workspace/tenant | 通常长期存在，不随进程退出 | `Codex · AnySentry · Host` |
| 运行实例 `RuntimeInstance` | 一次真实 Agent 根进程及其 generation | host + boot + PID namespace + root PID + start ticks | 精确 ProcessExit；或有证据的 lost | 一次 `codex` 命令启动的 native 进程 |
| 对话线程 `ConversationThread` | 用户理解中的一段可继续/恢复的上下文 | provider thread ID、runtime session ID 或持久 binding ID | 显式新建/删除/关闭；空闲不自动结束 | Codex 中命名为“测试”的 thread |
| 实例段 `ConversationInstanceSegment` | 某 Thread 被某 Runtime Instance 承载的一段连续区间 | thread ID + instance ID + segment ordinal | 实例退出、resume 到新实例或明确切换 | 同一 thread 在今日与明日两个 Codex 进程上的两段 |
| 轮次 `Turn` | 一次用户输入直到模型最终回复或明确中断 | thread ID + turn ordinal/provider turn ID | final model reply、cancel、failure 或 gap settlement | “你有什么工具”及其完整工具循环 |
| 模型交互 `ModelInteraction` | 一次模型网络请求/响应 | Interaction ID | response terminal event | 一次 Responses `response.create → completed` |
| 语义事件 `SemanticEvent` | 页面时间线中的用户、模型或工具事件 | thread/turn + source item ID | 原子事件 | 用户消息、模型回复、Bash 工具结果 |

### 3.1 “同一个终端再次启动 Codex”到底是什么

#### 宿主机 SSH 场景

```text
SSH connection / pts/4
  ├─ shell process
  ├─ codex process A  ── exit code 0 ──> Runtime Instance A 结束
  └─ codex process B                    Runtime Instance B 新建
```

- SSH 窗口不是容器。
- Shell 进程仍在，不代表 Codex 实例仍在。
- 第二次 `codex` 的 PID/start ticks 不同，所以是新运行实例。
- 两个实例仍可属于同一个 Logical Agent。
- 如果 B 使用 `codex resume <thread>`，A 和 B 可以承载同一个 Conversation Thread，但必须形成两个 Instance Segment。

#### `tender_jang` Docker 场景

```text
Docker container tender_jang（物理载体仍存活）
  ├─ codex process A ── exit ──> Runtime Instance A 结束
  └─ codex process B            Runtime Instance B 新建
```

退出 Codex 不等于结束 `tender_jang` 容器。只有 Docker container 本身停止、删除或重建，才结束物理载体生命周期。

### 3.2 “第二天继续同一个长任务”是什么

如果 Codex/Claude 根进程仍存活：

```text
Runtime Instance A
  09:00 Turn 1 完成
  09:05 activity = idle
  ... 18 小时无人工输入 ...
  次日 03:00 Turn 2 开始
```

它仍是：

- 同一个运行实例；
- 同一个 Conversation Thread；
- 新的 Turn；
- activity 从 idle 恢复 active。

空闲时间不能创建新实例，也不能自动拆分 Conversation。

如果进程已经退出，次日通过 resume 继续：

```text
Thread T
  Segment 1 → Runtime Instance A → exited
  Segment 2 → Runtime Instance B → running
```

Thread 不变，实例变化。

---

## 4. 当前实现事实与已确认偏差

本节区分已确认事实与拟议设计，避免把推荐方案写成现状。

### 4.1 当前链路

```text
Observer process/root discovery
  → AgentRuntimeSnapshotEntry
  → AgentRuntimeStateService（内存）
  → AgentInteractionRecord（ClickHouse）
  → projectAgentConversations（查询时投影）
  → projectAgentConversationDirectory（Logical Agent 聚合）
  → ConversationTrackingPage（三列固定 Grid）
```

### 4.2 当前已确认事实

| 项目 | 当前实现 |
|---|---|
| 运行实例根身份 | `hostId + bootId + PID + /proc startTimeTicks` 形成 root key，再派生 `ari_*` |
| 另一套交互实例身份 | Interaction 中仍可能出现 `host-root:<host>:<boot>:<pid>:<startTicks>` |
| 运行状态 | `running / exited / lost / unobserved`；running 还有 `active / idle` |
| Observer activity idle | 默认约 60 秒 |
| API activity idle | 默认约 5 分钟 |
| API unobserved | 最少约 90 秒，或三个 Forwarder interval |
| API terminal hot TTL | 默认约 1 小时 |
| API unobserved TTL | 默认约 24 小时 |
| inferred Conversation idle | 默认 30 分钟 |
| Conversation 强身份优先级 | 显式 conversation ID → provider response chain → runtime session → inferred root/time/tool/user lineage |
| Logical Agent | canonical product + environment + workspace/product scope |
| 页面布局 | 固定 `320px / 1fr / 0.78fr` 三栏；不可拖拽 |
| 页面事件种类 | model request/response、tool call/result、external tool、retry、error 共七种视觉类型 |
| Runtime 历史 | 主要是内存状态和有界 terminal retention；不是完整持久目录 |
| Conversation | 每次查询从 Interaction 重新投影，没有稳定持久的 Thread/Segment binding |

### 4.3 真实数据暴露出的偏差

2026-08-30 的只读样本中：

- 同一宿主机 Codex Logical Agent 行累计 18 个 instance ID、34 个 Conversation；
- 同一个实际进程可能同时出现 `host-root:*` 与 `ari_*` 两种 instance alias；
- 同一个 Claude Code 根进程在几分钟内被拆成 5 个 inferred Conversation；
- 同一个长工具任务可能被拆为模型 Conversation、MCP initialize、MCP tools/list 等多个 Conversation；
- 相同 Claude Conversation 中出现 3 个工具调用但 17 个工具结果，说明累计请求中的历史 tool result 被跨 Interaction 重复计数；
- 一个仍在运行但超过 activity idle 阈值的 Agent 会显示 idle，但用户容易把它理解为实例结束；
- terminal runtime 约一小时后从热目录移除，使历史 Conversation 仍存在但对应运行实例详情消失；
- API/Observer 重启后，Runtime Snapshot 回补前会暂时把有正文的 Conversation 显示为历史；
- 页面左栏只显示实例数量，不显示实例本身，用户无法判断 18 个 ID 中哪些是别名、当前进程或历史进程。

### 4.4 当前解析器的直接问题

当前 Responses SSE/WS 归一化存在类似逻辑：

```text
只要 event.delta 是字符串
  → 追加到 response text
```

这会同时命中：

```text
response.output_text.delta              → 模型文字，正确
response.custom_tool_call_input.delta   → 工具输入，不应成为模型文字
```

因此可能产生：

```text
模型说明文字 + 工具 JavaScript/arguments
```

被拼成一个 `model_response`，导致工具调用和 LLM 对用户的文字回复混在一起。

Claude Messages 也必须按 `content_block.type` 区分：

```text
text         → 模型
tool_use     → 工具调用
tool_result  → 工具结果（即使外层 role=user，也不是人工用户）
```

### 4.5 当前方案为什么不能只改 TTL

把 terminal TTL 从一小时改成七天，只能让旧 runtime record 多存在几天，不能解决：

- instance alias 重复；
- 同一 Thread 跨实例 resume；
- 一个实例承载多个 Thread；
- Claude/Codex 长任务被拆成多个 Conversation；
- tool result 累计重复；
- 模型文字与工具参数混合；
- UI 看不到实例与 Conversation 的明确关系。

---

## 5. 产品目标、非目标与成功标准

### 5.1 用户目标

运维人员进入对话追踪页面后，应能在十秒内回答：

1. 当前哪些 Agent 正在运行？
2. 同名 Agent 有几个真实运行实例？分别在哪里、何时启动、是否活跃？
3. 某个运行实例承载了哪些 Conversation？
4. 某个 Conversation 是否跨多个运行实例恢复过？
5. 当前 Turn 中哪些内容来自人工用户、模型和工具？
6. 工具调用和结果是否成对？最终模型回复是否存在？
7. 如果内容缺失，是 Agent 没有产生、采集丢失、协议未解析，还是归因不确定？

### 5.2 目标

- Codex/Claude 首批完整支持三类事件投影；
- Runtime Instance 在进程退出后仍能在历史目录中长期查询；
- 同一终端重新启动产生新实例；
- 同一进程长时间 idle 后继续对话仍归属原实例和 Thread；
- resume 可以将同一 Thread 关联到新实例段；
- 实例 alias 不重复计数；
- Conversation 不因工具循环、MCP 初始化或固定 30 分钟 idle 被错误拆分；
- 工具调用/结果按 call ID 去重和配对；
- 最终模型文字独立于工具调用展示；
- 三栏可调整宽度，状态可恢复，键盘可操作；
- 原始 Interaction、TLS 证据和解析版本仍可审计。

### 5.3 非目标

- 不引入 Agent Hook、SDK 或读取本地 session 文件作为生产正文来源；
- 不依赖 Codex/Claude 版本号、官网 URL 或模型配置归因；
- 不保证在完全缺失 provider/thread/instance 证据时强行合并 Conversation；
- 不把模型 reasoning 私密内容推断为用户可见回复；
- 不把所有 MCP server、Skill 名称都通过正文猜测出来；无法确定时显示通用 Tool；
- 本阶段不重做 AnySentry 全局导航和整体视觉系统。

---

## 6. 方案比较

| 方案 | 方法 | 优点 | 主要问题 | 结论 |
|---|---|---|---|---|
| A. 进程即 Conversation | 每个 Runtime Instance 只有一个 Conversation | 实现简单 | resume 无法跨进程；同一进程多 thread 无法表达；长任务容易混乱 | 不采用 |
| B. 只认 provider thread | 仅 provider/session ID 相同才合并 | 精度高 | Claude/中转/部分协议不一定提供；缺失即完全碎片化 | 只作为强证据 |
| C. Thread + Runtime + Segment 分层 | Thread 与实例独立，通过 Segment 多对多关联；多级证据解析 | 能表达 CLI、resume、工作流、长 idle 和多实例；可审计 | 需要持久 binding 和迁移 | **推荐** |

---

## 7. 统一身份模型

### 7.1 物理载体身份

```ts
interface PhysicalWorkloadIdentity {
  environment: "host" | "docker" | "kubernetes";
  hostId: string;
  bootId?: string;
  containerId?: string;
  podUid?: string;
  workloadGeneration?: string;
  displayName: string;
}
```

它回答“运行在哪里”，不回答“这是哪一次 Agent 启动”。

### 7.2 运行实例身份

推荐统一 canonical key：

```text
sha256(
  schemaVersion,
  agentScopeId,
  hostId,
  bootId,
  pidNamespace,
  rootPid,
  rootStartTimeTicks
)
```

关键属性：

- PID 不是单独身份；
- `startTimeTicks` 防止 PID reuse；
- `physicalWorkloadId` 是 placement，不进入进程实例的替代身份；
- Node/npm wrapper 与 native Codex child 通过同 scope 的连续进程链归并为一个 root；
- Bash、MCP child、tool process 是该实例的 child runtime，不自动成为新 Agent 实例；
- 明确启动另一个 Codex/Claude 根进程，即使同 workspace、同 terminal，也产生新 instance。

### 7.3 Instance Alias

当前以下 ID 可能表达同一根进程：

```text
ari_<hash>
host-root:<host>:<boot>:<pid>:<startTicks>
旧 container/workload identity
```

新增 alias 表：

```ts
interface AgentRuntimeInstanceAlias {
  aliasId: string;
  canonicalInstanceId: string;
  aliasType: "observer_root" | "interaction_root" | "legacy_workload";
  evidence: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}
```

归并条件必须至少满足：

```text
hostId 相同
bootId 相同
rootPid 相同
rootStartTimeTicks 相同
Agent scope 不冲突
```

页面计数只使用 canonical instance ID。

### 7.4 Terminal Context

终端用于帮助用户识别实例，但不作为身份主键：

```ts
interface TerminalContext {
  tty?: string;              // pts/4
  parentShellPid?: number;
  loginUid?: number;
  sshConnectionHash?: string; // 只保存不可逆、短期 hash；可选
}
```

UI 可显示：

```text
Host · pts/4 · PID 730037 · 12:18 启动
```

不要显示或持久化原始 SSH 地址、用户密钥或完整环境变量。

### 7.5 Logical Agent

继续使用 product + environment + real workspace/tenant 作为长期目录，但要区分：

```text
Logical Agent：Codex · AnySentry · Host
Runtime Instance：I-7K3P · PID 730037 · 运行中
Conversation Thread：测试 · 12 Turns
```

`agent://*`、`agent-scope:*` 是占位 scope，不是用户 workspace。后续可通过稳定 binding 合并，但 UI 必须标明“工作区待确认”，不能伪装成真实路径。

---

## 8. 运行实例生命周期

### 8.1 状态机

```text
                snapshot/control gap
                      ┌───────────────┐
                      ▼               │
discovered → running.active → running.idle
                │   ▲             │   ▲
                │   └ activity ────┘   │
                │                      │ same root re-observed
                ├─ exact exit ───────> exited
                ├─ liveness loss ────> lost
                └─ observer gap ─────> unobserved
```

状态语义：

| 状态 | 含义 | 是否结束实例 | UI |
|---|---|---:|---|
| `running.active` | 近期有用户/模型/工具/进程活动 | 否 | 绿色实点“活跃” |
| `running.idle` | 进程仍在，近期无活动 | 否 | 青灰空心点“空闲 18h” |
| `unobserved` | Forwarder/Observer 控制面暂时不可确认 | 否 | 琥珀“观测中断” |
| `lost` | 多次 liveness 检查找不到进程，但无精确 exit | 可能 | 琥珀/灰“失联” |
| `exited` | 精确退出事实，含 exit code/signal | 是 | 灰“已退出 · code 0” |

### 8.2 推荐时间语义

| 参数 | 推荐默认 | 作用 | 不允许做什么 |
|---|---:|---|---|
| active → idle | 5 分钟 | 仅改变 activity badge | 不结束实例/Conversation |
| snapshot → unobserved | 3 个 interval，且不少于 90 秒 | 表达控制面不确定 | 不直接标 exited |
| liveness misses → lost | 2 次，保留现有证据 | 表达进程疑似消失 | 不删除历史 |
| terminal hot cache | 1 小时可保留 | 控制内存 | 不能决定历史是否存在 |
| durable instance metadata | 默认 90 天，可按数据策略配置 | 历史导航 | 不与正文 retention 强绑定 |
| dormant display | 24 小时无 Thread 活动 | 只用于 UI 分组 | 不切分 Thread |

Observer 当前 60 秒 activity idle 与 API 当前 5 分钟不一致，应统一为服务端配置并由 Snapshot 只上报 activity timestamp，不由两个组件分别判断。

### 8.3 持久化原则

运行实例终态不能只留在 `AgentRuntimeStateService` 内存中。推荐：

```text
Observer snapshots / ProcessExit
  → Runtime Current State（内存或 Redis，快速）
  → Runtime Lifecycle Facts（ClickHouse，追加事实）
  → Runtime Instance Directory（PostgreSQL，当前 canonical/alias/摘要）
```

API 重启时：

1. 从 PostgreSQL/ClickHouse 恢复实例目录；
2. 未收到新 Snapshot 前显示 `unobserved`，不是 `historical`；
3. 收到相同 canonical process key 后恢复 `running`；
4. 精确 exited 状态不可逆，不允许被旧 Snapshot 复活。

---

## 9. Conversation Thread 与归因

### 9.1 Thread 身份优先级

从强到弱：

| 优先级 | 证据 | 质量 | 规则 |
|---:|---|---|---|
| 1 | 显式 provider conversation/thread ID | exact | 同 Logical Agent scope 内直接绑定 |
| 2 | Codex/Responses `previous_response_id` 完整链根 | strong | 链根相同即同 Thread |
| 3 | Claude/runtime session ID、Dify conversation ID、LangChain thread ID | strong | 规范化后绑定 |
| 4 | tool call/result `call_id` 跨 Interaction | strong | 只连接 Turn/Thread，不单独创建 Conversation |
| 5 | 同 canonical instance + 同 active thread + 新用户消息 | inferred | 进程连续时不因 idle 拆分 |
| 6 | workspace + user lineage + bounded time | inferred | 仅在缺失更强身份时使用 |

禁止用以下字段单独合并 Conversation：

- 相同模型；
- 相同 URL/Host；
- 相同产品名；
- 相同 Docker 容器；
- 只有时间接近；
- 只有相同 workspace。

### 9.2 Thread、Instance 与 Segment

```ts
interface AgentConversationThread {
  conversationId: string;
  logicalAgentId: string;
  providerThreadId?: string;
  runtimeSessionId?: string;
  idSource: "provider" | "runtime" | "response_chain" | "inferred";
  correlationQuality: "exact" | "strong" | "inferred" | "unresolved";
  state: "active" | "waiting_user" | "dormant" | "closed" | "incomplete";
  firstSeenAtUnixNs: string;
  lastActivityAtUnixNs: string;
  title?: string;
}

interface ConversationInstanceSegment {
  segmentId: string;
  conversationId: string;
  agentInstanceId: string;
  ordinal: number;
  startedAtUnixNs: string;
  endedAtUnixNs?: string;
  startReason: "created" | "resumed" | "reconnected" | "inferred";
  endReason?: "instance_exit" | "thread_switch" | "replaced" | "observation_gap";
  correlationQuality: "exact" | "strong" | "inferred";
}
```

### 9.3 Conversation 状态机

```text
new user input
     │
     ▼
active.turn
  ├─ model progress/text
  ├─ tool call ───────> waiting_tool
  │                         │ tool result
  │                         └─────────────> waiting_model
  ├─ final model reply ──────────────────> waiting_user
  ├─ explicit cancel/failure ────────────> incomplete
  └─ process exit
       ├─ provider thread resumable ─────> dormant
       └─ no resume identity ────────────> closed/incomplete
```

`waiting_user` 可以持续数天。用户下一次输入只创建新 Turn，不新建 Thread。

### 9.4 归因算法

```text
for each Interaction:
  canonicalInstance = resolveInstanceAliases(interaction.instance/process)
  semanticItems = parseTypedProtocolItems(interaction)

  thread = resolve in order:
    1. explicit conversation/thread ID
    2. provider response-chain root
    3. runtime session ID
    4. call_id bridge to an open turn
    5. current open thread on the same persistent CLI instance
    6. create inferred thread with explicit uncertainty

  segment = active segment(thread, canonicalInstance)
    or create a new segment with startReason

  turn = resolve:
    - new human user item → new turn
    - model/tool continuation → current open turn
    - final model reply → close turn as waiting_user
    - gap/instance exit → mark incomplete without fabricating content
```

### 9.5 复杂场景决策表

| 场景 | Logical Agent | Runtime Instance | Conversation Thread | Segment / Turn |
|---|---|---|---|---|
| 同一 SSH 终端退出 Codex，再运行 `codex` | 同一个 | 新实例 | 默认新 Thread | 新 Segment/Turn |
| 同一终端 `codex resume 测试` | 同一个 | 新实例 | 同一个 Thread | 新 Segment，新 Turn |
| Codex 进程存活，第二天继续输入 | 同一个 | 同一个 | 同一个 Thread | 同 Segment，新 Turn |
| 两个终端并行运行 Codex | 同一个 | 两个实例 | 通常两个 Thread | 各自 Segment |
| 同一实例切换到新 thread | 同一个 | 同一个 | 新 Thread | 新 Segment |
| `tender_jang` 内退出 Codex 再启动 | 同一个 | 新实例 | 由 resume 证据决定 | 物理容器不变 |
| Docker container 重启 | 同一个或新 workload generation | 新实例 | 可由 provider ID resume | 新 Segment |
| Observer/API 暂时重启 | 同一个 | 同一个，先 unobserved | Thread 不变 | 不创建新 Segment，除非进程/连接真的重建 |
| PID 被复用 | 同一个 | 新实例，因为 start ticks 不同 | 不自动继承 | 新 Segment |
| Dify 长驻 worker 处理多个用户 | 同一个 | 同一个 worker 实例 | 按 Dify conversation/workflow run 分多个 Thread | 一个实例多 Thread |
| LangChain HTTP 无 thread ID | 同一个 | 服务进程实例 | 每个 inbound invocation 默认新 Thread | 以 invocation 边界分段 |

### 9.6 inferred Conversation 不再使用单一 30 分钟规则

推荐按运行模式处理：

| 模式 | Thread 边界 |
|---|---|
| 持续交互 CLI | 根进程连续 + 当前 thread binding；idle 不拆分 |
| CLI resume | provider/runtime session 显式跨实例绑定 |
| `codex exec` / 一次性 CLI | 一次 invocation 一个 Thread，除非显式 resume |
| Dify Chat | provider/Dify conversation ID |
| Dify Workflow | workflow run ID；若有上层 conversation，再作为 parent thread |
| LangChain service | thread ID 优先，否则 inbound request/invocation ID |
| 完全未知 | 同 instance + user lineage + open turn；超时仅降低 confidence，不自动合并或拆分 |

---

## 10. 三类语义事件模型

### 10.1 页面只显示三类 Actor

```ts
type ConversationActor = "user" | "model" | "tool";

type SemanticEventKind =
  | "user_message"
  | "model_progress"
  | "model_final"
  | "tool_call"
  | "tool_result";
```

Retry、解析错误、采集缺口和 coverage 不作为 Actor：

```ts
interface TimelineDiagnostic {
  type: "retry" | "capture_gap" | "parse_gap" | "correlation_gap";
  severity: "info" | "warning" | "error";
  attachedToEventId?: string;
}
```

### 10.2 规范化结构

```ts
interface AgentSemanticEvent {
  semanticEventId: string;
  conversationId: string;
  segmentId: string;
  turnId: string;
  actor: ConversationActor;
  kind: SemanticEventKind;
  phase?: "progress" | "final";
  atUnixNs: string;
  endedAtUnixNs?: string;
  content?: unknown;
  contentPreview?: string;
  toolCallId?: string;
  toolName?: string;
  toolKind?: ToolKind;
  status?: "pending" | "running" | "succeeded" | "failed" | "unknown";
  sourceInteractionIds: string[];
  sourceItemIds?: string[];
  parserId: string;
  parserVersion: number;
  correlationQuality: "exact" | "strong" | "inferred" | "unlinked";
  completeness: "complete" | "partial" | "missing";
  partialReasons: string[];
}
```

### 10.3 Codex / OpenAI Responses 映射

| Wire event/item | Actor | Kind | 说明 |
|---|---|---|---|
| request `input` 中新的 human user message | user | user_message | 只显示相对上一次请求新增的人工消息 |
| `response.output_text.delta/done` | model | model_progress/model_final | 仅这些文字事件进入模型正文 |
| `response.output_item.done`，item.type=message | model | model_progress/model_final | 保留 item/phase 边界 |
| `response.custom_tool_call_input.delta/done` | tool | tool_call | **不得追加到 model text** |
| item.type=`custom_tool_call/function_call` | tool | tool_call | call ID、name、arguments |
| 下一 request 的 `custom_tool_call_output/function_call_output` | tool | tool_result | 按 call ID 回补 |
| `response.completed` | 状态 | terminal | 完成当前 ModelInteraction，不自动等于 final user-visible reply |

### 10.4 Claude Messages 映射

| Wire event/item | Actor | Kind |
|---|---|---|
| request 中新的 role=user text block | user | user_message |
| `content_block_start/delta/stop`，block.type=text | model | model_progress/model_final |
| block.type=`tool_use` | tool | tool_call |
| request role=user 中 block.type=`tool_result` | tool | tool_result，不是人工用户 |
| `message_stop` | 状态 | terminal |

### 10.5 ToolKind 统一

```ts
type ToolKind =
  | "bash"
  | "read"
  | "write"
  | "search"
  | "mcp"
  | "skill"
  | "http"
  | "code"
  | "other";
```

归一优先使用结构化名称：

```text
exec / exec_command / bash / shell       → Bash
read / read_file                         → Read
write / write_file / apply_patch         → Write
search / search_query / web_search       → Search
mcp JSON-RPC server + method/tool         → MCP · <server>/<tool>
skill structured invocation              → Skill · <skill name>
generic HTTPS tool                       → HTTP · <method/path or tool name>
```

Codex 的 `exec` custom tool 中可能包含 `tools.exec_command(...)` 等嵌套调用。允许使用有界、只读词法解析提取 `tools.<identifier>`；禁止执行正文。无法唯一识别时显示 `Exec`，不要凭路径或 URL 猜测为某个产品工具。

### 10.6 工具调用与结果成对展示

页面不再把 call/result 当两个完全独立的大卡片，而是按 call ID 形成一个 Tool Step：

```text
工具  Bash                                      成功 · 1.2s
      $ rg "AgentRuntime" apps/api/src

      结果
      23 matches in 4 files
```

状态：

```text
call only                    → 等待结果
call + result                → 成功/失败
result without observed call → 结果已见，调用证据缺失
重复累计 result             → 按 call ID + semantic hash 去重
```

### 10.7 模型最终回复必须独立

同一次模型 response 可同时包含：

```text
assistant commentary text
custom tool call
```

必须投影为：

```text
模型 · 过程说明
工具 · Bash 调用
```

工具完成后的最后一次 response：

```text
模型 · 最终回复
```

不能把 tool arguments 拼入 model text，也不能因为一个 response 中存在 tool call 就丢弃同 response 的 assistant text。

### 10.8 完整性与缺口

```text
Interaction 证据完整但 Conversation 等待结果 → pending，不立即报错
后续相同 call ID 结果出现               → 回补 complete
实例退出后 call ID 仍无结果              → capture/tool gap
response terminal 存在但无 final text     → no_final_response
transport/template 失败                   → 中性“采集缺口”行 + Inspector 证据
```

旧 Interaction 不被修改；语义投影通过 parserVersion 可重算。

---

## 11. 数据存储与服务职责

### 11.1 Source of Truth

```text
Raw TLS/HTTP evidence + AgentInteractionRecord
  = 不可修改的传输事实

Runtime Instance / Thread Binding / Semantic Event
  = 可版本化、可回算的语义索引
```

### 11.2 推荐存储

| 数据 | 存储 | 原因 |
|---|---|---|
| Interaction 原始正文与时间 | ClickHouse，沿用现有 | 大体量、时间查询、TTL |
| Runtime lifecycle facts | ClickHouse append-only | 启动/活动/退出/失联事实 |
| canonical runtime current state | PostgreSQL + 内存热缓存 | alias、状态归并和 API 重启恢复 |
| Thread / Segment / alias binding | PostgreSQL | 需要幂等 upsert、merge、人工纠偏和稳定 deep link |
| Semantic event projection | 首期查询时生成；稳定后可 ClickHouse 物化 | parser 可快速迭代，后续再优化查询性能 |

### 11.3 新增核心表/记录

```text
agent_runtime_instances_v2
agent_runtime_instance_aliases_v1
agent_conversation_threads_v1
agent_conversation_instance_segments_v1
agent_conversation_bindings_v1
agent_conversation_aliases_v1
agent_semantic_projection_revisions_v1
```

不需要复制第二份完整原始正文。Semantic event 保存：

- source interaction ID；
- source item ID / sequence / JSON path；
- 有界 preview 或按现有正文策略保护的 normalized content；
- parser version；
- hash 和 completeness。

### 11.4 Binding 决策审计

每次 merge/split 都记录：

```ts
interface ConversationBindingDecision {
  decisionId: string;
  interactionId: string;
  conversationId: string;
  instanceId: string;
  segmentId: string;
  evidence: string[];
  quality: "exact" | "strong" | "inferred";
  resolverVersion: number;
  decidedAt: string;
}
```

后续 parser 更新可重放，不需要修改 Interaction。

---

## 12. API 设计

保持现有接口兼容，新增 V2 字段和按需详情接口，不一次返回所有历史实例正文。

### 12.1 Logical Agent Directory

```text
POST /security-center/agents/conversation-directory-v2
```

返回：

```ts
interface LogicalAgentDirectoryV2 {
  logicalAgentId: string;
  product: string;
  displayName: string;
  environment: string;
  workspace: WorkspaceIdentity;
  lifecycle: "running" | "unobserved" | "historical";
  instanceCounts: {
    active: number;
    idle: number;
    unobserved: number;
    exited: number;
    lost: number;
    total: number;
  };
  conversationCounts: {
    active: number;
    dormant: number;
    incomplete: number;
    total: number;
  };
  recentInstances: AgentRuntimeInstanceSummary[]; // bounded preview
  lastActivityAtUnixNs?: string;
  coverage: AgentConversationCoverage;
}
```

### 12.2 Runtime Instance Directory

```text
POST /security-center/agents/runtime-instances-v2
```

过滤：

```ts
interface RuntimeInstanceDirectoryQuery {
  logicalAgentId: string;
  lifecycle?: "running" | "history" | "all";
  activity?: "active" | "idle" | "all";
  cursor?: string;
  limit?: number; // max 100
}
```

返回必须包含：

- canonical instance ID 和短显示 ID；
- alias 数量，不返回全部 alias 除非展开；
- PID/start time/host/physical workload；
- terminal context（脱敏）；
- start/last activity/end/duration；
- runtime/activity state；
- exit code/signal；
- conversation count；
- 当前 active thread count；
- coverage。

### 12.3 Conversation Threads

```text
POST /security-center/agents/conversations-v2
```

支持：

```text
logicalAgentId
agentInstanceId（可选，表示过滤承载过该 Thread 的实例）
conversationId
threadState
time range
coverage
cursor/limit
```

返回 Thread + Segment 摘要，而不是把 Thread 复制到每个实例下。

### 12.4 Semantic Timeline

```text
POST /security-center/agents/conversations/timeline-v2
```

返回：

```ts
interface AgentConversationTimelineV2 {
  thread: AgentConversationThread;
  segments: ConversationInstanceSegment[];
  turns: Array<{
    turnId: string;
    ordinal: number;
    state: "active" | "complete" | "incomplete";
    startedAtUnixNs: string;
    endedAtUnixNs?: string;
    events: AgentSemanticEvent[];
    diagnostics: TimelineDiagnostic[];
  }>;
  parserVersion: number;
  dataSource: "clickhouse" | "hot_ring";
  coverage: QueryCoverage;
}
```

### 12.5 Deep Link

URL 建议：

```text
/conversations?
  logicalAgentId=...
  &instanceId=...              // optional filter
  &conversationId=...
  &segmentId=...               // optional
  &turnId=...
  &semanticEventId=...
  &interactionId=...
```

Deep link 解析顺序：Conversation → owner Logical Agent → optional Instance Segment → Event。不能让实时目录的第一行覆盖已有 deep link。

---

## 13. 对话追踪页面设计

### 13.1 页面要证明什么

页面不是聊天客户端，也不是原始 HTTP 查看器。它要回答：

```text
哪个逻辑 Agent
  → 哪个真实运行实例
    → 承载哪段 Conversation
      → 用户、模型、工具按什么顺序发生
        → 哪一步有缺口，可查看什么证据
```

### 13.2 保留三栏，但允许调整

```text
┌──────────────────────┬────────────────────────────────┬────────────────────────┐
│ Agent / Instance     │ Conversation Timeline          │ Detail / Evidence      │
│ Navigator            │                                │ Inspector               │
│                      │                                │                         │
│  min 240             │  min 480                       │  min 320                │
│  default 300         │  default fill                  │  default 420            │
│  max 520             │                                │  max 50vw               │
└──────────────────────┴────────────────────────────────┴────────────────────────┘
                    ↑ 12px hit target / 1px visible divider ↑
```

推荐不新增依赖，新增内部 `ResizableConversationWorkspace`：

- Pointer Events 支持鼠标/触控拖拽；
- divider 使用 12px 可命中区域、1px 可见线，并设置 `role="separator"`、`aria-orientation="vertical"`；
- ArrowLeft/Right 每次 16px；Shift + Arrow 每次 64px；
- Enter 或双击恢复默认；
- Inspector 可折叠，中心栏不可折叠；
- 宽度写入 `localStorage:anysentry.conversations.layout.v1`，只保存数值，不保存正文/ID；
- URL 不携带宽度，避免分享 deep link 时传播个人布局；
- 拖拽期间只更新 CSS variables，结束后持久化，避免 React 高频重渲染；
- 窗口变化时重新 clamp，不产生文档级横向滚动。

### 13.3 左栏：Agent 与运行实例导航

左栏默认仍优先让用户快速找到 Agent，不把所有实例永久平铺。

```text
Agent 导航                      [运行中 3] [历史 18]
────────────────────────────────────────────
● Codex · AnySentry · Host                 部分
  2 活跃 · 1 空闲 · 34 会话
  最近活动 12:18

  运行实例（仅选中 Agent 时展开）
  ├─ ● I-7K3P  活跃
  │    Host · pts/4 · PID 730037
  │    12:18 启动 · 已运行 2h14m · 5 会话
  ├─ ◌ I-A7AB  空闲 18m
  │    Host · pts/3 · PID 730005 · 0 会话
  └─ ▫ 查看 12 个历史实例

● Claude Code · tender_jang · Docker       完整
  0 活跃 · 1 空闲 · 5 会话
```

规则：

- Logical Agent 行只显示 canonical instance count；alias 不计数；
- active、idle 分开，不用“活动实例”包含二者；
- 选中 Agent 后只展开该 Agent 的实例，避免所有树同时展开；
- 实例短 ID 使用 canonical ID 后 4–6 位稳定编码，例如 `I-7K3P`；
- 必须同时显示状态文字和图标，不能只靠颜色；
- Host、Docker、Kubernetes 使用不同 placement 文案，但保持同一组件；
- “历史实例”按结束时间倒序分页，不受一小时热 TTL 影响；
- `unobserved` 单列“观测中断”，不立即移动到历史；
- 选择实例后，中心栏过滤到承载过该实例的 Conversation；
- 再次点击已选实例或选择“全部实例”清除实例过滤。

### 13.4 中栏头部：明确当前位置

```text
Codex · AnySentry
实例：I-7K3P（活跃）  >  对话：测试

[全部实例 ▼] [对话 12/34 ▼]     12 Turns · 4 Tools · 完整
```

如果 Thread 跨实例：

```text
对话：测试 · 2 个实例段
[全部段] [I-A1 · 08-30] [I-B2 · 08-31 resume]
```

用户默认看完整 Thread；选择 Segment 只是诊断过滤，不创建另一个 Conversation。

### 13.5 中栏正文：只用三类 Actor

推荐使用单列时间轴，不做左右聊天气泡交替。运维阅读的重点是顺序和证据，不是模拟 IM。

#### 用户

```text
┌ 用户 ───────────────────────────────────── 09:01:12 ┐
│ 你有什么工具                                             │
└──────────────────────────────────────────────────────────┘
```

- 颜色：Sky/Blue 语义；
- 图标：User/Message；
- 只显示人工用户的新输入；
- developer/system、内部 `response.create` 参数不显示为用户消息。

#### 模型

```text
┌ 模型 · 过程说明 ───────────────────────── 09:01:14 ┐
│ 我会先查看当前能力，再按类别说明。                        │
└──────────────────────────────────────────────────────────┘

┌ 模型 · 最终回复 ───────────────────────── 09:02:35 ┐
│ 当前会话可以进行代码读取、修改、构建验证……                │
└──────────────────────────────────────────────────────────┘
```

- 颜色：Teal；
- 过程说明与最终回复都属于模型，但通过小标签区分；
- 最终回复具有更高正文对比度；
- 不展示工具 arguments；
- 模型 retry、token、provider 等降级为元信息或 Inspector。

#### 工具

```text
┌ 工具 · Bash ─────────────────────── 成功 · 1.2s ┐
│ 调用  rg "AgentRuntime" apps/api/src             │
│ 结果  23 matches in 4 files                       │
│                                                  │
│ [展开完整参数与结果]                              │
└──────────────────────────────────────────────────┘
```

- 颜色：Violet；
- Bash、Read、Write、Search、MCP、Skill 使用同一工具 Actor 色；
- 工具类型以文字和统一 Lucide 图标区分；
- call/result 默认合并一张卡；
- 结果长文本默认 2–4 行，详情在展开区/右侧 Inspector；
- pending 使用“等待结果”，失败使用 Rose 边界，但仍是工具卡；
- 并行工具显示一个 batch 分组，内部每个 call ID 一张子卡。

### 13.6 色彩语义

延续 AnySentry 当前深色硬边界设计，不采用通用设计检索建议中的玻璃拟态、Fira 全量替换或绿色 CTA 主题。

| 语义 | Token | 建议色相 | 同时使用的非颜色标识 |
|---|---|---|---|
| 用户 | `conversation-user` | Sky | “用户”文字 + User icon |
| 模型 | `conversation-model` | Teal | “模型”文字 + Bot/Message icon |
| 工具 | `conversation-tool` | Violet | “工具 · Bash/MCP…” + Wrench/Terminal icon |
| 完成 | `state-complete` | Safe Green | Check + 完整 |
| 等待/部分 | `state-review` | Amber | Clock/Alert + 原因 |
| 失败 | `state-error` | Rose | X/Alert + 失败 |
| 证据/元信息 | `evidence-muted` | Zinc/Cyan | mono label |

正文与背景对比需达到 WCAG AA；状态不能只靠色彩。

### 13.7 采集缺口的展示

缺口不是第四类 Actor，使用时间线中的中性 divider/notice：

```text
──────── 采集缺口 · 等待 call_990 的工具结果 ────────
已观察到工具调用；未观察到相同 call ID 的结果或最终模型回复。
[查看证据]
```

避免使用“模型调用失败”，除非 HTTP/provider 明确失败。

### 13.8 右栏 Inspector

右栏继续按需显示：

```text
语义 | 原始 | 证据
```

建议将当前“结构化”改名“语义”，减少用户把协议 JSON 与页面语义混淆。

- 语义：当前 User/Model/Tool event 的 normalized content；
- 原始：source Interaction request/response；
- 证据：instance、segment、thread binding、parser version、wire template、TLS adapter、时间、hash、correlation quality；
- 一个 semantic event 来自多个 Interaction 时，提供证据列表而不是只取第一个；
- Tool 卡点击默认打开语义；“查看原始”才切到 raw；
- 原始正文保持当前复制、折叠和浏览器预览上限。

### 13.9 响应式

| 宽度 | 行为 |
|---|---|
| ≥1280 | 三栏，可拖拽 |
| 768–1279 | 左栏 + 中栏；Inspector 为抽屉；左栏可缩为 240px |
| <768 | 单列导航：Agent → Instance/Conversation → Timeline → Inspector |

移动端不提供精细拖拽手柄；使用明确的返回按钮和页面层级。任何视口都不能产生文档级横向滚动。

### 13.10 键盘与无障碍

- Agent/Instance list 使用 roving tab index；
- Arrow Up/Down 移动；Left/Right 折叠/展开；
- resize separator 可聚焦并通过方向键调整；
- Tool Step 的展开按钮有 `aria-expanded`；
- Actor、状态、工具类型均有可读文字；
- live update 不抢占 focus，不自动改变用户正在阅读的 Conversation；
- 新事件数量使用 `aria-live="polite"`，不逐条朗读大段正文；
- touch target 不少于 44px；
- `prefers-reduced-motion` 下禁用非必要宽度/抽屉动画。

---

## 14. 页面选择与跳转逻辑

```text
进入 /conversations
  → 默认选最近活动的 running Logical Agent
  → 不自动选某个 instance，中心显示该 Agent 的最新 Thread

选择 Logical Agent
  → 展开该 Agent 的 instance 列表
  → 中心显示全部实例的 Thread

选择 Runtime Instance
  → URL 写 instanceId
  → Conversation 下拉只显示该实例承载过的 Thread

选择 Conversation
  → 默认显示完整 Thread 的所有 Segment
  → Header 展示当前/历史 Segment

选择 Segment
  → 只过滤时间线，不改变 Conversation 身份

选择 Semantic Event
  → Inspector 打开
  → URL 写 semanticEventId/interactionId
```

实时跟随规则：

- 用户停留在列表顶端且选中最新 Thread 时，可追加新事件；
- 用户查看历史 Turn、选择实例过滤或打开 raw Inspector 时，不抢走选择；
- 新事件通过“3 条新事件”按钮提示；
- ProcessExit 更新实例状态，不自动跳回目录；
- resume 到新实例后，当前 Thread 增加 Segment badge，不新建视觉重复 Thread。

---

## 15. 后端模块设计

### 15.1 Observer

主要修改：

- `a3s-observer-collector/src/interaction.rs`
- Observer/common wire structs
- Forwarder runtime lifecycle publication

职责：

1. Codex Responses 按 event type 提取 typed semantic items；
2. Claude Messages 按 content block type 提取 typed semantic items；
3. 禁止 generic string `delta` 直接进入 model text；
4. 保留 output index、content index、item ID、sequence number、phase；
5. tool call/result 输出稳定 call ID、name、times；
6. MCP JSON-RPC 输出 server/method/tool identity；
7. 输出 parser version 和 partial reason；
8. Runtime Snapshot 输出 canonical root facts，不用 container identity 替换 root identity；
9. ProcessExit、lost、unobserved 分开上报。

### 15.2 AnySentry API

主要修改：

- `agent-runtime-state.service.ts`
- `agent-conversation.ts`
- `agent-conversation-directory.ts`
- `aggregation.service.ts`
- `clickhouse-store.ts`
- `relational-business-store.service.ts`
- `security-monitoring.controller.ts`
- `types.ts`

建议新增：

```text
agent-runtime-history.service.ts
agent-runtime-instance-identity.ts
agent-conversation-binding.service.ts
agent-conversation-segment.service.ts
agent-semantic-timeline.ts
```

职责拆分：

| 模块 | 职责 |
|---|---|
| Runtime Identity | canonical root key、alias、PID reuse fencing |
| Runtime History | 当前状态、durable lifecycle、API 重启恢复 |
| Conversation Binding | thread identity、merge/split、resolver version、binding audit |
| Segment Service | thread ↔ instance 的分段关系 |
| Semantic Timeline | 三类 Actor、Turn state machine、call ID pairing/dedup |
| Directory Projection | bounded Logical Agent/Instance/Thread 摘要 |

### 15.3 Web

当前单文件 `ConversationTrackingPage.tsx` 已同时承担查询、目录、Timeline、Inspector 和响应式。V3 应拆分：

```text
pages/conversations/
  ConversationTrackingPage.tsx
  useConversationWorkspaceState.ts
  useResizableConversationPanels.ts
  LogicalAgentNavigator.tsx
  RuntimeInstanceList.tsx
  ConversationHeader.tsx
  ConversationTimeline.tsx
  ActorEventCard.tsx
  ToolStepCard.tsx
  InteractionInspector.tsx
  conversation-colors.ts
```

数据 fetch 与 presentational components 分离；频繁拖拽宽度不放入全局 Context。

---

## 16. 开发阶段与依赖顺序

### Phase 1：语义协议修复（P0）

目标：先让 Codex/Claude 单个真实 Interaction 输出正确的 User/Model/Tool item。

交付：

- Responses event-type-aware text/tool parser；
- Claude content-block parser；
- call/result 跨 Interaction 去重；
- model progress/final 分离；
- parser version；
- fixture tests。

退出条件：真实 Codex/Claude 长工具链中，最终模型文字不再混入工具参数，工具结果不重复累计。

### Phase 2：Canonical Runtime Instance 与 durable history（P0）

目标：同一根进程只出现一个实例；退出后历史可查；idle 不结束。

交付：

- canonical process key；
- `ari_*` / `host-root:*` alias；
- Runtime lifecycle facts；
- PostgreSQL current directory；
- API restart recovery；
- terminal context（脱敏）；
- current/historical instance API。

退出条件：同一 PID/start 不重复计数；同终端重启产生新实例；一晚 idle 保持原实例。

### Phase 3：Thread / Segment Binding（P0）

目标：Conversation 与 Runtime 解耦，支持 resume 和跨天。

交付：

- binding resolver；
- provider/response/runtime/tool evidence priority；
- Conversation alias；
- Instance Segment；
- merge/split audit；
- 30 天现有 Interaction backfill。

退出条件：同一 Claude 长任务不再拆成多个 Conversation；resume 后 Thread 不重复、Segment 增加。

### Phase 4：V2 API 与三类 Timeline（P1）

目标：给前端提供稳定、分页、可深链的数据合同。

交付：

- Directory V2；
- Runtime Instance V2；
- Conversation V2；
- Timeline V2；
- cursor、coverage、parser revision；
- V1 compatibility adapter。

### Phase 5：前端交互（P1）

目标：一眼分清 Agent、实例、Conversation 与三类事件。

交付：

- 可调三栏；
- Agent → Instance 导航；
- Conversation/Segment header；
- User/Model/Tool card；
- paired Tool Step；
- gap notice；
- semantic/raw/evidence Inspector；
- deep link 与 live follow；
- responsive/keyboard/a11y。

### Phase 6：迁移、实机与发布（P0 Gate）

交付：

- 旧 instance/conversation alias backfill；
- Codex/Claude real matrix；
- Docker/Host/SSH/Kubernetes lifecycle cases；
- API restart/Observer restart；
- browser View 1440/1024/390；
- performance/privacy/retention；
- feature flag 与回滚。

---

## 17. 兼容与迁移

### 17.1 Instance

1. 对历史 Interaction 读取 host/boot/PID/start ticks；
2. 生成 canonical instance ID；
3. 将 `host-root:*`、`ari_*`、legacy workload ID 写入 alias；
4. 无完整 process key 的旧记录保留 provisional instance，标记 inferred；
5. 不把两个不同 start ticks 的进程合并。

### 17.2 Conversation

1. 优先重算 provider response chain；
2. 按 call ID 连接工具循环；
3. 按 canonical instance 和 user lineage 合并旧碎片；
4. 为旧 conversation ID 写 alias，保证 deep link；
5. inferred merge 保留 resolver evidence，可人工 split；
6. 不重写 Interaction 原文。

### 17.3 发布

建议 feature flag：

```text
ANYSENTRY_CONVERSATION_V3_SHADOW=true
ANYSENTRY_CONVERSATION_V3_UI=false
```

阶段：

```text
shadow projection
  → V1/V3 diff report
  → internal UI opt-in
  → default V3
  → V1 compatibility read
```

Diff 重点：

- instance duplicate reduction；
- conversation merge/split 数；
- call/result pair rate；
- final response visibility；
- unresolved gap rate；
- parser ambiguity rate。

---

## 18. 性能、安全与隐私

### 18.1 性能

- Directory 只返回 bounded recent instance preview；
- 实例和 Conversation 分页，不嵌入全部历史；
- 50+ 行列表启用虚拟化或窗口化；
- Timeline 按 Turn 分页/增量加载；
- resize 只写 CSS variable，不触发数据查询；
- semantic projection 以 Interaction hash + parser version 缓存；
- backfill 和在线 resolver 分离，避免阻塞读 API；
- 不用无界 `GROUP BY payload` 或在列表中加载原始正文。

### 18.2 安全

- Conversation read 继续遵循平台当前访问边界；
- 原始正文不进入 URL、localStorage 或 analytics；
- localStorage 只保存 pane width/collapse state；
- Terminal Context 不保存 SSH 密钥、环境变量和原始远端地址；
- Tool input 不执行，只做结构化 JSON 或有界词法分析；
- alias merge 必须有 process key/provider evidence，禁止时间近似跨租户合并；
- tenant/environment ID 继续进入 binding scope。

### 18.3 Retention

- Runtime metadata 与正文 retention 解耦；
- Interaction 正文继续遵循现有数据生命周期；
- Thread/Segment metadata 可保留更久，但不得包含被正文策略删除后的完整正文；
- 正文过期后 UI 显示“历史元数据存在，正文已按策略过期”。

---

## 19. 测试矩阵

### 19.1 生命周期

| 用例 | 预期 |
|---|---|
| 同一终端启动 Codex、exit 0、再次启动 | 两个 Runtime Instance，一个 Logical Agent |
| PID reuse、start ticks 不同 | 两个实例，不继承旧状态 |
| 同一实例 idle 24h 后继续 | 同实例、同 Thread、新 Turn |
| Observer 三个 interval 无快照 | unobserved，不是 exited |
| API 重启后 Snapshot 回补 | 同 canonical instance 恢复 running |
| 精确 ProcessExit | exited + code/signal，终态不可复活 |
| Docker container 内两次 CLI | 同 Physical Workload、两个 Runtime Instance |
| Docker container 重建 | 新 workload generation、新实例 |

### 19.2 Conversation

| 用例 | 预期 |
|---|---|
| Codex 4 次工具循环 | 1 Thread、1 Turn、4 Tool Steps、1 final model reply |
| Claude text → tool_use → tool_result → text | User/Model/Tool/Model，最终 text 独立 |
| `codex resume` 到新进程 | 1 Thread、2 Segments |
| 同实例显式新建 thread | 2 Threads、同 instance |
| Dify worker 处理两个 conversation ID | 2 Threads、同 instance |
| LangChain 无 thread ID 两次 HTTP invoke | 2 Threads |
| 缺最后 tool result | 1 gap notice，coverage partial，不伪造 final |
| 累计请求重复携带历史 tool_result | 每个 call ID 只显示一次 result |

### 19.3 Parser

- `response.output_text.delta` 进入 Model；
- `response.custom_tool_call_input.delta` 只进入 Tool；
- `response.output_item.done(message)` 保留独立 model item；
- Responses commentary 与 final 不合并；
- Claude `text_delta` 与 `input_json_delta` 不混合；
- Claude role=user `tool_result` 不显示为人工用户；
- MCP initialize/list 不成为独立用户 Conversation；
- tool call/result exact call ID pairing；
- fragment/truncation/gap 有明确 partial reason；
- parser 更新可由同一 raw Interaction 重放。

### 19.4 前端

- 1440px 三栏拖拽、最大/最小约束；
- 1024px Inspector drawer；
- 390px 单列层级；
- separator 键盘操作与 reset；
- 宽度刷新后恢复；
- URL deep link 不受宽度偏好影响；
- 运行中/idle/unobserved/exited 文案正确；
- alias 不重复计数；
- 一个 Thread 跨实例只显示一次；
- User/Model/Tool 颜色、图标、文字三重区分；
- final model reply 独立；
- Tool Step 默认显示名称、状态、耗时；
- raw/evidence 按需可达；
- 无文档级横向滚动、无 runtime exception、无 network failure。

### 19.5 性能

- 100 Logical Agents、10,000 Runtime Instances、100,000 Threads 的 bounded API fixture；
- Directory P95 目标不高于当前生产基线的 1.2 倍；
- 10,000 semantic events 不一次渲染；
- 拖拽 60fps，无数据 fetch；
- polling 不覆盖用户选择或滚动状态。

---

## 20. 验收标准

本阶段最终验收必须同时满足：

### 采集与语义

- Codex、Claude 各至少一个真实长工具链完整；
- 用户输入、模型文字、工具调用/结果不混类；
- 工具返回后模型最终文字单独显示；
- 已回补 tool result 不报错；
- 真正缺失结果显示 gap；
- 解析失败保留可查看证据和 parser reason。

### 生命周期

- 同终端重启是新实例；
- 长 idle 不结束实例；
- resume 跨实例保持 Thread；
- `host-root`/`ari` 不重复计数；
- exited 实例超过一小时仍能在历史目录找到；
- API/Observer 短暂重启不制造新实例或 Thread。

### 页面

- Logical Agent、Runtime Instance、Conversation Thread 三层关系明确；
- 三栏可手动调节并可重置；
- 中栏只有 User/Model/Tool 三种主要 Actor；
- Tool 名称简洁，详情按需展开；
- 运行、空闲、观测中断、退出与历史时间可见；
- 桌面和移动端均通过真实 View。

---

## 21. 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| Provider thread ID 不在 wire 中 | 无法 exact resume | Segment + inferred binding，显示 quality，不强行合并 |
| 一个进程并发多个 Thread | instance continuity 不够 | provider/runtime/inbound invocation 优先；禁止一实例一 Thread 的硬编码 |
| Observer 中途接入压缩 WebSocket | 无法恢复历史 compression context | 标记 observation gap，等待重连；不伪造正文 |
| parser 更新改变旧投影 | 页面历史变化 | parserVersion、binding decision 和 alias audit |
| 过度合并 Conversation | 隔离与审计错误 | tenant/scope fence、强证据优先、inferred 可 split |
| 实例历史过多 | 左栏拥挤 | running preview + 历史分页 + selected-only expansion |
| 三种颜色仍难区分 | 可访问性 | Actor 文本、图标、形状与颜色共同表达 |
| pane resize 增加交互复杂度 | 键盘/触控问题 | 8px hit area、separator ARIA、默认/reset、断点降级 |

---

## 22. 审核重点

本文建议审核以下五项，而不是先讨论具体 CSS：

1. 是否确认“同一终端重新启动 = 新 Runtime Instance；resume 可保持同一 Thread”？
2. 是否接受 Thread 与 Runtime 通过 Segment 多对多关联？
3. 是否接受历史 Runtime metadata 默认至少保留 90 天，而正文继续遵循现有 retention？
4. 是否确认页面主要 Actor 只保留 User / Model / Tool，异常作为中性 gap/status？
5. 是否按 Phase 1–3 先完成语义、实例和 Thread 数据合同，再进入前端实现？

推荐五项全部通过。它们共同解决当前 Codex/Claude 的缺失、误分类、实例混乱、跨天 Conversation 断裂和前端难读问题；只通过其中某一项会继续在其他层产生补丁式修复。
