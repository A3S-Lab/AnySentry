# AnySentry Agent 用户指令无侵入观测与全链路对话追踪设计

> 状态：架构方向确认；受控加密 Fixture 闭环已实现；生产 Runtime ABI、
> Turn 并发模型和安全边界待验证后冻结
>
> 日期：2026-08-27，2026-08-28 更新
>
> 适用仓库：`AnySentry` 与独立的 `Observer`
>
> 核心原则：无侵入优先、能力分级、可选增强、证据来源透明

## 1. 决策摘要

AnySentry 将通过 eBPF TLS 明文观测，在不修改 Agent 源码、不强制安装 Hook、
不修改 LLM `baseURL` 的前提下，采集受支持 Agent 实际发送给 LLM Provider
的用户消息，并将其与 Observer 观测到的模型调用、工具意图、命令、进程、
文件、DNS、网络和 MCP 行为关联，形成全链路对话追踪。

产品定义固定为：

> AnySentry 通过无侵入式 TLS 明文观测，采集受支持 Agent 实际发送给 LLM
> Provider 的用户消息。该消息可能经过 Agent 的模板展开、上下文拼接或改写，
> 不等同于用户最初键入的原始文本。

核心事件命名为：

```text
LlmRequestObserved
└─ UserInstructionObserved
```

`UserInstructionObserved` 是 Observer 从实际 Provider 请求中提取出的观测事实，
不是 Agent 输入端声明的权威 `UserInstruction`。

基础模式保持无应用侵入；OTel、SDK Hook、IDE/CLI Adapter、LLM Gateway 和
MCP Relay 仅作为可选增强，用于扩大正文覆盖面或将推断关联提升为精确语义关联。

当前唯一有效的评审结论是：

> 架构方向正式确认，但设计尚未冻结；Runtime、并发关联、持久化和安全四项
> Gate 全部通过后，才允许进入正式实施。

在真实认证、服务端 RBAC、租户密钥、内容审计和删除能力完成前，生产环境严格
限定为源头 `metadata-only`。Phase -1 可以在隔离测试环境使用受控 Fixture 验证
TLS 明文能力，但不得据此开放生产正文采集。

2026-08-28 的实现进度不改变上述生产约束：AnySentry 已为
`ebpf_stdin + isolated_fixture` 增加独立 AES-256-GCM ContentStore、
`ContentStore finalize + Kafka durable ack` Receipt、只含内容引用的 PG/CH
投影，以及“管理凭据 + 独立正文凭据 + 调查原因”的按需查看和审计删除闭环。
真实 `codex exec -` 的受控 stdin 已完成端到端验证。该能力用于完成安全与
持久化 Gate 的可执行证明，默认部署缺少显式配置时仍严格为 `metadata-only`。

当前开发实例可按明确调试需求设置
`ANYSENTRY_INTERACTION_UNSAFE_LOCAL_DIRECT_VIEW=on`，使
`isolated_fixture` 会话在页面中无密钥自动显示正文。该旁路只覆盖只读状态、
会话和正文 GET，不覆盖管理写入或正文删除；它必须在共享环境和生产 Manifest
中保持不存在，不能作为正式认证设计的一部分。

## 2. 目标与非目标

### 2.1 目标

系统需要回答：

- 哪个 Agent Asset 和 Agent Instance 发起了模型调用；
- Agent 实际向哪个 Provider、哪个模型发送了什么用户消息；
- 请求是否完整、截断、部分缺失、仅有元数据或被策略禁止保留；
- 模型何时开始响应、何时结束、是否提出 ToolCall；
- ToolCall 对应哪些实际命令、进程、文件、DNS、Egress 或 MCP 行为；
- 一次用户指令触发了多少次 ModelCall、多少次 ToolCall 和哪些底层副作用；
- 最终回复是什么；
- 每一条内容和关系来自哪一种采集方式，完整性和关联置信度是多少。

目标展示链路：

```text
用户指令
→ LLM Request
→ LLM Response
→ ToolCall 意图
→ ToolExec / Process
→ File / DNS / Egress / MCP
→ 后续 LLM Request
→ 最终 Assistant Response
```

### 2.2 非目标

本方案不声称：

- 还原用户最初键入、粘贴或语音输入的原始文本；
- 获取 Provider 内部未返回的隐藏推理；
- 证明 Provider 内部最终向模型暴露了哪些经过内部加工的数据；
- 使用一个 OpenSSL 探针覆盖所有 Node、Python、Codex、Claude、Go 和 Rust Agent；
- 仅凭时间接近证明两个事件存在确定因果关系；
- 记录操作系统、Agent 或 Provider 内部的所有动作；
- 在采集失败或覆盖未知时将空数据解释为“没有调用”。

“全部动作”仅表示当前 Capture Profile 已启用的 Observer 探针能够观测到的动作。

## 3. 总体架构

```text
Agent 进程
  │
  ├─ SSL_write / SSL_write_ex ──→ 请求明文
  ├─ SSL_read / SSL_read_ex   ──→ 响应明文
  ├─ exec / exit              ──→ 命令与进程
  ├─ file read/write/delete   ──→ 文件行为
  ├─ connect / DNS            ──→ 网络行为
  └─ Pipe / MCP               ──→ 工具协议
          │
          ▼
Observer eBPF
  │
  ├─ Agent 目标过滤
  ├─ TLS Runtime 适配
  ├─ 有界明文分片
  └─ 独立 Ring Buffer
          │
          ▼
Observer Interaction Collector
  │
  ├─ TLS 连接与请求重组
  ├─ HTTP/1.1、HTTP/2、WebSocket 解析
  ├─ SSE 响应聚合
  ├─ Provider Payload 解析
  ├─ 用户指令提取
  ├─ 结构化脱敏
  └─ Completeness / Loss Ledger
          │
          ▼
AnySentry Interaction Ingest
  │
  ├─ Source 认证与 Scope Binding
  ├─ Agent 身份解析
  ├─ 幂等与冲突检测
  ├─ 正文加密存储
  └─ metadata/contentRef 写入 Kafka
          │
          ▼
Flink ObservedTurnCorrelator
  │
  ├─ Conversation / Turn 会话化
  ├─ 多次 ModelCall 聚合
  ├─ ToolCall 与底层行为关联
  ├─ 多源去重
  └─ 迟到事件 Revision
          │
          ├─ PostgreSQL：会话当前状态
          ├─ ClickHouse：事实、性能和关联历史
          └─ ContentStore：加密正文
                    │
                    ▼
               /conversations
```

### 3.1 三条证据 Lane

