# AnySentry Agent 全链路采集、会话归因、内核证据与查询性能修复开发计划

- 文档状态：待审核
- 编写日期：2026-09-01
- 适用仓库：`AnySentry`、`Observer`
- 当前开发分支：`feat/agent-tls-interaction-observability`
- 本文性质：现场调研结论与后续开发计划；本文提交审核前不代表功能已经实现

## 连续 Goal

在不依赖 Agent SDK、应用 Hook、固定官方域名或精确 CLI 版本的前提下，以 eBPF 捕获的 TLS/明文传输事实为统一入口，稳定还原 Codex、Claude Code、LangChain、LangGraph 及后续 Agent 在本地终端、SSH、Docker 和 Kubernetes 中的用户输入、模型过程与最终回复、工具调用与结果及其准确时间，将恢复后的同一产品会话跨进程、跨终端和跨运行实例归入一个可解释的 Conversation Thread，并通过进程代次、调用标识、内容、时间和 Trace 等分层证据把每个可观测工具动作唯一关联到既有内核事件与风险研判，最终以低延迟、可直接深链到原事件且不重复、不串线、不伪造完整性的方式呈现在对话追踪页面。

## 1. 结论

本轮八个问题不是一个 PPID 或一个模板判断错误，而是四层问题同时暴露：

1. **传输重组层**：Codex 的 Rustls WebSocket 在指针变化和同 PID 多连接并发时，当前使用“最近 WebSocket”猜测归属，可能把尾部帧归错或丢弃；纯 HTTP 流还存在同一请求的多次局部响应被当作多个 Interaction 的风险。
2. **语义分类层**：只要请求带 `input/messages + model` 就容易被当成用户对话，导致 Codex 搜索后台请求、Claude 会话标题生成请求和累计历史重放进入用户 Thread。
3. **身份与证据层**：SSH、本地终端、容器和 Pod 的启动上下文没有完全统一为“进程代次 + 物理工作负载 + 逻辑 Agent”；Tool→Kernel 关系又只在用户点开详情时按单个 Tool 临时计算，覆盖率和唯一归属都不足。
4. **查询与展示层**：Conversation 目录读取会重新投影并写回 PostgreSQL，内核 Event ID 深链会在 ClickHouse 的超大时间窗口中扫描，造成页面慢、数据库争用和已有关联却打不开原事件。

推荐采用一套通用主干加少量可插拔语义规则：

- 通用主干负责 TLS/HTTP/WebSocket 重组、请求—响应配对、消息增量、Provider 锚点、进程代次、证据仲裁和增量读模型；
- Codex、Claude 等产品规则只负责识别已在真实流量中确认的“后台派生操作”，不得决定是否采集、不得依赖域名、不得依赖版本；
- SSH、本地 Shell、Docker、Kubernetes 只影响 Runtime 启动来源与实例归因，不改变同一种 Wire Protocol 的解析算法；
- 原始 Interaction 永久保真，用户 Thread 是可重新计算的语义投影；后台请求不删除，只折叠进“技术活动”；
- WITR 分支中的原生实现可以补强进程代次、启动来源和 Tool→Kernel 仲裁，但不能替代本次传输重组与语义分类修复，应选择性吸收实现提交，而不是整分支直接合并。

## 2. 本阶段范围与成功定义

### 2.1 本阶段必须完成

- Codex：SSH 与本地终端的 Responses WebSocket/HTTP 明文链路一致，用户输入、模型过程、工具调用、工具结果和最终回复不丢失、不串线；自定义中转与官方地址使用相同算法。
- Claude Code：SSH、Docker 与本地终端的 Messages HTTP/SSE 明文链路一致；会话标题生成、重试和历史重放不再制造用户 Thread；模型最终回复不再归到工具结果。
- LangChain/LangGraph：带明确 Agent 工作负载标签的服务在启动后、第一次 LLM 调用前就成为运行中 Runtime；一次外部 Run 的多次模型调用与工具循环归入同一个 Run/Thread。
- Conversation：新启动、恢复、继续、Fork、长时间空闲、跨进程恢复和并发会话有稳定且可解释的归因结果。
- Kernel Evidence：符合条件的 Agent-side Tool 调用关联到唯一内核事实及既有风险研判；从对话可打开精确原事件，从原事件可返回原 Thread/Turn。
- 性能：目录、Thread、证据和时间切换不再触发全量重投影与无界宽窗口扫描。
- 数据安全：测试配置中的 API Key、中转 URL、Authorization/Cookie、个人路径和原始私密截图不得进入代码、Fixture、日志或提交。

### 2.2 不以“看起来完整”代替真实完整

以下情况必须显式显示 `partial`、`ambiguous` 或 `coverage_gap`，不能猜成成功：

- Observer 在 WebSocket 握手之后才 Attach，缺少压缩上下文；
- 同一 PID 存在多个可行 WebSocket 且无法唯一证明帧归属；
- 工具结果只在下一次发给 LLM 的请求中被观察到，无法证明框架内部的精确完成时刻；
- 多个 Tool 调用竞争同一个内核事实；
- 内核候选窗口本身被截断；
- Provider、消息历史和 Trace 都无法区分两个并发会话。

## 3. 现场事实、当前偏差与判断强度

### 3.1 现场版本基线

| 组件 | 当前现场 |
|---|---|
| AnySentry 源码 | 分支 `feat/agent-tls-interaction-observability`，HEAD `2180707` |
| Observer 源码 | 分支 `feat/agent-tls-interaction-observability`，HEAD `6fa8e17` |
| WITR 研究 worktree | 分支 `research/witr-attribution-evidence-chain`，实现提交 `21823e1`，审计提交 `e478acf` |
| AnySentry 现场存储 | ClickHouse 可用，PostgreSQL 可用但出现连接超时和 WAL 写竞争 |
| 现场数据规模 | ClickHouse `events` 约 2.29 亿行；`agent_interactions_v1` 约 1.55 万个 Interaction |

上述行数是 2026-09-01 调研时的瞬时事实，不是容量承诺；Interaction 中累计请求会重复携带历史 Tool ID，因此 `toolCallIds` 总数不能当作真实独立工具调用数。

