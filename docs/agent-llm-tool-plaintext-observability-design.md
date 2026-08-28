# AnySentry 智能体 LLM 与工具明文观测设计

> 状态：历史调研与多方案比较；其中 Hook/Gateway 建议未进入当前实现范围
>
> 快照：2026-08-27 的历史调研；当前实现与集成基线以配套 PRD 和技术设计为准
> 目标读者：AnySentry/Observer 架构评审者与后续实现者
>
> 当前已审核并实现的 Passive HTTP/TLS V1 以
> [PRD](./anysentry-agent-llm-interaction-observability-prd.md) 和
> [技术设计](./anysentry-agent-llm-interaction-observability-technical-design.md) 为准。本报告保留为方案来源，
> 不应再用来判断本期支持矩阵或已实现状态。

## 结论与建议

AnySentry/Observer 已经具备四项可以复用的基础：Agent Candidate/Confirmed 身份与资产聚合、Observer 内核事件的精确发生时间、`invocationId/toolCallId` 可信关联，以及 AgentTool start/end 与内核事实的严格链接。[E005][E011][E012][E014][E015][E036] 当前缺口不是“再加几种日志”即可补齐，而是 LLM/Tool 内容从采集、协议重组、调用配对、身份归因、敏感内容存储到 UI 展示尚未形成一条完整数据链。

不建议把用户提供的 KCD 图片方案直接实现为“一个 OpenSSL `SSL_read/SSL_write` 探针解决全部 Agent”。当前 Observer 的 `SslContent` 每次最多截取 1024 字节，没有连接、HTTP 请求、模型调用或片段序号；Collector 只在单片内容上做字符串搜索，AnySentry 入库时又把通用 `SslContent` 限制到约 1000 字符、`rawPreview` 限制到 1800 字符。[E001][E003][E004][E008] 本机 Codex `0.150.1` 是 stripped static PIE，本机 Claude Code `2.1.170` 是包含 BoringSSL 痕迹的 Bun 可执行文件，当前固定挂载系统 `libssl.so.3` 的实现没有证据能覆盖二者。[E002][E018][E019]

推荐采用三源混合架构：

1. **语义源作为主关联。** Codex/Claude Code Hooks、原生 OTel、Dify OpsTrace/运行回调提供 Session、Turn、ModelCall、ToolCall、输入、结果与准确生命周期。
2. **协议网关补齐完整正文。** 对无法从稳定语义接口取得完整 LLM body 的客户端，使用显式的 Responses/Anthropic Messages 兼容网关；MCP stdio 使用字节透明的 JSON-RPC relay，HTTP MCP 使用协议网关或 OTel MCP 插桩。
3. **Observer 保持独立事实面。** eBPF 继续证明进程、文件、网络和子进程实际发生了什么；升级后的 TLS 捕获作为零改造 fallback、覆盖校验和未知 Agent 发现源，而不是唯一语义权威。