长期目标允许三条 Lane 汇入同一个 Interaction Plane：

| Lane | 主要来源 | 可以证明 | 不能单独证明 |
| --- | --- | --- | --- |
| Runtime | Observer eBPF | 进程、文件、网络、TLS 传输和内核时间 | 精确的逻辑 Session/Turn |
| Protocol | LLM Gateway、MCP Relay | 实际协议请求/响应、request ID | 本地工具实际执行和系统副作用 |
| Native | OTel、Hook、Agent Adapter | Session、Turn、ToolCall 和逻辑 Workflow | 未上报的底层副作用不存在 |

默认产品路径是 Runtime Lane。Protocol 和 Native Lane 为可选增强，不是无侵入基础
能力的前置条件。

不同 Lane 不得静默覆盖彼此的原始证据。服务端保存每个来源的 Observation，并通过
稳定关联记录组成统一 Interaction。

## 4. Observer TLS 采集层

### 4.1 当前实现缺口

截至 2026-08-28，`Observer/a3s-observer-common/src/lib.rs` 中的实验
`SslEventHeader schema_version=4` 已包含：

- `cgroup_id`；
- `pid`、`tid`；
- 本地读写操作；
- SSL 指针；
- 调用序号、分片序号、分片偏移、原始长度；
- 明确的 `truncated`；
- 每条 Ring Record 最多 31 KiB 内容；
- 当前 Phase -1 只挂载出站 `SSL_write*`，不读取响应正文；
- P95 范围内最多四片走静态直达路径，更大调用通过 `bpf_loop`；
- 对单次成功 OpenSSL 写入最多采集并重组 1 MiB；
- 进程名。

它仍缺少：

- 进程启动时间；
- SSL 生命周期与 generation；
- FD、连接和 Provider Peer；
- HTTP/2 Stream ID；
- 请求与响应配对 ID；
- 分片级 Ring Drop 的稳定关联。

隔离 Fixture 已取消“逐片段转 UTF-8 并进入普通 NDJSON”的旧路径，改为专用
`0600` Artifact，并在用户态实现有界 HTTP/1.1 `Content-Length`、chunked、gzip
和跨 SSL Call 重组。真实 Python/OpenSSL Fixture 已完整还原 276,034 字节与
1,012,036 字节的用户指令；超过 1 MiB 的单次调用仍明确标记为不完整。该实现尚
不能支持 HTTP/2、SSE 或 WebSocket，也不属于生产正文能力。共享工作站上的
declared-load 正确性、零丢包、资源和安全检查通过，但 2% P95/TTFT 性能门槛未
通过，且前后 metadata 基线不稳定；必须在专用安静基准节点执行完整
900 秒 metadata + 900 秒 Fixture + 900 秒 metadata 后才能重新评审 Gate A。

### 4.2 新的分片 ABI

新增独立结构：

```text
TlsPlaintextFragmentV2
```

建议字段：

```text
schemaVersion
bootIdHash
cgroupId
pid
tid
processStartTime
sslPointer
sslGeneration
fd
connectionId
sslOperation
ioDirection
callSequence
fragmentIndex
fragmentOffset
capturedLength
originalLength
observedAtMonotonicNs
observedAtUnixNs
captureProfile
truncated
data
```

eBPF 层只能声明本地 TLS 调用及 I/O 方向：

```text
sslOperation = write | read
ioDirection = egress | ingress
```

`SSL_write/read` 本身不能证明载荷是 HTTP Request/Response。只有用户态 HTTP、
HTTP/2 或 WebSocket Parser 成功解析后，Interaction 层才能赋予：

```text
messageType = request | response
```

`data` 必须保留原始字节，不能在 eBPF 或 Collector 入口使用 lossy UTF-8 转换。

### 4.3 TLS 函数支持

第一阶段支持：

```text
SSL_write
SSL_read
SSL_write_ex
SSL_read_ex
```

`SSL_write` 不能继续只在函数入口直接上报请求长度，因为调用可能失败或只写入部分
字节。正确流程为：

```text
函数进入：
  保存 sslPointer、buffer、requestedLength 和 callSequence

函数返回：
  读取真实 writtenLength
  只有成功写出的字节才能形成 Fragment
```

`SSL_read/read_ex` 在函数返回时读取已经解密的 Buffer。

还需要根据 Runtime 支持情况监听：

```text
SSL_new
SSL_free
SSL_set_fd
SSL_set_bio
```

用于处理 SSL 指针复用、FD 映射、BIO 映射和连接生命周期。

### 4.4 精准目标过滤

Uprobe 通常挂载到动态库或可执行文件 inode，再通过 BPF Map 过滤目标进程，不为
每个 PID 复制一整套探针。

目标键：

```text
cgroupId
+ pid
+ processStartTime
```

策略值：

```text
agentInstanceId
captureMode
allowedProviderEndpoints
maxBytesPerCall
maxBytesPerMinute
expiresAt
policyRevision
```

只有同时满足以下条件的流量可以进入明文 Ring：

- Agent 已确认为 Confirmed，或 Candidate 策略明确允许；
- PID、进程启动时间和 cgroup 与目标实例一致；
- 目标地址属于允许的 LLM Provider；
- Capture Policy 未过期；
- 当前进程和租户未超过配额。

不得对整台主机的所有 TLS 流量进行无差别正文采集。

### 4.5 TLS Runtime 自动发现

Observer 需要检查：

```text
/proc/<pid>/exe
/proc/<pid>/maps
/proc/<pid>/root
ELF build-id
executable/library inode
binary fingerprint
```

并建立能力注册表：

```text
runtimeFingerprint
binaryPathOrInode
tlsImplementation
tlsVersion
probeStrategy
supportedSymbolsOrOffsets
protocolCapabilities
status
lastVerifiedAt
```

状态固定为：

```text
full
partial
metadata_only
unsupported
```

动态 OpenSSL 可以按符号挂载。静态 Node、Codex、Bun/BoringSSL、Go `crypto/tls`
和 Rustls 需要独立适配策略，不能因为 `A3S_OBSERVER_SSL=1` 就声明已经覆盖。

### 4.6 Agent 输入边界 Adapter

TLS Lane 观测的是“Agent 发给 LLM 什么”。部分 CLI Runtime 还存在更靠前的输入
边界，可观测“什么被输入给 Agent”。两类事实必须分开：

```text
AgentInputObserved
  inputScope=agent_process_stdin
  └─ UserInstructionObserved

LlmRequestObserved
  requestScope=agent_to_llm
  └─ UserInstructionObserved
```

