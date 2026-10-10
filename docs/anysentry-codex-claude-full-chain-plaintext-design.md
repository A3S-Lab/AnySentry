# AnySentry Codex / Claude Code 全链路明文观测与内核事件关联设计

> 状态：P0–P4 已落地（Adapter Manifest、ConnectionIdentity、Tool 闭合/归一化、H2 HEADERS、Kimi Manifest）
>
> 记录日期：2026-09-08（Asia/Shanghai）；P0–P4：2026-09-08
>
> 负责范围：Codex CLI、Claude Code 两个 Agentic CLI 的明文全链路解析，以及明文链路事件与底层内核事件的关联。LangChain/LangGraph/Dify 的应用服务型解析、Observer 采集性能与写入速度优化由另两位工程师负责，本文只定义与它们的接口边界。
>
> 代码快照：AnySentry `b08e1e5`（分支 `goal/canonical-observability-20260903`，工作树含他人未提交改动）；Observer `e4128b6`（同名分支，工作树含他人未提交改动）。本文不把工作树当作干净发布版本。
>
> 上位合同：[LLM 观测技术设计](./anysentry-agent-llm-interaction-observability-technical-design.md)、[会话归因与统一证据 V4](./anysentry-agent-conversation-resolution-and-unified-evidence-v4-design.md)。本文只在这些合同之下补 Codex/Claude 的具体落点，不重新定义 LogicalAgent、Session、ToolCall、Coverage 语义。

本文使用四种标记：**已确认事实**（当前源码、命令输出、API 响应、二进制检查）、**目标设计**（合同要求或本文提议）、**推断**（有证据支持但未生产验证）、**未验证**。

---

## 0. 一页结论

1. **模块化设计已经成型，但"执行位置"与"合同位置"不一致。** 合同要求 Transport / LLM Format / Agent Adapter / Runtime 四个 Registry 正交；代码里 Transport 重组和 LLM 线协议解析实际全部在 Observer Collector（`interaction.rs`）完成并输出 `LlmInteraction`，AnySentry 侧的 `TransportDecoderContract`/`LlmFormatAdapterContract`/`AgentAdapterManifest` 目前是**描述符**（`GET /v1/observability/contracts` 可见），ingest 路径上没有调用 `matchRuntime/extractIdentity/extractTool/classifyTraffic`。产品识别实际由 `filter-rule-builtins.ts`、`agent-attribution.service.ts`、`tls-runtime-selection-hints.json` 的进程名提示完成。这不违反合同（合同允许 Observer 做 edge parser），但意味着"新增 Kimi 只改 Manifest"今天还不成立：Manifest 不驱动任何运行时行为。本文的第一项工作是**让 Manifest 真正被执行**，而不是给 Codex/Claude 各加一套解析。
2. **Codex 与 Claude Code 的差距不在"要不要另写解析器"，而在四个具体缺口**：(a) Rustls 连接身份不稳定导致 WebSocket 流绑定歧义；(b) 明文连接与内核 Egress/TLS ClientHello 事实之间没有共同的 `ConnectionIdentity`（`endpoint=unknown`）；(c) 控制/后台流量没有被 Adapter 归类，污染为 `unparsed partial`；(d) ToolCall→ToolResult 跨 Interaction 闭合与 ToolCall→Exec/File KernelFact 的唯一归属尚未在 Codex/Claude 真实流量上跑通。四项都在通用层解决，产品只贡献声明。
3. **agentsight 值得借的是方法，不是代码。** 它对 Claude Code（Bun+BoringSSL 前缀模式）和 Codex（rustls 写端前缀模式）的处理思路与 Observer 现有 `tls-signature-families.json` 同源，且 Observer 已经领先：有 rustls **读端**探针（agentsight 只有写端，Codex 响应靠读 session 文件）、有 cgroup/进程代次门控、有跨 chunk 重组、有 EvidenceLink。值得吸收的是：attach 目标解析链（shebang → npm vendor 二进制）、请求/响应配对置信度阶梯、SSE/Responses 终结启发式作为测试向量、`view_source/confidence` 全字段溯源、以及它论文里描述但未实现的 Tool→Exec 三要素关联（血缘 + 有界时间窗 + 参数匹配）。不借：单 `pid:tid` 键控、单次 SSL 调用等于一条 HTTP 消息的假设、全局 HPACK 状态、用户态 comm 过滤、session 文件兜底（我们是纯 eBPF 定位）。
4. **实施顺序**：P0 让 Adapter Manifest 在 ingest 执行（trafficRole/anchors/toolNameView）→ P1 Observer `ConnectionIdentity` 桥接（tls ctx ↔ socket）与 WebSocket 多请求配对 → P2 Tool↔Result 闭合与 Tool→Kernel 唯一归属在 Codex/Claude 真实流量验收 → P3 HTTP/2 HEADERS 最小解码（Codex REST provider）→ P4 Kimi 作为"只加声明"的可扩展性回归。

---

## 1. 当前模块化设计：从代码出发的理解

### 1.1 端到端实际链路（已确认事实）

```text
Agent 进程（codex / claude.exe / …）
  │ eBPF：exec/exit/file/connect/DNS/TLS ClientHello（always-on，产品无关）
  │ eBPF：SSL_read/SSL_write(_ex) / rustls CommonState uprobes（opt-in，PID+cgroup+代次门控）
  ▼
Observer Collector
  ├─ tls_agent_scopes.rs   Agent cgroup/根进程 fence（AnySentry publisher 下发）
  ├─ tls_attach.rs         实现族签名扫描 + 前缀校验的 bootstrap offsets + 导出符号 attach
  ├─ ring_reader/pipeline  固定 POD 复制 → 事件时间重排 → 单写处理器
  ├─ interaction.rs        ConnectionKey{cgroup,pid,connection_id} 重组：
  │                        HTTP/1.1(httparse) / chunked / gzip / SSE / WebSocket(+deflate) /
  │                        HTTP/2 DATA-only / rustls body-only → wire template 匹配
  │                        (openai-responses / openai-chat / anthropic-messages / gemini / mcp)
  │                        → LlmInteraction（含 toolCalls/toolResults/semanticItems/anchors）
  │                        或 AgentPlaintextEvidence（unparsed/unsupported，metadata-only）
  ▼
Forwarder（scripts/observer-forward.js）  WAL/spool、Source 鉴权、批量 → POST /ingest/batch
  ▼
AnySentry API
  ├─ commitCanonicalObservation   RawObservation（hash-only）+ KernelFact 追加
  ├─ SentryJudge                  L1 判断（只消费 KernelFact，不看明文）
  ├─ parseObserverAgentInteraction  校验 anysentry.agent_interaction.v1 → AgentInteractionRecord
  │                                 → resolveLogicalAgentDefinition / deriveAgentInstanceIdentity /
  │                                   resolveSessionIdentity（legacy_agent_fallback → per_request）
  ├─ conversation-resolution-v2   Anchor 图、Thread/Segment、context_replay、resume/fork
  ├─ agent-semantic-kernel-relation (v3)  ToolCall ↔ KernelFact → EvidenceLink（append-only）
  └─ projection                  Conversation Directory V4 / Timeline V3 / Evidence / Coverage
  ▼
Web：ConversationTrackingPage（Navigator / Overview / SemanticTimeline / Inspector）
```

