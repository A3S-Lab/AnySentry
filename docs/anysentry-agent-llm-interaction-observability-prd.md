# AnySentry Agent—LLM 与外部工具明文观测 PRD

> 状态：已按审核结论实现，提交发布前复审
>
> 文档版本：v1.0-implementation-review
>
> 评审对象：分支 `feat/agent-tls-interaction-observability`；AnySentry 集成基线为
> `origin/main@9625908` 加 `fix/observer-delivery-health-20260827@d139a25`，Observer 集成基线为
> `origin/main@06105bb`
>
> 技术设计：[Agent—LLM 与外部工具明文观测技术设计](./anysentry-agent-llm-interaction-observability-technical-design.md)
>
> 运行证据：受控验证结论汇总在第 9 节；包含本机地址、运行实例标识和临时镜像信息的
> 原始验证 JSON 属于本地审计产物，不纳入 Git
>
> 发布状态：集成分支完成测试后重新构建带源码 revision 的正式镜像；旧分叉工作树生成的
> 本地镜像不得作为本分支发布产物

## 0. 评审结论

本期已经按用户审核后的范围实现：不安装 Agent Hook，不引入 LLM Gateway，不伪造证书或数字身份；Observer 在受支持进程真实使用的 TLS 函数边界，或明文 HTTP 系统调用边界，异步复制请求与响应字节。Collector 再把片段重组成一次 Agent 交互，AnySentry 展示最终发给 LLM 的请求、LLM 返回给 Agent 的内容、工具指令顺序、工具结果和边界时间。[E001][E002][E003][E004]

产品边界不是“采集 Agent 进程处理过的一切数据”。内部 RAG、文件解析、OCR、切块、embedding、重排候选和临时 prompt 草稿，只要没有进入最终模型请求，就不采集、不展示；已经序列化进最终请求的文本、图片引用、file ID 或 inline base64，则属于“模型实际收到的表示”，进入交互正文。[E004][E010][E019][E020][E021]

本期验证结论是版本和协议限定的，不是语言级通用承诺：[E011]

- Pi 0.83.0：宿主机和 Docker 容器中的 Node/OpenSSL TLS 均验证通过；
- LangChain 1.3.17 + langchain-openai 1.6.0：Python/OpenSSL TLS 验证通过；
- Dify 1.14.2：OpenAI-compatible provider 的模型 TLS 调用，以及显式准入的 HTTP Request 工具 TLS 调用验证通过；
- Claude Code 2.1.170：精确二进制指纹对应的 BoringSSL TLS 偏移验证通过；
- Codex CLI 0.150.1：Responses 明文 HTTP 验证通过；该版本实测 HTTPS/Responses WebSocket 使用 Rustls，当前不能被本方案被动解密；
- 通用 Go `crypto/tls`、通用 Rustls、HTTP/2、WebSocket、HTTP/3/QUIC、MCP pipe/relay 不在本期实现范围。

## 1. 用户要解决的问题

AnySentry 现有 Agent 资产和行为链路可以回答“哪个 Runtime 在什么时候连接了什么目标、启动了什么进程、读写了什么文件”。它不能仅凭 Egress 事件回答以下问题：

1. Agent 每一次最终发送给 LLM 的正文是什么；
2. LLM 每一次实际返回给 Agent 的正文是什么；
3. 哪次响应发出了什么工具指令，后续请求带回了什么工具结果；
4. 请求开始、请求完整、首个响应和响应结束分别是什么时间；
5. 一条内容为什么属于某个 Candidate/Confirmed Agent，而不是同机浏览器、数据库或内部控制面；
6. 页面没有内容时，是没有调用、尚未 attach、协议不支持、正文超限，还是采集发生丢失。

HTTP egress 本身仍是明文；HTTPS 到达普通网络出口时已经是 TLS record 密文。TLS 1.3 在记录层保护应用数据，接收端解密后才交给上层，因此不能在 HTTPS egress 之后异步“还原”明文。[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) [E016]