二者不能互相覆盖。Agent 可能在两者之间添加 system prompt、历史消息、工具结果、
检索上下文或安全策略。

2026-08-28 已对 `codex-cli 0.147.0` 完成首个隔离 Spike。实际 Codex 是静态
Rust/rustls 二进制，OpenSSL uprobe 不适用；非交互式 `codex exec -` 直接从 fd0
读取初始指令。实验 tracepoint 仅在以下 Gate 同时成立时附着：

```text
captureMode=fixture_payload
environment=isolated_test
explicitPlaintextConfirmation=true
exactPidAllowlist contains tgid
fd=0
globalKillSwitch=enabled
```

`sys_enter_read` 只保存 Buffer，`sys_exit_read` 成功后才复制实际返回字节，EOF
形成一条边界。真实 native Codex Fixture 已将 87 字节 Ground Truth 精确还原，
Codex 正常返回 `OK`，普通 Observer 输出泄漏为 0。使用 Node 启动器 PID 时没有
采集到其 native 子进程内容，证明 allowlist 没有隐式扩展到进程树。

该边界目前只适用于一次性 stdin + EOF。交互式 TUI/PTY、一个进程内多个输入、
app-server 和 IDE RPC 必须先识别各自 Frame/Submit 边界；禁止把整段终端字节流、
按键编辑过程或进程生命周期错误当成一条用户指令。该 Adapter 当前仍是
`fixture_only`，生产 metadata-only 不加载 tracepoint。

## 5. 用户态协议重组与 Provider 解析

### 5.1 连接重组键

基础重组键：

```text
bootId
+ processStartTime
+ pid
+ sslPointer
+ sslGeneration
+ ioDirection
```

HTTP/2 增加：

```text
streamId
```

WebSocket 增加：

```text
messageSequence
```

不能使用“一个 Socket 等于一次模型调用”的假设。一个连接可能顺序承载多个
HTTP/1.1 请求，也可能通过 HTTP/2 或 WebSocket 并发承载多个调用。

### 5.2 协议支持顺序

第一版支持：

- HTTP/1.1；
- `Content-Length`；
- chunked；
- gzip；
- OpenAI-compatible Chat；
- OpenAI Responses HTTP/SSE；
- Anthropic Messages HTTP/SSE；
- 出站用户消息。

后续支持：

- HTTP/2 Frame 与 HPACK；
- WebSocket；
- Gemini；
- Brotli；
- MCP Streamable HTTP；
- 其他 Provider 插件。

SSE 主要影响响应采集。Query 完整性主要受 HTTP/2、WebSocket、请求压缩、
TLS 片段丢失、采集配额和 Runtime 支持情况影响。

### 5.3 有界资源

以下参数必须可配置，并在真实压测后冻结默认值：

```text
fragmentBytes
maxFragmentsPerTlsCall
maxRequestBytes
maxResponseBytes
maxConnectionsPerProcess
maxInflightBytesPerAgent
reassemblyTimeout
```

超过限制时：

- 停止正文采集；
- 继续输出 metadata；
- 标记 `truncated`、`partial` 或 `content_quota_exceeded`；
- 增加 Loss Ledger；
- 绝不阻塞 Agent。

### 5.4 Provider Parser

实现版本化插件：

```text
OpenAIChatParser
OpenAIResponsesParser
AnthropicMessagesParser
GeminiParser
OpenAICompatibleParser
```

Parser 输出：

```text
provider
model
protocol
requestPath
stream
messages
toolDefinitions
toolCalls
usage
finishReason
providerRequestId
```

用户消息提取：

| 协议 | 提取位置 |
| --- | --- |
| OpenAI Chat | `messages` 中最新的 `role=user` |
| OpenAI Responses | `input` 字符串或 `input[]` 中的用户项 |
| Anthropic Messages | `messages` 中最新的 `role=user` |
| Gemini | `contents` 中最新的用户内容 |

多模态内容拆分为文本、图片元数据、附件引用和 MIME Type。默认不保存附件原文。

## 6. Interaction 数据契约

### 6.1 层级

```text
agentAssetId
└─ agentInstanceId
   └─ observedConversationId
      └─ observedTurnId
         ├─ modelCallId
         │  └─ attemptId
         ├─ toolCallId
         └─ actionId/evidenceId
```

### 6.2 LlmRequestObserved

```json
{
  "schemaVersion": "anysentry.agent_interaction.v1",
  "eventType": "LlmRequestObserved",
  "sourceEventId": "src_evt_xxx",
  "tenantId": "tenant_xxx",
  "sourceId": "source_xxx",
  "collectorId": "collector_xxx",
  "agentInstanceId": "instance_xxx",
  "processInstanceId": "process_xxx",
  "observedConversationId": "observed_conv_xxx",
  "observedTurnId": "observed_turn_xxx",
  "modelCallId": "model_call_xxx",
  "attemptId": "attempt_xxx",
  "captureMethod": "ebpf_tls",
  "captureAuthority": "observer_inferred",
  "protocol": "openai_responses",
  "provider": "openai",
  "model": "gpt-*",
  "captureCompleteness": "complete",
  "parseStatus": "parsed",
  "rawRetentionState": "encrypted",
  "presentationState": "redacted",
  "observedAtUnixNs": "1787800000000000000"
}
```

### 6.3 UserInstructionObserved

```json
{
  "eventType": "UserInstructionObserved",
  "messageRole": "user",
  "redactedContent": "检查当前项目的依赖漏洞",
  "contentHmac": "hmac-sha256:...",
  "contentRef": "blob_xxx",
  "originalBytes": 42,
  "storedBytes": 42,
  "captureCompleteness": "complete",
  "completenessReason": null,
  "parseStatus": "parsed",
  "rawRetentionState": "encrypted",
  "presentationState": "redacted",
  "extractionConfidence": 0.98,
  "identityConfidence": 0.95,
  "protocolConfidence": 1.0,
  "truncated": false,
  "redactionPolicyVersion": 3
}
```

上述示例只适用于认证、RBAC、租户密钥和 Raw Content 安全 Gate 已通过的环境。
在当前生产 `metadata-only` 模式下，`redactedContent`、`contentHmac` 和
`contentRef` 均不得产生。

### 6.4 采集、解析、保留与呈现状态

以下状态必须正交保存，不能再把 `redacted` 或 `metadata_only` 混入完整性：

```text
captureCompleteness:
  complete | partial | truncated | unavailable

parseStatus:
  not_attempted | parsed | fallback | failed

rawRetentionState:
  encrypted | not_retained

presentationState:
  redacted | metadata_only | unavailable
```