关键代码位置：Observer `a3s-observer-ebpf/src/main.rs`（rustls 探针 ~2574–2680，`emit_tls_plaintext` ~3230–3353，路由/会话准入 ~3132–3227）；`a3s-observer-collector/src/interaction.rs`（`resolve_connection_key`/`resolve_rustls_stream` ~1750–1930，`process_http2_chunk` ~2319，wire template ~4830–4899，anchors ~5191–5312）；`tls_attach.rs`（实现族扫描 ~1490–1566，Codex vendor musl 路径 ~1239–1265）；AnySentry `agent-interaction.ts:693–1155`，`canonical-observability.ts`（类型 26–434，Manifest 722–790，Registry 描述符 798–817），`agent-semantic-kernel-relation.ts:575–991`，`security-monitoring.controller.ts:7434–7648`。

### 1.2 合同分层 vs 实际执行位置

| 合同层 | 合同要求的位置 | 实际位置（已确认事实） | 对本设计的含义 |
| --- | --- | --- | --- |
| TLS Implementation Registry | Observer | `tls-signature-families.json`（boringssl-classic / openssl-ex / rustls-common-state 三族）+ `tls-validated-anchor-fixtures.json`（前缀校验的 bootstrap offsets，含 codex 0.149.1/0.150.1/0.153.4、claude 2.1.170/2.1.245/2.1.251/2.1.263） | 已经是"按实现族、不按版本"，Codex/Claude 的 TLS 边界不需要再造 |
| Transport Decoder | Observer 有界 framing | Observer `interaction.rs` 全部完成（HTTP/1.1、SSE、WS、H2 DATA） | 补 WS 多请求配对与 H2 HEADERS，不另写 |
| LLM Format Registry | 可在 Observer 初解析，AnySentry 校验/版本化 | Observer `match_wire_protocol` + tool 抽取完成；AnySentry 只做 `agent-semantic-timeline.ts` 的 SSE 文本重投影 | 保持；AnySentry 不重复实现 OpenAI/Anthropic 协议 |
| Agent Adapter | AnySentry `AgentAdapterRegistry` | Manifest 存在但 ingest 不调用；产品识别在 filter builtins/attribution；Observer 侧只有 discovery hints | **P0：把 Manifest 变成 ingest 上真正执行的 Adapter** |
| Runtime Adapter | AnySentry | `agent-identity.ts` 从 cgroup/workload 推 host/docker/k8s；`agent-runtime-state.service.ts` 快照 | 无需改动 |
| Identity/Session Resolver | AnySentry | 已实现且是主链（V2 resolver、canonical session） | 只补 Codex/Claude 的 anchor 路径声明 |
| Correlation | AnySentry | `agent-semantic-kernel-relation.ts` v3：命令/资源/网络/进程代次、ambiguous、EvidenceLink | 补 argv 归一化声明 + Result 闭合 + 连接边 |

### 1.3 产品名今天出现在哪里（已确认事实）

允许区域（Manifest/Hint/Fixture）：`tls-runtime-selection-hints.json`（codex/claude/kimi/langchain/pi/dify）、`tls-validated-anchor-fixtures.json`、`canonical-observability.ts:722–790` Manifest、`filter-rule-builtins.ts:77–113` 运行时签名。

灰色区域（应迁入 Adapter 声明，但不是本阶段阻塞）：`main.rs:3650–3655` exec 后加速 re-attach 的 comm 列表；`agent-identity.ts:53–67` Codex 沙箱/fs-helper 子进程排除；`clickhouse-store.ts:469–470` SQL 排除 Codex helper argv；`agent-conversation*.ts` 显示名。

核心层无产品分支（已确认）：`agent-semantic-kernel-relation.ts` 只有工具类型正则（bash/file/network/sandbox）；`SentryJudge` 无产品匹配；Controller 只有 LLM host allowlist 与 OTLP `langgraph.run_id` 别名。

### 1.4 "今天新增一个 CLI 智能体"实际要做的事（已确认事实）

1. Observer：Agent Scope 文件覆盖其 cgroup/根进程（publisher 下发）；`tls-runtime-selection-hints.json` 加 pattern（Kimi 已有）；若 TLS 栈不是三族之一，加实现族签名；若模型路径不在默认路由，改 `A3S_OBSERVER_LLM_HTTP_ROUTES`；若线协议 JSON 形状不同，扩 `match_wire_protocol`。
2. AnySentry：加 `AgentAdapterManifest`（目前只是描述）；加 filter builtin 签名；可选显示名。
3. 管理面注册 LogicalAgent，否则 `logicalScopeMode=unresolved`。

结论：**Observer 侧已经接近"只加声明"；AnySentry 侧 Manifest 尚未被执行，Adapter 的 trafficRole/anchor/tool 字段声明没有消费者。** 这是本设计要先补的模块化缺口。

---

## 2. 目标二进制与运行态事实（2026-09-08 本机核查）

### 2.1 Codex CLI 0.153.4（已确认事实）

| 项目 | 事实 |
| --- | --- |
| 二进制 | npm 包 `@openai/codex` → `bin/codex.js`（Node launcher）→ `node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`（258 MB，静态 musl PIE，**fully stripped**，无 `.symtab`）；另有 `codex-code-mode-host`（69 MB）|
| TLS/HTTP 栈 | rustls（字符串 156 处）+ reqwest/hyper + **h2** + tokio-tungstenite；另内嵌 OpenSSL `_ex`（CRYPTOGAMS 汇编、`openssl-ex-x86-64` 族命中）|
| 实际两条 lane | ① `openssl-ex` HTTP/1.1 → `chatgpt.com/backend-api/*`（plugins/list、plugins/installed、analytics-events、wham/settings、`/backend-api/ps/mcp`）与 `ab.chatgpt.com/otlp/v1/metrics`；线程名 `reqwest-interna`。② `rustls-payload` WebSocket → `/v1/responses`（Responses over WS，`responses_lite`），线程名 `tokio-rt-worker` |
| WS 请求 | 文本帧 JSON：`{"type":"response.create", model, input[], tools, tool_choice, store:false, stream:true, prompt_cache_key, reasoning, text, include, client_metadata:{session_id, thread_id, turn_id, x-codex-installation-id, x-codex-window-id, x-codex-turn-metadata, x-codex-ws-stream-request-start-ms}}`；升级请求头含 `x-codex-turn-state`、`x-codex-parent-thread-id`、`x-openai-subagent`、`x-codex-routing-hint`、`OpenAI-Beta` |
| WS 响应 | `application/json-seq`：`response.created` → `response.output_item.added/…delta/…done` → `response.completed/failed/incomplete`；`response.id` 55 字符 |
| 工具项 | `function_call`（`shell`/`exec_command`/`write_stdin`/`update_plan`/`web_search_call`/`mcp__*`）、`custom_tool_call`（`apply_patch`）、`function_call_output`/`custom_tool_call_output`（`call_id`+`output`），`local_shell_call` |
| Session 语义 | `~/.codex/sessions/**/rollout-*.jsonl` `session_meta` 含 `session_id`、`id`(thread)、`forked_from_id`、`parent_thread_id`、`source.subagent.thread_spawn`（子智能体线程）；本机配置 `disable_response_storage=true` → `store:false`，每轮全量 `input`（无 `previous_response_id`）|
| 子进程 | `sandbox_mode=danger-full-access` 时直接 `bash -lc <cmd>`；受限沙箱时经 `codex-linux-sandbox` 包裹（`agent-identity.ts` 已排除为非根）|
| 配置 | 另有 `supports_websockets=false`、`wire_api="responses"` 的自定义 provider → Responses REST（reqwest+rustls，ALPN 可能协商 **h2**）|