本期采用的产品链路是：先让受支持 Agent 进程进入明文采集资格，再在真实 TLS/HTTP 调用处识别精确 POST 路径，最后在用户态验证请求确实是模型调用；只有三层都成立，正文才进入 Interaction 数据链。

```text
Agent / Agent 子 Runtime
        |
        |  Gate 1：精确 PID/cgroup 属于已选择 Agent
        v
TLS 函数或 HTTP syscall
        |
        |  Gate 2：POST + 精确准入路径
        v
有界明文片段
        |
        |  Gate 3：HTTP framing + 模型语义，或显式工具路由
        v
Model Interaction / External Tool Interaction
        |
        v
Forwarder -> AnySentry API -> ClickHouse/Hot Ring -> Agent 资产页
```

图中的三层是当前实际实现。Egress/DNS/SNI 仍用于 Agent 资产识别、目标证据和覆盖诊断，但 HTTPS 正文不是从 Egress payload 取得，当前正文准入也不把不稳定的 SNI 回写时序作为完整性前提。[E002][E004]

## 2. 产品目标与非目标

### 2.1 产品目标

G-01：对 `probable_agent` 与 `confirmed_agent`，在受支持版本、协议、正文上限和有效 attach 窗口内，每个模型 HTTP exchange 生成一条可查询的 `interactionType=model` 记录。

G-02：每条模型交互展示最终 request body、LLM-visible response body、内容类型、字节数、SHA-256、状态码、模型、endpoint、完整性与四个时间边界。

G-03：解析 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和兼容 SSE 中的工具指令；在后续模型请求包含 tool result 时，按 provider `toolCallId/call_id` 显示结果及顺序。

G-04：对明确配置的外部 HTTP 工具路径，生成 `interactionType=tool` 记录，展示 Agent 发出的 HTTP 指令、工具返回、HTTP 状态和网络边界耗时。

G-05：只保存最终传输边界内容。未进入最终 request body 的内部 RAG/文件中间态必须缺席；进入 body 的内容必须按实际序列化表示保存。

G-06：原文查询必须经过管理鉴权并写审计；篡改 hash、Unknown/Non-Agent 正文和无效 schema 必须 fail closed。[E006][E008][E010]

G-07：采集路径不得阻断 Agent。ring、队列、解析或 ClickHouse 失败只能影响观测，并通过 drop、partial 或 coverage 状态体现。

### 2.2 本期非目标

- 不实现 Claude Code/Codex/Dify/LangChain/Pi 的 Hook、Adapter、callback 或安装脚本；
- 不实现显式 LLM Gateway、透明代理、TLS MITM 或自签 CA 注入生产 Agent；
- 不实现通用 Go `crypto/tls`、Rustls、Schannel、Secure Transport 等语言/平台专用 TLS 探针；
- 不实现 HTTP/2/HPACK、多路复用 stream、WebSocket、HTTP/3 或 QUIC 重组；
- 不实现 MCP stdio、MCP Streamable HTTP 的通用语义 Relay；
- 不从 URL 下载远端图片或文件，也不根据文件读取事件猜测 file ID 的真实内容；
- 不声称获得 provider 未返回的隐藏推理；
- 不把 Dify 共享 worker 的 PID 时间邻近关系伪造成 tenant、workflow run 或 node 级逻辑归因；
- 不在当前证据不足时承诺生产 CPU 开销、p99 延迟或全量调用发现率。[E020][E023]

## 3. 产品对象与术语

### 3.1 最终模型请求

最终模型请求是 Agent 完成内部编排后，实际传给模型 HTTP 客户端的序列化 body。它可能包含：

- system/developer/user/assistant/tool 历史消息；
- 当前用户输入；
- 已经选中并写入请求的 RAG 文本；
- tool definitions、tool choice 和模型参数；
- 图片/音频 data URL、base64、HTTPS URL、provider `file_id` 或对象引用；
- Responses API input item、Chat messages 或 Anthropic content blocks。

不属于最终模型请求：未选中的检索结果、文件全文解析缓存、OCR 临时输出、embedding、重排候选、未发送的 prompt 草稿、Authorization/Cookie/API key。

### 3.2 LLM-visible response