`rawRetentionState=encrypted` 与 `presentationState=redacted` 可以同时成立：系统可以
保存经过授权的加密原文，但默认只呈现脱敏视图。

原因至少包含：

```text
unsupported_runtime
probe_attach_failed
ring_drop
fragment_missing
reassembly_timeout
unsupported_protocol
parse_failed
content_quota_exceeded
content_not_retained_by_policy
content_store_failed
```

没有 Interaction 记录不能解释为“没有调用”。

### 6.5 稳定 ID 与幂等

建议 Source 事件身份包含：

```text
collectorId
+ bootId
+ processStartTime
+ sslGeneration
+ requestSequence
+ sslOperation
+ operation
```

逻辑键：

```text
tenantId + sourceId + sourceEventId + operation
```

同键同 Payload Fingerprint 是 duplicate/no-op；同键不同 Payload 是 conflict，不允许
覆盖原记录或推进提交进度。

内容指纹使用租户级 HMAC：

```text
HMAC-SHA256(tenantKey, normalizedContent)
```

HMAC 只能在租户隔离、版本化密钥、密钥轮换和明确授权范围均已完成后启用。HMAC
同样要求接触明文，不能将其视为 `metadata-only`。在安全 Gate 通过前，不计算
Query HMAC。

不使用普通 SHA-256 作为短 Query 的唯一内容指纹，以降低字典反查风险。内容 HMAC
仅用于完整性、重复候选比较和受控关联信号，绝不能作为 Conversation 或 Turn 身份。
## 7. Conversation 与 Turn 关联

### 7.1 Flink 状态机

新增：

```text
ObservedTurnCorrelator
```

Flink 首先按以下 Process Scope 分区：

```text
tenantId
+ agentInstanceId
+ processInstanceId
```

该 Key 只限定处理分区，不能作为唯一 Turn Key。同一 Agent 进程可能并发处理多个
会话，因此每个 Process Scope 内必须维护有界的多活跃 Turn Map：

```text
MapState<TurnDiscriminator, ActiveTurn>
```

`TurnDiscriminator` 按以下强证据优先构造：

1. `nativeTurnId` 或受信 `sessionId + turnId`；
2. `previous_response_id`、Provider conversation ID 或明确的请求链；
3. `modelCallId/attemptId` 与前序 ToolCall/ToolResult 引用；
4. HTTP/2 `streamId`、WebSocket message ID 与同一协议上下文；
5. 版本化的请求上下文指纹。

`requestSequence` 和 `streamId` 可以区分一次传输或 ModelCall，但不能单独证明两个
ModelCall 属于同一个 Turn。没有足够证据区分并发会话时，事件必须标记为
`ambiguous` 或 `unassigned`，不得按时间接近强行归入任一活跃 Turn。

每个 Active Turn 独立运行以下状态机：

```text
IDLE
  ↓ UserInstructionObserved
TURN_OPEN
  ↓ LlmRequest
MODEL_RUNNING
  ↓ LlmResponse 包含 ToolCall
TOOL_PENDING
  ↓ ToolExec / File / Egress / MCP
TOOL_RUNNING
  ↓ ToolResult 进入后续请求
MODEL_RUNNING
  ↓ 最终 Response 且无 ToolCall
TURN_SETTLING
  ↓ 静默、下一条 Query 或超时
TURN_COMPLETE
```

一次 LLM Response 只结束一个 `ModelCall`，不能直接结束整个 Turn。

多活跃 Turn Map 必须限制：

```text
maxActiveTurnsPerProcess
maxEventsPerTurn
maxBytesPerTurn
turnIdleTimeout
turnAbsoluteTimeout
```

超过限制时保留原始 Observation 和 Loss Ledger，将无法安全分配的关系降级为
`unassigned`，不能通过丢弃旧 Turn 后把新事件错误并入剩余 Turn。

### 7.2 工具与底层行为

关联优先级：

1. 相同 `toolCallId`、`traceId` 或 MCP request ID；
2. 同一进程树，并且命令、文件或资源 Hash 一致；
3. 同一 Agent Instance、同一 Turn 和受控事件时间窗口；
4. 仅时间接近的关系保持推断或未分配。

关联等级：

```text
exact
strong
inferred
unassigned
```

每条关系保存：

```text
correlationMethod
correlationConfidence
causalStatus
evidenceIds
relationRevision
```

可关联行为：

- `ToolExec`；
- `ProcessStart/ProcessExit`；
- `FileAccess/FileDelete`；
- `Dns/Egress`；
- `MCP tools/call`；
- `SecurityAction`；
- `Trace/Span`；
- `Evidence Bundle`；
- 后续 `ModelCall`；
- 最终 `AssistantResponseObserved`。

### 7.3 进程树边界

Turn 绑定 `rootProcessInstanceId`。自动关联只允许：

- Root 进程；
- 可证明的子进程；
- 相同受信 cgroup；
- 直接派生的文件与网络行为。

后台任务、共享 Worker 和跨进程异步任务必须降低置信度或保持未分配。

### 7.4 指令前置行为

TLS 观测只能在 Agent 向 Provider 发送请求时看到用户消息。Agent 在此之前发生的
上下文读取无法天然证明属于该指令。

可选地为已授权 Agent 维护短时、有界行为 pre-roll。Query 出现后，只能将此前行为
标记为：

```text
inferred_pre_request
```

不得声明为确定因果。

### 7.5 重复 Query 与工具循环

一个用户指令可能在工具循环的每次 Model Request 中重复出现。

正确关系：

```text
一个 ObservedTurn
一个 UserInstructionObserved
多个 modelCallId
每个 modelCallId 可以有多个 attemptId
```

`contentHmac` 相同只能说明内容相同，不能证明是同一个用户、会话或 Turn。两个用户
可以同时输入相同文本，因此不得再使用以下条件直接复用指令：

```text
agentInstanceId
+ processInstanceId
+ contentHmac
```

只有同时存在以下至少一类连续性证据时，才能判断重复文本来自同一个工具循环：

- 相同受信 `nativeTurnId`；
- `previous_response_id` 指向前一个 ModelCall；
- 后续请求携带前一个 ToolCall 的 ToolResult；
- 明确的 Provider 请求链或 Conversation ID；
- 同一 Active Turn 内可验证的上下文指纹演进。

没有连续性证据时，即使 `contentHmac` 相同，也要创建独立 Turn Candidate，或在并发
无法区分时标记 `ambiguous`。Turn 已关闭后再次出现相同文本，始终创建新 Turn。

### 7.6 迟到事件