### 2.2 Claude Code 2.1.263（已确认事实）

| 项目 | 事实 |
| --- | --- |
| 二进制 | `@anthropic-ai/claude-code/bin/claude.exe`（215 MB ELF，动态链接 libc，`.symtab` 仅 1221 项，无 SSL 导出符号）；Bun 单体（`bun-usockets/src/crypto/openssl.c`、`vendor/boringssl/*` 路径字符串）|
| TLS/HTTP 栈 | BoringSSL 静态（classic `SSL_read/SSL_write`），HTTP/1.1 + SSE；线程名 `HTTP Client` |
| Observer 现状 | 已由 `tls-family:boringssl-classic-x86-64-205523b6…` 前缀锚点 attach（4 programs），`transport_scope=static-abi-fixture` |
| 请求 | `POST /v1/messages`（本机经 Anthropic 兼容中转，域名类别已脱敏）：`system`、`messages[]`（累计历史含 `tool_use`/`tool_result` block）、`tools[]`、`metadata.user_id`（含 `session_<uuid>`，为 provider Session 锚点）；另有 `/v1/messages/count_tokens` |
| 响应 | SSE：`message_start` → `content_block_start/delta(text_delta/input_json_delta)/stop` → `message_delta` → `message_stop`；`tool_use{id,name,input}` |
| 工具 | `Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`Task`(subagent)、`WebFetch`、MCP 工具；`Bash` 实际 exec 形态：`/bin/bash -c "source ~/.claude/shell-snapshots/snapshot-bash-*.sh … && eval '<cmd>' < /dev/null && pwd -P >| /tmp/claude-*-cwd"`（本机实测进程 argv）|
| Session 语义 | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`；`--resume/--continue`、`--fork-session`、`/clear`、`/compact` |

### 2.3 最近 3 小时 API 真实统计（`POST /security-center/agents/interactions`，`last_1d`，113 条；已确认事实）

| 产品 | tlsAdapterId | transport | 类型/解析/完整性 | 数量 | 说明 |
| --- | --- | --- | --- | ---: | --- |
| Claude Code | ssl-classic | http/1.1 | model / parsed / complete | 6 | `/v1/messages` 无工具轮次 |
| Claude Code | ssl-classic | http/1.1 | model / parsed / partial(`tool_result_pending`) | 10 | 每条 1–2 个 toolCall、8–16 个 toolResult（累计历史）；`sessionIdSource=provider/strong` |
| Claude Code | ssl-classic | http/1.1 | unparsed / partial(`wire_template_unparsed`) | 3 | `/v1/messages/count_tokens` |
| Claude Code | ssl-classic | http/1.1 或 unknown | unparsed / unsupported(`http_request_parse_error`、`probe_call_limit`) | 3 | 需定位 |
| Codex | openssl-ex | http/1.1 | unparsed / partial(`wire_template_unparsed`) | 55 | 全部 chatgpt.com backend-api 控制/遥测流量 |
| Codex | openssl-ex | http/1.1 | tool / parsed / complete | 2 | `/backend-api/ps/mcp`（MCP over HTTP）|
| Codex | rustls-payload | websocket | model / parsed / partial(`websocket_handshake_recovered`, `ambiguous_stream_binding`) | 2 | `/v1/responses`，`endpoint=unknown`，`sessionIdSource=provider/strong`，toolCalls=0 |
| Codex | rustls-payload | websocket / stream | unparsed / unsupported(`ambiguous_stream_binding`/`websocket_upgrade_observed`/`websocket_handshake_recovered`) | 11 | 与上面 2 条同一批 `tls:` 连接指针，同一字节被多份 provisional 状态重复上报 |

所有记录 `logicalScopeMode=unresolved`；Codex 无一条 ToolCall 进入 EvidenceLink；Observer 日志 `write_route_candidates=169`、`ssl_classic_successes=33592`、rustls `write_hits=0`（诊断计数器口径待核，见 §9）。

---

## 3. agentsight 调研结论

调研对象：`eunomia-bpf/agentsight` v1.0.31（2026-09-05，`bb99b66f`）、arXiv 2508.02736 v2。仓库克隆在 `/tmp`，未写入本项目。

### 3.1 与本平台的对照

| 维度 | agentsight | AnySentry/Observer 现状 | 判断 |
| --- | --- | --- | --- |
| Claude Code TLS 边界 | `find_boringssl_offsets()`：全文件扫描 19 字节 `SSL_read` 序言，`SSL_write` 在 `+0xCA0`、`SSL_do_handshake` 在 `−0x6F0`（±64 KiB 回退）| `boringssl-classic-x86-64` 族：同源前缀 `554889e54157415653504883bf98000000 0074`，`writeAfterReadOffsets=[912,1008]`（0x390/0x3F0）| 思路相同；我们的 delta 表按 Bun 版本演化维护即可 |
| Codex TLS 边界 | rustls 0.23 `PlaintextSink::write/write_vectored` 序言，attach 全部单态化副本（~25 个）；**只有写端**，响应靠读 `~/.codex/sessions` | `rustls-common-state-x86-64` 族：`CommonState::buffer_plaintext`（写，enter-only）+ `CommonState::take_received_plaintext`（读）；`OutboundChunks::Multiple` 未复制 | **我们领先**（有读端）；可借"多副本全部 attach"思路补 `write_vectored` 变体 |
| 连接/流身份 | 事件无 fd/SSL*/连接 id，只有 pid/tid；HTTP/2 用 `(tid,stream_id)`；SSE 用 `pid:tid:message_id` | `ConnectionKey{cgroup,pid,connection_id}`，OpenSSL 用 `SSL*`，rustls 用 `CommonState*`（会移动）| 两边都没有 socket 级身份；本文 §5.2 补 `ConnectionIdentity` 桥接 |
| 跨 chunk 重组 | HTTP/1.1 无（依赖一次 `SSL_write` 一条消息）；H2 帧不得跨调用；HPACK 全局共享 | 有界 8 MiB 重组、chunked/gzip、WS 分片与 deflate、H2 DATA | 我们领先；H2 HEADERS/HPACK 两边都缺 |
| 进程门控 | 内核仅 `targ_pid/uid`，comm/session 用户态过滤 | PID+cgroup+exec 代次内核门控，路由/会话 map | 我们领先 |
| Tool→Exec 关联 | 论文描述"血缘 + 100–500 ms 时间窗 + 参数匹配"，**代码未实现**，仅按 pid 归属 | v3 correlator：命令/资源/网络键 + 进程代次 + ambiguous 仲裁 | 我们领先；借其"三要素"作为验收口径 |
| 溯源字段 | 每行 `view_source`/`confidence`；请求响应配对置信度阶梯 0.95/0.75/0.7/0.35 | `authority`/`confidence`/`status`/`resolutionRevision` | 借配对阶梯做 WS 多请求配对的质量分级 |
| 隐私 | `AuthHeaderRemover` 默认开 | Observer 只导出 `Host`，其余 header 不出内核态用户态边界 | 已满足；新增 header 白名单时沿用 |
| 会话文件兜底 | 读 Claude/Codex/Gemini 本地 JSONL 补响应与 token | 不读 transcript 正文（eBPF-only 定位） | **不采用**；仅允许把文件路径元数据当锚点提示（合同 §7.9）|