LLM-visible response 是 provider 实际交付给 Agent 客户端的 HTTP body 或 SSE event，包括文本、content block、function/tool call、usage、finish/stop reason 和错误。系统不把 provider 内部状态或未下发推理描述为已采集内容。

### 3.3 两类 Interaction

| 类型 | 含义 | 当前关联能力 |
| --- | --- | --- |
| `model` | Agent 与 LLM endpoint 的一次 HTTP request/response exchange | 同一 TLS session/HTTP connection 上按顺序配对；解析 provider tool ID |
| `tool` | Agent 对明确准入的外部 HTTP 工具路径的一次 request/response exchange | 以 transport 级稳定 ID 配对指令和结果 |

`interactionId` 是一次 transport exchange 的稳定内容标识，不等同于 framework 的 Turn ID。当前无 Hook 阶段如果线上 body 没有 session/turn/workflow ID，系统只归因到已确认的 Agent Runtime，不制造更强逻辑关联。

### 3.4 时间语义

| 字段 | 当前含义 | 精度边界 |
| --- | --- | --- |
| `startedAtUnixNs` | Collector 观察到 request 第一片的内核校准时间 | 传输边界，不是用户开始输入时间 |
| `requestCompleteAtUnixNs` | 完整 HTTP request body 可用时间 | 不是 provider 收到请求的远端时间 |
| `firstResponseAtUnixNs` | response 第一片到达 Agent 进程边界的时间 | SSE 下不是必然等于首个可见 token |
| `endedAtUnixNs` | HTTP response framing 或 SSE 终止完成时间 | 异常断流会按 partial/unsupported 处理 |
| `durationNs` | `ended - started` | 整体传输边界耗时 |
| `toolCall.issuedAtUnixNs` | 模型工具指令完成解析的观察时间 | 无 Hook 时不保证是框架实际调度开始 |
| `toolResult.observedAtUnixNs` | 下一次模型请求或外部工具 response 中结果完整可见时间 | 无 Hook 时不等于工具内部执行结束 |

UI 使用“边界耗时”，不把上述时间写成框架内部精确执行时长。外部 HTTP 工具的 request complete → response complete 更接近网络调用耗时；进程内 `read/bash` 的真实开始/结束仍需未来 Hook，或与现有 ToolExec/文件/进程证据单独关联。[E004][E009][E011]

## 4. 目标用户与场景

| 用户 | 核心问题 | V1 能回答 | V1 不能保证 |
| --- | --- | --- | --- |
| Agent 资产运营者 | Agent 实际发给模型什么、模型返回什么 | 原始 body、解析消息、模型、时间、状态 | attach 前历史调用 |
| 安全分析人员 | 哪个响应触发了什么工具、工具结果是否再次发给模型 | provider tool ID、参数、后续 tool result、外部工具 exchange | 无 ID 时跨进程强关联 |
| 平台/SRE | 慢在请求、首响应还是完整响应；采集为何缺失 | 四个时间边界、完整性、来源、bytes/hash | provider 内部排队时间 |
| 审计人员 | 谁读取了交互原文 | 管理鉴权和 `agent.interaction.content.read` 审计 | 完整租户级内容导出工作流 |

核心场景：

- UC-01：在 Candidate Agent 详情页查看 Pi 的三次模型调用，并看到 `read → bash` 顺序以及结果由后续请求带回；
- UC-02：在 Confirmed Dify Runtime 详情页查看一次显式外部 HTTP 工具调用的指令、结果和边界时间；
- UC-03：确认内部 RAG sentinel 没有进入最终 body，而最终选中的上下文确实进入；
- UC-04：请求带 inline 图片或 URL/file ID 时查看最终表示；大正文仍受配额限制；
- UC-05：Claude Code 通过精确 BoringSSL profile 观测 Messages request/response；
- UC-06：Codex 使用明文 HTTP 自定义 Responses provider 时可观测；切换 HTTPS/Rustls 后 coverage 明确为 unsupported，不出现伪造完整正文。

## 5. 三层准入规则

### 5.1 Gate 1：Agent 进程/容器准入