原始 Observation 不可覆盖。迟到行为通过追加：

```text
TurnActionRelationRevision
```

补充关系。Flink 使用事件时间、真实 Watermark 和 Allowed Lateness，不使用 API 当前
时间伪造完整性。

## 8. AnySentry 接入与存储

### 8.1 专用 API

新增：

```http
POST /security-center/interactions/ingest
GET  /security-center/conversations
GET  /security-center/conversations/:conversationId
GET  /security-center/turns/:turnId
GET  /security-center/interactions/:interactionId/content
```

不复用当前 `/security-center/ingest/events` 传输完整正文。现有通用事件路径会限制
字符串长度和敏感字段，并且不具备内容独立授权、删除和审计语义。

Interaction Ingest 负责：

- Source 认证；
- tenant/environment/workspace/workload/agent Scope Binding；
- Agent 身份解析；
- Schema、深度和大小限制；
- 幂等与冲突检测；
- ContentStore 写入；
- Kafka 持久确认；
- 逐项 Durable Receipt。

### 8.2 存储职责

| 存储 | 内容 |
| --- | --- |
| PostgreSQL | Conversation、Turn、Message 当前状态、权限和删除状态 |
| ClickHouse | Interaction metadata、ModelCall 性能、Token、完整性和关系 Revision |
| Kafka | metadata、contentRef 和关联事件，不保存明文 |
| ContentStore | 加密 Query、Response、Tool 参数和结果 |
| Redis | 短期在线状态和临时缓存，不保存长期正文 |

完整 Query 不进入现有 `events.attributes` 或 `rawPreview`。

### 8.3 ContentStore

稳定接口：

```text
putTemporary
finalize
readRedacted
readRawAuthorized
delete
rotateKey
```

开发/PoC：

```text
本地加密文件 ContentStore
```

生产：

```text
MinIO、S3 或云对象存储
```

不建议使用 ClickHouse 保存完整正文，避免重新引入大字段写入、Merge、备份和查询
压力。

提交顺序：

```text
验证 Source 和策略
→ 为 sourceEventId/contentRole 派生稳定 blobId
→ 流式写入临时加密对象
→ 计算已授权的 HMAC/Hash
→ ContentStore 原子 finalize
→ Kafka 写入 metadata/contentRef 并取得 durable ack
→ 返回 Durable Receipt
→ PostgreSQL/ClickHouse 异步投影
```

`ContentStore finalize` 与 Kafka 不可能构成跨系统原子事务。正式接收成功边界定义为：

```text
ContentStore finalize succeeded
+ Kafka durable ack succeeded
```

只有两者均成功后才能返回包含正文引用的 Durable Receipt。若策略为
`metadata-only`，则不访问 ContentStore，以 Kafka durable ack 作为接收成功边界。

PostgreSQL 和 ClickHouse 是可重放投影，不进入 Receipt 事务边界。Receipt 应明确
返回：

```text
sourceEventId
contentDisposition
blobId（若存在）
kafkaDurable
projectionStatus = pending
acceptedAt
```

还必须实现：

- ContentStore 已 finalize、Kafka 尚未成功时的幂等重试；
- Kafka 写入前进程崩溃产生的孤儿 Blob TTL 清理；
- Blob Manifest 与 Kafka metadata 的周期对账；
- Kafka 重放重建 PostgreSQL/ClickHouse 投影；
- 每个 Source/Partition 的提交游标与消费进度；
- 投影失败、重试和 DLQ 的可查询状态；
- Receipt 已返回后投影延迟不得被解释为数据丢失。

正文保存失败时保留 `content_store_failed` 状态，但不得标记为完整或返回虚假的正文
Durable Receipt。

## 9. 安全与隐私

### 9.1 Capture Mode

```text
off
metadata
redacted
encrypted_full
```

当前 AnySentry 明确处于：

```text
authenticationRequired = false
authorizationEnforced = false
```

因此，在真实认证、服务端 RBAC、租户密钥、访问审计、删除和密钥轮换全部完成前，
生产环境强制执行：

```text
captureMode = metadata
encrypted_full = disabled
redacted content = disabled
Raw View = disabled
Candidate pre-roll = disabled
Query HMAC = disabled
ContentStore writes = disabled
```

该限制必须由服务端和 Observer Capture Policy 强制执行，不能只隐藏前端入口。

安全 Gate 通过后的目标策略才可以是：

| 分类 | Gate 通过后的默认策略 |
| --- | --- |
| Confirmed Agent | `redacted`；授权 Workspace 可启用 `encrypted_full` |
| Candidate Agent | 默认 `metadata`；显式租户政策可允许短 TTL 加密预采集 |
| Unknown | `metadata`；默认不允许正文 pre-roll |
| Non-Agent | 不采集正文并删除未使用 pre-roll |

正文策略与内核 Capture Profile 分离。允许正文不等于允许整机 TLS 全量采集。

### 9.2 metadata-only 的源头约束

`metadata-only` 必须在采集源头执行，不能实现为“先抓明文、再丢弃”。该模式必须
同时满足：

- eBPF 不读取 TLS Payload Buffer；
- 不调用 `bpf_probe_read_user` 复制请求或响应正文；
- 明文 Fragment Ring 不产生任何正文记录；
- Collector 只接收长度、时间、进程、连接、SNI/DNS 和目标地址等元数据；
- Provider 只能通过目标地址、SNI/DNS 映射判断；
- Provider 无法确认时标记 `unknown`；
- 不读取请求体识别 Model；
- 不计算 Query Hash 或 HMAC；
- 不生成 `UserInstructionObserved`；
- 不写 `contentRef` 或 ContentStore。

metadata-only 可以产生：

```text
LlmTransportObserved
provider = known | unknown
requestBytesApprox
responseBytesApprox
latency
ttftApprox
processInstanceId
agentInstanceId
captureCapability
```

其中 `latency` 与 `ttftApprox` 必须同时携带证据范围。当前基于 Socket
读写和关闭事件的实现只能标记为 `timingScope=connection`；HTTP/2、WebSocket
或复用 HTTP/1.1 长连接不能据此生成请求级时延。证据不足时必须使用
`timingScope=unavailable`，且相应时间值不得出现。

它不能产生或暗示：

```text
UserInstructionObserved
model
message role
tool call body
query fingerprint
```

Phase -1 只允许在隔离测试环境、受控 Fixture、明确授权和一键 Kill Switch 下临时启用
Payload读取。该例外不能进入生产默认配置。

### 9.3 结构化脱敏

先按 Provider 协议结构处理，再使用补充规则：