### 3.2 决定吸收的要点

1. **attach 目标解析链**作为 Runtime/Adapter 的显式步骤：PATH → symlink → `#!` shebang 追踪（≤5 级）→ "该 ELF 是否内嵌 TLS"字节扫描 → npm 包布局规则（`@openai/codex-linux-*/vendor/*-musl/bin/codex`）。Observer `codex_vendor_musl_candidates` 已有雏形，应改成 Manifest 声明的 `executableResolution` 规则，Claude 同理（`~/.local/share/claude/versions/*` 与 npm `bin/claude.exe` 两种布局）。
2. **请求/响应配对置信度阶梯**：显式 id（`response.id` / `request-id` 类 header）> 单一 pending > 唯一候选 > orphan。用于 §5.3 WebSocket 长连接上多次 `response.create` 的配对与 `wireCompleteness` 分级。
3. **SSE/Responses/Anthropic 终结启发式**作为 golden 测试向量：`message_stop`、`[DONE]`、`response.completed|failed|incomplete|cancelled`、非空 `usage`、`finish_reason`；Responses `function_call_arguments.delta/done`、`output_item.added/done`。
4. **Tool→Exec 三要素**（血缘、有界时间窗、参数匹配）作为验收定义，时间窗只缩小候选、不单独成边（与合同 §13 一致）。
5. **thread comm 陷阱**：`bpf_get_current_comm` 是线程名（Claude `HTTP Client`、Codex `tokio-rt-worker`/`reqwest-interna`），内核态永远不按 comm 过滤，用户态展示用 `exe`+`processGenerationKey`。我们已如此，本文写入验收清单防回归。
6. **ring 预留教训**：agentsight 固定按最大结构 `reserve` 导致大包饿死。Observer 已分 16/128/512 KiB 三档，保持。
7. Claude Code 会向遥测端点发送 `tengu_tool_use_success{tool_name,duration_ms}` 一类事件——**不作为证据来源**（应用自报，authority 低），但 Adapter 应把该路径归为 `background`。

### 3.3 明确不采用

`pid:tid` 作为连接键；"一次 SSL 调用一条 HTTP 消息"假设；全局 HPACK；用户态 comm/session 过滤；读取 transcript 正文补全响应；LLM-as-analyst 二级判读进入采集主链；agentsight 的 process tracer（无 fd 的 open、仅 IPv4 connect）。

---

## 4. 差距清单（gap → 根因 → 所属模块）

| # | 现象（已确认） | 根因（已确认/推断） | 归属模块 | 对应设计 |
| --- | --- | --- | --- | --- |
| G1 | Codex WS：13 条中 11 条 `ambiguous_stream_binding`/`handshake_recovered`，同一连接字节被多份 provisional 状态重复上报 | rustls 探针以 `&mut CommonState`（rdi）作 `connection_id`；`ClientConnection` 在 tokio-rustls `connect` future → `TlsStream` 返回 → 移入 hyper/tungstenite 连接 → 移入 spawn 的 task 之间被**按值移动多次**，握手期与稳态地址不同；Collector 只能靠 `resolve_rustls_stream` 启发式重绑，两个 pending upgrade 并存即放弃（推断，代码注释与数据一致） | Observer eBPF + Collector | §5.2 `ConnectionIdentity` 桥接：tls ctx ↔ socket fd/cookie |
| G2 | Codex WS `endpoint=unknown`；Claude/Codex `LlmInteraction` 与 `Egress`/TLS ClientHello KernelFact 之间无 EvidenceLink | TLS uprobe 事件无 fd/socket；Egress/SNI 事件键为 `(cgroup,pid,fd)`；两条 lane 没有共同键 | Observer eBPF + AnySentry correlation | §5.2 + §5.5(d) `emitted_by` 连接边 |
| G3 | Codex 55 条 backend-api 控制/遥测流量、Claude `count_tokens` 被记为 `unparsed partial`，进入对话目录噪声 | Adapter Manifest 无 `classifyTraffic` 执行路径；Observer 对非 LLM 路径正确地不解析，但没有 `trafficRole` 语义 | AnySentry Adapter（P0）| §5.4(a) trafficRole 声明与执行 |
| G4 | Claude 10 条 `tool_result_pending` 永久 partial；Codex 2 条 parsed 但 toolCalls=0 | ToolResult 出现在**下一条** Interaction 的请求体，Observer 单 Interaction 内无法闭合；AnySentry 未把 `tool_use_id`/`call_id` 跨 Interaction 配对写回 completeness；Codex WS 请求 `input[]` 中 `function_call_output` 未被识别为 toolResult（未验证：可能是 parsed partial 截断） | AnySentry correlation/projection；Observer Responses 解析核对 | §5.5(a) |
| G5 | 两产品 ToolCall→Exec/File 无 EvidenceLink | 未在真实流量验收；Claude Bash 的 argv 是 shell-snapshot 包裹、Codex 是 `bash -lc`/沙箱包裹，通用命令哈希不命中 | AnySentry correlation + Adapter 声明 | §5.5(b)(c) argv/路径归一化声明 |
| G6 | `logicalScopeMode=unresolved`、`logicalAgentCandidateId` | 管理面未注册 Codex/Claude 定义（按合同这是正确降级） | 管理面/验收流程 | §7 验收前注册定义，不改代码规则 |
| G7 | Codex REST provider（`supports_websockets=false`）经 rustls 时 ALPN 可能协商 h2；Collector 只有 H2 DATA 路径，无 HEADERS/HPACK → 无 method/path/status | 未实现 HPACK | Observer Collector | §5.3(c) P3 |
| G8 | rustls `OutboundChunks::Multiple`（vectored 写）只计数不复制 | eBPF 只校验 `Single` 布局 | Observer eBPF | §5.2(b) |
| G9 | Claude 3 条 `http_request_parse_error`/`probe_call_limit` | 未定位（未验证：大请求体超过单 call 512 KiB 档、或 pipelining） | Observer | §7 P1 fixture 复现 |
| G10 | Kimi 只有 discovery hint，无 Manifest/fixture | 尚未接入（按合同属 future） | — | §6 只作可扩展性回归 |

