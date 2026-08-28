# AnySentry Agent—LLM 与外部工具明文观测技术设计

> 状态：实现完成，等待代码与发布复审
>
> 文档版本：v1.0-implementation-review
>
> 实现分支：`feat/agent-tls-interaction-observability`
>
> 集成基线：AnySentry `origin/main@9625908` 加
> `fix/observer-delivery-health-20260827@d139a25`；Observer `origin/main@06105bb`
>
> 产品需求：[PRD](./anysentry-agent-llm-interaction-observability-prd.md)
>
> 运行证据：第 13 节保留可复核摘要；含本机端点、运行实例和临时镜像信息的原始验证
> JSON 仅保留为本地审计产物，不纳入 Git
>
> 发布状态：完成新基线回归后重新构建带源码 revision 的正式镜像；旧分叉工作树构建的
> 本地镜像不属于本设计的发布产物

## 0. 设计摘要

本实现新增独立的 `anysentry.agent_interaction.v1` 数据链，不再尝试把旧 `SslContent` 的 1,024-byte 快照拼成完整调用。数据链由三个连续、互不替代的准入层组成：[E002][E003][E004]

1. **进程层**：只有成功识别并完成 PID-scoped TLS attach 的 Agent PID/cgroup 才进入内核 plaintext allow map；
2. **路径层**：TLS/HTTP 写入必须是 `POST`，且 request path 的有界 hash 命中模型默认路径或运维显式配置的工具路径；
3. **协议语义层**：用户态必须完成 HTTP/1.1 framing；模型路径还要满足生成请求 body 结构，工具路径则依赖显式 route authority。

```text
process/signature -> PID-scoped attach -> process+cgroup map
                                           |
Agent SSL_write/read or HTTP write/read ----+
        |
        +-> POST + admitted path -> bounded plaintext record
                                      |
                                      v
                          HTTP/SSE/provider reassembly
                                      |
                                      v
               Observer NDJSON LlmInteraction (model | tool)
                                      |
                                      v
                   Forwarder -> API -> ClickHouse/Hot Ring -> UI
```

该设计解释了 Egress 与 TLS plaintext 的关系：HTTP egress bytes 是明文；HTTPS 普通 egress 已是 TLS record。Egress/DNS/SNI 可以继续证明目标和辅助资产识别，但当前正文来自加密前/解密后的进程函数边界，不是事后从网络密文恢复。[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) [E016]

实现已经在固定版本 Pi、LangChain、Dify、Claude Code 和 Codex HTTP fixture 中产生完整 request/response/tool evidence；该证据不支持通用 Go/Rustls、HTTP/2、WebSocket、QUIC 或生产性能结论。[E011][E023]

## 1. 目标、约束与不变量

### 1.1 开发目标

- 对 Candidate/Confirmed Agent 的受支持连接生成 model interaction；
- 同时保存最终 request、LLM-visible response、模型 tool call 和后续 tool result；
- 对显式准入的外部 HTTP 工具生成独立 tool interaction；
- 复用现有 Agent Asset、Runtime、Source 认证、分类和审计，不建设第二套身份系统；
- HTTP/TLS 采集、重组、转发、存储失败均 fail-open，不阻断 Agent；
- 前端在同一 Agent 详情页展示内容、时间、工具顺序、结果、hash、完整性和来源。

### 1.2 设计不变量

I-01：正文边界是实际 HTTP body。Agent 内部读取或生成过、但没有进入该 body 的数据不属于 Model Interaction。

I-02：进程身份、HTTP path 和模型语义必须逐层成立。任何一层都不能单独授权全量 plaintext。

I-03：未知二进制指纹不猜偏移；不完整 TLS function pair 不写入 PID allow map。[E003]

I-04：原始 body 和 SHA-256 是权威内容证据。`structured/messages/text` 是可省略的派生视图，不能反向替换 raw body。

I-05：Authorization、Cookie、API key 不进入 Interaction。当前捕获对象从 request line 开始，但用户态只导出 body 与安全元数据。

I-06：内核时间是传输边界时间。无 Hook 时不伪造 framework Turn、workflow node 或工具内部执行开始/结束。

I-07：任何“complete”都来自 framing 完成且没有已知 partial reason；attach 成功、capture profile=`full` 或 JSON parse 成功都不能单独证明 complete。

I-08：资源全部有界。超限时丢观测而不是阻塞 Agent，并保留能够对账的 drop/truncation 状态。

## 2. 代码边界与组件职责

| 仓库/模块 | 当前职责 | 关键入口 |
| --- | --- | --- |
| Observer common | 共享 eBPF ABI、route class、tier size、model types | `a3s-observer-common/src/lib.rs`、`src/model.rs` |
| Observer eBPF | process/route gate、TLS/HTTP byte copy、sequence、capture decision | `a3s-observer-ebpf/src/main.rs` |
| Observer attach resolver | 发现 Agent PID、容器路径、TLS 库/主 ELF、符号或精确 profile | `a3s-observer-collector/src/tls_attach.rs` |
| Observer reassembler | HTTP/1.1、transfer/content decoding、SSE/provider/tool parsing | `a3s-observer-collector/src/interaction.rs` |
| Observer collector main | 安装 routes、attach、map 同步、事件时间校准、NDJSON 输出 | `a3s-observer-collector/src/main.rs` |
| Forwarder | 分类、Source 认证信封、优先级队列、batch/retry、上限 | `scripts/observer-forward.js` |
| AnySentry parser | schema、size/hash、classification、identity normalization | `apps/api/.../agent-interaction.ts` |
| AnySentry aggregation | 2,000/64 MiB hot ring、ClickHouse merge/filter、coverage | `aggregation.service.ts` |
| ClickHouse store | 专用表、migration、insert/query、30-day TTL | `clickhouse-store.ts` |
| Query/Audit API | management auth、参数边界、content read audit | `security-monitoring.controller.ts` |
| Web | model/tool list、request/response、tool timeline、responsive UI | `apps/web/src/pages/AgentsPage.tsx` |