- 永久删除 Authorization；
- 永久删除 Cookie；
- 删除 API Key、Token、密码和私钥；
- 删除或 Hash URL Query 与预签名 URL；
- Tool 参数按字段执行 mask/hash/drop；
- PII 按租户 DLP 策略处理；
- 附件默认只保留元数据和引用。

### 9.4 明文边界

原始明文不得进入：

- Observer 普通日志；
- NDJSON 调试输出；
- Kafka 消息；
- ClickHouse `events.attributes`；
- `rawPreview`；
- Redis 长期缓存；
- URL；
- Prometheus Label；
- 错误消息。

Raw View 必须满足：

- 独立权限；
- 明确查看原因；
- 全量访问审计；
- 默认禁止批量下载；
- 支持删除、TTL 和密钥轮换；
- 不得自动拼入 AnySentry AI Assistant 的 System Prompt。

## 10. 性能与可靠性

### 10.1 独立内容 Lane

TLS 正文使用独立 Ring、队列和配额，不能挤占：

- Process；
- ToolExec；
- SecurityAction；
- File/Delete；
- Agent 生命周期。

内容通道过载时可以降级正文，但底层安全事实不能被正文采集拖垮。

### 10.2 有界背压

以下层级全部必须有界：

```text
eBPF Ring
Collector Reassembly
Forwarder Queue
Local Encrypted Spool
Interaction Ingest
Kafka Producer
ContentStore Inflight
Flink State
```

达到限制时：

- metadata 优先；
- 正文标记 partial/drop；
- 记录精确 Drop Accounting；
- Agent 继续运行；
- 不创建无界 Promise、内存队列或重试风暴。

### 10.3 流式响应

SSE/WebSocket 不按 Token 写 Kafka 或 ClickHouse。Collector 或 Gateway 聚合：

- response start；
- first byte/first token；
- response end；
- usage；
- final content。

### 10.4 Loss Ledger

至少记录：

```text
probeAttempted
probeAttached
probeUnsupported
fragmentsObserved
fragmentsRingDropped
fragmentsAdmitted
reassemblyComplete
reassemblyPartial
parseSucceeded
parseFailed
interactionAccepted
contentStored
contentStoreFailed
uiVisible
```

守恒关系：

```text
observed
= rejectedByPolicy
+ droppedBeforeQueue
+ admitted

admitted
= parseFailed
+ unpairedPartial
+ pairedComplete

pairedComplete
= metadataOnly
+ contentStoreFailed
+ visibleWithContentRef
```

计数单位必须区分物理 Fragment、HTTP Attempt、ModelCall、UserInstruction、Turn 和
Content Blob。

## 11. Agent 覆盖矩阵

| Agent 类型 | 身份与底层动作 | 用户消息内容 | 处理策略 |
| --- | --- | --- | --- |
| Python 动态 OpenSSL | 高 | 首批支持 | 动态符号挂载 |
| 普通 Node | 高 | 取决于 Node 链接方式 | 自动发现 libssl 或 Node 符号 |
| Pi Agent | 已有身份基础 | 首批验证 | 对实际 Node 镜像验收 |
| Codex CLI | 高 | `exec -` stdin Fixture 正确性通过；LLM 请求与交互模式未支持 | stdin 边界 Adapter + 后续 build-id/protocol 适配 |
| Claude Code | 高 | Bun/BoringSSL 需专用适配 | 指定支持版本 |
| Go Agent | 高 | 需要 Go `crypto/tls` 适配 | 后续专项 |
| Rust Agent | 高 | 需要 Rustls/OpenSSL 适配 | 后续专项 |
| Dify Worker | Runtime 高 | 仅凭 PID 无法区分 Workflow | 可选 Dify Trace Adapter |
| MCP stdio | 进程可见 | Pipe 解析尽力而为 | MCP Relay 可选增强 |
| 浏览器 Agent | 浏览器进程可见 | Tab/会话归因弱 | 默认 metadata_only |
| 云端托管 Agent | 本地调用可见 | 云端内部不可见 | Provider/API 能力决定 |

页面必须显示真实能力状态，不能把“未采集到”解释成“没有指令”。

## 12. 对话追踪 UI

当前 `apps/web/src/pages/ConversationTrackingPage.tsx` 只是占位页。目标信息结构：

```text
Conversation
└─ Turn
   ├─ 用户指令
   ├─ ModelCall 1
   │  ├─ Request
   │  └─ Response / ToolCall
   ├─ ToolCall
   │  ├─ 命令
   │  ├─ 子进程
   │  ├─ 文件
   │  ├─ DNS / Egress
   │  └─ Exit / Result
   ├─ ModelCall 2
   └─ 最终回复
```

每一层显示：

- 事件时间；
- Provider/Model；
- TTFT 和 Duration；
- Token；
- captureMethod；
- captureCompleteness；
- parseStatus；
- rawRetentionState；
- presentationState；
- correlationMethod；
- 置信度；
- Source 与 Runtime；
- Evidence 深链接；
- Raw View 权限状态。

示例：

```text
14:03:01 用户指令
“检查项目依赖漏洞”
[ebpf_tls] [complete] [confidence 0.97]

14:03:01 Model Request · deepseek-chat
14:03:02 Model Response · ToolCall bash

14:03:02 命令
osv-scanner scan .
[strong: command hash + process ancestry]

14:03:02 文件读取
package-lock.json

14:03:03 网络连接
api.osv.dev:443

14:03:04 进程退出
exitCode=0

14:03:04 Model Request · tool result
14:03:05 最终回复
“发现 3 个依赖漏洞”
```

列表默认只加载 metadata。正文按需、按权限读取，防止打开页面时下载整段会话。

## 13. 分阶段实施

### Phase -1A：可行性验收合同

在运行任何 Payload Spike 前，先冻结验收合同。合同必须填写并经评审批准：

```text
目标Agent及精确版本
binaryFingerprint/build-id
TLS Runtime及版本
目标协议和Provider
声明支持的并发负载
请求完整率门槛
Parser正确率门槛
Ring/Queue Drop门槛
Observer CPU/RSS预算
Agent P50/P95与TTFT影响预算
内存和Reassembly上限
Kill Switch生效时间
明文泄漏零容忍条件
不支持版本的降级行为
```

没有批准后的数值门槛和测试负载，不允许用“成功挂载探针”或“采到一条Query”
判定可行性通过。

### Phase -1B：隔离 Runtime 可行性 Spike

仅在隔离测试环境使用受控 Fixture，对以下对象测试：