---

## 5. 设计方案

### 5.1 原则（继承合同，不再展开）

- 原始事实只追加；Adapter/解析失败只产生 `partial/unparsed/unsupported/coverage_gap`，不删 KernelFact、Candidate、元数据。
- 产品名只能出现在 Manifest/Adapter/Fixture/Hint；Transport、LLM Format、Correlation、Sentry、Controller、SQL、前端不得新增 `if product == …`。
- Observer 内核热路径只做固定复制与计数；连接身份桥接也必须是固定大小 map 查找 + 有界 LRU。
- 所有新增 map/队列/缓存带 `max_entries`/TTL/exit 清理/drop 计数。
- 明文正文默认 hash-only 进入 Canonical，正文留存受 TTL/权限策略约束，本文不放宽。

### 5.2 Observer：统一 `ConnectionIdentity`——把 TLS 上下文桥接到 socket

**目标设计。** 合同 §7.6 要求 `ConnectionIdentity = processGeneration + socketCookie(优先) + fdGeneration + tlsContextId + streamId`。今天 TLS uprobe 事件只有 `tlsContextId`（`SSL*` 或 `CommonState*`），Egress/TLS ClientHello 只有 `(cgroup,pid,fd)`，二者无法汇合，rustls 指针移动又使 `tlsContextId` 本身不稳定。解决办法不是在用户态猜，而是在内核态利用**同线程调用邻接**建立 `tls_ctx → socket` 绑定：

```text
写方向（rustls / OpenSSL / BoringSSL 通用）
  uprobe buffer_plaintext / SSL_write(ctx=P)            → LAST_TLS_CTX[pid_tgid] = {P, api_kind, ts}
  tracepoint sys_enter_write|writev|sendto|sendmsg(fd)  → 若 LAST_TLS_CTX[pid_tgid] 存在且 ts 距今 ≤ T_bind
                                                          且 fd 是 socket（已有 tls_write/sock 判定复用）
                                                        → TLS_CTX_SOCKET[{cgroup,pid,P}] = {fd, fd_gen, cookie?}
                                                          首次绑定或 fd 变化时 emit TlsConnectionBind 事件
读方向
  tracepoint sys_exit_read|recvfrom|recvmsg(fd, ret>0)  → LAST_SOCKET_READ[pid_tgid] = {fd, ts}
  uprobe take_received_plaintext / SSL_read exit(ctx=P) → 同上反向绑定
```

依据（推断，来自 tokio-rustls / OpenSSL 调用结构）：tokio-rustls 的 `poll_write` 在同一次 poll 内顺序执行 `writer().write()`（触发 `buffer_plaintext`）→ `write_tls()` → 底层 `TcpStream` 的 `write/writev` syscall；`poll_read` 顺序执行 `read()` syscall → `read_tls` → `process_new_packets`（触发 `take_received_plaintext`），tokio 一个 worker 线程同一时刻只 poll 一个 task，因此同线程邻接是可靠信号；OpenSSL/BoringSSL 的 `SSL_write` 内部同步调用 `send/write`，`SSL_read` 内部同步 `read/recv`，邻接同样成立。`T_bind` 取 2 ms 级并按 `api_kind` 可调；若窗口内出现第二个不同 fd，则记 `bind_conflict` 不绑定。

由此获得：

1. **稳定连接身份**：`socket_cookie`（内核 ≥5.12 tracing 程序可用 `bpf_get_socket_cookie(sk)`；需在 `kprobe:tcp_sendmsg/tcp_recvmsg` 或 `fentry` 取 `struct sock*`）或降级 `(pid, fd, fd_generation)`（fd_generation 由 `connect`/`close` 代次维护，Observer 已有 `sock_close` tracepoint 与 socket fd 生命周期跟踪基础）。rustls `CommonState` 地址移动只会产生**同一 socket 的新 alias**，Collector 用 `TlsConnectionBind` 直接合并，不再依赖 `resolve_rustls_stream` 的多候选启发式；后者保留为 bind 缺失时的回退。
2. **Egress/SNI 汇合**：`(cgroup,pid,fd)` 已是 Connect/TLS ClientHello 事件的键，Collector 在 `LlmInteraction` 上填 `connection.socketCookie/fd/fdGeneration`，AnySentry 用同键把 `LlmCall ↔ Egress/TlsClientHello` 建为 `emitted_by` EvidenceLink，并把 SNI 作为 `endpoint` 的降级来源（解决 `endpoint=unknown`）。
3. **UOS 4.19 arm64 回退**（未验证）：无 `bpf_get_socket_cookie` 时只用 `(pid,fd,fd_generation)`，`ConnectionIdentity.quality=weak`，功能不丢，只降质量。

ABI 变更（Observer common，additive）：`TlsPlaintextEventHeader` 增加 `socket_fd:i32`、`socket_cookie:u64`、`bind_quality:u8`（0=unbound,1=fd,2=cookie）；新增 `TlsConnectionBind` POD 事件或复用 `TLS_EVENTS` ring 的一个子类型。新 map：`LAST_TLS_CTX`（HashMap，pid_tgid，10240）、`LAST_SOCKET_READ`（HashMap，10240）、`TLS_CTX_SOCKET`（LruHashMap，8192，随 `do_exit`/`sock_close` 清理）。诊断计数：`bind_hits/bind_conflicts/bind_stale/bind_missing`。

(b) **rustls 补全**：`OutboundChunks::Multiple` 有界 scatter/gather（≤2 段 × 16 KiB 起步，超出置 `TRUNCATED`+`vectored_partial`），沿用同一 `emit_tls_plaintext`；写端继续 enter-only（避免 Rust 尾调用下 uretprobe 不返回）。签名扫描沿用 `rustls-common-state-x86-64` 族，`write_vectored`/`PlaintextSink` 变体如出现，作为**同族第二组前缀**加入 `tls-signature-families.json`，不加版本分支。

(c) **attach 时机**：exec 驱动 attach 已有（日志 `attached Agent TLS probes from exec lifecycle signal`）。Codex 的 Node launcher → musl vendor 二进制、Claude 的 `claude.exe` 均是 `execve` 新映像，把 §3.2(1) 的解析链声明为 Manifest `executableResolution`，由 Observer 在 `sched_process_exec` 提交时预先解析目标 ELF，缩短首个请求前的空窗。

### 5.3 Observer：WebSocket 长连接与 HTTP/2 的传输合同