### 3.2 八个问题的核对结果

| 问题 | 已确认事实 | 当前判断 |
|---|---|---|
| 1. SSH Codex 页面与真实会话不一致 | Codex 本地 JSONL 中存在正确的两轮用户消息、工具调用、Web 检索结果及最终回复；AnySentry 同时生成了两个来自 Codex `/backend-api/codex/alpha/search` 的 Interaction，这两个请求携带完整历史并被错误识别为 `openai-responses/conversation`；真实 WebSocket 最终回复未形成 Interaction | **两个独立问题**：后台搜索请求误分类已确认；最终 WebSocket 尾部丢失与当前 Rustls“最近 WebSocket”别名算法高度相关，但需并发连接故障注入确认最后因果 |
| 2. Docker Claude 两个相同内容 Event | `evt_75c4e898c31a7d4c` 是用户对话；`evt_6eb4956facc19fa1` 是 Claude 自动生成会话标题的另一次真实模型调用，模型、请求/响应 Hash 和连接均不同 | 不是 eBPF 重复采集，不能按文本去重；应把后者分类为 `derived_metadata/session_title_generation` 并折叠到技术活动 |
| 3. LangChain/LangGraph 服务未识别 | 测试入口实际是 Kubernetes Service 的 `kubectl port-forward`，不是 Docker 端口；Pod 已带 `anysentry.io/workload-kind=agent`、Agent ID、LangChain/LangGraph 标签。LLM 事件已被识别为 `confirmed_agent`，但 Runtime Snapshot 没有该 Pod，页面因此显示历史 Agent；同一次 Run 的多个模型调用被拆成多个 Thread | 采集和事件身份已经部分成功，缺口在“启动即物化 Runtime”和 Run/Session 归因，不应再硬编码某个 `service.py` 命令作为唯一入口 |
| 4. SSH Claude 多个 `<session>` 且工具/正文缺失 | 多个 `<session>…</session>` Interaction 是同一会话标题请求的重复尝试；真实用户请求和模型回复另有独立 Interaction。当前测试中一条“有哪些工具”请求本身没有执行工具，不能据此证明工具捕获失败 | 标题请求误分类与历史消息重复投影已确认；实际工具缺失需用固定 Tool fixture 复验纯 HTTP/SSE 的请求—响应版本合并 |
| 5. SSH 与本地效果不同 | 同一产品实际经过的 Transport 组合不同：Codex 可能同时有 Rustls Responses WebSocket、OpenSSL 后台 HTTP 和 MCP；Claude 中转可走纯 HTTP。当前 Parser、连接猜测、角色分类和 Runtime 归因相互耦合 | PPID 不是 Parser 差异的合理原因。SSH/TTY 只能作为启动来源证据，不能参与 Wire Parser 选择 |
| 6. 内核证据覆盖低、跳转失败 | PostgreSQL 当前仅有 23 个不同 Semantic Event 的关系，其中 13 个 Kernel Event；关系在详情点击时才生成，而不是随 Tool 事实增量生成。已有关联 Event ID 的 30 天查询实测约 25.6 秒后返回 0 条并降级到 `hot_ring_only`，但直接窄查询确认原事件仍在 ClickHouse | 覆盖率低的首要原因是“按需生成”；跳转失败的首要原因是 Event ID 查询仍绑定 30 天宽窗口，而非路由参数本身完全缺失 |
| 7. WITR 归因优化 | `21823e1` 增加进程代次键、父代次权威边、Launch Context、Conversation continuity 冲突屏障、Tool→Kernel Batch 所有权仲裁及有界索引；固定 1,501 候选微基准从约 43.3 ms 降到约 4.9 ms | 可直接弥补 SSH 启动来源、PID reuse、证据竞争与关系计算效率；不能解决 TLS 尾部丢失、标题请求角色和历史消息增量 |
| 8. 页面加载慢 | `conversation-directory-v3` 最近 3 小时现场首次请求约 15.5 秒、响应约 720 KB，并标记 `scan_limit`；读取路径会加载 Interaction、重新解析、加载多组 PostgreSQL 绑定，之后又把投影写回 PostgreSQL；页面每 10 秒轮询 | 根因是读时计算和读时写入，而不是只缺一个前端缓存；必须改为增量物化读模型，再做前端请求取消、分页和缓存 |

## 4. 统一领域模型

### 4.1 名词在本项目中的职责

| 对象 | 当前语境含义 | 新建条件 | 结束条件 |
|---|---|---|---|
| Logical Agent | 用户认知中的产品/服务，例如 Codex、Claude Code、某个 LangGraph Agent | 稳定 Agent 身份首次出现 | 不物理删除，只进入历史 |
| Runtime Instance | 一次真实运行代次；Host 进程使用 `host + boot + pid + startTime`，容器/Pod叠加 UID 与 Container ID | 新进程代次或新工作负载代次 | 进程 Exit、容器终止或租约确定过期 |
| Launch Segment | 同一 Conversation 在某个 Runtime Instance 中执行的一段 | Conversation 切入新 Runtime | 离开该 Runtime 或 Runtime 结束 |
| Conversation Thread | 用户可恢复、可继续的同一产品会话 | Provider Session/Conversation 新 ID，或没有连续证据的新历史根 | 不因空闲或进程退出自动结束；Fork 创建新 Thread |
| Run / Invocation | 工作流服务的一次外部调用或 CLI 一次任务执行 | `run_id/invocation_id/trace_id` 或明确入口事件出现 | 完成、失败、取消 |
| Turn | 一次新增用户输入及其后续模型—工具循环，直到模型最终回复 | 新的 Human 消息增量 | 最终模型回复、错误或明确中断 |
| Wire Interaction | 一次物理请求—响应交换 | 请求边界形成 | 响应终态、错误或明确 Partial |
| Semantic Event | 用户、模型或工具视角的一条增量事件 | 从不可变 Interaction 投影 | 不单独续期 |
| Kernel Fact | 既有 eBPF/内核事实与风险研判 | 内核采集产生 | 不因 Conversation 重算而改变 |