- Pi/Node；
- Python/OpenSSL；
- 当前 Codex 二进制；
- 当前 Claude/Bun 二进制；
- HTTP/1.1；
- SSE；
- WebSocket。

输出：

```text
binaryFingerprint
可挂载函数/offset
请求完整率
响应完整率
Parser正确率
Ring/Queue Drop
协议类型
Observer CPU/RSS
Agent P50/P95与TTFT变化
Kill Switch结果
明文泄漏扫描结果
不支持原因
```

Spike 使用可丢弃的实验 ABI，不预先冻结 `TlsPlaintextFragmentV2`。真实二进制、
ABI、分片和协议结果用于反向修正正式 ABI。未通过验收合同的 Agent 版本不能标记
为支持。

Kill Switch 必须证明：

- 可以通过一个受管控制动作关闭 Payload 读取；
- 控制确认后 eBPF 不再调用 `bpf_probe_read_user` 读取正文；
- 明文 Ring 不再产生 Fragment；
- Collector 清除 Inflight Reassembly 和明文内存；
- 状态页可确认关闭时间、策略版本和剩余队列；
- Kill Switch 不关闭 Process/File/Network 等基础事实采集。

### Phase 0：四项冻结 Gate

Phase -1 结束后，依次完成：

#### Gate A：Runtime ABI

- 根据真实 Runtime 结果冻结 Fragment ABI；
- 明确每个 Runtime/版本的 probeStrategy；
- 明确 HTTP/1.1、HTTP/2、SSE、WebSocket 支持范围；
- 未支持版本严格降级为 metadata-only 或 unsupported。

#### Gate B：并发 Turn

- 冻结有界多活跃 Turn Map；
- 完成两个并发会话、相同文本、共享进程和工具循环模型验证；
- 无强证据时保持 ambiguous/unassigned；
- `contentHmac` 不参与 Turn 身份。

#### Gate C：持久化

- 冻结 ContentStore finalize + Kafka durable ack 的 Receipt 边界；
- 验证崩溃窗口、幂等重试、孤儿 Blob、对账和投影重放；
- 冻结 Source/Partition 提交游标；
- PG/CH 明确为可重建投影。

#### Gate D：安全

- 完成真实认证和服务端 RBAC；
- 完成租户隔离、版本化密钥和轮换；
- 完成 Raw View 审计、删除和TTL演练；
- 证明 metadata-only 在采集源头不读取正文；
- Candidate 默认 metadata；
- 加密正文、Raw View 和 HMAC 在 Gate 通过前保持禁用。

只有四项 Gate 全部通过，文档状态才能从“架构方向确认、待验证后冻结”改为
“设计冻结、允许实施”。

### Phase 1：Interaction Plane

实现：

- Interaction Ingest；
- Source 认证；
- PostgreSQL 会话表；
- ClickHouse Interaction metadata 表；
- Kafka Topic；
- Durable Receipt；
- `/conversations` 基础页面。

Phase 1 首先按生产 `metadata-only` 工作，不依赖正文或 ContentStore。只有 Gate D
已经通过，才可以同时启用 ContentStore 和正文权限路径。

### Phase 2：无侵入 Query MVP

范围：

- Python/OpenSSL；
- 已验证 Node/Pi；
- HTTP/1.1；
- OpenAI-compatible；
- Anthropic Messages；
- 出站请求；
- 用户消息提取；
- 经过安全 Gate 批准的 `redacted` 或 `encrypted_full` 模式。

退出条件：

- 受控 Query 与实际 Provider 请求一致；
- 分片请求可重组；
- 工具循环不重复生成顶层用户指令；
- 并发相同文本不会被合并；
- 不支持时明确显示原因；
- 无明文进入日志、Kafka 或普通 Events。

若 Gate D 未通过，Phase 2 只能保留在隔离测试环境，不能进入生产。

### Phase 3：全链路 Turn

增加：

- SSL 响应；
- SSE 聚合；
- ToolCall 解析；
- Flink Turn Correlator；
- Process/File/DNS/Egress 关联；
- 最终 Assistant Response；
- 迟到 Revision；
- Conversation 完整时间线。

退出条件：

- Query 到最终回复形成完整树；
- 工具意图与实际命令明确区分；
- 并行和后台事件不会被强行误配；
- 所有推断关系展示置信度。

### Phase 4：扩大覆盖

增加：

- HTTP/2；
- WebSocket；
- Gemini；
- Node 静态 OpenSSL；
- Codex TUI/PTY、app-server 与 Agent→LLM 版本化适配；
- Claude/BoringSSL；
- Go TLS；
- Rustls；
- MCP Pipe。

### Phase 5：可选增强

提供但不强制：

- OTel；
- SDK Hook；
- IDE/CLI Input Adapter；
- LLM Gateway；
- MCP Relay；
- Dify Trace Adapter。

这些增强用于将 `observer_inferred` 提升为精确的：

```text
sessionId
turnId
modelCallId
toolCallId
```

## 14. 测试与上线 Gate

### 14.1 Phase -1 客观指标

Phase -1 验收合同至少包含：

| 维度 | 客观通过条件 |
| --- | --- |
| 支持版本 | 每个声明支持的 binary fingerprint/build-id 均成功匹配正确 Probe Strategy |
| Attach | 声明支持的 Fixture 中探针附着成功；未支持版本不得误报为 supported |
| Byte 正确性 | 所有标记 `captureCompleteness=complete` 的请求与 Ground Truth 逐字节一致 |
| Parser 正确性 | 所有标记 `parseStatus=parsed` 的支持 Fixture 与预期 Provider Schema 一致 |
| 完整率 | 在批准的目标并发和Payload分布下达到合同数值门槛 |
| Ring/Queue Drop | 在声明支持负载内为零；超载时全部进入Loss Ledger且不得误报complete |
| CPU/RSS | Observer增量不超过合同预算 |
| Agent影响 | P50/P95和TTFT变化不超过合同预算 |
| Metadata-only | Payload Read、正文Fragment、Query HMAC和ContentStore写入均为零 |
| 明文泄漏 | 日志、Kafka、ClickHouse普通Event、Redis和磁盘扫描结果为零 |
| Kill Switch | 在合同时间内停止Payload读取、清空明文状态并保留基础事实采集 |

合同必须记录测试时长、并发、请求大小分布、Runtime版本和机器配置。更换二进制
Fingerprint、TLS Runtime或主要协议版本后，原验收结论自动失效，必须重新验证。

### 14.2 功能