(a) **WebSocket 多请求配对（Codex `responses_lite`）**。目标设计：一条 WS 连接上顺序发送多个 `response.create`，服务端以 json-seq 事件流回应；Collector 维持 per-connection `pending_requests` FIFO（已有），以 `response.created` 开始、`response.completed|failed|incomplete|cancelled` 终结一个 exchange；配对质量按 §3.2(2) 阶梯写入 `wireCompleteness`/`partialReasons`：`response.id` 与请求 `client_metadata.turn_id`/`x-codex-turn-metadata` 一致 → complete；单一 pending → strong；多 pending → ambiguous（保留两者，不合并）。控制帧 ping/pong/close 只作连接生命周期，不产生 Interaction。这些逻辑在 Transport/LLM Format 层，不认识 Codex；Codex 只在 Manifest 里声明"turn 锚点路径"。

(b) **同一字节多份上报的收敛**：有了 `TlsConnectionBind`，provisional 状态在绑定到 canonical socket 后合并，`AgentPlaintextEvidence` 只在绑定确实缺失时上报一次，并带 `bind_quality`。验收：同一连接的 metadata-only 证据条数 ≤1。

(c) **HTTP/2 HEADERS 最小解码（P3）**：为 Codex REST provider（及任何 reqwest/rustls 客户端）补 HPACK 解码 `:method/:path/:status/content-type/host`（静态表 + 动态表，每连接独立、有界 4 KiB），只用于路由/配对/`endpoint`；不解码其他 header。`SETTINGS/WINDOW_UPDATE/PING` 已识别。若 HPACK 状态失同步 → `h2_hpack_desync` gap，DATA 路径继续按 body-only 解析。

### 5.4 AnySentry：让 Agent Adapter 真正执行（P0）

**目标设计。** 在 `parseObserverAgentInteraction` 之后、identity/session 解析之前，插入一步产品无关的 `applyAgentAdapter(record, manifest)`：按 `detectedAgentIdentity.product`（或 Manifest `detection` 命中）选取 Manifest，执行四个纯函数，输出只写入新增字段，不改原始 `request/response`：

| 函数 | 输入 | 输出字段 | Codex 声明 | Claude Code 声明 |
| --- | --- | --- | --- | --- |
| `classifyTraffic` | method/path/endpoint/wireTemplateId/body 结构 | `trafficRole ∈ conversation/bootstrap/control/context_replay/background/unclassified` | `control`: `/backend-api/ps/*`、`/backend-api/wham/*`、`/backend-api/plugins/*`；`background`: `/backend-api/codex/analytics-events/*`、`/otlp/v1/*`；`conversation`: wireTemplateId=`openai-responses` | `control`: `/v1/messages/count_tokens`；`background`: 遥测路径；`conversation`: wireTemplateId=`anthropic-messages` |
| `extractIdentity` | request.structured / 升级请求头白名单 | `IdentityHint[]`（session/thread/turn/parent，hash 化，`strength`）| `client_metadata.session_id`(exact session)、`.thread_id`(exact thread)、`.turn_id`(strong turn)、`prompt_cache_key`(strong continuity)、`x-codex-parent-thread-id`/`x-openai-subagent`(parent→子 Session) | `metadata.user_id` 中 `session_<uuid>`(exact session)、`message_start.message.id`(strong response)、`tool_use.id` |
| `extractLifecycle` | argv（KernelFact Exec）/ 请求字段 | `LifecycleFact`：resume/fork/compact/subagent_spawn | argv `resume`/`fork`；`session_meta.forked_from_id` 仅作路径元数据提示 | argv `--resume/--continue/--fork-session`；`/compact` 表现为 `system` 变化 + 历史缩短 → `compaction` |
| `extractTool` | toolCalls/toolResults 原始项 | `ToolNameView{rawName, canonicalKind}`、`execArgvNormalizer`、`resultPairingKey` | `shell/exec_command→shell`、`apply_patch→file_edit`、`update_plan→unknown`、`web_search_call→browser`、`mcp__*→mcp`；normalizer：剥 `bash -lc`、`codex-linux-sandbox … --`；pairing `call_id` | `Bash→shell`、`Read→file_read`、`Write→file_write`、`Edit→file_edit`、`Glob/Grep→search`、`Task→subagent`、`WebFetch→browser`；normalizer：剥 shell-snapshot 包裹取 `eval '<cmd>'` 内文；pairing `tool_use_id` |

约束：Manifest 中路径匹配只允许前缀/精确，不允许正则执行任意代码；`classifyTraffic` 不看域名（合同 V4 §7.5）；Adapter 只返回值对象，没有 Service 写权限。`trafficRole=control/background` 的记录进入 Technical Activity 折叠区，不再显示为 `unparsed partial` 对话噪声，但**不删除**。Conversation Resolver V2 只让 `conversation`+`context_replay` 参与 Thread（已如此）。

对 Observer 的要求（保持产品无关）：WS 升级请求头中一个**非敏感白名单**（`x-codex-*` 前缀、`OpenAI-Beta`、`anthropic-beta`、`user-agent`）以 hash 或原值进入 `correlationHeaders`（`LlmInteraction` 已有该字段），Authorization/Cookie/API key 一律不出 Collector。

### 5.5 AnySentry：关联层——把两条 lane 连起来

(a) **ToolCall ↔ ToolResult 跨 Interaction 闭合**（G4）。通用规则：同一 Session/Segment 内，Interaction N 的 `toolCalls[].id` 与 Interaction N+k 请求体 `toolResults[].toolCallId` 精确相等 → 写 `RelationRevision(tool_call → tool_result, method=explicit_id, status=confirmed)`，并把 N 的 `conversationCompleteness` 从 `tool_pending` 提升为 `complete`（投影层，不改原始行）。Claude 累计历史里旧的 `tool_result` 是 `context_replay`，只对**首次出现**的 result 计数（V2 resolver delta 规则已定义）。Codex `input[]` 中 `function_call_output`/`custom_tool_call_output` 同理，需核对 Observer Responses 解析确实产出 toolResults（未验证，P1 fixture）。

(b) **ToolCall ↔ Exec KernelFact**（G5）。沿用 v3 correlator 的键与仲裁，只补两个通用输入：① Adapter 的 `execArgvNormalizer` 在比较前对 KernelFact argv 与 tool 参数同时归一化（去 `bash -lc`/`-c`、去 shell-snapshot 包裹、去 `codex-linux-sandbox` 前缀、去尾部 `pwd -P >| /tmp/…`）；② 时间窗改为 `[ToolCall 所在响应的 first_response_at, 匹配 ToolResult 所在请求的 request_complete_at]`（无 result 时 +30 min 上限，已有）。血缘：子进程的 `parentProcessGenerationKey` 必须落在 Agent 根代次或其受信 `network_runtime` 之下；Codex 沙箱 helper 作为中间节点不作根。唯一所有权与 ambiguous 规则不变。

(c) **文件类工具 ↔ FileAccess/FileDelete**。Claude `Read/Write/Edit`、Codex `apply_patch` 在**Agent 进程自身**内执行（无子进程），因此匹配对象是根代次自己的 FileAccess（路径归一化 + 访问模式），不是子进程。Adapter 只声明 `argumentPaths`（`input.file_path`、`apply_patch` 的 `*** Update File:` 路径）；匹配逻辑通用。