只有 TlsAttach Resolver 成功验证并 attach 的 PID 才写入 `PLAINTEXT_AGENT_PROCESSES`。Key 同时包含内核 cgroup ID 与 host PID，避免同 PID、不同容器或 PID reuse 的正文串线。容器 cgroup namespace 无法从 host 路径直接还原时，使用目标进程自身 cgroup mount root 的 kernfs inode与 `bpf_get_current_cgroup_id` 对齐。[E002][E003]

API 再执行第二次资产保护：只有最终分类为 `probable_agent` 或 `confirmed_agent` 的 `LlmInteraction` 才进入 interaction store；Unknown/Non-Agent 即使提交格式正确也被拒绝。[E006][E010]

### 5.2 Gate 2：精确 HTTP 路径准入

内核只读取最多 64 字节 request line；只接受 `POST`，去除 query/fragment 后用 FNV-1a hash 查找精确 route map。默认模型路径为：

- `/v1/chat/completions`、`/chat/completions`；
- `/v1/responses`、`/responses`；
- `/v1/messages`、`/messages`；
- `/v1/completions`、`/completions`；
- `/api/chat`、`/api/generate`。

额外模型路径通过 `A3S_OBSERVER_LLM_HTTP_ROUTES` 配置。外部工具没有宽泛默认值，只能通过 `A3S_OBSERVER_TOOL_HTTP_ROUTES` 显式列出，例如 Dify lab 的 `/tool/execute`。普通浏览器 API、Docker API、数据库和 Agent 内部 RAG HTTP 路径不会仅因来自 Agent 进程就进入正文 ring。[E002][E010][E020]

### 5.3 Gate 3：用户态协议和语义准入

模型路径还必须满足 HTTP/1.1 framing、POST 和请求 body 语义：通常同时具有 `model` 与 `messages/input/prompt`，或 provider `contents`。路径像模型 API、但 body 不满足生成请求结构的流量不产生 model interaction。

显式工具路径不要求 LLM body 语义，因为其安全前提是“Agent PID/cgroup + 运维显式配置的精确 path”。它生成独立 `tool` interaction，不能用通配符把所有 Agent HTTPS 请求升级为工具正文。

负向 fixture 与代码路径支持一个工程推断：相比只按进程或只按目的地址采集，三层同时成立会显著缩小过采集面；当前没有生产流量误报率，不能把该推断写成已测量的准确率。[E022]

## 6. V1 支持矩阵

| 产品/Runtime | 已验证版本与实现 | 已验证 transport/协议 | 展示能力 | 当前边界 |
| --- | --- | --- | --- | --- |
| Pi，宿主机 | Pi 0.83.0，Node 24，主 ELF 导出 OpenSSL | TLS + HTTP/1.1 + chunked SSE | 3 次 request/response、`read → bash`、结果累计、最终文本 | 受 attach 起点和正文上限约束 |
| Pi，Docker | Pi 0.83.0，容器 PID namespace | TLS + HTTP/1.1 + SSE | 与宿主机相同，且 host PID/cgroup 归因正确 | 短生命周期容器需留出 attach 窗口 |
| LangChain | 1.3.17，langchain-openai 1.6.0，Python 3.13/OpenSSL | TLS + HTTP/1.1 + SSE | `bind_tools` 三次调用、工具顺序/结果、最终文本 | 不是所有 LangChain transport 的通用声明 |
| Dify | 1.14.2，OpenAI-compatible plugin 0.0.64 | provider TLS；显式外部工具 TLS | 模型正文；工具指令/结果/hash/时间 | 只能证明 provider/worker Runtime，不能被动得出 workflow node ID |
| Claude Code | 2.1.170，精确静态 BoringSSL profile | TLS + Anthropic Messages/SSE | 2 次 request/response、Bash 指令、结果、最终文本 | 二进制 hash/version 变化必须重新验证 |
| Codex CLI | 0.150.1，自定义 Responses provider | 明文 HTTP + Responses/SSE | 2 次 request/response、`exec_command`、结果、最终文本 | HTTPS/WS 实测 Rustls，当前不支持被动明文 |
| 通用动态 OpenSSL/Node/Python | 符号可解析的 PID-scoped ELF/动态库 | 机制支持 HTTP/1.1 JSON/SSE | 需逐产品 fixture 后加入正式矩阵 | 不能只凭语言名宣布支持 |
| Go `crypto/tls`、通用 Rustls | 未实现 | 无 | coverage=`unsupported` | 后续单独立项 |
| HTTP/2、WebSocket、HTTP/3/QUIC | 未实现重组 | 无 | coverage=`unsupported` | 不能降级为 complete |