生产 AnySentry 未新增第三方依赖。Observer Collector 新增 `httparse`、`flate2` 和 `base64`：分别用于有界 HTTP framing、gzip/deflate 解码和非 UTF-8 body 的无损传输。LangChain 包只固定在测试 Dockerfile，不进入生产依赖。

## 3. 端到端控制流

### 3.1 一次 TLS 模型调用

```text
Agent PID       TLS uprobe/eBPF       Collector          Forwarder/API       UI
   | attach verified |                  |                    |                |
   |---------------->| allow pid+cgroup |                    |                |
   | SSL_write POST  |                  |                    |                |
   |---------------->| route gate       |                    |                |
   |                 |----request------>| HTTP request       |                |
   | SSL_read SSE    |                  |                    |                |
   |<----------------|----response----->| pair + parse       |                |
   |                 |                  |--LlmInteraction--->| hash/classify   |
   |                 |                  |                    |--store/query--->|
```

关键时间由 fragment 的 monotonic timestamp 经 Collector anchor 校准为 Unix ns：request 第一片形成 `startedAtUnixNs`，request framing 完成形成 `requestCompleteAtUnixNs`，response 第一片形成 `firstResponseAtUnixNs`，response/SSE 完成形成 `endedAtUnixNs`。

### 3.2 模型工具调用与结果

```text
request #1 -> LLM response(toolCall id=call_1)
                  |
                  +-> UI: tool issued boundary

Agent executes tool outside model transport

request #2(messages include tool result call_1) -> LLM response(final text)
                  |
                  +-> UI: result observed boundary; call_1 paired
```

该链能证明“模型返回的工具指令”和“Agent 后续实际放进模型请求的工具结果”。它不能在无 Hook 条件下证明 framework 调用函数的精确开始/结束；现有 `ToolExec`、FileAccess、ProcessExit 可以作为另一个内核事实面板，但只有稳定 ID/严格证据时才应合并。

### 3.3 外部 HTTP 工具

外部工具 path 只有在 `A3S_OBSERVER_TOOL_HTTP_ROUTES` 明确列出后才进入 capture。request 完成时生成 transport tool call，response 完成时生成同一 transport ID 的 tool result。该链记录的 duration 是 Agent→工具 endpoint→Agent 的边界耗时，不是工具服务内部 CPU 时间。

## 4. Agent 进程选择与 TLS Attach Resolver

### 4.1 进程发现

`TlsAttachManager` 每 2 秒扫描 `/proc`，但只对匹配受控产品模式的进程继续解析。默认模式包括 Codex、Claude、Dify plugin daemon、LangChain、Pi coding agent 和 Pi fixture；额外模式由 `A3S_OBSERVER_TLS_PROCESS_PATTERNS` 提供。

进程选择规则：

- `comm` 精确等于 `codex | claude | claude.exe | pi`；
- `comm/cmdline` 命中受控 pattern；
- 精确 `cmdline == pi`，覆盖 Node PID 1 仍保留 `MainThread` 的情况；
- 只有 Dify plugin-daemon 的有限祖先关系可以继承，普通 Codex/Claude/Pi 工具子进程不继承 TLS Agent 身份。

测试环境为定位 Dify provider/worker使用了 `openai_api_compatible,celery` 扩展 pattern。`celery` 过宽，不应成为生产默认值；生产应使用控制面下发的具体 cgroup/signature 或更精确 runtime command。

### 4.2 容器路径与 cgroup

容器中的 `/usr/lib/.../libssl.so` 不一定存在于 Observer root。Resolver 读取 `/proc/<pid>/maps`，再通过 `/proc/<pid>/root/<mapped-path>` 打开目标容器实际 inode；计划 key 包含 PID、device、inode 和 symbol family。

明文 allow map key 为：

```text
PlaintextProcessKey = cgroup_id(8B) + host_pid(4B) + padding(4B)
```

当 host cgroup path 无法重建时，Collector 读取 `/proc/<pid>/root/sys/fs/cgroup` 的 kernfs inode。
受控 Docker Pi 使用不同的 namespace PID 与 host PID，并产生 3 条完整 TLS interaction，
说明 cgroup namespace fallback 与内核 `bpf_get_current_cgroup_id` 对齐。[E011]

### 4.3 动态符号路径

Resolver 支持从以下位置按符号 attach：

- 目标进程主 ELF 导出的 OpenSSL symbol，例如 Node；
- 容器/宿主机动态 `libssl`；
- 代码上可识别 GnuTLS/NSS symbol family，但未进入本期发布兼容矩阵。

Node/Python 主 ELF 尝试 classic 与 `_ex` OpenSSL pair。动态库 attach 只有完整 read/write pair 成功才计为覆盖；单个符号成功不会把 PID 写入 plaintext allow map。

### 4.4 静态二进制 profile

静态/stripped CLI 只能匹配 `tls-profiles.json` 中的精确 profile。校验条件同时包括：

- 文件大小；
- head 64 KiB SHA-256；
- whole-file SHA-256；
- read/write offset；
- offset 处预期指令前缀；
- classic 或 OpenSSL `_ex` ABI。

当前 profile：

| Product | 版本 | profile 能力 | 运行结论 |
| --- | --- | --- | --- |
| Claude Code | 2.1.170 | BoringSSL classic read/write exact offsets | HTTPS Messages TLS 2/2 complete |
| Codex CLI | 0.150.1 | 精确 OpenSSL `_ex` offsets | profile 可 attach，但实测 custom HTTPS 与默认 WS 走 Rustls，未产生 plaintext；不能宣称 HTTPS 支持 |