(d) **LlmCall ↔ Egress/TLS ClientHello**（G2）。用 §5.2 的 `ConnectionIdentity` 精确键写 `emitted_by`（method=`connection_stream`，confidence 0.98）；无 bind 时按 `(pid,fd)`+时间窗降为 `inferred`。此边同时给 Interaction 提供 `endpoint`（SNI）降级来源与 `Egress → Session` 反查。

(e) **MCP 工具**：`mcp__server__tool` 的执行体是 Agent 子进程（stdio MCP server）或远端（HTTP MCP，如 Codex `/backend-api/ps/mcp` tool interaction）。前者匹配子进程 Exec + pipe；后者匹配 `tool` 类型 Interaction（Observer 已产出）→ `ToolCall → Interaction(tool)` 边。远端无本地事实时 `semantic_only`。

(f) **子智能体**：Codex `x-codex-parent-thread-id`/`x-openai-subagent`、Claude `Task` 工具 → 新 Session 带 `parentSessionId`，运行在同一根进程代次（Claude）或新线程（Codex）。不因子智能体创建新 LogicalAgent。

### 5.6 前端（对话追踪页）的展示落点

不改三栏布局。对 Codex/Claude 的语义：

- 中栏时间线只显示 `trafficRole=conversation` 的 User/Model/Tool 三类 Actor；`bootstrap/control/background` 折叠进"技术活动"并显示条数（Codex backend-api 55 条即在此）。
- Tool 卡片显示 `rawName`（`Bash`/`shell`/`apply_patch`），状态按 §13.5 三态：`requested`（仅语义）→ `observed`（有 Exec/File EvidenceLink）→ `completed`（有 ToolResult 且子进程 Exit）；`ambiguous` 明示竞争候选。
- 右栏 Inspector 增加 `ConnectionIdentity` 小节：SNI/endpoint、`bind_quality`、关联 Egress/TLS ClientHello 深链；Coverage 小节显示 `unsupported_transport(h2_headers)`、`ambiguous_stream_binding`、`attach_pending` 等原因。
- Codex WS 一条连接多轮：左栏 Thread 以 `thread_id` 锚点聚合，多个 Turn 各自对应一次 `response.create`；resume 显示"恢复摘要"而不是重复的用户消息。

### 5.7 可扩展性证明：新增 Kimi CLI 需要做什么

按本设计落地后，新增 Kimi（或 Z.ai、Pi）只需：① 安装后用 Observer 现有扫描确认 TLS 实现族（Kimi 若为 Python/Node → 导出符号族；若为 Rust → rustls 族；未知族 → 新增签名族，`unsupported_tls_profile` 期间 KernelFact 照常）；② 填一页 `AgentAdapterManifest`（detection、session/turn/tool 路径、trafficRole 路径、`execArgvNormalizer`、`executableResolution`）；③ 提供 fresh/resume/fork/tool-loop/split-boundary fixture；④ 管理面注册定义。不需要改 Transport、LLM Format、Correlation、Sentry、Controller、SQL、前端。

---

## 6. 与另两位工程师的边界与文件所有权

| 区域 | 本人（Codex/Claude 全链路） | Observer 性能工程师 | LangChain/LangGraph 工程师 |
| --- | --- | --- | --- |
| Observer eBPF `main.rs` | rustls 探针段（~2574–2680）、`emit_tls_plaintext` 新增 bind 字段、新 map/tracepoint 绑定程序 | ring/inbox/reorder、Critical/Semantic 预算、verifier 预算 | — |
| Observer common `lib.rs` | `TlsPlaintextEventHeader` additive 字段、`TlsConnectionBind` POD | ABI 版本号协调 | — |
| Observer `interaction.rs` | `resolve_connection_key` 的 bind 优先路径、WS 配对、H2 HEADERS | 重组内存上限、淘汰策略 | 无（LangChain 走 HTTP/1.1 已通） |
| Observer `tls_attach.rs` / json 注册表 | rustls vectored 变体前缀、`executableResolution` | attach 重试节流 | — |
| AnySentry `agent-interaction.ts` | `applyAgentAdapter` 插入点 | — | 应用语义（OTLP/authenticated adapter）入口不重叠 |
| AnySentry `canonical-observability.ts` | Manifest 字段扩展（`trafficRoles/anchors/toolNameView/execArgvNormalizer/executableResolution`）、`codex-cli`/`claude-code` 条目 | — | `langchain-langgraph`/`dify` 条目 |
| AnySentry `agent-semantic-kernel-relation.ts` | normalizer 注入、ToolResult 闭合、connection 边 | — | sandbox 跨 Pod 归属规则（共享 correlator，改动前互相知会） |
| Web `SemanticInteractionInspector.tsx` | ConnectionIdentity/Coverage 小节 | — | — |

共享文件（`interaction.rs`、`agent-semantic-kernel-relation.ts`、`main.rs`）改动前在交接消息声明行段，checkpoint commit 只 `git add` 自己的文件，不做 `commit -a`。本地构建部署前先停旧的 collector/forwarder 与 API Pod（`kubectl -n anysentry scale`/`rollout`），避免双份采集抢占 tracepoint 与 I/O。

---

## 7. 分阶段实施

| 阶段 | 内容 | 主要文件 | 完成判据 |
| --- | --- | --- | --- |
| P0 Adapter 执行 | `applyAgentAdapter`；Manifest 增字段；Codex/Claude 声明；`trafficRole` 进 AgentInteractionRecord 与 Timeline V3 折叠；`toolNameView` | `agent-adapter-execution.ts`、`agent-interaction.ts`、`canonical-observability.ts`、`types.ts`、`scripts/verify-agent-adapter-execution.mjs` | **已完成（2026-09-08）**：ingest 调用 `applyAgentAdapter`；Codex backend-api / Claude `count_tokens` → `control/background` 并折叠进 technical activity；`toolCalls[].canonicalKind`；`node scripts/verify-agent-adapter-execution.mjs` 绿 |
| P1 连接身份桥接 | §5.2 map/tracepoint/ABI；Collector bind 优先合并；`connection.*` 进 `LlmInteraction`；Ingest 写 `ConnectionIdentity`；`emitted_by` 边；SNI 降级 endpoint；rustls vectored；G9 定位 | Observer common/ebpf/collector；AnySentry `canonical-observability.ts`、correlation | Codex 一次 WS 会话：`ambiguous_stream_binding`=0（或有 `bind_missing` 明确计数）、metadata-only 证据 ≤1/连接、`endpoint` 非 unknown、每条 LlmCall 有 Egress 边；Claude 每条 `/v1/messages` 有 Egress 边；`cargo test/clippy/fmt`、eBPF release build、verifier 通过 |
| P2 Tool 双向闭合 | ToolResult 跨 Interaction 配对；argv/路径归一化；Codex/Claude 真实工具回合验收；Inspector 小节 | correlation、projection、web | Claude `Bash`/`Edit` 各 ≥1 条 `observed/completed` 唯一 EvidenceLink，`tool_result_pending` 在下一轮后闭合；Codex `shell`/`apply_patch` 同理；ambiguous 场景（并发两条相同命令）保持 ambiguous |
| P3 HTTP/2 HEADERS | 有界 HPACK；Codex REST provider fixture | `interaction.rs` | `supports_websockets=false` provider 下 Responses REST 能得到 method/path/status 与 complete exchange，或明确 `h2_hpack_desync` gap |
| P4 扩展性回归 | 用 Kimi/Pi Manifest（无二进制）跑 fixture 回放，证明零核心改动 | fixtures、verify 脚本 | 新 Manifest 加入后旧回放 diff 为空 |