所有“完整”结论只适用于受控 fixture 中实际进入采集窗口的调用。运行验证摘要见第 9 节；
包含本机端点和运行实例的原始逐项记录保留在本地审计目录，不进入仓库。[E011][E018][E019][E020][E021]

## 7. 功能需求

### 7.1 模型请求与响应

FR-001：每次成功配对的模型 exchange 生成唯一 `interactionId`，并包含 Agent Asset/Instance、PID、connection、transport、protocol、endpoint、method、path、status、model 和 capture source。

FR-002：request 与 response 分别保存：

- 原始 body；
- `utf8 | base64` encoding；
- content type；
- captured/decoded bytes；
- SHA-256；
- `complete | partial | truncated | redacted | reference_only | unavailable | unsupported`；
- 可用时保存 structured、messages 或聚合 text。

FR-003：Content-Length、chunked、gzip/deflate、JSON 和 SSE 必须跨 TLS API call/系统调用片段重组。一个 TLS read/write 不能被当成一次模型调用。

FR-004：同一 HTTP/1.1 keep-alive connection 上的顺序请求分别产生 interaction；1xx response 不消费 pending request。

FR-005：OpenAI Chat/Responses、Anthropic Messages 和兼容结构中的 tool/function call 需要保留 provider call ID、name、arguments 和观察时间。Responses `response.output_item.done.item` 中的最终 message 需要解析为 response text。

FR-006：Authorization、Cookie、API key 等 HTTP headers 不进入 interaction body。V1 保存的是 body，不提供任意原始 header dump。

### 7.2 工具链

FR-010：模型响应产生的工具指令按 response 中的 provider ID 展示顺序；下一次模型 request 出现同 ID 的 tool result 时关联并展示结果。

FR-011：外部 HTTP 工具仅在精确配置 path 后采集；记录原始 JSON/body、status、request complete、first response、response complete、hash 和 completeness。

FR-012：同一内容在两个边界出现时不得互相覆盖：Tool Interaction 证明工具返回了什么，后续 Model Interaction 证明 Agent 实际把哪些结果再次发送给模型。

FR-013：无 Hook 时工具时间必须标为 transport/collector boundary。产品不得把 LLM tool-use 结束到下一请求完成的间隔宣传为工具内部精确执行时长。

### 7.3 RAG、文件与多模态

FR-020：未进入最终 request body 的内部 RAG、上传文件解析和候选 chunk 必须缺席。

FR-021：进入 body 的文本、URL、file ID、data URL/base64 按原始序列化形式保存；V1 不自动拉取远端 URL，也不把 file ID 展开成未观察到的文件内容。

FR-022：Collector 每个方向最多重组 8 MiB；单次 TLS API call 选择 16 KiB、128 KiB 或 512 KiB event tier。客户端把大 body 拆成多个不超过 tier 的 TLS call 时可跨片重组；某个单次 TLS call 超过 512 KiB 时会产生 truncation/drop 证据，不能承诺完整 interaction。

FR-023：body 大于 512 KiB 时，原始 body 与 hash 仍是权威证据；为控制事件放大，`structured/messages` 的重复便捷副本可以省略。UI 仍可展示原始 body，但不能把“未生成结构化副本”写成“正文缺失”。

FR-024：Forwarder 单事件上限为 12 MiB，API route 为 16 MiB，controller 有效 payload 上限为 15 MiB。超过任一边界时必须 fail closed/计数，不允许无界内存。[E014][E015]

### 7.4 查询、页面与权限