Codex 官方配置支持 custom provider `base_url`、`env_key`、Responses wire API 和 WebSocket capability switch；这些配置项不等于 TLS 实现证据。[Codex configuration reference](https://developers.openai.com/codex/config-reference) [E017][E018]

### 4.5 生命周期与 fail closed

成功 attach 后 `mark_attached(plan.key, pid)` 才把 PID加入 `plaintext_pids`，随后同步 BPF map。进程退出后 `plaintext_pids()` 移除不存在 PID，map sync 清理旧 key。未知 fingerprint、找不到完整 TLS pair、路径/ELF 读取失败都只上报告警，不降级为猜偏移。

当前 scan 属于轮询，极短生命周期 Agent 可能在下一次 attach 前完成首调用。测试 fixture 通过 `SIGSTOP/SIGCONT` 或 attach grace 明确建立“先 attach、后请求”门槛；生产短任务需要事件驱动 attach 或外部生命周期控制，不能承诺回溯已经加密发送的正文。

## 5. 内核明文数据面

### 5.1 Maps

| Map | 上限 | Key/Value | 作用 |
| --- | ---: | --- | --- |
| `PLAINTEXT_AGENT_PROCESSES` | 16,384 LRU | process+cgroup → marker | Gate 1 |
| `PLAINTEXT_HTTP_ROUTES` | 512 | FNV-1a path hash → model/tool | Gate 2 |
| `PLAINTEXT_SSL_SESSIONS` | 8,192 LRU | pid+SSL pointer → route kind | TLS session admission/revocation |
| `HTTP_SOCKS` | 8,192 LRU | pid+fd → route kind | Plain HTTP connection admission |
| `SSL_CALL_ARGS` | 10,240 | pid_tgid → buffer/ABI/time | entry→return 参数传递 |
| `SSL_CALL_SEQUENCES` | 16,384 LRU | pid+connection+direction → seq | 缺片/乱序检测 |
| `SSL_EVENTS` | 32 MiB ring | tiered plaintext record | 与普通 event rings 隔离 |

route map 使用 64-bit FNV-1a hash，不保存 path 明文；配置 path 必须以 `/` 开始、不超过 58 bytes，并禁止 query、fragment 和换行。理论 hash collision 是剩余风险，当前通过 Agent Gate、POST、body semantic Gate 共同降低误采影响；若该 route 被视为对恶意已选 Agent 的强安全边界，应升级为双 hash/length key。

### 5.2 Kernel request-line admission

`http_request_prefix_kind` 只读取 request line 前 64 bytes：

1. 识别常见 HTTP method；
2. 非 POST 返回 `OTHER`；
3. 从 `POST ` 后计算 path hash，遇空格、`?` 或 CR 停止；
4. 用 `bpf_loop` 执行有界逐字节 hash，避免展开循环导致 verifier 指令数超过上限；
5. map 命中才返回 `LLM` 或 `TOOL`。

TLS 第一次应用 write 命中后，把 `(pid, SSL*) → route kind` 写入 session map，后续 response read 才能通过。SSL pointer 被非 LLM request 复用时会撤销旧 admission。Plain HTTP 以 `(pid,fd)` 保存同类状态，直到 close/LRU eviction。

### 5.3 TLS API capture

挂载程序覆盖：

- `SSL_write` entry/return；
- `SSL_read` entry/return；
- `SSL_write_ex` entry/return；
- `SSL_read_ex` entry/return；
- exact profile 的 classic 或 `_ex` offset。

entry 保存 buffer、请求长度、SSL pointer、direction、ABI 和 monotonic start；return 读取真实成功长度。Classic API 使用返回 `i32`，`_ex` 使用 output pointer；失败或 0 bytes 不复制。

每次成功 API call 选择最小容纳 tier：16 KiB、128 KiB、512 KiB。`original_len` 保存 API 成功长度，`captured_len` 保存实际复制长度；超过 512 KiB 设置 `TRUNCATED`。记录同时包含：

- ABI/header version；
- cgroup、PID、TID；
- SSL pointer/connection ID；
- per-direction call sequence；
- direction 与 API kind；
- call start/capture monotonic ns；
- capture decision；
- tool-route、unbound、copy-error/truncated flags。

### 5.4 明文 HTTP syscall capture

Collector 加载 `sys_enter_write`、`sys_enter_writev`、`sys_enter_sendto` 识别 request；`sys_enter/exit_read` 与 `recvfrom` 按真实返回长度捕获 response。PID/cgroup 和 route gate 与 TLS 共享，因此启用 HTTP parser 不会把该 Agent 的任意 stdout、pipe 或非准入 socket 当成模型正文。

Codex 0.150.1 的本期兼容路径正是该 plain HTTP lane，source=`tcp_plaintext`。如果用户把同一 endpoint 改成 HTTPS，普通 syscall 只能看到 TLS records；在 Rustls 未支持时必须显示 unsupported。

### 5.5 非阻断和 backpressure

probe 只执行 map lookup、bounded user copy、ring reserve/submit 和计数。reserve 失败、copy 失败、单 call 超限时立即返回，不等待 Collector。用户态 ring reader、reassembly、Forwarder 和 ClickHouse 全部在 Agent 请求路径之外。

风险不是“会阻断 Agent”，而是“会丢观测”。因此完整性必须同时考虑：kernel truncation、ring drop、fragment sequence gap、HTTP framing、queue event size、API body limit 和 persistence availability。

## 6. 用户态重组与协议解析

### 6.1 Connection state

`InteractionReassembler` 是单写者、有界状态机。Key 为：

```text
ConnectionKey = cgroup_id + pid + connection_id
```

TLS `connection_id` 使用 SSL pointer；plain HTTP 使用稳定 socket-derived key。State 分别保存 request/response decoder、pending request FIFO、per-direction last sequence、source 和 last activity。

默认边界：2,048 active connections、每个方向 8 MiB、90 秒 idle timeout。达到 connection 上限时淘汰最旧 idle state；正文超限或 sequence gap 写 partial reason。当前超过 declared Content-Length 上限时无法证明 message 结束，因此不会生成伪造 complete interaction。

### 6.2 HTTP/1.1 framing

`httparse` 解析 request/status line 和最多 96 个 headers。Decoder 支持：

- 跨 fragment header/body；
- Content-Length；
- chunked transfer；
- gzip、zlib/deflate；
- 1xx 不消费 pending request；
- 同一 keep-alive connection 的顺序 exchange；
- response close/SSE 终止边界；
- 非 UTF-8 body 使用标准 base64，不做 lossy decode。

endpoint 只取 `Host`，content-type/content-length/content-encoding/transfer-encoding 只用于解析；Authorization 等 headers不进入输出。HTTP/2 preface 明确返回 `unsupported_http2`，不按 HTTP/1 误解。

### 6.3 模型语义 Gate

`looks_like_llm_request` 要求：

- method=`POST`；
- path 为默认/兼容模型生成后缀，包括 Gemini `:generateContent` 类；
- body 是 JSON，且满足 `model + messages/input/prompt`，或存在 `contents`。

该 Gate 阻止真实案例中的 `api.moby.localhost` Docker control request 被误标为 LLM，即使 body 恰好出现 `model/input` 字样。路径与语义缺一不可。[E004][E010]

显式 tool route 不执行 LLM body Gate。它把 request structured/body 规范化为一个 transport tool call，把 response structured/body 规范化为同 ID tool result；HTTP status ≥400 标 `isError=true`。

### 6.4 Provider parsers

首批 parser 能力：

| Provider shape | Request | Response/tool |
| --- | --- | --- |
| OpenAI Chat Completions | `model/messages/tools` | `choices.message/delta.content`、`tool_calls` |
| OpenAI Responses | `instructions/input/tools` | `output`、`function_call`、`function_call_output`、`item/response` 嵌套 |
| Anthropic Messages | `system/messages/tools` | content block、tool_use、input_json_delta、message_stop |
| OpenAI-compatible | 兼容上述字段 | JSON 或 SSE fallback |

SSE parser 不假设一条 TLS read 等于一条 event；它按空行分隔，最多保存 2,048 个 structured events，聚合文本 delta、tool name/arguments delta 与 terminal item。Chat tool-call arguments 分片保留首次非空 ID；Anthropic partial JSON 在 block 范围聚合。

tool result 从下一次 request 中提取：

- OpenAI `function_call_output` 的 `call_id/output`；
- Chat/Anthropic `role=tool`、`tool_call_id` 或 tool-result block。

### 6.5 Content 构造与多模态

`make_content` 对 decoded body 计算 SHA-256，保存真实 decoded bytes 和 captured bytes。正文是 UTF-8 时原样保存，否则 base64 编码；parser 不把图片/音频解码成视觉/音频语义，也不主动下载 URL。

为防止一个 inline image 在 `body + structured + messages` 中重复两到三次：

- body ≤512 KiB：可同时导出 structured/messages/text；
- body >512 KiB：保留完整 raw body、bytes、hash；省略 structured/messages 的重复副本；
- response text 自身超过 512 KiB 时也不另存重复 text，raw response 仍是权威来源。

Collector 可跨多个 ≤512 KiB TLS API call 重组到 8 MiB。一次 API call 本身超过 512 KiB 仍会截断；这与总 stream 上限是两个不同维度。大内容测试必须模拟真实多 call 分片，不能只把 600 KiB 直接注入用户态并宣称内核支持。

### 6.6 Interaction ID 与完整性

`interactionId` 由以下内容 hash 后截取 24 个 hex 字符并加 `mi_`：cgroup、PID、connection、connection sequence、start time、path、request SHA-256。它用于幂等和查询，不承担跨来源语义 Turn ID。

完整性由 request/response partial reasons 合并决定：没有已知原因时 `complete`；存在 fragment gap、kernel truncation、reassembly limit、decode/parser error 等时降级。V1 仍有一个已知缺口：如果 Content-Length 大于 8 MiB或关键单 call 被截断，HTTP message 可能无法形成 Interaction；当前可通过 probe/ring计数诊断，但尚未生成 metadata-only partial record。

## 7. Observer 事件与 Forwarder

### 7.1 `AgentEvent::LlmInteraction`

Collector 输出字段与 AnySentry wire name 一致：

| 组 | 字段 |
| --- | --- |
| Identity | schemaVersion、interactionId、interactionType、pid、connectionId |
| Protocol | transport、protocol、endpoint、method、path、statusCode、model |
| Timing | started/requestComplete/firstResponse/ended/duration、timeQuality |
| Content | request、response：body/encoding/type/bytes/hash/completeness/derived fields |
| Tool | toolCalls、toolResults |
| Quality | completeness、partialReasons、captureSource |

source 根据 lane 与 route 标记为：

- `tls_uprobe`；
- `tcp_plaintext`；
- `tls_uprobe_tool_route`；
- `tcp_plaintext_tool_route`。

### 7.2 Forwarder 语义

Forwarder 把 `LlmInteraction` 设为最高保护优先级之一，和 ToolExec/ProcessExit 一样不会被普通 non-Agent noise policy 丢弃。它仍携带完整原始 `line`，由服务器使用最终 classification 决定是否存正文。

边界：

- 默认 batch 32 events、50 ms flush、512 KiB目标 batch；
- 单个首项可超过 batch target 独立发送；
- `FORWARD_MAX_EVENT_BYTES=12 MiB`；
- outstanding 16,384 events / 64 MiB；
- retry 有时间、数量和 byte ownership 边界；
- event 太大或队列不可容纳时记录明确 drop reason。

Source token、collector ID、workspace 和 classification semantics 由 Forwarder envelope 提供。正文原始 line 不允许自称 trusted classification；API使用服务器解析后的 `meta.classificationSemantics/attribution`。

## 8. AnySentry 接入、身份与存储

### 8.1 Parser 和安全校验

`parseObserverAgentInteraction(line, meta)` 执行：

1. line ≤14 MiB；
2. JSON 和 `anysentry.agent_interaction.v1`；
3. `mi_` ID、时间字符串、path/endpoint/method 上限；
4. request/response body ≤8 MiB；
5. base64 canonical 校验；
6. decoded length 与声明一致；
7. 重新计算 SHA-256 与声明一致；
8. classification 必须是 probable/confirmed；
9. 使用 `detectedAgentIdentity` 生成 canonical Agent Asset/Runtime instance；
10. derived JSON、tool calls/results 和数组数量有界。

任何校验失败都不进入 interaction store。hash tamper、Unknown classification 和大正文都已有 verifier。[E006][E010]

### 8.2 Hot ring

Aggregation 层先把记录写入 `interactionHot`，按 ID 更新。Hot ring 同时受 2,000 records 与 64 MiB 限制，超限删除最早项。这样 ClickHouse 短暂不可用时页面仍可看到近期记录，但响应标记 `dataSource=hot_ring`、coverage partial，不伪装为完整历史。

### 8.3 ClickHouse 表

`agent_interactions_v1` 使用 `ReplacingMergeTree(revision)`：

| 列 | 用途 |
| --- | --- |
| interactionId/revision/at/ts | 幂等 revision、时间分区与 TTL |
| tenant/environment/workspace/source/collector | 数据域和来源 |
| agentAsset/agentInstance/agentProduct/classification | Agent 归因 |
| interactionType/transport/protocol/endpoint/model/completeness | 查询过滤 |
| startedAtUnixNs/endedAtUnixNs | 精确边界 |
| requestSha256/responseSha256/toolCallIds | 对账和工具索引 |
| payload | 完整 versioned record，包括正文 |

Partition 为月份，ORDER BY tenant/environment/agentAsset/at/interactionId，TTL 30 天。启动时执行 `ADD COLUMN IF NOT EXISTS interactionType ... DEFAULT 'model'`，旧行自动视为 model；live ClickHouse 验证列类型为 `LowCardinality(String)`，query 返回 `dataSource=clickhouse`。[E007][E011]

### 8.4 Query、权限与审计

`POST /security-center/agents/interactions` 支持时间窗、asset/instance/interaction/type/model/transport/completeness 和 limit（最大 500）。Controller 使用 `@RequireManagementAuth()`；返回原文后写 `agent.interaction.content.read` audit，包含 actor、resource、result count、scope 和 limit。[E008]

当前管理 token 是 V1 的最小安全边界，不是最终 content RBAC。生产多租户场景仍需：独立 `interaction.content.read/export` 权限、理由/短期 grant、按 tenant/environment 限定、导出审计、KMS 和独立 blob store。当前 ClickHouse payload 中有 raw body，必须按敏感数据管理。

### 8.5 Raised multimodal ingress bounds

完整链路上限：

| 层 | 值 |
| --- | ---: |
| Forwarder event | 12 MiB |
| Express observer route | 16 MiB |
| Controller batch payload | 15 MiB |
| Parser line | 14 MiB |
| Parser request/response body | 8 MiB each |

测试构造了 2,097,344-byte inline multimodal request；其 envelope 超过旧 4 MiB限制，API 接受并保留 raw/hash，同时省略过大的 duplicate structured view。Observer ingress 5 MiB到达 controller，17 MiB在 body parser 被 413 拒绝。[E010][E015]

## 9. Web UI

`AgentInteractionTrace` 在 Agent 详情页按当前 canonical `agentAssetId + agentInstanceId` 查询：

- header 分别统计“模型调用”和“外部工具调用”；
- list 显示时间、complete、model 或 tool path、transport、endpoint、HTTP status、duration、bytes、指令/结果数；
- detail 显示 Interaction/Connection、四个边界、capture source/time quality；
- model labels 为“最终发送给 LLM 的请求”“LLM 返回给 Agent 的内容”；
- tool labels 为“Agent 发送给外部工具的指令”“外部工具返回给 Agent 的结果”；
- tool timeline 按 index 展示 name、ID、arguments、result、issued/result time 和边界耗时；
- partial reason 和 data coverage 在 UI 显式呈现。

真实浏览器 verifier 先选择 Pi asset 验证 3 次 model interaction，再选择 Dify worker asset 验证 1 次 external tool interaction；1440×1100 与 390×844 均无横向 overflow、runtime exception 或 failed network request。[E009][E013]

Dify provider 与 worker 当前可能显示为不同 Agent Asset。这不是 UI bug，而是无 Hook 阶段不能把共享 provider process 与 worker tool node 强合并为同一 workflow run；后续 Dify Adapter 必须用上游逻辑 ID解决。

## 10. 产品特定实现和证据

### 10.1 Pi

Pi fixture 使用真实 Pi CLI、真实内置 `read/bash` 工具和 OpenAI-compatible SSE provider：

```text
request #1 -> read(canary.txt)
request #2 + read result -> bash(fixed command)
request #3 + both results -> final text
```

宿主机与 Docker 各通过 22 项独立断言。Docker 请求由不同的 namespace PID/host PID 发出，
3 条 TLS interaction 的结果数依次为 0、1、2。未进入 final prompt 的 RAG sentinel 不在
provider transcript。[E019][E011]

### 10.2 LangChain

测试镜像固定 `langchain==1.3.17` 与 `langchain-openai==1.6.0`，运行真实 `ChatOpenAI.bind_tools` 循环，不安装 callback/Hook。Python 3.13/OpenSSL container PID产生 3 条 TLS interaction，tool order=`read,bash`，内部 RAG sentinel 缺席。[E021][E011]

### 10.3 Dify

Lab 使用官方 Dify 1.14.2 Compose 和 OpenAI-compatible plugin 0.0.64。LLM fixture 与 tool fixture 使用不同 SNI 和本地测试 CA，分别记录不含正文的 bytes/hash 账本：

- provider PID 2482048：402-byte request、1,068-byte response；
- worker PID 2391176：159-byte `/tool/execute` request、297-byte response；
- Observer 的 request/response SHA-256 与 mock 逐项一致。[E020][E011]

测试专用 pattern `celery` 与工具 path `/tool/execute` 不能直接复制到生产。生产需由 Agent control plane或精确 runtime signature 下发目标 cgroup/path。

### 10.4 Claude Code

Claude Code 2.1.170 使用 exact whole-file fingerprint + BoringSSL classic offsets。受控 Anthropic Messages fixture 产生 2 条完整 TLS interaction：第一次 response 包含 Bash tool_use，第二次 request 带回 tool_result 并得到最终文本。其他版本默认 unknown，不能继承 2.1.170 的支持声明。[E018][E011]

### 10.5 Codex CLI

Codex 0.150.1 使用 custom Responses provider、`supports_websockets=false`。实测 HTTPS REST仍未命中嵌入 OpenSSL profile，说明该配置走 Rustls；默认 Responses WebSocket 同样在当前排除范围。V1 因此只在用户明确配置受控 HTTP endpoint 时，通过 syscall lane捕获 2 条 Responses interaction，并解析 `response.output_item.done.item` 中最终文本。[E017][E018][E011]

若 endpoint 是非本机明文 HTTP，API key 与对话也会在网络中明文传输；这不适合作为生产建议。生产 Codex 完整正文需要后续 Rustls 专项、显式 Gateway 或经审核 Hook/OTel 方案。

## 11. Capture Profile 与部署

### 11.1 Capture Profile

`CAPTURE_PROFILE_ACTIONS` 当前行为：

- `agent_full`、`investigation_full`：SSL full；
- `probable_investigation`：SSL full，使 Candidate 在识别后的有效窗口逐次采集；
- `security_full`、`business_context`、`infrastructure_aggregate`、`unknown_discovery`、`self_health`：SSL `not_enabled`。

即使 profile 选择 full，内核仍需 process map 和 route Gate。Unknown profile 的 `llm` 元数据可以 full，但不等于允许 SSL body。

### 11.2 Observer DaemonSet

关键部署条件：[E014]

- privileged；
- `hostPID: true`；
- `/sys` 只读；
- `A3S_OBSERVER_SSL=1` 才启用明文；
- Source/management token 从 Secret 注入；
- Filter/Capture snapshots 独立挂载；
- Forwarder event max 12 MiB；
- 30 秒 termination grace，PID1 supervisor 负责 Collector→Forwarder drain。

当前 canonical manifest 不应内置测试 `celery` pattern 或 `/tool/execute` route。生产 route/signature 应来自版本控制且可审计的环境/控制面配置。

### 11.3 AnySentry Deployment

API observer body route 限制为16 MiB，并继续只对 ingest batch/runtime snapshot 扩大；普通 JSON route保留 Express 默认窄限制。ClickHouse table migration 由 API bootstrap 幂等执行，滚动部署无需手工 DDL。[E015]

## 12. 失败模式与诊断

| 故障 | 可见行为 | 不允许的行为 |
| --- | --- | --- |
| 进程未匹配 | 无 attach，coverage unavailable | node-wide attach |
| static fingerprint mismatch | warning `unsupported_binary_fingerprint` | 猜 offset |
| 只有 read 或 write symbol | target rejected | 把单向内容标 complete |
| route 不命中 | 不进入 plaintext ring | 仅凭 Agent PID 全采 |
| route 命中但 body 非模型语义 | 无 model interaction | 误报 Docker/RAG control API |
| ring reserve/copy 失败 | counter/drop；Agent 继续 | probe 阻塞 Agent |
| sequence gap | partial reason | 静默拼接 |
| HTTP/2 preface | unsupported | 当 HTTP/1 解析 |
| body >8 MiB / TLS call >512 KiB | 无 complete；drop/truncate evidence | 截前缀仍写 complete hash |
| Forwarder >12 MiB | `event_too_large` | 无界 queue |
| API hash mismatch | 拒绝入库 | 信任 producer hash |
| Unknown/Non-Agent | 拒绝正文 | 存入 ClickHouse后再隐藏 |
| ClickHouse unavailable | hot ring + partial coverage | 阻塞 Agent/Collector |
| raw query无管理鉴权 | HTTP拒绝 | 返回 metadata 中的 body |

当前诊断不足：当 reassembler 因 declared body limit 无法形成 message 时，尚未生成 metadata-only partial interaction；用户需要结合 attach log、probe/ring heartbeat 和 coverage 判定。这是发布说明必须保留的限制。

## 13. 测试设计与结果

### 13.1 Observer 单元/宿主测试

正确测试命令排除 no_std eBPF binary 的宿主链接：

```bash
cargo test -p a3s-observer \
  -p a3s-observer-common \
  -p a3s-observer-collector --release
```

结果为 145 项通过：library 28、workload contract 6、collector 104、common 7。`cargo test --workspace` 会尝试把无 `main` 的 eBPF bin 链成宿主 test executable，并因 undefined `main` 失败；这是 target 选择问题，不是 eBPF build 失败。Collector build script 已成功为 BPF target 构建并在内核加载。[E012]

交互专项覆盖：fragment、keep-alive、Content-Length、chunked、gzip/deflate、SSE、Chat/Responses/Anthropic tool、external tool route、HTTP/2 fail-closed、invalid UTF-8、RAG 边界和多片 inline multimodal。

### 13.2 AnySentry 回归

通过：

- `pnpm build`；
- `pnpm verify:agent-interactions`；
- `pnpm verify:observer-ingest:local`；
- `pnpm verify:filter-pipeline`；
- `pnpm verify:s5-capture-profile`；
- `pnpm verify:s6-tool-evidence`；
- `pnpm verify:deployment-manifests`。

Interaction verifier 同时验证：声明 hash 被篡改时拒绝、Unknown classification 拒绝、model/tool 查询 filter、超过旧 4 MiB envelope 的 inline multimodal、raw content management auth。[E010][E012]

### 13.3 运行时矩阵

完整环境记录保存在本地审计目录且不进入 Git；可复核摘要如下：[E011]

| Runtime | Interactions | Transport | Tool evidence | Completeness |
| --- | ---: | --- | --- | --- |
| Pi host | 3 | TLS | read → bash；0/1/2 results | complete |
| Pi Docker | 3 | TLS | read → bash；0/1/2 results | complete |
| LangChain Docker | 3 | TLS | read → bash；0/1/2 results | complete |
| Dify | 1 model + 1 tool | TLS | `http.tool.execute` | complete |
| Claude Code | 2 | TLS | Bash；0/1 result | complete |
| Codex | 2 | HTTP | exec_command；0/1 result | complete |

### 13.4 UI 与 ClickHouse

Headless Chrome 在桌面/移动视口验证 model/tool 两种详情、request/response、tool IDs/arguments/results、边界时间、RAG sentinel 缺席；无 overflow、runtime exception 或 network failure。[E013]

连接 live ClickHouse 后，interaction query 返回 `dataSource=clickhouse`，migration 后 `interactionType` 列为 `LowCardinality(String)`。正文持久化测试没有包含真实凭据，测试 credential也未写入仓库。[E007][E011]

## 14. Rollout、回滚与运维

### 14.1 Rollout 顺序

1. 先部署 AnySentry API/Web，使新 schema、DDL、query/UI 可接受但未产生 plaintext；
2. 验证 ClickHouse migration、管理鉴权和审计；
3. 在测试节点部署 Observer，保持 `A3S_OBSERVER_SSL` 关闭，确认旧事件回归；
4. 对受控 Agent signature 打开 SSL，并只安装默认 LLM routes；
5. 对确有需求的外部工具逐条添加 exact tool routes；
6. 对每个产品版本执行 fixture hash reconciliation；
7. 完成容量/安全验收后再扩大节点范围。

### 14.2 回滚

- 首选把 `A3S_OBSERVER_SSL` 设为 off/移除，停止 plaintext attach；
- 移除 `A3S_OBSERVER_TOOL_HTTP_ROUTES` 可单独关闭外部工具正文；
- 回滚 Observer 不要求删除 ClickHouse column，旧 API可忽略专用表；
- 回滚 AnySentry UI/API 前应先停新 Observer event，避免旧 API把新 event视为 unsupported noise；
- ClickHouse 30-day TTL 自动清理正文；提前删除属于数据治理动作，不能在普通回滚中静默执行。

### 14.3 运行告警建议

应补充或聚合：

- attach success/rejected，按 product/profile/reason；
- active plaintext PIDs、routes 和 sessions；
- SSL ring reserve/copy/truncation；
- fragment sequence gap、active connection eviction、reassembly limit；
- model/tool interactions complete/partial/unsupported；
- Forwarder `event_too_large`、outstanding limit、retry exhausted；
- API interaction rejected by hash/classification/size；
- ClickHouse insert/query failure与 hot-ring-only coverage；
- raw content read audit、denied与 export（未来）。

## 15. 已知限制和下一阶段

### 15.1 本期必须保留的限制

1. Go `crypto/tls`、Rustls 不支持；Codex HTTPS属于该边界；
2. HTTP/2、WebSocket、HTTP/3/QUIC 不支持；
3. 单 TLS API call 512 KiB、每方向 8 MiB；超限可能只有 drop counter，没有 partial interaction；
4. 无 Hook 时 session/turn/workflow/node 和工具内部开始/结束不可强归因；
5. Dify provider 与 worker可能是两个 Runtime asset；
6. raw body 存在 ClickHouse payload，只有管理 auth，不是最终多租户 Content Store；
7. 尚无生产 overhead/容量 benchmark；
8. 64-bit route hash 存在理论 collision 风险；
9. 轮询 attach 对极短任务存在首调用窗口。

### 15.2 推荐后续顺序

P1：性能、ring-loss、正文策略与安全治理；增加 metadata-only partial interaction，使超限/协议错误可从 UI 直接解释。

P2：独立加密 Content Store、tenant-scoped RBAC、read/export grant、retention/legal hold。

P3：按需 Hook/Adapter：Dify逻辑 ID优先，其次 Claude/Codex/Pi 精确 tool lifecycle；不能把 Hook 设为本期被动链的隐形依赖。

P4：HTTP/2/WebSocket/MCP Relay；每种协议独立状态机和 fixture。

P5：Go TLS/Rustls 专项；需要稳定 hook 点、版本兼容清单和 fail-closed 测试，不采用无版本的偏移猜测。

若业务要求跨协议、跨版本、超大正文的强完整性，应单独评审显式 LLM Gateway；它改变 Agent 配置并进入请求关键路径，不能作为 eBPF 的透明“增强开关”。

## 16. 实现文件清单

### 16.1 Observer

- `a3s-observer-common/src/lib.rs`：route kind、tiered plaintext ABI；
- `a3s-observer-ebpf/src/main.rs`：process/route/session maps、TLS/HTTP probes、`bpf_loop` path hash；
- `a3s-observer-collector/src/tls_attach.rs`：PID/container TLS resolver；
- `a3s-observer-collector/src/tls-profiles.json`：Claude/Codex exact profiles；
- `a3s-observer-collector/src/interaction.rs`：HTTP/SSE/provider/tool reassembly；
- `a3s-observer-collector/src/main.rs`：route install、attach refresh、event output；
- `src/model.rs`：`AgentEvent::LlmInteraction` wire model；
- Cargo manifests：`httparse`、`flate2`、`base64`。

### 16.2 AnySentry

- `apps/api/src/security-monitoring/agent-interaction.ts`；
- `types.ts`、`aggregation.service.ts`、`sentry-judge.service.ts`；
- `clickhouse-store.ts`、`security-monitoring.controller.ts`；
- `scripts/observer-forward.js`；
- `apps/web/src/lib/api/security-center.ts`；
- `apps/web/src/pages/AgentsPage.tsx`；
- `deploy/anysentry.yaml`、`deploy/observer.yaml`；
- interaction/forwarder/browser/deployment/observer ingest verifiers。

### 16.3 Test labs

- `examples/pi-tls-observability-lab/`；
- `examples/langchain-tls-observability-lab/`；
- `examples/cli-tls-observability-lab/`；
- `deploy/manual-test/agent-llm-observability/dify/`。

## 附录 A：需求—实现—验证追踪

| 需求 | 实现 | 验证 |
| --- | --- | --- |
| Candidate/Confirmed model body | process map + API classification gate | synthetic probable/confirmed、Unknown fail-closed、Pi probable UI |
| request/response/time | tiered ABI + reassembler + record schema | Pi/LangChain/Dify/Claude/Codex runtime matrix |
| tool instruction/result/order | provider parser + tool result extraction | read→bash、Bash、exec_command、external tool |
| external tool body/time | explicit tool route + tool interaction | Dify `/tool/execute` hash reconciliation |
| internal RAG excluded | final HTTP body only | Pi/LangChain/Dify sentinels |
| multimodal | raw body/hash + raised bounds + derived omission | 2 MiB API E2E、multi-fragment Collector test |
| no unrelated TLS | process + route + semantic gates | Docker API negative test、unknown classification rejection |
| raw content protection | management auth + audit + hash verification | interaction verifier、browser auth setup |
| durable query | ClickHouse table/migration/filter | live `dataSource=clickhouse` and column query |
| host/container Pi | container-root attach + cgroup inode fallback | 22/22 host and Docker fixtures |

## 附录 B：证据索引

| 证据 | 来源 | 状态 | 支持内容与边界 |
| --- | --- | --- | --- |
| E001 | 本次会话审核结论 | confirmed_fact | 本期 no-Hook/no-Gateway 与 Go/Rustls 延期 |
| E002 | Observer eBPF process/route maps | confirmed_fact | Kernel Gate 1/2；不证明 parser |
| E003 | `tls_attach.rs` | confirmed_fact | PID/container/symbol/profile/fail-closed |
| E004 | `interaction.rs` | confirmed_fact | HTTP/SSE/model/tool 重组；不支持 H2/WS/QUIC |
| E005 | Observer common ABI | confirmed_fact | tier/sequence/time/content record contract |
| E006 | AnySentry `agent-interaction.ts` | confirmed_fact | size/hash/classification validation |
| E007 | ClickHouse store | confirmed_fact | dedicated table、migration、TTL、filter |
| E008 | Controller | confirmed_fact | management auth 和 content read audit |
| E009 | `AgentInteractionTrace` | confirmed_fact | model/tool UI fields |
| E010 | interaction verifier | confirmed_fact | tamper/Unknown/filter/multimodal tests |
| E011 | 受控 fixture 本地运行记录 | confirmed_fact | 固定版本运行、bytes/hash/tool/result；原始环境快照不入库 |
| E012 | 同一受控运行的 automated checks | confirmed_fact | 145 Observer tests 与 AnySentry 回归 |
| E013 | browser verifier | confirmed_fact | 1440/390 UI 状态 |
| E014 | Observer manifest | confirmed_fact | privileged/hostPID/forwarder bounds |
| E015 | AnySentry manifest与 ingest test | confirmed_fact | 16/15 MiB route/controller bounds |
| E016 | [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) | confirmed_fact | HTTPS network egress已受 TLS 保护 |
| E017 | [Codex configuration reference](https://developers.openai.com/codex/config-reference) | confirmed_fact | custom provider配置；不证明 TLS library |
| E018 | CLI fixture | confirmed_fact | Claude TLS/Codex HTTP version boundary |
| E019 | Pi fixture | confirmed_fact | host/container three-call contract |
| E020 | Dify fixture | confirmed_fact | model/tool hash reconciliation与逻辑归因限制 |
| E021 | LangChain fixture | confirmed_fact | bind_tools TLS flow |
| E022 | 三层代码与负向 fixture 综合 | supported_inference | 降低过采集；生产误报率未测 |
| E023 | 当前仓库与本地验证记录的 benchmark inventory | confirmed_fact | 未发现本功能的生产级 overhead/容量结果；不排除仓库外材料 |

本文描述集成分支的设计与受控验证结论。最终发布前仍须记录干净 commit、新镜像 digest、
部署日期与性能验证链接；在此之前不要把该文档当作公开发行版兼容声明。