- 单片与多片请求；
- chunked/gzip；
- SSE；
- HTTP/2 并发 Stream；
- WebSocket；
- 自动重试；
- 相同 Query 重复输入；
- 工具循环；
- PID/FD/SSL Pointer 复用；
- 并发 Agent；
- Dify 共享 Worker；
- 超大正文；
- 进程退出；
- Collector 重启；
- Kafka 和 ContentStore 故障。

### 14.3 并发与关联

- 同一进程并发两个不同会话；
- 两个用户同时输入相同文本；
- 相同Query在工具循环中重复进入后续ModelCall；
- HTTP/2不同Stream并发；
- WebSocket多消息并发；
- Dify共享Worker中的不同Workflow/Node；
- 后台任务跨Turn继续执行；
- 无强证据时保持ambiguous/unassigned；
- Active Turn Map达到容量上限时不串线。

### 14.4 安全

- Authorization/Cookie/API Key 不进入日志；
- HMAC 跨租户不可比较；
- Candidate TTL 后正文不可读；
- Raw View 完整审计；
- 未授权用户无法读取内容；
- 内容不可自动进入 AI Assistant Prompt；
- 恶意深层 JSON、超大 Payload 和无终止 SSE 不产生无界内存。
- 未启用认证/RBAC时服务端拒绝`redacted/encrypted_full`；
- metadata-only从eBPF源头不读取正文；
- Kill Switch后不再产生正文Fragment或残留明文状态。

### 14.5 正确性

- 每个支持 Runtime 有真实版本记录；
- `captureCompleteness=complete` 必须具有全片证据；
- Ring Drop 后不得仍标记 `captureCompleteness=complete`；
- `parseStatus`、`rawRetentionState`和`presentationState`不得替代完整性；
- 同一 Attempt 重放不产生逻辑重复；
- 同一逻辑键不同 Payload 触发 conflict；
- `contentHmac`不得作为Turn身份；
- 时间邻近关系不得标记 `exact`；
- 迟到事件不得覆盖原始事实；
- 多源 Observation 不得静默合并或覆盖。

### 14.6 持久化与恢复

- ContentStore finalize成功、Kafka写入前崩溃；
- Kafka超时但实际已持久化后的幂等重试；
- API在返回Receipt前退出；
- PG/CH投影Worker退出和重放；
- 孤儿Blob TTL清理；
- Blob/Kafka对账发现缺口；
- Source/Partition提交游标恢复；
- metadata-only Receipt不访问ContentStore；
- 投影延迟不导致重复Receipt或虚假丢失。

### 14.7 性能

实施前后比较：

- Agent P50/P95 总延迟；
- TTFT；
- Observer CPU/RSS；
- Ring Drop；
- Collector Queue 和 Inflight Bytes；
- 每 Agent 内容字节；
- Kafka 吞吐；
- Flink State；
- ClickHouse 写入和查询延迟；
- ContentStore 写入延迟。

数值阈值必须在 Phase -1A 由真实负载和容量预算批准；阈值未填写时不得启动
Phase -1B，也不得判定任何 Runtime 可行。

## 15. 首个可交付闭环

冻结前的首个交付物不是生产代码，而是：

```text
Phase -1验收合同
+ 真实Runtime兼容矩阵
+ Ground Truth报告
+ 性能与Drop报告
+ Metadata-only源头证明
+ Kill Switch演练
+ 四项Gate结论
```

四项 Gate 通过后的第一个生产闭环保持严格 metadata-only：

```text
已识别Agent
→ 不读取Payload的LLM Transport Metadata
→ Interaction Ingest
→ Kafka Durable Ack
→ PostgreSQL/ClickHouse投影
→ /conversations显示“正文未采集”
```

只有安全 Gate 已经通过，才允许交付无侵入 Query 闭环：

```text
已验证的 Node/Python Agent
→ SSL_write 明文
→ HTTP/1.1 重组
→ OpenAI/Anthropic 解析
→ UserInstructionObserved
→ Interaction Ingest
→ 加密存储
→ /conversations 展示
```

后续全链路扩展：

```text
SSL_read / SSE
→ ToolCall
→ Process / File / Egress
→ Flink ObservedTurn
→ 最终 Assistant Response
```

只有完成全链路 Turn 阶段后，产品才能宣称已经形成“用户消息到 Agent 底层动作再到
最终回复”的对话追踪。LLM Request 闭环只能宣称已经无侵入观测到受支持 Agent
发给 LLM Provider 的用户消息；Input Adapter 闭环只能宣称观测到输入给受支持
Agent Runtime 的指令。只有二者可靠关联后，才能比较“用户输入”与“模型实际收到
什么”；metadata-only 闭环不能宣称已采集用户消息。

## 16. 最终约束

- 当前状态是“架构方向确认、生产设计尚未冻结”；production metadata-only
  闭环已获得实施授权，正文仅允许在显式开启的 `isolated_fixture` 中用于受控
  验证。
- Runtime、并发关联、持久化和安全四项 Gate 全部通过前，不进入正式正文实施。
- Observer 负责底层事实和无侵入传输观测；AnySentry 负责认证、持久化、关联和展示。
- 不修改现有 `traceId`、`invocationId`、`toolCallId` 或 `agentInstanceId` 语义。
- Producer 不得直接声明最终 `agentAssetId`，由服务端现有 Resolver 解析。
- 未支持的 Runtime 或协议必须显示 `unsupported/unavailable`。
- 缺记录、空列表和零值不能显示为确定的“没有调用”。
- metadata-only 必须从 eBPF 采集源头禁止 Payload Buffer 读取，不能先抓明文再丢弃。
- 真实用户认证、服务端RBAC和KMS租户密钥治理完成前，生产环境不计算Query
  HMAC、不写ContentStore，不开放Candidate pre-roll、redacted正文、
  encrypted_full或Raw View；本机受控Fixture使用的独立密钥和双Token能力不能
  被表述为生产RBAC已经完成。
- `contentHmac`只用于受控内容比较，不得作为Conversation或Turn身份。
- 同一进程必须支持有界多活跃Turn；无法区分的并发事件保持ambiguous/unassigned。
- Durable Receipt只覆盖ContentStore finalize（若适用）与Kafka durable ack；
  PostgreSQL和ClickHouse属于可重放投影。
- 内容采集失败不能阻塞 Agent，也不能拖慢 L1/L2/L3 主判断链路。
- 正文必须独立授权、加密、可审计、可删除，并与普通事件查询隔离。
- eBPF-only 关联必须保留推断性质；精确逻辑身份依赖可信语义 ID。
- Agent、Observer、Kafka、Flink、ContentStore 或 API 任一环节的丢失都必须进入
  Completeness 与 Loss Ledger。