FR-030：Agent 资产页显示“模型调用数”和“外部工具调用数”，交互列表至少显示时间、model/path、transport、endpoint、status、duration、request→response bytes、指令/结果数和 completeness。

FR-031：详情区显示 request/response 原文、content type、bytes、SHA-256、四个时间边界、capture source 和 tool timeline；布局在 1440px 与 390px 视口无横向溢出。[E009][E013]

FR-032：查询支持 `agentAssetId`、`agentInstanceId`、`interactionId`、`interactionType`、model、transport、completeness、时间窗和 limit。

FR-033：原文查询 `POST /security-center/agents/interactions` 必须通过管理鉴权；每次读取写入 `agent.interaction.content.read` 审计，记录资源和结果数。[E008]

FR-034：hash 与 body 不一致、schema 无效、正文超限、Unknown/Non-Agent 分类必须拒绝入库；拒绝不能被页面误显示成空的合法 interaction。[E006][E010]

### 7.5 存储与覆盖

FR-040：V1 使用独立 ClickHouse `agent_interactions_v1` 表，不把正文塞回通用 `events` 表；记录以 `interactionId` 和 revision 去重，TTL 为 30 天。[E007]

FR-041：进程内 hot ring 同时受 2,000 条和 64 MiB 限制；ClickHouse 不可用时页面可以回退 hot ring，并明确显示 `hot_ring` 与部分历史覆盖。

FR-042：旧表自动 `ADD COLUMN IF NOT EXISTS interactionType LowCardinality(String) DEFAULT 'model'`，保证滚动升级期间旧记录仍可查询；model/tool filter 必须先在 ClickHouse 过滤，不能在 limit 之后才筛选。

FR-043：每条记录显示 `captureSource`，例如 `tls_uprobe`、`tcp_plaintext`、`tls_uprobe_tool_route`，便于区分能力和审计来源。

## 8. 安全与非功能需求

### 8.1 安全不变量

- 默认不能通过 Unknown 全机 TLS 捕获正文；
- route 必须精确配置，禁止用 `*` 把 Agent 所有 TLS 请求变成工具正文；
- 未知静态二进制不能猜偏移，fingerprint 不匹配必须拒绝 attach；
- TLS probe、ring、Collector、Forwarder 和 ClickHouse 失败都不得改变 Agent 请求字节或阻塞业务；
- 凭据不得写入仓库、镜像层、测试 transcript 或 interaction body；
- 测试 CA 只用于隔离 fixture，不修改宿主机/Agent 的系统信任；
- 当前 ClickHouse payload 包含原始正文，生产启用前必须确认数据分类、租户隔离、备份、管理员权限和 30 天保留是否满足安全政策。

### 8.2 有界资源

| 层 | 当前边界 | 超限行为 |
| --- | --- | --- |
| Kernel route line | 64 bytes | 不命中 route，不采正文 |
| TLS plaintext event | 16/128/512 KiB tier | 标 truncated；不阻断 Agent |
| SSL ring | 32 MiB | reserve drop 计数 |
| Active reassembly | 2,048 connections | 有界 eviction |
| Request/response stream | 8 MiB/方向 | parser 无法证明完整时不得生成 complete |
| Derived structured export | 512 KiB body 阈值 | 保留 raw/hash，省略重复 derived data |
| Forwarder event | 12 MiB | `event_too_large` drop |
| API observer body | 16 MiB parser / 15 MiB controller | HTTP 413 |
| Interaction hot ring | 2,000 records / 64 MiB | 淘汰最早记录，历史依赖 ClickHouse |

### 8.3 性能声明

当前已经验证有界队列、非阻断 probe 和受控功能正确性，但没有可发布的生产 CPU、内存、ring drop 或 Agent latency 指标。[E012][E023] 发布到生产正文模式前必须完成目标节点密度、并发 SSE、大 body 和 ClickHouse 降级压测；任何建议阈值在实测前只能作为验收候选，不能写成当前结果。

## 9. 验收结果

### 9.1 自动化与运行时证据