每阶段结束：`pnpm build:api && node scripts/verify-canonical-observability.mjs && node scripts/verify-agent-conversation-resolution-v2.mjs && node scripts/verify-agent-semantic-kernel-relation.mjs`；Observer `cargo fmt --all -- --check && cargo test -p a3s-observer-common -p a3s-observer-collector --release && cargo clippy … -D warnings`；旧 fixture 回放 diff；本地 checkpoint commit（不 push）。

---

## 8. 测试矩阵（Codex / Claude Code 各一份 fixture 集）

| 场景 | Codex | Claude Code | 断言 |
| --- | --- | --- | --- |
| fresh session，一轮无工具 | WS `response.create` → `response.completed` | `/v1/messages` SSE | 1 LlmCall complete，Session=provider exact，Turn=1 |
| 一轮含工具 + 结果回传 | `function_call shell` → 子进程 `bash -lc` → 下一 `response.create` 含 `function_call_output` | `tool_use Bash` → 子进程 shell-snapshot bash → 下一请求 `tool_result` | ToolCall→Exec 唯一 `observed`；Result 闭合 → `completed`；Exec 子进程 File/Egress 归入同 Turn |
| 文件工具 | `apply_patch` | `Edit`/`Write`/`Read` | 根代次 FileAccess 路径匹配，无子进程 |
| 同一 WS 连接连续两轮 | 两次 `response.create` | — | 两个 Turn 各自配对，无交叉；第二轮 `input[]` 历史标 `context_replay` |
| 指针移动 / 任意字节边界切分 | 回放真实 chunk 序列并注入 `CommonState` 地址变化 | 16 KiB 切分 SSE | bind 合并后无 ambiguous；无 bind 时明确 `bind_missing` |
| 并发两个连接 | 主线程 + 子智能体线程同时请求 | `Task` 子智能体 | 按 socket 区分，不按时间猜 |
| resume / fork / compact / 重启 | `codex resume`、`fork` 线程、进程重启 | `--resume`、`--fork-session`、`/compact`、重启 | 新 AgentInstance；resume 同 Session 新 Segment；fork 新 Session+parent；compact 同 Session |
| 控制/后台流量 | backend-api plugins/analytics/otlp/mcp | count_tokens、遥测 | `trafficRole` 正确，折叠不删除 |
| HTTP/2 REST provider | `supports_websockets=false` | — | P3 前 `unsupported_transport` 且 KernelFact 完整；P3 后 complete |
| attach 失败 / 未知 ABI | 篡改前缀 | 篡改前缀 | `unsupported_tls_profile`；Exec/File/Network KernelFact 与 Candidate 保留 |
| 环境 | Host、SSH 终端、`tender_jang` Docker、k3s | 同 | 同一 Adapter，差异只在 RuntimeContext |
| 隐私 | 真实 API key / prompt 不落盘 | 同 | fixture 用合成凭据与短内容；报告只有计数与 hash 前缀 |

---

## 9. 风险、边界与未验证项

- **未验证**：`bpf_get_socket_cookie` 在目标内核（本机 6.17；UOS 4.19 arm64 发布通道）tracing 程序中的可用性；不可用时按 `(pid,fd,fd_generation)` 降级。
- **未验证**：Codex WS 请求中 `function_call_output` 是否已被 Observer Responses 解析为 toolResults（当前 2 条 parsed 记录 toolCalls=0，可能是 partial 截断）。P1 fixture 先回放确认。
- **推断**：rustls `CommonState` 地址变化源于连接对象按值移动；即使原因不同，socket 桥接方案与原因无关。
- **推断**：Observer 日志 `write_hits=0` 与 API 中存在 `rustls-payload` 记录并存，说明该诊断计数器口径（可能只统计某一子路径）需要在 P1 一并核对，不能据此判断探针无效。
- **版本漂移**：Bun/BoringSSL 与 rustls 序言随编译器变化；对策仍是同族新增前缀/fixture + fail-closed，不加版本分支。
- **verifier 预算**：新增 tracepoint 与 map 查找必须保持 `bpf_loop`/有界；每次改动跑 eBPF release build 与已有 verifier 冒烟。
- **性能**：`sys_enter_write/read` 上多一次 hash 查找，对所有进程生效；用 `VERIFIED_AGENT_PROCESSES` 先过滤再查 `LAST_TLS_CTX`，与性能工程师核对 ring/inbox 影响。
- **隐私**：正文仍 hash-only 进 Canonical；header 白名单只含 `x-codex-*`/`OpenAI-Beta`/`anthropic-beta`/`user-agent`，且 `x-codex-turn-metadata` 一类 hash 后存。
- **不做**：读取 `~/.codex/sessions`、`~/.claude/projects` 正文补全响应；LLM Gateway/MITM；Hook/OTel 注入 Agent。

---

## 附录 A：本次调研证据索引（脱敏）

- 二进制：`file`/`nm`/`readelf`/`strings` 对 `codex`（0.153.4，musl static stripped，rustls/h2/tungstenite/OpenSSL 字符串）与 `claude.exe`（2.1.263，Bun/BoringSSL 路径字符串，1221 符号无 SSL 导出）。
- Observer 日志（`a3s-observer-s8s6r`，4h）：`attached verified Agent TLS plaintext probes product=tls-family:boringssl-classic-x86-64-… path=…/claude.exe programs=4`；`TLS target rejected … static_tls_family_not_discovered`（另一容器内 ELF，dev:86）；`TLS plaintext profile diagnostics … write_route_candidates=169 ssl_classic_successes=33592`。
- API：`POST /security-center/agents/interactions`（`last_1d`）113 条分组统计见 §2.3；查询使用 Kubernetes Secret 临时读入 shell 变量的管理令牌，已 `unset`，未写入任何文件。
- 注册表：`tls-signature-families.json`（v2，三族）、`tls-validated-anchor-fixtures.json`（按实现族分组的前缀校验 fixture）、`tls-runtime-selection-hints.json`（7 条 hint，含 kimi、pi）。
- agentsight：`bpf/sslsniff.bpf.c`、`bpf/sslsniff.c`（`find_boringssl_offsets`、`attach_codex_rustls`）、`bpf/codex_offsets.h`、`agentsight-capture/src/binary_resolver.rs`、`ext/analysis/src/analyzers/*`、`ext/analysis/src/view/{canonical,projection}.rs`、`docs/design/paper.txt`、PR #100/#107/#127/#134。
- 代码定位：见 §1.1 末段。