关键约束：**Runtime Instance 不是 Conversation Thread**。退出 Codex 后恢复同一 Provider/历史会话，会产生新 Runtime Instance 和新 Launch Segment，但仍属于原 Thread；重新执行 `codex` 且没有 Resume 连续证据，则是同一 Logical Agent 下的新 Thread。

OpenAI Responses API 明确定义 `previous_response_id` 用于创建多轮会话；`conversation.id` 也可把 Response 附着到同一 Conversation。因此它们是高于 Runtime、PPID 和空闲时间的 Provider 证据。[OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

Claude Code 官方说明 Session 与项目目录绑定，`--resume` 在同一 Session ID 上继续，`--fork-session` 才复制历史并创建新 Session；这支持“Resume 跨进程仍是同一 Thread、Fork 是新 Thread”的产品语义。[Claude Code Session 文档](https://code.claude.com/docs/en/sessions)

### 4.2 完整目标链路

```text
身份面
Kubernetes/Docker labels + process exec + /proc startTime
              │
              ▼
Logical Agent ── Runtime Instance ── Launch Segment
                                  │
传输面                            │
TLS/plain chunk ── Physical Stream ── Wire Interaction
       │                 │                  │
       │                 └─ request/response/terminal/revision
       └─ 不识别域名、不识别 CLI 版本
                                            │
语义面                                      ▼
Operation Role ── Provider Anchors ── Conversation Thread
                                            │
                                 Turn ── User / Model / Tool
                                            │
证据面                                      ▼
Tool Invocation ── Process Generation ── Kernel Fact ── Existing Judgment
                                            │
展示面                                      ▼
Agent 目录 ── Thread 时间线 ── 事件检查器 ── 原始内核事件 / Evidence Bundle
```

这与 OpenTelemetry GenAI 约定的方向一致：Conversation ID 用于关联同一会话，输入消息本身包含历史，Tool Call 与 Tool Result 是独立语义部分；Inference Operation 的时段应从发起持续到响应完整结束。[OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)

## 5. 方案一：传输重组与 Operation Role 修复

### 5.1 Rustls WebSocket 连接归因

Observer 当前以 `(cgroup, pid, TLS 对象指针)` 建 Connection State。Rustls 的读写边界可能暴露不同或移动的内部指针，所以代码会在同 PID 内选择“最近活跃 WebSocket”；当 Codex 同时运行模型 WebSocket、搜索 HTTP 和其他连接时，最近者不一定是正确者。

有两个可行方向：

| 方向 | 做法 | 收益 | 代价与风险 |
|---|---|---|---|
| A. 用户态证据驱动 Stream Binding（推荐） | 保留现有 eBPF ABI；先按已证明的 Pointer Alias、Fragment Owner、握手、方向、Pending Request 和 Response 生命周期筛选；完整未压缩帧可再用 JSON 事件与 `response.id` 证明归属；只有唯一候选才绑定 | 改动集中在 Collector；不依赖版本、URL 或 Rustls 内存结构；直接面向当前 Codex 暴露的症状 | 压缩帧多候选时不能破坏性试解，必须有界等待或标记歧义，不能再按“最近”硬选 |
| B. 增加内核 Socket/FD 关联 | 尝试从 Rustls 对象或同线程网络事件补充 Socket Cookie/FD，扩展 Plaintext ABI | 如果能够可靠获得 Socket，可形成物理精确键 | Rustls 加密函数通常不直接持有 FD；需要跨事件关联和 ABI 迁移，维护成本高，且仍受运行时内部结构变化影响 |

第一阶段实施 A。只有在 Codex/Claude 并发连接矩阵中，A 的唯一绑定率无法达到验收标准时，才进入 B 的独立设计审核，不在本阶段默认扩展 eBPF ABI。

当前 Decoder 内的 `flate2::Decompress` 不是可直接 Clone 的状态，因此“同时在多个候选上试解压”不是现成能力。本阶段先使用非破坏性的状态证据和有界等待；若压缩多候选仍构成主要缺口，再单独比较“保留有限压缩历史并重放”与“引入可快照 Inflater Adapter”两种实现。后者若需要新增直接依赖，必须先说明必要性、内存上限和兼容风险，不能静默引入。

推荐状态机：

```text
Observed Pointer
      │
      ├─ 已有 Alias ────────────────────────────────► Canonical Stream
      │
      └─ 未知 Pointer
           │
           ├─ HTTP Upgrade/101 唯一配对 ───────────► 新 Canonical Stream
           │
           ├─ 完整 WS 帧：对候选 Decoder 试解
           │       ├─ 唯一合法 + Response 生命周期匹配 ─► 绑定 Alias
           │       ├─ 多个合法 ─► 有界等待后标记 ambiguous
           │       └─ 均不合法 ─► transport gap
           │
           └─ Continuation：只允许跟随已证明 Alias/Fragment State
```

必须新增以下不变量测试：

- 同 PID 两条同时 Pending 的 Responses WebSocket，响应交错时不得按最近时间串线；
- Rustls 指针每个 Fragment 都变化时，Request、Delta、Tool Call 和 Terminal 仍归入同一交换；
- `permessage-deflate` 有/无 context takeover、帧拆分、Control Frame 插入均可复原；
- 缺少握手且压缩字典不可恢复时只发覆盖缺口，不输出伪造正文；
- `response.completed/failed/incomplete/cancelled/error` 才能关闭一次 Responses 交换。

### 5.2 请求—响应版本合并

纯 HTTP syscall 或流式中转可能对同一个请求生成多个局部响应。引入稳定 `exchangeKey`：

```text
processGenerationKey
  + canonicalPhysicalStreamKey
  + requestOrdinalWithinStream
  + requestSha256
```

同一 `exchangeKey` 的后续结果作为 `exchangeRevision` 合并：

- 请求正文只保存一份；
- 响应由 `partial → terminal` 单向推进；
- 新 Revision 只能补充内容、Tool Call、Usage、终态和 Partial Reason，不能删除已经确认的证据；
- `interactionId` 稳定，`revision` 递增，ClickHouse 使用最新 Revision；
- 两个真实不同连接、不同请求时间或不同请求 Hash 不得因文本相似被合并。

### 5.3 Wire Template 与 Operation Role 解耦

当前 `input + model` 足以命中 `openai-responses`，但这只能说明 Wire Shape 类似 Responses，不能证明它是终端用户对话。改为两步：

1. `wireTemplate` 回答“怎样解析字段”；
2. `operationRole` 回答“这次交换在 Agent 中是什么作用”。

建议角色：

| Role | 是否进入用户 Thread | 示例 |
|---|---:|---|
| `conversation` | 是 | 用户输入、工具循环、模型最终回复 |
| `context_replay` | 作为连续证据，不重复显示 | 累计历史重发 |
| `tool_backend` | 否，进入技术活动 | Codex 搜索后端、Provider 托管工具 |
| `derived_metadata` | 否，进入技术活动 | Claude 会话标题、摘要/标签生成 |
| `bootstrap` | 否，折叠 | 启动指令、能力协商、模型预热 |
| `control` | 否，折叠 | MCP initialize、tools/list、ping |
| `retry` | 不新增 Turn，挂在原调用诊断 | 相同请求的失败重试 |
| `unclassified` | 否，保留原始证据和诊断 | 证据不足 |

分类证据按优先级执行：

```text
显式协议语义/Provider ID
  > 请求与终态响应的组合形状
  > 消息增量、Tool Call/Result、输出类型
  > 已验证的产品语义规则
  > 路径/Host（只能加分或解释，不能作为采集门槛）
```

具体修复：

- Codex `/alpha/search`：请求具有 `commands/settings` 等后台操作形状，响应具有搜索 `results/encrypted_output`，既不是 HTTP Responses 终态对象（Provider Response ID、`object=response`、状态），也不是 WebSocket `response.completed` 终态事件；分类为 `tool_backend`。路径只作为佐证，不作为唯一规则。
- Claude 标题生成：单次任务要求从 `<session>` 内容生成短标题，响应是标题 JSON；分类为 `derived_metadata/session_title_generation`。原始模型调用和 Token 使用保留，但不生成 Human Turn。
- 不按“中转 URL 是否官方”拒绝解析；任何 Host 只要满足同一 Wire/终态契约都走相同 Parser。
- 规则输出 `ruleId/ruleVersion/evidence[]/confidence`，允许后续新增 Kimi CLI 规则而不改传输主干。

## 6. 方案二：消息增量、最终回复与 Conversation 归因

### 6.1 原始历史与本轮增量分离

Chat/Responses/Messages 请求经常重发完整历史。原始 Interaction 必须保留完整请求，但 Timeline 只显示本轮新增语义：

```text
上一请求消息链： [U1, A1, T1]
当前请求消息链： [U1, A1, T1, U2]
本轮新增用户事件：              [U2]

上一请求消息链： [U1, A1, ToolCall1]
当前请求消息链： [U1, A1, ToolCall1, ToolResult1]
本轮新增工具结果：                          [ToolResult1]
```

增量算法：

1. 优先用 `message.id/turn_id/tool_call_id` 求公共前缀；
2. 缺 ID 时对规范化后的 `role + content + tool identity` 求 Hash 前缀；
3. 前缀只在已通过 Provider Anchor、Tool Call 或唯一历史证据连接的 Interaction 之间比较；
4. 公共前缀标记 `context_replay`，只在“恢复上下文”摘要中展示数量，不重复生成用户事件；
5. 当前请求的后缀才生成 User 或 Tool Result；
6. 当前响应中的 Assistant Text 独立生成 Model Event，不能因同一次请求包含 Tool Result 就归到 Tool；
7. 响应同时有说明文字和新 Tool Call 时，文字为 `model_progress`；终态响应中无未完成 Tool Call 的 Assistant Text 为 `model_final`。

Tool 完整性不能再用“有任意 Tool Call 且没有任意 Tool Result”判断。应按 Call ID 做集合差：

```text
pendingCallIds = response.toolCallIds - allObservedToolResultIds
```

只有 `pendingCallIds` 非空才是 `tool_pending`。一个请求中携带旧 Tool Result，同时模型又发出新 Tool Call，仍应正确标记新 Call Pending。

### 6.2 Thread 归因证据阶梯

| 等级 | 证据 | 归因结果 |
|---|---|---|
| Exact | Provider Conversation/Session ID；`previous_response_id → response.id`；稳定 message/turn ID；现有可信 `session_id` | 直接归入同一 Thread |
| Strong | Tool Call ID 跨 Interaction 闭环；完整消息历史严格前缀；可信 Trace/Run 与唯一 Thread 相交 | 归入同一 Thread 并记录证据 |
| Supporting | 同 Logical Agent、workspace、host、Runtime/Launch Segment、SSH/TTY、相近时间 | 只能缩小候选，不能单独合并 |
| Conflict | 不同显式 Provider Session；两个不相容 Human 历史；同一 continuity key 被不同任务复用 | 禁止合并，输出冲突诊断 |
| Unknown | 候选仍多于一个 | 保留未归因 Segment，不按最近 Thread 硬合并 |

OpenAI 的 `prompt_cache_key` 是缓存键，不等于 Conversation ID，不能单独跨不相容 Human 历史强制合并；WITR 分支的 `continuity_collision_without_shared_history` 屏障正适合补上这一点。

对于 Claude：官方 Session ID 是最理想的产品身份，但 TLS 请求未必携带该 ID。此时用稳定消息历史、Tool Call 闭环和项目范围恢复；本地 JSONL 只用于测试 Oracle，不作为生产采集依赖，保持 TLS-only 约束。

### 6.3 SSH 与本地一致性不变量

```text
NormalizedTimeline(
  same product + same wire payload sequence + same resume semantics
)

必须与 launchOrigin = local_shell / ssh_session / docker_exec 的取值无关。
```

- SSH/TTY、Shell、systemd、container 进入 `LaunchContext`；
- Parser 只看 TLS Family、Transport 和 Wire Shape；
- Conversation Resolver 只看 Provider/Message/Tool/Trace 连续证据；
- Runtime Resolver 使用进程代次与工作负载；
- PPID 只用于构建带代次验证的父边，不能直接当 Conversation ID。

Linux `/proc/<pid>/stat` 的 `starttime` 表示进程自系统启动后的开始时间，因此 `host + boot + pid + starttime` 能区分 PID 被复用后的不同进程代次。[Linux `/proc/<pid>/stat`](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)

## 7. 方案三：LangChain/LangGraph 启动发现与 Run 归因

### 7.1 当前链路偏差

```text
Pod 启动并带 Agent Label
       │
       ├─ 当前：未命中特定 argv 签名 → Runtime Snapshot 缺失
       │                                      │
       │                                      └─ 页面先看不到运行实例
       │
       └─ 首次 LLM/自注册事件 → 事件被确认 Agent → 形成历史式 Conversation 资产
```

正确链路：

```text
Kubernetes Watch / Identity Snapshot
       │ 看到 workload-kind=agent + Pod UID + Container ID
       ▼
立即物化 Logical Agent + running Runtime Instance
       │
       ├─ 后续 Exec/进程代次补充 Root PID
       └─ 后续 TLS LLM Interaction、Run/Trace、Tool 绑定到已有实例
```

Kubernetes 官方把 Label 定义为可供查询和工具自动化使用的识别属性，并明确区分应用名称与唯一实例名称；因此已存在的 Agent 标签应当是启动发现的权威输入，而不是等待某个固定命令路径命中。[Kubernetes Labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/)

### 7.2 通用身份优先级

1. 明确 `anysentry.io/workload-kind=agent` + Agent ID：确认 Agent；
2. Pod UID + Container ID：物理 Runtime Instance；
3. `agent-runtime=langchain`、`agent-orchestrator=langgraph`：Framework 集合与显示名；
4. 进程签名：补充 Root PID/产品证据，不得覆盖更权威的 Workload Label；
5. 行为发现：无标签时的候选升级路径。

Generic `uvicorn module:app` 不能全局认定为 Agent，但一个已明确标记为 Agent 的 Pod 内 PID 1/服务根进程可以继承该工作负载身份。冲突仍记录，但“泛化基础设施/普通 Python”不能把明确 Agent Label 抑制为不可见。

### 7.3 Workflow Session、Run 与模型调用

对于当前示例：

- `session_id=human-check-001` 是 Conversation Thread 锚点；
- 一次 `/runs` 返回的 `run_id/invocation_id/trace_id` 是一次 Run；
- Run 内多次 LLM 规划、重试、Tool 调用和校验属于同一 Thread 的同一 Run，不是多个用户会话；
- `force_retry_once` 产生的模型重试挂在原 Model Call/Run 下；
- 内容继续从 TLS 明文获取；现有应用已提供的 Session/Trace 只用于归因，不把 SDK/OTel 变成内容采集前提。

W3C Trace Context 规定 `traceparent` 用统一 Trace ID/Parent ID 连接分布式请求；当现有服务已经传播它时，应作为强关联证据，但没有 Trace 时系统仍必须通过 TLS 与进程证据工作。[W3C Trace Context](https://www.w3.org/TR/trace-context/)

## 8. 内核证据关系与 WITR 选择性吸收

### 8.1 WITR 实现可直接吸收的部分

计划从 `21823e1` 选择性吸收以下原生 AnySentry 代码：

- `processGenerationKey`、`parentProcessGenerationKey`、`parentLinkAuthority`；
- Forwarder 父代次边与 ClickHouse lifecycle nullable 字段；
- `AgentLaunchContext`：systemd、SSH、Shell、supervisor、cron、container；
- Conversation continuity + Human History 冲突屏障；
- `buildSemanticKernelRelationBatch` 与 Kernel Event 单一 Owner 仲裁；
- generation/indexed ancestry，保留历史数据的低置信 legacy PID fallback；
- 有界 PID/port/file/name/container Repair 工具和对应验证脚本。

合并策略：

1. 不直接 Merge `research/witr-attribution-evidence-chain`，避免把研究报告、资产和已被当前分支独立实现的提交再次带入；
2. 以 `21823e1` 为代码来源做 Cherry-pick/逐文件移植；
3. 保留当前分支已完成的用量展示、历史折叠、Timeline V3 与运行时制品变更；
4. 对 `types.ts`、Conversation Resolver 和 Semantic Relation 做人工语义合并；
5. WITR 的研究报告与生成资产不进入本功能提交，提交信息中记录来源 Commit 即可。

静态 Merge 审查显示，实现代码与当前分支整体可合并，整分支层面的主要冲突在既有 V4 设计文档；这进一步支持“移植实现提交、不合并研究文档”的策略。

### 8.2 WITR 之外仍需补齐的关系机制

WITR 的 Batch Resolver 当前仍由详情查询触发。本阶段应把它改为 Interaction/Conversation 增量投影后的关系任务，复用现有进程，不新增微服务或外部消息队列：

```text
Tool Semantic Event durable
       │
       ├─ 精确索引候选：trace/span/invocation/toolCall/process generation
       ├─ 内容候选：commandHash/resourceHash/network host
       └─ 时间候选：[issuedAt-skew, observedResultAt+skew]
                         │
                         ▼
                  Batch Ownership Arbitration
                         │
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
 linked_exact      linked_strong       ambiguous / gap
        │                │                 │
        └────────持久化 Relation + Resolution Revision────┘
```

关系优先级：

1. 相同可信 Trace/Span/Invocation/Tool Call ID；
2. 相同 Runtime 与精确 Process Generation/Parent Generation；
3. Tool 类型与 Kernel Kind 相容；
4. Command/Resource/Host 规范化 Hash 相同；
5. Kernel 时间位于 Tool 区间；
6. 一个 Kernel Event 只能有一个 Exact/Strong Semantic Owner；竞争时所有候选变成 `ambiguous`，不得传播风险。

Tool 结果时间需要区分：

- `frameworkCompletedAt`：只有独立 Pipe/MCP/Tool Transport 或进程 Exit 证据时才是精确时间；
- `observedBackAtLlmAt`：结果在下一次 LLM 请求中被观察到，是完成时间上界；
- `kernelStartedAt/kernelEndedAt`：来自 ToolExec/ProcessExit 等内核事实；
- 页面根据 `timeQuality` 显示“精确”或“最晚在此时已完成”。

### 8.3 Event 深链

Relation 增加 `kernelEventAtMs`、`kernelEventKind`、`decisionRevision`。对话页跳转时携带：

```text
eventId
+ custom start/end = kernelEventAt ± 小窗口
+ snapshotAsOf
+ conversationId / semanticEventId（返回路径）
```

通用 Event ID 入口再增加一个窄 `event_locator_v1`：仅保存 `eventId → at + latest decision revision`，按 `eventId` 排序。先定位时间，再用 `at + eventId` 读取宽事件；不再用 30 天范围扫描 2.29 亿行。

当前 ClickHouse 主表按时间排序，官方说明物理 `ORDER BY` 决定主索引和可跳过范围；仅按不相关高基数字段搜索会更慢，Bloom Skip Index 也不能代替匹配查询模式的排序键。因此 Event Locator 比继续扩大超时更符合当前数据模型。[ClickHouse 查询优化说明](https://clickhouse.com/resources/engineering/clickhouse-query-optimisation-definitive-guide)

## 9. 查询与页面加载优化

### 9.1 停止读时写入

当前 `conversation-directory-v3` 的一次读取大致执行：

```text
读取最多 2,000 Interaction
  → 多轮 PostgreSQL Binding/Anchor/Thread/Segment 查询
  → 全量 Conversation Resolver
  → 生成 Directory/Usage/Technical Activity
  → 再次 UPSERT Thread/Segment/Binding/Membership/Anchor/Alias
  → 返回约 720 KB
```

修复为：

```text
Interaction 写入/Revision 更新
  → 增量语义分类与 Conversation Resolution
  → 仅变化时写 Membership/Thread Summary/Usage Revision
  → 增量 Tool→Kernel Relation

页面读取
  → 只读 Directory Summary
  → 选择 Thread 后按 Membership 读取该 Timeline
  → 选择 Tool 后按已持久化 Relation 读取 Evidence
```

读取接口不得再调用 `persistProjection`。UPSERT 前比较 `projectionFingerprint`，正文、成员和 Revision 无变化时 `DO NOTHING`，避免每 10 秒轮询产生 WAL、死元组和 Autovacuum 压力。

### 9.2 读模型与接口

| 接口 | 返回内容 | 优化 |
|---|---|---|
| Directory V4 | Logical Agent 薄摘要、运行/历史计数、最近实例、最近 Thread 摘要 | Cursor 分页；默认每 Agent 只带最近 3 个 Thread；正文与 Technical Activity 不内联 |
| Instance list | 一个 Agent 的运行实例与 Launch Context 摘要 | 展开时懒加载；按状态与 `lastSeenAt` 索引 |
| Thread list | 指定 Agent/Instance 的 Thread 摘要 | Cursor + `resolutionRevision`；历史单独加载 |
| Timeline V4 | 指定 Canonical Conversation 的 Turns/Events | 直接使用持久 Membership 与时间边界，不再全局投影 |
| Evidence | 已持久化 Semantic→Kernel Relation 和窄时间事件 | 无 Relation 时才执行一次有界 Repair，并异步持久化 |
| Event locator | Event ID 的精确时间与 Revision | 小列、Event ID 排序、短超时 |

目录和 Timeline 返回 `dataRevision` 与 `ETag`。前端轮询传 `sinceRevision`；没有变化时返回轻量 Not Modified/空 Delta，而不是重复 720 KB。

### 9.3 前端并发与时间切换

- 每次 Agent、Instance、Thread、时间范围变化都生成统一 `selectionKey`；Directory、Timeline、Interaction 和 Evidence 都校验同一个 Key；
- 取消旧 AbortSignal，旧响应即使晚到也不得覆盖新选择；
- 切换 Thread 时立即清空旧正文并显示 Skeleton，不能显示旧 Thread 配新标题；
- Timeline 使用按 `conversationId + snapshot + resolutionRevision` 的短期缓存，返回键一致时可即时恢复；
- 用户手动调整时间后，Directory、Timeline、Evidence 使用同一个 `snapshotAsOf`；
- 实时跟随只增量追加新 Revision，不重建所有历史；
- 内核跳转带精确 Event 时间，返回浏览器历史后恢复原 Thread/Turn/滚动位置。

### 9.4 性能目标

以下以当前约 2.29 亿 Event、1.55 万 Interaction 的测试环境为基线：

| 路径 | 目标 |
|---|---:|
| Directory 首屏 | P50 ≤ 500 ms，P95 ≤ 1 s，压缩前 Payload ≤ 200 KB |
| Agent 的 Thread 分页 | P95 ≤ 700 ms |
| Thread Timeline | P95 ≤ 1 s |
| Tool Evidence | 已持久化关系 P95 ≤ 800 ms；一次 Repair P95 ≤ 2 s |
| Event ID 深链 | P95 ≤ 1 s，100% 定位仍在 TTL 内的已关联事件 |
| 前端切换反馈 | 100 ms 内进入新选择 Loading 状态；旧正文不闪回 |
| 后台轮询 | 无变化时不执行 Conversation 全量 Resolver，不写 PostgreSQL |

## 10. 数据契约调整

### 10.1 Interaction 增量字段

| 字段 | 作用 |
|---|---|
| `physicalStreamKey` | Canonical Stream，不直接暴露不稳定 Rustls 指针 |
| `streamBindingQuality` | `exact/strong/ambiguous/unbound` |
| `exchangeRevision` / `terminalState` | 合并流式/局部响应，表达最终状态 |
| `operationRole` | 用户对话、后台工具、派生元数据、控制等 |
| `operationRoleEvidence[]` | Rule ID、响应终态、形状与置信度 |
| `messageLineage[]` | 稳定 Item ID 或规范化 Content Hash，不保存额外正文副本 |
| `pendingToolCallIds[]` | 按 Call ID 集合计算 |

原 `trafficRole` 在迁移期保留为兼容字段，由 `operationRole` 投影；旧数据可重算，不改原始 request/response Hash。

### 10.2 Runtime 与关系字段

WITR 提供的 `processGenerationKey`、`parentProcessGenerationKey`、`parentLinkAuthority` 和 `launchContext` 采用 nullable/additive 迁移；历史数据没有代次证据时只能进入低置信兼容路径。

`AgentSemanticKernelRelation` 追加：

- `kernelEventAtMs`、`kernelEventKind`；
- `lineageMethod`；
- `competingToolInvocationIds[]`；
- `timeQuality` 与 Tool/Kernel 时间边界；
- `relationVersion` 与 `resolutionRevision`。

### 10.3 隐私边界

- Authorization、Cookie、API Key 和 Proxy Credential 继续在 Collector 边界剔除；
- 测试 Fixture 使用脱敏 Host、Model、路径和 Token；
- SSH Launch Context 只允许 `SSH_CONNECTION/SSH_CLIENT/SSH_TTY/TMUX/STY` 白名单，不读取完整 Environment；
- Conversation 正文沿用已有平台访问权限与审计，不复制进日志或关系表；
- 本地 Codex/Claude JSONL 仅用作人工验收 Oracle，不作为采集来源、不提交。

## 11. 开发阶段与改动范围

### Phase 0：冻结现场与回归 Fixture

目标：先把本次真实偏差固化为可重复测试，不再靠截图判断。

- 从 Codex SSH Native Transcript 与已采集 Interaction 生成脱敏事件序列；
- 固化“Responses WebSocket + 同 PID 后台 search HTTP + 工具 + 最终回复”Fixture；
- 固化 Claude 用户调用、标题生成调用、标题重试、累计历史和真实 Tool Use Fixture；
- 固化 LangGraph 一个 Session、一个 Run、多次模型调用、一次 Retry、一次 Sandbox Tool Fixture；
- 记录每条期望 Semantic Event 的 Actor、Kind、顺序、Call ID、时间质量和应否进入用户 Thread；
- 增加 Collector reassembly counters、Operation Role counters、Conversation conflict counters、Relation coverage/ambiguity counters 和查询时延/字节指标。

### Phase 1：Observer 传输重组与角色分类

主要文件：

- `Observer/a3s-observer-collector/src/interaction.rs`
- 必要时 `Observer/a3s-observer-common/src/lib.rs`
- 本阶段默认不修改 `a3s-observer-ebpf` ABI

交付：

- 证据驱动 WebSocket Stream Binding，去掉多候选场景的“最近连接即正确”；
- 同请求多 Revision 合并；
- Responses/Anthropic 终态状态机；
- Wire Template 与 Operation Role 分层；
- Codex Search、Claude Title 的已验证语义规则；
- 按 Call ID 的 Conversation Completeness；
- 并发、分片、压缩、移动指针和 Partial 测试。

### Phase 2：AnySentry Conversation 与 Semantic Delta

主要文件：

- `apps/api/src/security-monitoring/agent-interaction.ts`
- `apps/api/src/security-monitoring/agent-conversation-resolution-v2.ts`
- `apps/api/src/security-monitoring/agent-conversation.ts`
- `apps/api/src/security-monitoring/agent-semantic-timeline.ts`
- `apps/api/src/security-monitoring/agent-conversation-binding.service.ts`
- `apps/api/src/security-monitoring/types.ts`

交付：

- Operation Role V2 兼容解析；
- 跨 Interaction 消息公共前缀与新增后缀算法；
- 模型 Final 与 Tool Result 独立投影；
- Provider/History/Tool/Trace 证据阶梯；
- Resume 跨 Runtime 保持 Thread，Fork/新历史根创建新 Thread；
- WITR continuity collision 屏障；
- 对旧错误绑定生成 Route Alias/Resolution Revision，而非破坏旧 URL。

### Phase 3：WITR 证据链与增量关系

主要文件来自 `21823e1`，重点为：

- `agent-semantic-kernel-relation.ts`
- `process-lifecycle.ts`
- `agent-runtime-state.service.ts`
- `aggregation.service.ts`
- `clickhouse-store.ts`
- Observer Forwarder attribution/launch-context 脚本

交付：

- 进程代次和父代次权威边；
- SSH/systemd/shell/container Launch Context；
- Batch 单一 Owner 仲裁；
- 关系从按需改为增量持久化；
- 时间质量和反向 Kernel→Conversation 索引；
- Relation V2 Shadow 对比与历史低置信兼容。

### Phase 4：Label-first Runtime 与 Workflow 归因

- Kubernetes/Docker Agent Label 在 Snapshot 阶段直接物化 Runtime；
- 通用 Framework Set：`langchain`、`langgraph` 可同时存在，显示名不再由固定 argv 决定；
- Pod UID/Container ID 与 Root Process Generation 合并；
- Session/Run/Trace/Invocation 的层级投影；
- 修复“Pod 正在运行但 Conversation 目录显示历史”的状态连接。

### Phase 5：读模型、Event Locator 与前端

- Conversation 解析移出 Read Path；
- Directory/Thread/Timeline V4 薄接口与 Cursor；
- PostgreSQL Projection Fingerprint/no-op write；
- ClickHouse `event_locator_v1` 与窄 Event 查询；
- 全链路统一 Selection Key、Abort、缓存、增量轮询；
- 精确内核 Event 深链及返回 Thread 链接；
- 性能压测、数据库等待与 Payload 指标验收。

### Phase 6：现场发布与人工验收

1. Observer Shadow：新旧 Stream Binding/Role 同时计算，只输出差异指标；
2. AnySentry Shadow：Conversation Resolver/Relation V2 不替换旧 UI，比较 Thread 数、重复数和关系冲突；
3. 灰度启用 Codex/Claude 新投影；
4. LangGraph Label-first Runtime 启用；
5. V4 API 与页面切换；
6. 固化脱敏 ACL Suite，最后再清理兼容路径。

## 12. 测试矩阵与验收标准

### 12.1 产品与运行环境矩阵

| 产品 | 本地 Shell | SSH | Docker Exec | Kubernetes Service | Fresh | Resume | Tool |
|---|---:|---:|---:|---:|---:|---:|---|
| Codex | 必测 | 必测 | 必测 | 可选 | 必测 | 必测 | bash、read/write、web、MCP/skill |
| Claude Code | 必测 | 必测 | 必测 | 可选 | 必测 | 必测 | bash、read/write、MCP |
| LangChain/LangGraph | 进程模式 | SSH 启动服务 | 必测 | 必测 | Run | Session 续接 | HTTP sandbox/tool |
| Pi/Kimi CLI | 回归 | 回归/后续扩展 | 回归 | 可选 | 回归 | 回归 | 通用 Tool |

Transport 必须覆盖 Rustls WebSocket、OpenSSL HTTP/SSE、Plain HTTP relay；Endpoint 覆盖官方形状 Fixture 和自定义中转，不允许按 Host 做通过/拒绝分支。

### 12.2 精确功能验收

#### Codex SSH

- 人工输入按原顺序各出现一次；
- 模型过程、Tool Call、Tool Result、最终回复均存在；
- `/alpha/search` 原始 Interaction 仍可审计，但不产生用户消息或新 Thread；
- 两条并发 WebSocket 不串响应；
- 页面内容与 Native Transcript 的规范化事件序列一致；
- 本地与 SSH 对同一 Fixture 的规范化 Timeline 完全一致，只有 Launch Context 不同。

#### Claude

- 用户对话与标题生成是两个真实 Interaction，但只产生一个用户 Thread；
- 标题生成及重试折叠在一次 Technical Activity；
- 累计历史中的旧 User/Assistant/Tool 不重复；
- Tool Result 之后的 Assistant Text 显示为模型最终回复；
- Resume 继续原 Thread，Fork 进入新 Thread；
- Docker、本地、SSH 的规范化结果一致。

#### LangGraph

- Pod/容器启动后 15 秒内显示 running Runtime，不等待第一次 LLM 调用；
- 一个 `session_id` 只形成一个 Thread；
- 一个 `run_id` 下多次规划、重试、工具与核验作为一个 Run 展示；
- Runtime 正在运行时不显示 historical；
- TLS 明文仍是请求/回复正文来源。

#### Kernel Evidence

- 对“本地 Agent-side Tool 且内核窗口完整”的 eligible 调用，Exact/Strong 关联率 ≥ 95%；
- 已知错误 Exact 关联为 0；同一 Kernel Event 多 Owner 时必须 `ambiguous`；
- Provider-side 托管工具或无本地执行事实标记 `not_applicable/semantic_only`，不纳入覆盖率分母；
- 100% 已关联且 TTL 内的 Kernel Event 可从对话精确打开；
- 原事件页可返回相同 Conversation/Turn/Semantic Event；
- 风险分数和结论来自原 Kernel Judgment，不根据工具文字重算。

### 12.3 性能与稳定性验收

- 使用生产量级快照重复测试第 9.4 节 SLO；
- Directory 连续轮询 30 分钟，无变化时 PostgreSQL Conversation 表更新行数应为 0；
- PostgreSQL 不出现由 Conversation 读取触发的连接获取超时或持续 WALWrite 堵塞；
- ClickHouse Event ID 查询不再以 30 天宽窗口作为必经路径；
- 页面快速切换 30 次 Thread，最终标题、Timeline、Inspector 和 URL 始终一致；
- Observer 在最大并发 Fixture 下无无界 Buffer、无 Panic、无敏感 Header 输出。

## 13. 风险、未知项与停止条件

| 风险/未知项 | 处理 |
|---|---|
| Rustls 多连接在纯用户态仍无法唯一绑定 | 输出 Ambiguous 指标；若验收不达标，停止扩大规则，单独审核 Socket/FD ABI 方案 |
| Claude 中转返回非标准 SSE/无终态 | 保留 Partial Revision；为真实 Shape 增加模板，不按 Host 特判 |
| 历史错误 Conversation 已被持久化 | 使用 Resolution Revision + Route Alias 修复，不原地删除审计事实 |
| Label 把整个多进程 Pod 都视为同一个 Agent | Workload 身份与 Process Root 分轴；Pod 是物理边界，具体 Agent Root 仍按进程代次区分 |
| 增量投影失败导致目录落后 | Raw Interaction 已持久化；记录 Projection Lag，可重放修复，不回退读时全量写入 |
| Event Locator 增加存储 | 只存窄字段并跟随 Event TTL；先测压缩与写放大 |
| 更严格仲裁使 linked 数量下降 | 这是正确性提升；区分 `ambiguous/coverage_gap/not_applicable`，不能以降低阈值换表面覆盖率 |

出现以下情况应暂停实现并重新审核：

- 需要读取/提交用户 API Key、中转配置或 Native Transcript 才能让生产链路工作；
- 需要用 URL allowlist 或 CLI 版本号作为采集前提；
- 用户态 Stream Binding 无法达到目标且必须扩展 eBPF ABI；
- 增量 Conversation Projection 与现有审计/回放模型存在不可兼容的数据迁移；
- Event Locator 对当前 ClickHouse 写入吞吐造成不可接受的回归。

## 14. 推荐审核结论

建议按 Phase 0→6 连续实施，架构选择为“用户态证据驱动 Stream Binding + Operation Role 分层 + Provider/消息增量 Conversation Resolver + WITR 进程代次与 Batch Evidence + 增量物化读模型”。该方案不把任何单一 Agent、版本、域名、SSH PPID 或固定命令路径当成系统前提，同时能针对本轮已经观察到的 Codex Search、Claude Title 和 LangGraph Label 缺口增加可测试的专门规则；审核通过后先完成真实 Fixture 和 Shadow 指标，再修改生产输出，最后才切换 V4 页面与性能路径。