| 验收项 | 结果 | 说明 |
| --- | --- | --- |
| Observer library/workload/collector/common | 145 项通过 | 包含 HTTP/SSE、gzip、chunked、keep-alive、tool route、Responses item、multimodal、fail-closed |
| AnySentry API/Web build | 通过 | Nest API 与 Rsbuild Web |
| Interaction ingest/query | 通过 | hash、Unknown、model/tool filter、2 MiB inline multimodal、管理鉴权 |
| Existing regressions | 通过 | Observer ingest、filter pipeline、S5、S6、deployment manifests |
| Pi host | 3/3 complete | `read → bash`，result 0→1→2，22/22 fixture |
| Pi Docker | 3/3 complete | namespace PID 与 host PID/cgroup 归因正确，22/22 fixture |
| LangChain Docker | 3/3 complete | `bind_tools`，内部 RAG sentinel 缺席 |
| Dify | model + tool complete | request/response bytes 与独立 mock SHA-256 一致 |
| Claude Code | 2/2 complete TLS | Bash 指令、结果、最终文本 |
| Codex CLI | 2/2 complete HTTP | `exec_command`、结果、最终文本；HTTPS 不支持 |
| Browser | 通过 | model/tool 两类详情，1440/390，无 overflow/异常/失败请求 |
| ClickHouse | 通过 | `dataSource=clickhouse`，`interactionType` 列迁移和查询通过 |

这些结果是本机、固定版本、受控 provider/工具 fixture 的观察，不外推为生产 100% 发现率或性能结果。[E010][E011][E012][E013]

### 9.2 发布验收条件

合并/构建镜像前：

- [x] 三层准入在内核可加载，未超过 verifier 指令限制；
- [x] request/response/tool route 与 provider parser 通过单测；
- [x] Candidate/Confirmed API 入库策略、hash 校验和 Unknown fail-closed 通过；
- [x] Pi host/container、LangChain、Dify、Claude Code、Codex HTTP 完成受控运行验证；
- [x] ClickHouse migration、durable query、model/tool filter 通过；
- [x] 桌面/移动端正文和工具详情通过真实浏览器验证；
- [x] 既有 Filter/S5/S6/Observer ingest/manifest 回归通过；
- [ ] 生产正文采集开关、管理员范围和 30 天保留由安全负责人确认；
- [ ] 生产容量/性能压测达到部署环境批准阈值；
- [ ] 发布说明明确 Codex HTTPS、通用 Go/Rustls 和 HTTP/2/WS/QUIC 不支持。

## 10. 风险、限制与处理

| 风险/限制 | 当前后果 | 当前处理 | 后续方向 |
| --- | --- | --- | --- |
| attach 发生在首调用之后 | 已发送明文不可恢复 | UI/文档说明有效窗口；测试进程留 grace | 事件驱动 attach 或经审核的短 preroll |
| 静态二进制版本变化 | 偏移可能失效 | 整文件 hash、head hash、指令前缀全部匹配才 attach | 签名清单和自动兼容 CI |
| Codex HTTPS 使用 Rustls | 无 TLS 正文 | 只声明 HTTP 支持，HTTPS 显式 unsupported | 后续 Rustls 专项或显式 Gateway/Hook |
| 单次 TLS API call >512 KiB | 该 call 截断，完整 HTTP body可能无法形成 | drop/truncation 计数；不生成伪 complete | 分段 probe/spool 或显式 Gateway |
| HTTP/2/WS/QUIC | parser 无法可靠配对 | 显式 unsupported | 独立协议项目 |
| Dify 多租户共享 Runtime | PID 不能证明 workflow/node | 只展示 Runtime 级 attribution | Dify Trace/Hook Adapter |
| 无 Hook 的内部工具时间 | 只能得到模型/请求边界时间 | UI 写“边界耗时” | Hook/Adapter 与 kernel evidence 合并 |
| 原文在 ClickHouse payload | 权限和存储 blast radius 较大 | 管理鉴权、审计、TTL、独立表 | 独立加密 Content Store/RBAC |
| 日志/Collector 输出量大 | 诊断日志可能快速轮转 | 正式链路由 Forwarder 持续发送，不依赖 kubectl logs | 增加 interaction 专用指标和采样诊断 |