这一选择与工业实践的方向一致。阿里云 AgentLoop 把“AI 应用会话日志”和“节点 Runtime/eBPF”设计成可同时启用的两条链：前者提供 Session、Turn、模型请求/响应和工具调用/结果，后者发现未管理 Agent 与未上报副作用。[AgentLoop 审计接入指南](https://help.aliyun.com/zh/document_detail/3045692.html) [E022]

本报告建议先批准“统一交互契约 + 受保护内容存储 + Codex/Claude/Dify 语义适配”的第一阶段，再决定是否投入高维护成本扩展静态 TLS 二进制的版本偏移表。需要产品与安全共同确认的三个决策是：原始正文的保留周期和查看角色、Candidate 内容是否允许短期预采集、Codex 的目标认证模式是否允许经过显式网关。

## 1. 目标、术语与成功标准

### 1.1 当前语境中的 Candidate 与 Confirmed

本文沿用项目四分类，但把用户表述映射为项目真实字段：

| 用户表述 | 项目字段 | 含义 |
| --- | --- | --- |
| Candidate Agent | `probable_agent` | 多条非权威证据达成候选，仍需继续观察或人工确认 |
| Confirmed Agent | `confirmed_agent` | 可信平台、认证注册、强身份锚点或人工确认 |
| Unknown | `unknown` | 证据不足，不等于非 Agent |
| Non-Agent | `non_agent` | 稳定身份被权威事实明确排除 |

Candidate 与 Confirmed 都应进入智能体资产和 Agent 行为页面；Unknown 与 Non-Agent 的内容策略仍需遵循现有发现和抑制边界。项目当前已经把自动检测、人工审核和最终有效分类分开，且不会把后续改名或审核结果回写为历史采集事实。[E011][E038]

### 1.2 目标不是“看到一些正文”，而是每次调用可审计

一次合格的模型调用至少需要回答：

- 哪个 `agentAssetId`、哪个运行实例、哪个 Session/Invocation/Turn 发起了调用；
- 请求何时开始，正文是什么，使用了哪个 provider/model，是否重试；
- 首个响应字节何时到达，流何时结束，最终正文、工具调用块、Token、状态和错误是什么；
- 内容是否完整、是否被截断或脱敏，来源是 Hook、OTel、Gateway 还是 eBPF；
- 若该响应触发工具，具体 `toolCallId` 的工具名、参数、开始时间、结束时间、结果和错误是什么；
- 工具的语义声明与 Observer 的进程、文件、网络事实是否严格关联，还是只有 Runtime 级或推断关系。

成功标准因此是“每次有明确的配对状态和证据质量”，不是假设每次都成功采到。采不到时必须保留 `partial/unavailable/truncated/redacted` 及原因；无记录不能被解释成“没有调用”。

本文所称“LLM 返回内容”只包括 provider 实际交付给 Agent 客户端的可见 response item，例如文本、tool-use block、usage、stop reason 和错误；不声称采集 provider 内部、未下发或加密的隐藏推理。Claude 的 raw-body 规范也会遮盖 extended-thinking 内容。[E029]

### 1.3 范围

报告覆盖 Codex、Claude Code、Dify 类工作流、普通 Node/Python/Go Agent、MCP stdio 与 Streamable HTTP。报告不修改生产代码，也不把测试环境结果外推为生产完整率或性能结论。

## 2. 当前实际链路

### 2.1 从内核事实到 Agent 页面

当前主链可以压缩为：

```text
Agent / 工具子进程
        |
        | exec / exit / connect / file / TLS uprobe
        v
Observer eBPF -> Collector -> NDJSON -> AnySentry Forwarder
                                            |
                                            | 身份合并、过滤、批量接入
                                            v
AnySentry Ingest -> Sentry 判断 -> ClickHouse -> Agent/Event/Action UI
```

Observer 输出进程、cgroup、父子关系和精确事件时间。Forwarder 依次合并进程签名、工作负载快照、模板、统一规则、行为候选和 Infrastructure 事实，再决定 `confirmed_agent`、`probable_agent`、`unknown` 或 `non_agent`，最后把原始 Observer line 与归因结果发送到批量接入。[E005][E011] AnySentry 通过认证 Source 解析事件、生成可信关联、保存 ClickHouse 行并将事件物化到资产和查询视图。[E009][E012]

这一链路适合回答“某个 Agent Runtime 实际执行了什么”。但当多个逻辑 Agent 或多个 Dify workflow 共享进程/cgroup 时，内核身份只能确认共享 Runtime；项目设计文档本身也要求使用 `traceId/runId` 或应用上下文才能进一步区分 Invocation。[E038]

### 2.2 当前 LLM 观测分成两条未连接的证据

Observer 当前输出：

- `LlmCall`：TLS ClientHello 到 socket close 之间的请求/响应 wire bytes、总延迟和 TTFT 近似值；
- `SslContent`：一次 `SSL_write` 或 `SSL_read` 的 UTF-8 lossy 明文快照；
- `LlmApi`：从同一快照中尽力查找 `model`、`prompt_tokens` 和 `completion_tokens`。

三者没有共享的 `modelCallId`。`SslEvent` 没有 fd、SSL 指针、HTTP/2 stream id、HTTP 请求序号或 fragment id，因此不能可靠地把若干 `SslContent` 拼成一条 LLM 请求，也不能把它与 socket-close 时产生的 `LlmCall` 绑定。[E001][E004][E007]

部署清单确实设置了 `A3S_OBSERVER_SSL=1`，但 Collector 只是尝试把三个 uprobe 挂到一个配置路径或默认 `/usr/lib/x86_64-linux-gnu/libssl.so.3`；启用开关不等于目标进程符号匹配成功。[E002][E037] 对动态链接系统 OpenSSL 的 Python/Node 进程，这条链可能得到片段；对静态、BoringSSL、Rustls、Go TLS 或容器内不同库路径则没有统一保证。

### 2.3 当前工具链已经有可复用骨架

内核侧 `ToolExec` 和 `ProcessExit` 已经可以 bracket 一个子进程的开始与结束，并保留命令是否截断、不完整以及 exec 是否成功的证据。语义侧，Pi Adapter 会为每个工具生成 `AgentTool start/end`，携带 `invocationId` 和 `toolCallId`；AnySentry 按这两个 ID 聚合状态与耗时，并只在“同一进程+同一资源”或“直接子进程+同一命令”等强条件成立时链接内核证据。[E013][E014][E015]

Agent 资产详情已经有“Agent 行为追踪”：语义 ToolCall 是顶层行为，内核文件/进程/网络事实嵌套展示；没有 Adapter 时只回退到 Runtime 级，不伪造 ToolCall。[E036] 这恰好是新交互视图应继续沿用的产品原则。

当前 Pi Adapter 只保存工具结果的 byte size 与 hash，现有 `AgentActionItem` 也只提供目标摘要；因此“工具何时调用”已有实现，“完整指令与完整结果可查看”尚未实现。[E013][E015]

### 2.4 内容在 AnySentry 接入和存储边界被主动缩小

当前 API 的通用属性会限制键数量与字符串长度，并对 `gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.tool.call.arguments` 和 `gen_ai.tool.call.result` 一类敏感字段返回 `[redacted]`。Observer 原始行只保留 1800 字符 `rawPreview`，通用 `SslContent` 只保留约 1000 字符。[E008][E017]

这一行为对普通安全事件是合理的默认保护，但意味着不能简单要求客户端“把完整内容塞到 attributes”。ClickHouse events 表虽然有精确纳秒时间、`invocationId/toolCallId`、attributes 与 rawPreview，却没有 `modelCallId`、内容完整性、正文引用或独立访问策略。[E009]

### 2.5 当前能力与目标差距

| 目标 | 当前事实 | 主要缺口 |
| --- | --- | --- |
| 每次 LLM 请求正文 | 单次 OpenSSL write 最多 1024 字节 [E001] | 动态 attach、分片、HTTP/1/2/WebSocket 重组、完整存储 |
| 每次 LLM 响应正文 | 单次 OpenSSL read 快照 | SSE/stream 结束条件、响应合并、请求配对 |
| 模型调用时间 | 有每片 capture time；`LlmCall` 有 close latency/TTFT | 缺 request start/response complete 的统一逻辑调用 |
| 工具开始/结束 | AgentTool adapter 已支持，内核有 exec/exit | 覆盖 Codex/Claude/Dify，保存完整参数与结果 |
| Candidate 每次都可见 | `probable_investigation` 在 S5 enforce 时对 SSL 采用 SAMPLE [E010] | 第一调用竞争、采样缺口；legacy/shadow 也仍受 1024 字节和 attach 限制 |
| Confirmed 每次都可见 | `agent_full` 对 SSL 选择 FULL | FULL 只表示“每个 probe 事件不采样”，不代表协议和正文完整 |
| 页面按调用展示 | 已有 Event Raw Preview 和 Agent ActionTrace [E016][E036] | 缺 Turn/ModelCall/ToolCall 分层、正文与完整性状态 |

## 3. 为什么时间、内容和归因必须一起设计

### 3.1 时间有不同语义

“调用时间”不能只保存一个 `timestamp`。建议区分：

| 字段 | 语义 | 推荐来源 |
| --- | --- | --- |
| `startedAtUnixNs` | 一次逻辑操作开始 | OTel Span/PreToolUse/Gateway 收到完整请求 |
| `requestSentAtUnixNs` | 请求已交给传输层 | Gateway 或 TLS write 完成；可选 |
| `firstResponseAtUnixNs` | 第一个响应字节/事件到达 | Gateway、SSE/WebSocket parser、TLS first read |
| `endedAtUnixNs` | 完整响应、工具结果或终止已确定 | Span end、SSE `[DONE]`、HTTP END_STREAM、PostToolUse |
| `observedAtUnixNs` | 采集器看到事实 | eBPF/Adapter/Collector |
| `receivedAtUnixNs` | AnySentry 接入收到事件 | Ingest API |
| `persistedAtUnixNs` | 元数据/正文形成持久证据 | Interaction Store |

Observer 已经正确地区分 kernel event time 与 Collector receipt time，并使用字符串保存纳秒值，避免 JavaScript 安全整数截断。[E005] 新链路应继续这个做法，同时保存 `clockSource`、`clockDomain` 和可选 `clockUncertaintyNs`。同一主机内的持续时间优先用单调时钟计算；跨主机展示用 Unix 时间，但不得用毫秒邻近替代强关联。

### 3.2 ID 建立关系，时间只负责排序和查找

推荐层级如下：

```text
agentAssetId
  └─ agentInstanceId
      └─ sessionId
          └─ invocationId
              └─ turnId
                  ├─ modelCallId -> attemptId(s)
                  └─ toolCallId
```

- `sessionId` 表示对话或长期工作单元；
- `invocationId` 表示一次顶层任务/运行，继续复用当前可信关联字段；
- `turnId` 表示一次用户输入触发的 agent loop；Codex `turn_id`、Claude `prompt.id` 可映射到这里；
- `modelCallId` 是需要新增的一次逻辑模型调用 ID，重试使用其下的 `attemptId`；
- `toolCallId` 继续使用当前字段；MCP 可使用 JSON-RPC request id 作为 `protocolRequestId`，再映射为稳定的 ToolCall ID。

AnySentry 不应把这些字段写回或替换现有 `traceId`。当前可信关联契约已经明确区分 Invocation/ToolCall、Runtime Root、Physical Workload 与 inferred episode；扩展 `turnId/modelCallId` 应沿用同一 Source 认证、scope binding 和 claim receipt 机制。[E012]

### 3.3 传输并发会击穿“一个 socket 等于一次调用”的假设

一个 TLS 连接可能顺序承载多个 HTTP/1.1 请求、通过 HTTP/2 stream 并发承载多个调用，也可能升级为 WebSocket；SSE 响应会跨越许多 `SSL_read`。自动重试又可能让一个逻辑调用对应多个 HTTP attempt。只按 `(pid, fd)` 或时间窗口配对会在并行 Agent、并行工具和连接池下错配。[E021][E029]

AgentSight 的开源实现展示了需要的最低协议层：SSL 指针、HTTP/1 状态机、HTTP/2 stream 聚合、SSE parser、RequestOnly/ResponseOnly 和 provider payload parser；它也明确存在 parser silent skip 与缺少显式 backpressure 的工程边界，不能原样复制。[AgentSight 开源实现](https://github.com/alibaba/anolisa/tree/5e3c6bab8e1727dd478c7a00184c3c5b3380b8a9/src/agentsight) [E021]

### 3.4 Candidate 的第一调用竞争

行为发现通常在看到 LLM endpoint 或工具交替之后，才把 Unknown 提升为 Candidate。若收到 Candidate 结果后才把 SSL 从 SAMPLE 切到 FULL，触发候选的第一条请求已经结束。对预先有 K8s/Docker label 的 Confirmed Agent，控制面可以在运行前下发；对基于进程签名和行为发现的 Candidate，则需要以下二选一或组合：

- 从进程启动即启用原生 Hook/OTel/Gateway 采集，把内容短期写入受限区，身份确定后再展示；
- 对命中 Agent runtime signature 或 LLM 域名的精确进程维护短 TTL、严格 byte quota 的本机加密 pre-roll，Candidate 后回放，Unknown/Non-Agent 到期销毁。

pre-roll 是隐私敏感设计，不能默认为整机所有 TLS 流量。它必须同时满足进程/域名 allowlist、租户政策、每进程上限和显式 drop accounting。

## 4. 对参考图片与工业方案的判断

参考图把 Agent↔LLM 放在 TLS 明文边界，把 Agent↔MCP stdio 放在 pipe JSON-RPC 边界，
并用进程、网络和文件探针补足系统事实。它是合理的采集点地图，但原始截图不纳入仓库，
图示本身也不能证明库兼容、正文完整性或调用归因。[E035]

阿里云公开的 AgentSight 产品路线与图片高度相似：按进程或域名白名单捕获 TLS 明文，解析 OpenAI/Anthropic/DashScope payload，给同一次请求/响应相同 `event.id`，可选择增量 messages 和 raw HTTP fallback。[AgentSight 采集文档](https://help.aliyun.com/zh/sls/collect-ai-agent-observability-agentsight-logs) [E020] 其官方技术附录同时写明，采集能力取决于能否定位目标二进制的 SSL 函数，并把当时的官方 Codex CLI 列为不支持。

开源 AgentSight 主干随后增加了三级回退：符号、字节模式、按二进制 fingerprint 查 offset；但只内置了若干 Codex 版本。本机 Codex `0.150.1` 的 file size 与 head hash 均未命中当前表。[E018][E021] 这说明 Codex eBPF 不是理论上完全不可做，而是会转化为“每个发行版本提取/验证偏移、处理 ABI 和 HTTP/WebSocket 变化”的持续兼容工作。

OpenTelemetry 给出了另一条工业坐标。GenAI 约定定义模型 input/output、Agent/Workflow Span、`execute_tool`、`gen_ai.tool.call.id`、arguments 和 result；MCP 约定进一步把 `tools/call`、JSON-RPC id、W3C trace context 与 transport 关联。[OTel GenAI](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) [OTel MCP](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md) [E023][E024][E025] 这些约定仍是 Development，且把正文定义为敏感、opt-in 数据，因此可以作为 AnySentry 外部兼容词汇，不能直接替代内部稳定 schema。

## 5. 三个候选方案

### 5.1 方案 A：Observer-first TLS/pipe 全透明采集

#### 切入点

```text
Agent binary
  |-- TLS library call ----> eBPF uprobe -> HTTP/SSE/WS parser -> ModelCall
  |-- MCP child stdin/out --> eBPF pipe   -> JSON-RPC parser   -> ToolCall
  `-- syscalls ------------> existing probes                -> Kernel facts
```

#### 需要实现的组件

1. **动态 TLS attach。** Collector 按 `/proc/<pid>/maps`、目标 executable inode/build-id 和容器 root 解析实际库；支持 `SSL_write/read`、OpenSSL 3 `_ex` ABI、BoringSSL pattern，按需要增加 GnuTLS 与 Go `crypto/tls` 路径。DeepFlow 的公开实现也把 Go TLS 与 OpenSSL 分成不同的 symbol-resolution 路径，说明这不是一个通用函数名能覆盖的问题。[DeepFlow Agent 配置](https://deepflow.io/docs/configuration/agent/) [E034]
2. **新的 fragment ABI。** 至少包含 `host/boot/cgroup/pid/start/tid`、`ssl_ptr`、方向、调用序号、fragment offset/len、原始总长、capture time、capture profile 和 truncation/error。当前 1024 字节 `SslEvent` 不能兼容地承担完整重组。[E001][E003]
3. **有界 userspace reassembly。** 按 `(processInstance, ssl_ptr generation)` 管理 HTTP/1 connection state，按 HTTP/2 stream id 管理并发，处理 content-length、chunked、gzip、SSE、WebSocket、timeout、cancel、retry 和 connection close。
4. **provider parser 插件。** OpenAI Responses/Chat、Anthropic Messages、OpenAI-compatible、DashScope 等采用版本化 parser；未知 payload 进入受限 raw fallback，不能静默丢弃。
5. **MCP pipe 采集。** 只对 Agent 启动的 MCP child pipe 采集；按 newline 重组 JSON-RPC，用 request `id` 关联 `tools/call` 与 result。MCP 2026-07-28 的 stdio binding 仍使用换行分隔 JSON-RPC，因此协议上可行。[MCP Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) [E026]
6. **完整 loss ledger。** probe attempted、selected、ring submitted/dropped、fragment admitted/dropped、reassembly complete/partial、parser success/fallback、paired/unpaired、blob stored/failed、UI visible 必须守恒。

#### 收益

- 不要求 Agent 框架配合，可发现未知或恶意绕过语义日志的行为；
- 可以复用现有 process/cgroup/Agent Root 与 Capture Profile；
- LLM 内容和内核副作用来自同一 Runtime 观察面，适合独立核验。

#### 代价与边界

- Codex/Claude/Bun/Go/静态 OpenSSL 要按版本维护探针，升级回归成本最高；
- HTTP/2、WebSocket、SSE 和大 body 的重组状态复杂，ring/backpressure 会直接影响“每次”完整性；
- pipe eBPF 可能同时看到日志、分片和 fd 复用，用户态 relay 更容易证明字节透明；
- Dify 一个 worker 可同时运行多个 tenant/app/workflow，eBPF 只能证明共享 Runtime，不能凭 pid 给逻辑 workflow 归因；
- 抓取进程内全部 OpenSSL 明文可能包含非 LLM 业务和凭据，安全风险最大。

**适用结论：** 适合作为 Observer 的长期 fallback 和独立事实面，不适合作为第一阶段唯一方案。

### 5.2 方案 B：CLI/框架原生 OTel 与 Hook Adapter

#### 切入点

```text
Agent loop / workflow node
        |
        | native event, Hook, OTel span/log
        v
AnySentry Interaction Adapter -> authenticated agent_adapter/application Source
```

#### Codex

Codex 官方 OTel 可以输出 conversation、API/SSE/WebSocket、用户 prompt、tool decision 和 tool result；用户 prompt 正文需要显式 opt-in。[Codex Observability](https://learn.chatgpt.com/docs/config-file/config-advanced) [E027] Codex Hooks 进一步提供稳定的 `session_id`、`turn_id`、`tool_use_id`、`tool_input`、`tool_response`、用户 prompt 和最新 assistant message。[Codex Hooks](https://learn.chatgpt.com/docs/hooks) [E028]

建议用受管 Hook Adapter 采集工具：

- `UserPromptSubmit` -> `turn.started`；
- `PreToolUse` -> `tool.started`，记录准确 ToolCall ID 与参数；
- `PostToolUse` -> `tool.ended`，记录结果、错误和 Adapter 本机时间；
- `Stop/SubagentStop` -> turn/subagent end 与最终 assistant text；
- Codex OTel -> API duration、SSE token、transport 与版本元数据。

Hook 进程不应同步请求远端 AnySentry；它应把事件写入本机 bounded queue/WAL 后立即返回，避免观测故障阻塞 Agent。Codex transcript path 可作为故障诊断，但官方明确说明格式不稳定，不能成为主协议。[E028]

这条链能完整覆盖工具，却不能从公开稳定 OTel/Hook 合同取得每一次完整模型 request body 和完整 streaming response body。因此 Codex 的 LLM 正文仍需方案 C 网关，或使用经版本验证的 App Server/本地协议适配；不建议依赖 rollout JSONL 私有格式。

#### Claude Code

当前 Claude Code 官方 OTel 已提供最接近目标的合同：`prompt.id` 关联一次用户交互，`client_request_id/request_id` 关联模型请求，`tool_use_id` 关联 Hook、Tool Span 与 Tool Result；还可显式开启 assistant response、tool input/output 和完整 Anthropic Messages request/response body。[Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage) [E029]

对超出 OTel attribute 限制的 body，`OTEL_LOG_RAW_API_BODIES=file:<dir>` 会在本地保存不截断内容并在事件中给出引用。AnySentry sidecar 应读取后上传受保护内容，再删除/轮转本地文件；不能把主机绝对路径直接当作远端内容链接。部分字段要求 Claude Code `2.1.193`、`2.1.214` 或更高版本，本机 `2.1.170` 必须先升级或按旧版能力降级验收。[E019][E029]

Claude Hooks 同样能取得 built-in 与 MCP 工具的原始 input/output，可作为 OTel 内容的交叉校验或旧版本兼容入口。[Claude Hooks](https://code.claude.com/docs/en/hooks) [E030]

#### Dify

Dify 的语义身份不是 worker pid，而是 `tenant_id/app_id/workflow_id/workflow_run_id/node_execution_id`。当前 Dify 主干 `OpsTraceManager` 从持久化 workflow/message/node/tool 对象构造 inputs、outputs、prompt/completion token 和 start/end time，再异步分发到 trace provider。[Dify OpsTraceManager](https://github.com/langgenius/dify/blob/main/api/core/ops/ops_trace_manager.py) [E032]

建议实现一个版本化 Dify→AnySentry Trace Adapter，优先在 Dify 的 workflow/node/tool callback 处生成 start/end；若只能接 OpsTrace，则保留原始 start/end，但明确 `receivedAt` 晚于执行完成。并行节点必须用 `workflow_run_id + node_execution_id` 关联，禁止按时间邻近配对。

多租户 Dify 必须为每个 tenant/app 绑定独立 Source scope 与内容密钥。Dify 曾出现全局 OTel provider 把 Langfuse trace 发往错误租户的版本性事故，这一案例说明不能让全局 exporter 持有第一个租户的动态配置。[Dify #36122](https://github.com/langgenius/dify/issues/36122) [E033]

#### 收益与边界

该方案对工具语义、逻辑 Agent、并行 workflow 和时间最准确，开发速度也最快；但它依赖 Agent/框架配置，无法独立发现绕过 Hook 的子进程行为，且不同产品公开内容合同不一致。它必须与 Observer 组合，而不是替换 Observer。

### 5.3 方案 C：显式 LLM Gateway + MCP Relay

#### 切入点

```text
Codex / Claude / Dify
        |
        | Responses / Messages / OpenAI-compatible
        v
AnySentry LLM Gateway -----> upstream provider
        |
        `-> request/response tee -> Interaction Ingest

Agent MCP client -> stdio relay / HTTP gateway -> MCP server
```

Gateway 在收到完整 request headers/body 时生成 `modelCallId`，以 streaming tee 转发上游响应，不等待全文后再返回 Agent；同时记录首字节、结束、HTTP/SSE/WebSocket 状态、provider request id、retry attempt 和内容 hash。它必须支持目标客户端真实使用的协议，尤其是 OpenAI Responses SSE/WebSocket 与 Anthropic Messages SSE。

Claude Code 官方支持 `ANTHROPIC_BASE_URL` 指向可检查明文的 sampling proxy；Codex 配置支持 `openai_base_url` 或自定义 `model_providers.<id>.base_url`。[Claude Secure Deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment) [Codex Config Reference](https://learn.chatgpt.com/docs/config-file/config-reference) [E031] 但 Codex 的 ChatGPT 登录、API key、自定义 provider 和 WebSocket 模式并不等价。目标部署必须以真实认证模式验证登录、刷新、SSE/WebSocket、重试和工具行为，不能仅依据 base URL 字段宣布支持。

MCP stdio 更适合用 relay 而不是 eBPF pipe：把原 MCP command 改为 `anysentry-mcp-relay -- <server> ...`，relay 原样转发 stdin/stdout，仅旁路解析完整 JSON-RPC。它用 `tools/call` request id 配对参数与结果，绝不向 stdout 写日志；自身日志与 AnySentry 事件走独立 fd。HTTP MCP 则由协议 gateway 或 OTel MCP instrumentation 注入/提取 `traceparent`，保留 transport span 与 MCP span 的区别。[E025][E026]

#### 收益

- 对静态 TLS 二进制无依赖，最适合补 Codex 完整 LLM body；
- provider/parser 版本集中维护，可统一内容安全、重试和计费字段；
- MCP relay 天然拿到 JSON-RPC id、工具参数和结果。

#### 代价与边界

- 需要变更 endpoint/MCP command 或部署透明代理；
- Gateway 是高敏感、高可用基础设施，故障会影响 Agent 主链；
- 只看 LLM body 可以看到模型提出的 tool call 和下一请求中的 tool result，却不知道本地工具真正何时开始/结束，也不能证明文件/网络副作用；
- TLS MITM 需要 CA 分发，且并非所有程序遵守代理环境变量。优先显式协议 endpoint，不把通用 MITM 作为默认方案。[E031]

### 5.4 方案对比

| 维度 | A：eBPF TLS/pipe | B：原生 OTel/Hook | C：显式 Gateway/Relay |
| --- | --- | --- | --- |
| Agent 代码改造 | 无代码改造，但需内核/符号兼容 | 通常只需配置或 Adapter | 需 endpoint/MCP command 路由 |
| LLM body 完整度 | 协议重组成功时高；丢片即 partial | Claude/Dify 高，Codex 稳定合同不足 | 协议支持范围内最高 |
| Tool 参数/结果 | 仅 MCP pipe 或从 LLM body 间接得到 | 最高，直接拿 ToolCall 生命周期 | MCP 高；普通本地工具不足 |
| 逻辑 Agent 归因 | Runtime 强，Dify 逻辑 workflow 弱 | 最强 | 需可信 header/sidecar 才能绑定 Agent |
| 独立核验副作用 | 强 | 弱 | 弱 |
| Codex 版本维护 | 高，offset/ABI/WS 变化 | Hook 较低；LLM body 仍缺 | 中，需 Responses/认证兼容 |
| Candidate 第一调用 | 需要 pre-roll/早期 attach | 从进程启动即可 | 从路由启用即可 |
| 安全暴露面 | 可能抓到进程内非 LLM TLS | 内容由 Agent 明确提供 | Gateway 集中持有全部明文 |
| 推荐角色 | fallback/独立事实 | 主语义链 | 主正文链与 MCP 协议链 |

没有一个单方案同时满足全部目标。方案 B+C 先交付可解释的模型/工具交互，方案 A 继续提供不依赖 Agent 自报的核验与未知覆盖。

## 6. 推荐的目标架构

### 6.1 三条证据 lane 汇入同一个 Interaction Plane

```text
Native lane:  Codex Hooks/OTel | Claude OTel/Hooks | Dify Trace Adapter
                                      \
Protocol lane: LLM Gateway | MCP stdio relay | MCP HTTP/OTel ----> Interaction Normalizer
                                      /                              |
Runtime lane: Observer process/file/network/TLS fallback            +--> ClickHouse metadata
                                                                     +--> encrypted content store
                                                                     `--> Agent Interaction UI
```

三条 lane 的权威不同：

| Lane | 可以作为事实的内容 | 不得单独声称 |
| --- | --- | --- |
| Native | Session/Turn/ToolCall、框架输入输出、逻辑 Agent/Workflow | 未上报的实际系统副作用不存在 |
| Protocol | 实际发给 provider/MCP peer 的 bytes、协议 request id、响应与 transport timing | 该调用一定属于某逻辑 Agent，除非有可信 scope binding |
| Runtime | process/cgroup/exec/file/network 与内核事件时间 | 某事件属于具体 Dify node/ToolCall，除非存在强语义链接 |

Resolver 只允许高权威 lane 补充自己的字段，不允许覆盖另一 lane 的原始证据。例如 Gateway 可以提供 `modelCallId` 与 body，Agent Adapter 可以把它绑定到 `turnId`，Observer 可以把该 turn 下的 ToolExec 链到实际进程；任一方都不能用一个同名字段覆盖其他来源。

### 6.2 使用现有 Source 与可信关联，不重建第二套身份系统

- Codex/Claude Hook 与 Dify Adapter 使用受 token 保护、带 tenant/environment/workspace 或 agent scope binding 的 `agent_adapter` Source；
- 标准应用 OTel 可使用 `application` authority；
- Observer 继续使用 collector-bound `observer_runtime` authority；
- Gateway 初期只对 `modelCallId/protocolRequestId` 和内容负责，只有在 sidecar 注入的 scope 与服务端 binding 匹配后，才能声明 Invocation/Agent；
- `agentAssetId` 始终由服务端现有资产 resolver 产生，producer 不直接指定最终资产主键。

当前 Source 服务已经要求 application/agent_adapter 至少绑定 tenant、environment 和 workspace/workload/agent 之一，observer_runtime 必须绑定 collector；这可以直接成为新内容接入的信任边界。[E012]

### 6.3 Candidate 与 Confirmed 的内容策略

用户目标要求两类 Agent 都能查看每次交互，因此两者的**逻辑内容采集动作都应是 FULL**，不再把 Candidate 的 LLM 正文归入通用 `ssl: sample`。但内容安全策略可以不同：

| 有效分类 | 采集 | 默认可见性 | 建议保留 | 说明 |
| --- | --- | --- | --- | --- |
| `confirmed_agent` | 完整模型/工具内容 | 授权调查者可见 | 按租户正式策略 | exact asset/runtime binding |
| `probable_agent` | 完整模型/工具内容 | 受限、明确“候选”标识 | 更短 TTL，可审核后延长 | 防止误识别造成长期隐私扩张 |
| `unknown` | 默认仅元数据；可选短期加密 pre-roll | 不在 UI 展示正文 | 极短 TTL | 只限命中 LLM endpoint/进程策略 |
| `non_agent` | 不采集常规内容 | 不可见 | 无 | 保留安全/生命周期与抑制统计 |

Capture Profile 仍决定内核 payload 成本；`Interaction Content Policy` 应成为独立策略域，因为正文访问、加密和 TTL 与 syscall 采样不是同一类决策。

### 6.4 Agent/传输覆盖建议

| 对象 | 主语义源 | 完整正文源 | Runtime 核验 | 结论 |
| --- | --- | --- | --- | --- |
| Codex CLI | Hooks + Codex OTel | Responses-compatible Gateway | Observer exec/file/network；TLS 仅版本化 fallback | 首批支持，但 Gateway/auth 必须实测 |
| Claude Code | Claude OTel + Hooks | OTel raw API bodies，必要时 Gateway | Observer；AgentSight-style static BoringSSL 可选 | 需规定最低 CLI 版本 |
| Dify workflow | Dify Trace Adapter | Adapter node data + 可选 model gateway | 自托管 worker 的 Observer | 必须以 app/workflow/node ID 归因 |
| 普通 Node/Python Agent | OTel/SDK 若可用 | Gateway 或动态 OpenSSL uprobe | Observer | provider parser 覆盖决定正文质量 |
| Go Agent | OTel/SDK 或 Gateway | Gateway；Go TLS uprobe 为可选专项 | Observer | 不纳入首版通用 TLS 承诺 |
| MCP stdio | Codex/Claude Hook 或 stdio relay | relay JSON-RPC | Observer child process/pipe 仅核验 | relay 为首选 |
| MCP Streamable HTTP | MCP OTel/HTTP Gateway | Gateway | Observer network/process | 保留 MCP span 与 transport span |
| Provider 托管工具 | provider response parser | LLM Gateway/API body | 本机无内核事实 | UI 标记 `provider_hosted` |

## 7. 交互契约、存储与安全

### 7.1 新增稳定交互 envelope，不把正文塞进 JudgedEvent

建议新增 `anysentry.agent_interaction.v1`，metadata 进入专用 ClickHouse 表，正文进入独立 content plane。关键字段如下：

| 域 | 字段 |
| --- | --- |
| Source | `sourceId`、`authority`、`captureMethod`、`producer/version`、`sourceEventId` |
| Asset | 服务端解析后的 `agentAssetId`、`agentInstanceId`、`physicalWorkloadId` |
| Correlation | `sessionId`、`invocationId`、`turnId`、`modelCallId`、`attemptId`、`toolCallId`、`protocolRequestId`、`traceId/spanId/parentSpanId` |
| Operation | `model.request/model.response/tool.start/tool.end`、provider、model、tool、status、error |
| Time | `started/firstResponse/ended/observed/received/persisted AtUnixNs`、`clockSource/domain` |
| Content | `contentRefs[]`、hash、原始/存储 bytes、media type、encoding、redaction、completeness |
| Evidence | `captureProfile`、`correlationMethod/confidence`、`claimReceipts`、linked kernel event IDs |

现有 `JudgedEvent` 继续承载安全判断和事件深链接。Interaction 可以派生一个有限的 `LlmCall`、`AgentTool` 或安全事件进入现有判断流，但正文不应复制到每个事件 revision。这样既保护当前 ClickHouse 查询，也避免一次长会话在 attributes/rawPreview 中反复复制全文。[E008][E009]

### 7.2 Content Plane

生产建议遵循 OTel 的模式：Span/Event 保存引用，大正文进入具有独立访问控制的外部存储。[OTel Content Guidance](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md#capturing-instructions-inputs-and-outputs) [E023]

这是一个需要显式评审的新依赖；当前仓库部署清单没有配置对象存储。[E039] 主要选择是：

| 存储方式 | 收益 | 代价与适用条件 |
| --- | --- | --- |
| ClickHouse 专用 content 表 | 不增加运行组件，PoC 和小规模部署最简单 | 大正文影响 merge/query/backup；难把 raw-content 权限与事件查询彻底分离 |
| 对象存储 + ClickHouse reference | 大对象、TTL、加密、分层访问和低成本归档更自然；推荐生产采用 | 新增 S3/MinIO/云对象存储依赖；需要处理跨系统提交、孤儿对象和 key rotation |
| 本机加密 spool | 适合 Hook/Gateway 解耦和 Candidate pre-roll | 只能作为短期缓冲，不是多节点可查询的证据源 |

推荐先定义 `ContentStore` 接口，用 ClickHouse backend 完成无新依赖的受控 PoC；生产启用 raw body 前切换到对象存储 backend，并把部署、备份、删除与密钥管理纳入验收。这个切换不能改变 `blobId/contentRef` 的上层合同。

每个 blob 至少保存：

- `blobId`、tenant key、`sha256`、原始和存储字节数；
- `contentRole`：system、input_messages、output_messages、tool_arguments、tool_result、raw_request、raw_response；
- `mediaType/contentEncoding` 与结构化 schema 版本；
- `complete/truncated/partial/unavailable` 和具体 reason；
- `redactionState`、DLP 规则版本、加密 key version；
- `createdAt/expiresAt`、来源、访问审计引用。

提交顺序建议为：验证 Source 与大小上限 -> 流式写入临时加密对象并计算 hash -> 原子 finalize blob -> 写 Interaction metadata/reference -> 更新可查询索引。任何一步失败都写明确的 metadata 状态；孤儿临时对象由 TTL 清理。`sourceEventId + contentRole + chunk/part` 作为幂等键，Gateway/Adapter 重试不能产生重复正文。

### 7.3 结构化脱敏而不是只用正则

当前正则可以遮盖常见 API key，但不能保证消除所有 secret。[E017] 新入口应先按协议结构处理：

- headers 采用 allowlist，永久删除 Authorization、Cookie、API key、签名和代理凭据；
- URL 删除或 hash query，尤其是预签名 URL；
- JSON body 按 provider schema 区分 messages、tool definitions、tool args/result；
- 配置字段级 drop/hash/mask 与 tenant-specific DLP；
- 原始加密正文和默认 redacted view 分离，原文查看必须二次授权、记录审计，并可禁用下载；
- Candidate raw TTL 默认短于 Confirmed；密钥按 tenant 隔离，禁止把 per-tenant exporter 挂到全局可变 provider。[E033]

如果法规或租户策略禁止保存 raw body，系统仍保存 redacted structured content 与 hash，但 UI 必须显示“raw not retained by policy”，不能伪装为完整原文。

### 7.4 大正文、增量与配额

每次请求若包含全部历史 messages，会产生二次方存储增长。AgentSight 的 `MessageDeltaOnly` 做法值得借鉴：保存 system/tools 的版本 hash，只在变化时写全文；每次调用保存新增 messages 与对上一快照的引用。[E020] 但必须保留可重放性：UI 展开一次调用时，应能从基线+delta 重建实际发送内容并校验最终 hash。

配额至少包含 per-call、per-agent/day、per-tenant/day、in-flight reassembly 和本机 pre-roll；达到上限时停止正文但继续 metadata，并报告 `content_quota_exceeded`。

## 8. UI 设计

现有 `AgentActionTrace` 应扩展为“Agent 交互与行为”，而不是再建一个与资产脱节的页面：

```text
Turn 12  14:03:01.120  Candidate Agent  [coverage: complete]
  ├─ Model request  model=gpt-*        14:03:01.131
  │    input messages / tools / provider / content source
  ├─ Model response                     first 14:03:01.612 · end 14:03:05.044
  │    text / tool_use(call_7) / tokens / finish reason
  ├─ Tool call call_7: Bash             14:03:05.052 → 14:03:05.441
  │    arguments / result / error / linked ToolExec+ProcessExit
  └─ Model request (tool result)         14:03:05.450
```

Candidate 与 Confirmed 使用相同信息结构，身份标签和 raw-content 权限不同。每个 ModelCall/ToolCall 显示：

- 逻辑时间、TTFT、duration 与 ingest delay；
- `session/invocation/turn/modelCall/toolCall` ID；
- capture source badge：Native、Gateway、MCP Relay、eBPF；
- completeness：Complete、Partial、Truncated、Unavailable、Redacted；
- 当前 redacted structured view，以及有权限时的 Raw View；
- 与现有 Event、Evidence Bundle、内核证据和 Agent Asset 的双向链接；
- 多源内容不静默覆盖，允许查看“Gateway body / Native object / eBPF copy”及 hash 是否一致。

搜索接口增加 `turnId/modelCallId`，保留现有 `traceId/invocationId/toolCallId` 语义和旧深链接。列表默认只加载 metadata；正文按需获取，防止一次打开资产页下载整段会话。

## 9. 分阶段实施方案

### Phase 0：契约与安全边界

交付：

- `anysentry.agent_interaction.v1` 与 `contentRef.v1`；
- Source authority/correlation 扩展规则；
- provider/MCP fixture corpus；
- raw/redacted、TTL、RBAC、审计和 tenant key 决策记录；
- completeness/loss ledger 指标定义。

退出条件：同一个 fixture 经 native/gateway/observer 三种来源后，ID、时间、内容状态和去重结果确定；未知字段和超限数据 fail-closed，不改写现有 `traceId`。

### Phase 1：Interaction Plane 与语义适配

AnySentry：

- 新 Interaction Ingest/Normalizer/Store/Content Service；
- 扩展现有 Source auth 和 Trusted Correlation，新增 `turnId/modelCallId/attemptId`；
- Agent Action API 返回 ModelCall+ToolCall 树；
- AgentsPage 增加交互详情与正文按需读取。

Adapters：

- Codex managed Hooks + OTel adapter，先完成工具、Turn 和 final assistant；
- Claude Code 规定最低版本，接入 OTel logs/traces/raw body file uploader；
- Dify Trace Adapter，以 tenant/app/workflow/node ID 输出 start/end 与内容；
- Pi Adapter 从 result hash-only 扩展为 policy-controlled contentRef。

退出条件：不依赖 eBPF TLS，也能在受控 Codex/Claude/Dify fixture 中显示完整 ToolCall；Claude/Dify 显示完整 ModelCall，Codex 明确标为“正文待 Gateway”而不是误报完整。

### Phase 2：LLM Gateway 与 MCP Relay

- 实现 OpenAI Responses HTTP/SSE/WebSocket、Anthropic Messages SSE 的 streaming tee；
- 保留逻辑 call 与 attempt，处理 cancel、retry、timeout、provider error；
- 实现 MCP stdio relay 和 Streamable HTTP gateway/OTel；
- 为 Codex API-key、自定义 provider、ChatGPT 登录等实际 auth mode 建立兼容矩阵；
- Adapter 将 Gateway `modelCallId` 与 turn/invocation 绑定。

退出条件：目标 Codex 版本在真实认证模式下，每个受控模型请求/响应均成对入库；Gateway 断开或 storage backpressure 不得静默截断 Agent 响应。

### Phase 3：Observer TLS fallback 升级

Observer：

- 新增动态 target discovery、OpenSSL `_ex`、BoringSSL static pattern 与版本 fingerprint；Go/GnuTLS 是否进入首版由覆盖需求决定；
- 新 fragment ABI、独立高容量 lane、分片 drop accounting；
- userspace HTTP/1/2/SSE/WebSocket reassembly 与 provider parser；
- 本机加密 pre-roll 与 Candidate promotion；
- 生成 `modelCallId` 的 attested runtime fallback，并把 parse/loss/completeness 送入 AnySentry。

AnySentry：

- `probable_agent` 的 Interaction Content Policy 改为 FULL；
- 保留内核 Capture Profile 的采样与成本语义，不让 content policy 误开启整机 TLS；
- 多源一致性视图与独立 evidence link。

退出条件：对明确支持的 binary/version 列表达到 fixture 级完整配对；未命中符号/offset、ring drop、parser fallback 和超限都产生可查询 coverage 状态。没有版本条目的 Codex 不标记为 supported。

### Phase 4：灰度与治理

1. `off -> shadow -> enabled` 分别控制 interaction ingest、raw content、Candidate pre-roll 和 Observer TLS parser；
2. 先部署 reader/schema/content store，再启 producer；
3. 以 agent/version/captureMethod 观察 paired、partial、drop、redaction、quota 和 hash mismatch；
4. 只有在 tenant 隔离、删除、审计和密钥轮换演练通过后开放 Raw View；
5. 任何 lane 可独立关闭，现有事件、ActionTrace 与 Observer 主链不回写、不迁移主键。

## 10. 测试与验收标准

### 10.1 功能矩阵

| 用例 | 必须证明的结果 |
| --- | --- |
| Codex Responses SSE | request/response 配对，input/output、tool items、TTFT/end、turn/modelCall ID 正确 |
| Codex WebSocket/fallback | transport 切换不产生重复逻辑调用，attempt 单独可查 |
| Claude Messages SSE | raw body、assistant text、tool_use、ToolResult、request_id 与 prompt.id 关联 |
| Dify 并行 workflow | 相同 worker 内两个 workflow/node 不串内容，时间和 tenant/app 归属正确 |
| MCP stdio | 分片 read/write、转义换行、大 result、并行 request id 均正确配对，stdout 字节完全透明 |
| MCP HTTP/SSE | MCP span 与 HTTP transport span 分开，trace context 和 tool result 正确 |
| Tool failure/cancel | start/end、error、partial result 与 ProcessExit/内核事件一致 |
| Candidate 第一调用 | 从 Unknown 到 probable 后仍可查看触发候选的第一条调用，或明确记录 policy 未允许 pre-roll |
| PID/fd/SSL pointer 复用 | 新 process/socket generation 不继承旧调用 |
| 大正文与压缩 | gzip/chunked/HTTP2/多 fragment 重建正确；超过配额明确 partial |
| 多源重复 | Native/Gateway/eBPF 不重复成三条顶级调用，来源和 hash 可展开 |

### 10.2 证据守恒

每个 Source/Collector 窗口至少满足：

```text
observed
  = rejected_by_policy
  + dropped_before_queue
  + admitted

admitted
  = parse_failed_or_raw_fallback
  + unpaired_partial
  + paired_complete

paired_complete
  = metadata_only_by_policy
  + content_store_failed
  + visible_with_content_ref
```

计数单位必须明确区分 physical fragment、logical model call、tool call 和 content blob，不能像多片 Exec 那样把物理记录数当成逻辑事件数。Observer 当前测试已经验证了 ring/queue 的部分守恒和优先级隔离，可继续沿用该测试风格。[E006]

### 10.3 负向与安全验收

- 未认证 Source 不能声明 Invocation/ToolCall/ModelCall，也不能上传可查看 raw content；
- tenant、environment、workspace/workload/agent binding 不匹配时拒绝或只保留 unassigned metadata；
- Authorization/Cookie/API Key/签名 URL 不进入 redacted view、日志或错误消息；
- Candidate raw content 过期后对象、索引和缓存均不可读；
- 一个 Dify tenant 的 exporter/密钥不能访问另一个 tenant；
- Raw View 每次读取有操作者、原因、时间、对象 hash 和导出动作审计；
- 内容存储不可用时 Agent 主调用不中断，Interaction 显示 `content_store_failed`；Gateway 本身不可用则按明确的 fail-open/fail-closed 部署策略处理；
- 恶意超大 JSON、深层对象、无终止 SSE、乱序/重复 JSON-RPC id 不产生无界内存。

### 10.4 性能验收

本报告没有现成生产基线，因此不声明固定开销目标。实施前先对目标 Codex/Claude/Dify workload 测量：Agent p50/p95 总时延、TTFT、Gateway added latency、Hook return time、Observer CPU/RSS、ring drop、ingest throughput、content bytes/day 和 ClickHouse query latency。最终阈值应由基线与容量预算批准，而不是直接沿用 AgentSight 论文或其他产品的数字。

## 11. 风险、未知项与最终决策

| 风险/未知 | 当前判断 | 下一步 |
| --- | --- | --- |
| Codex eBPF 跨版本 | 可通过 fingerprint/offset 增加个别版本，但维护成本高 | 不阻塞 Phase 1/2；建立明确 supported-version 表 |
| Codex ChatGPT 登录经过 Gateway | 官方配置有 base URL，但目标 auth/WS 行为未验证 | 用真实账号模式做最小 PoC 后再承诺 |
| Candidate 隐私 | 完整采集可能基于误识别 | 短 TTL、受限可见、精确进程/域名、可关闭 pre-roll |
| Dify 多租户 | 全局 exporter 有现实串租风险 | per-tenant Source/exporter/key，隔离测试为发布门禁 |
| OTel GenAI/MCP 稳定性 | 当前仍是 Development | 内部 v1 稳定，外部字段通过 versioned adapter 映射 |
| eBPF 完整性 | 任一 ring/drop/parser/offset 失败都会形成缺口 | loss ledger + completeness 状态，不以缺记录代表无调用 |
| 内容成本 | 全量历史 messages 重复量大 | baseline+delta、外部 blob、quota、按需加载 |

最终推荐是批准混合方案，并按 **Phase 0 -> Phase 1 -> Phase 2 -> Phase 3** 推进。第一阶段应最大化复用当前 `agent_adapter`、可信关联、AgentTool 聚合和 AgentActionTrace；第二阶段用 Gateway/Relay 补 Codex 与 MCP 的完整协议正文；Observer TLS 扩展在此之后作为独立覆盖面建设。这样即使某个 CLI 升级导致 uprobe offset 失效，语义主链仍可用；即使 Agent 不配合上报，Observer 仍能暴露进程、文件和网络副作用。

## 附录 A：证据索引

证据状态含义：`confirmed_fact` 为源码、测试、配置、二进制或一手外部资料直接支持；`supported_inference` 为多项事实支持但未通过运行验证的解释；`project_claim` 为设计稿、README 或图片表达，不能视为本项目已实现。

| ID | 状态 | 来源与定位 | 支持的窄结论 |
| --- | --- | --- | --- |
| E001 | confirmed_fact | `Observer/a3s-observer-common/src/lib.rs: SslEvent` | SSL 单片 1024 字节且缺调用级关联字段 |
| E002 | confirmed_fact | `Observer/a3s-observer-collector/src/main.rs: A3S_OBSERVER_SSL` | 只挂一个配置/default libssl 路径 |
| E003 | confirmed_fact | `Observer/a3s-observer-ebpf/src/main.rs: emit_ssl` | 每次 SSL call 产生一个有界、带单调时间的 record |
| E004 | confirmed_fact | `Observer/a3s-observer-collector/src/main.rs: RingOrigin::Ssl` | 单片发 SslContent/LlmApi，provider 未关联 |
| E005 | confirmed_fact | `Observer/a3s-observer-collector/src/event_time.rs` | 精确 event/receipt Unix ns |
| E006 | confirmed_fact | Observer Collector 86 tests | 时间、顺序、队列和当前 parser 测试通过 |
| E007 | confirmed_fact | `Observer/src/model.rs: LlmCall/SslContent/LlmApi` | 指标与正文是分离事件 |
| E008 | confirmed_fact | `security-monitoring.controller.ts: deriveMeta/eventInner` | rawPreview/content 当前被限长 |
| E009 | confirmed_fact | `clickhouse-store.ts: events/toRow/fromRow` | 保存时间与 correlation，但无 content plane/modelCallId |
| E010 | confirmed_fact | `filter-rule-builtins.ts: CAPTURE_PROFILE_ACTIONS` | confirmed SSL FULL，candidate SSL SAMPLE（enforce profile） |
| E011 | confirmed_fact | `scripts/observer-forward.js: handleLine` | 多源身份合并后再路由接入 |
| E012 | confirmed_fact | `trusted-correlation.ts` | Invocation/ToolCall 需要认证与 scope binding |
| E013 | confirmed_fact | `anysentry-pi-adapter.mjs` | 工具 start/end 已有，结果仍为 hash/size |
| E014 | confirmed_fact | `pnpm verify:s6-tool-evidence` | Adapter、严格 linker、持久 relation 验证通过 |
| E015 | confirmed_fact | `aggregation.service.ts: storedAgentActions` | 以 Invocation/ToolCall 聚合工具耗时 |
| E016 | confirmed_fact | `AgentEventsPage.tsx: EventDetail` | Event UI 只有 attributes/raw preview |
| E017 | confirmed_fact | API sensitive attribute handling | 当前 GenAI 正文字段默认 redacted/限长 |
| E018 | confirmed_fact | 本机 Codex `0.150.1` binary | static stripped，未命中 AgentSight offset 表 |
| E019 | supported_inference | 本机 Claude Code `2.1.170` binary | Bun/BoringSSL，当前 fixed libssl attach 很可能失效 |
| E020 | confirmed_fact | [AgentSight 官方采集文档](https://help.aliyun.com/zh/sls/collect-ai-agent-observability-agentsight-logs) | TLS/HTTP/SSE/event.id/delta 与兼容边界 |
| E021 | confirmed_fact | [AgentSight commit `5e3c6ba`](https://github.com/alibaba/anolisa/tree/5e3c6bab8e1727dd478c7a00184c3c5b3380b8a9/src/agentsight) | 开源 pipeline 与版本化 Codex offset 做法 |
| E022 | confirmed_fact | [AgentLoop 审计接入](https://help.aliyun.com/zh/document_detail/3045692.html) | 应用语义 + eBPF Runtime 双链并用 |
| E023 | confirmed_fact | [OTel GenAI content guidance](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) | 内容敏感、opt-in、生产推荐外部存储 |
| E024 | confirmed_fact | OTel Execute Tool Span | ToolCall ID、参数、结果、duration 词汇 |
| E025 | confirmed_fact | [OTel MCP conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md) | JSON-RPC/MCP/Tool/W3C context 关联 |
| E026 | confirmed_fact | [MCP 2026-07-28 Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) | stdio newline JSON-RPC 与 request-scoped Streamable HTTP |
| E027 | confirmed_fact | [Codex OTel](https://learn.chatgpt.com/docs/config-file/config-advanced) | Codex API/SSE/prompt/tool telemetry 范围 |
| E028 | confirmed_fact | [Codex Hooks](https://learn.chatgpt.com/docs/hooks) | turn/tool ID、input/response、prompt/final message |
| E029 | confirmed_fact | [Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage) | raw API body、content file ref、trace 与关联字段 |
| E030 | confirmed_fact | [Claude Hooks](https://code.claude.com/docs/en/hooks) | built-in/MCP tool 原始 input/output |
| E031 | confirmed_fact | [Claude secure proxy](https://code.claude.com/docs/en/agent-sdk/secure-deployment) | 显式 sampling proxy 与 TLS MITM 边界 |
| E032 | confirmed_fact | [Dify OpsTraceManager](https://github.com/langgenius/dify/blob/main/api/core/ops/ops_trace_manager.py) | workflow/message/node/tool 输入输出和时间可用 |
| E033 | confirmed_fact | [Dify #36122](https://github.com/langgenius/dify/issues/36122) | 全局 OTel provider 的多租户隔离风险实例 |
| E034 | confirmed_fact | [DeepFlow Agent](https://deepflow.io/docs/configuration/agent/) | Go TLS 与 OpenSSL 需要不同 uprobe 解析 |
| E035 | project_claim | 用户提供的 KCD 参考图（原始文件未入库） | TLS 明文与 MCP pipe 采集点设想 |
| E036 | confirmed_fact | `AgentsPage.tsx: AgentActionTrace` | 已有工具顶层行为与嵌套内核证据 UI |
| E037 | confirmed_fact | `deploy/observer.yaml: A3S_OBSERVER_SSL` | K8s 清单选择启用 SSL capture |
| E038 | confirmed_fact | `docs/agent-discovery-filter.md: Logical Agent` | 共享进程不能仅凭内核事实区分多个逻辑 Agent |
| E039 | confirmed_fact | AnySentry deployment manifests | 当前没有配置 interaction object store |

## 附录 B：验证记录

本次只运行仓库已有、与结论直接相关的验证，没有启动生产部署或调用外部模型：

```text
Observer:
  cargo test -p a3s-observer-collector --bin a3s-observer-collector
  -> 86 passed, 0 failed

AnySentry:
  pnpm verify:s6-tool-evidence
  -> API build passed
  -> Pi adapter verification passed
  -> Tool↔kernel evidence linker verification passed
  -> durable ToolEvidence relation verification passed
```

这些结果证明当前事件时间、队列/顺序和语义工具关联的命名测试行为；不证明任一真实 Agent 的 TLS 正文完整率、生产性能或跨版本兼容性。[E006][E014]