## 11. 分阶段后续计划

本期完成的是 Passive HTTP/TLS V1。后续工作不得反向扩大当前发布声明：

1. **生产加固**：性能压测、正文策略开关、租户 RBAC、独立 Content Store、retention/legal hold；
2. **语义增强**：按需新增 Claude Code/Codex/Dify Hook/Trace Adapter，补 Session/Turn/workflow/node 和内部工具精确生命周期；
3. **协议扩展**：评估 HTTP/2、WebSocket、MCP Relay 与 pipe；
4. **TLS 实现扩展**：Go `crypto/tls` 和 Rustls 分别立项，不建立“找到任意偏移就算支持”的通用扫描；
5. **强覆盖方案**：若业务要求跨版本、跨协议、超大多模态都保证完整，应显式评审 LLM Gateway 的可用性、凭据和关键路径风险，而不是把该承诺压给 eBPF。

## 12. 本次评审要点

评审者应优先确认：

1. “最终传输边界”是否符合产品预期；
2. Candidate/Confirmed 都可查看，但 attach 前历史不可恢复的表达是否可接受；
3. 内部工具只提供边界时间，外部 HTTP 工具提供 transport 时间的精度是否可接受；
4. Codex 当前只发布 HTTP 支持、Claude 发布精确 2.1.170 profile 是否可接受；
5. 8 MiB/方向、512 KiB/单 TLS call、12/15/16 MiB 数据链上限是否适合作为 V1；
6. ClickHouse 原文、管理鉴权、访问审计与 30 天 TTL 能否进入目标环境；
7. 哪些性能指标必须在镜像发布后、生产启用前完成。

## 附录 A：证据索引

| 证据 | 来源与定位 | 状态 | 支持的窄结论 |
| --- | --- | --- | --- |
| E001 | 本次会话审核结论 | 已确认事实 | 本期无 Hook/Gateway；通用 Go/Rustls 延期 |
| E002 | Observer `a3s-observer-ebpf/src/main.rs` 的 process/route maps | 已确认代码事实 | PID/cgroup 与精确 route 在内核先行准入 |
| E003 | Observer `tls_attach.rs` | 已确认代码事实 | 容器路径、符号、指纹、PID scope 与未知 fail-closed |
| E004 | Observer `interaction.rs` | 已确认代码事实 | HTTP/1.1/SSE 重组、provider/tool 解析和时间/hash |
| E006–E009 | AnySentry parser/store/controller/UI | 已确认代码事实 | 分类保护、ClickHouse、鉴权审计和页面展示 |
| E010 | `scripts/verify-agent-interactions.mjs` | 已确认测试事实 | tamper/Unknown/filter/multimodal 验证 |
| E011–E013 | 受控 fixture 运行记录与仓库浏览器验证脚本 | 已确认运行事实 | 固定版本运行矩阵、构建回归和 UI；原始环境快照不入库 |
| E014–E015 | `deploy/observer.yaml`、`deploy/anysentry.yaml` | 已确认配置事实 | 部署资源边界 |
| E016 | [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) | 已确认标准事实 | HTTPS egress 是受保护的 TLS application data |
| E017 | [Codex configuration reference](https://developers.openai.com/codex/config-reference) | 已确认官方文档 | custom provider 配置项；不证明 TLS 实现 |
| E018–E021 | CLI/Pi/Dify/LangChain fixture README | 已确认测试契约 | 版本、输入、工具顺序和验收边界 |
| E022 | 三层代码与对抗 fixture 的综合分析 | 支持性推断 | 三层准入降低过采集；无生产误报率数据 |
| E023 | 当前仓库与本地验证记录的 benchmark inventory | 已确认缺口 | 未发现本功能的生产级开销/容量结果；不排除仓库外材料 |

完整逐项结果和临时镜像 artifact 保存在本地审计目录，不进入 Git。最终发布记录必须引用
干净集成分支的 commit 与新构建 digest，不能复用旧分叉工作树的镜像。
