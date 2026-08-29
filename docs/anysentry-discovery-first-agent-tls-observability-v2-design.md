# AnySentry Discovery-first Agent TLS 全链路观测与 Agent 目录 v2.1 开发设计

> 状态：**已审核，正在实施与真实链路验收**
>
> 文档版本：v2.1-review（根据全局发现优先原则重构）
>
> 审核结论：2026-08-29 已确认 discovery-first、配置无关和“通用能力 + 特例加速”方向
>
> 方案类型：跨 Agent 产品、跨 LLM provider 的通用采集与解析架构；Codex / Claude Code 为首批端到端验收样本
>
> 日期：2026-08-29
>
> 目标分支：`feat/agent-tls-interaction-observability`
>
> 现场基线：AnySentry `6cb2a4a27ae3`，Observer `6b28280472f0`
>
> 前序设计：[对话追踪与 Codex / Claude Code TLS 明文观测 v1.1](./anysentry-conversation-tracking-codex-claude-tls-stage-design.md)
>
> 隐私边界：本文不记录或推导中转域名、完整 URL、API Key、Token、认证文件内容、私有证书、二进制哈希、用户对话正文和本机私有运行标识。真实配置仅在运行时内存中用于验证；实现、测试日志、Git 和镜像均不得保存这些信息。

## 0. 本阶段一句话目标

**在不依赖 Agent Hook/SDK、产品版本、官网域名、固定 URL 或 LLM 配置的前提下，让 AnySentry 对候选和已确认 Agent 的 TLS 加密前/解密后明文进行有界、异步、非阻断采集，再通过通用传输解码和可扩展线协议模板识别 Codex、Claude Code、Kimi Code、Dify、LangChain 等 Agent 的模型请求、回复、工具调用、结果与时间；未知协议也保留为可发现证据，并在前端按“运行中 / 历史逻辑 Agent”聚合实例和会话。**

## 1. 结论：采集优先，解析后置；产品只做身份，不做正文门禁

### 1.1 总体判断

当前 Agent 资产发现不是主要故障。三个目标 CLI 都能完成真实模型调用，Codex 和 Claude Code 的工具循环也能执行成功；正文没有进入页面，是因为现有实现把“是否值得采集”与“是否已经能解析”放在同一个内核门禁中：

1. **Codex 已命中正确 OpenSSL `_ex` 函数，但请求路由带中转/官方前缀，未命中 eBPF 的完整路径哈希 allowlist，明文在进入 Ring Buffer 前被拒绝。**[E006][E007][E009][E010]
2. **Claude Code 2.1.251 仍使用与既有版本一致的 BoringSSL classic ABI，但现有实现要求整文件大小和哈希精确匹配，因此新版本在 attach 前被 `unsupported_binary_fingerprint` 拒绝；即使 attach，带前缀的 Messages 路由也会被当前完整路径 allowlist 拒绝。**[E004][E005][E008][E009]
3. **对话追踪左栏直接平铺 Conversation 和 asset-only 占位，不是 Agent 目录；同一逻辑 Agent 的多次 PID 生命周期、别名资产和历史实例占据多行，运行中 Agent 与历史 Agent 混在一起。**[E012][E013][E014]

这两个断点说明 v2.0 仍然偏向“已知版本、已知路径、已知模板才允许发现”，不符合可观测平台目标。[E020] 本阶段不需要推翻 TLS 路线，也不需要改用 Hook/SDK；需要重新划分职责：

```text
内核 / uprobe：尽可能、低开销地复制 Agent TLS 明文，不判断模型厂商和 URL
        ↓
Collector：连接级重组、凭据 Header 清除、资源预算和临时缓冲
        ↓
Transport adapters：HTTP/1、HTTP/2、WebSocket、SSE、JSON、压缩
        ↓
Wire protocol templates：Responses、Chat Completions、Messages、Gemini、Kimi、MCP…
        ↓
Conversation normalization：request / response / tool / result / time
        ↓
Agent identity & UI：Codex、Claude Code、Kimi Code、Dify、LangChain 等产品展示
```

**URL、Host、route、模型名和 provider 配置只能作为解析后的元数据与辅助识别信号，不能再作为明文采集的拒绝条件。** 通用采集层先保留事实；已知模板负责结构化，未知模板显示 `unparsed` 并进入模板发现流程，而不是被丢弃。

### 1.2 现场事实矩阵

下表中的版本和 provider 类型来自只读、无泄密检查；“命中次数”只证明受控运行中函数被调用，不是性能或稳定性统计。[E002]

| 目标 | 配置与协议 | ELF / TLS 实现 | 跨版本函数证据 | 真实运行证据 | 当前平台结果 |
| --- | --- | --- | --- | --- | --- |
| SSH Codex 0.150.1 | 官网登录、默认 provider、Responses、HTTPS | 静态 PIE；OpenSSL 3 `_ex` 路径，同时包含 Rustls/AWS-LC 代码 | 与 0.149.1 的 read/write 指令锚点相同且各自唯一；read→write 相对距离均为 592 字节 | 临时 uprobe 看到同一 write 函数和 HTTP/1 `POST/GET`；受控 final 成功 | 新 sentinel 未形成 Conversation，最近实例多为 `asset_only` [E004][E007][E011] |
| Docker TLS lab Codex 0.149.1 | 自定义 HTTPS provider、`wire_api=responses` | 静态 PIE；OpenSSL 3 `_ex` 路径 | 与 0.150.1 相同的唯一锚点对和 ABI | 工具循环成功；一次受控运行 read=236、write=29；另一轮 29 次 write 中有 3 次 HTTP/1 POST | 新 sentinel 为 0；现有 profile 已 attach，route gate 未准入 [E003][E006][E009] |
| Claude Code 2.1.170 | 历史已登记版本 | Bun 内嵌 BoringSSL classic | read/write 前缀与后续版本一致；read→write 为 912 字节 | 本轮未重新运行该旧二进制 | 精确 profile 存在 [E003][E004] |
| Claude Code 2.1.245 | 历史已登记版本 | Bun 内嵌 BoringSSL classic | read/write 前缀与 2.1.251 一致；read→write 为 1008 字节 | 本轮未重新运行该旧二进制 | 精确 profile 存在 [E003][E004] |
| Docker TLS lab Claude Code 2.1.251 | 自定义 `ANTHROPIC_BASE_URL`、Messages、HTTPS | 动态 ELF；内嵌 BoringSSL classic | read 锚点全文件唯一；短 write 前缀有 14 个候选，但 read 后 1008 字节处的近邻候选唯一 | `tool_use → Bash → tool_result → final` 成功；read=99、write=11，含 2 次 HTTP/1 POST | Observer 明确报 `unsupported_binary_fingerprint`；新 sentinel 为 0 [E004][E005][E008][E011] |

### 1.3 对后续版本的维护策略

已测两版 Codex 和三版 Claude Code 的目标 TLS ABI 与关键函数指令保持稳定，这足以取消“先匹配版本号”的设计，但不足以证明未来所有版本永远不变。[E004]

本阶段应承诺：

- **不再以 CLI 版本、文件大小、头部哈希或整文件哈希作为 attach 的前置门槛；**
- **只要未来版本仍落在同一 TLS ABI/函数实现族，就自动发现，不要求每个版本登记 profile；**
- 静态二进制允许产生少量候选并进入运行时验证，不再要求全文件唯一签名后才有机会观察；
- 运行时通过 buffer 可读性、HTTP/JSON/frame 结构、双向连接一致性和连续调用行为提升或降低候选置信度；
- 候选验证失败可以降级、换候选或仅保留 metadata，不阻断 Agent；
- 只有候选数量失控、读取异常或资源预算超限时才停止该候选，而不是因为版本未知停止整个产品。

这把维护单位从“产品版本”降低为少量“TLS 实现族 + 传输协议 + 线协议模板”。版本变化通常不需要任何维护；只有 TLS vendor/ABI 或线协议语义真正改变时才新增适配。

### 1.4 为什么必须从产品抽象上升到线协议抽象

同一个 Agent 产品可以使用多种 LLM provider，同一种线协议也可以被多个 Agent 产品复用：

| Agent / 框架 | 运行时与当前 TLS 证据 | 可配置的 LLM 线协议 | 通用层应负责 | 专用层只负责 |
| --- | --- | --- | --- | --- |
| Codex | 静态 ELF；当前两版实测内嵌 OpenSSL `_ex` | OpenAI Responses；官方或任意兼容 gateway | 静态 TLS ABI 发现、HTTP/SSE、Responses 模板 | 进程身份、工具名称展示 |
| Claude Code | Bun 单文件；当前三版 BoringSSL classic 前缀稳定 | Anthropic Messages；官方或 gateway | BoringSSL 发现、HTTP/SSE、Messages 模板 | Claude root/子进程身份 |
| Kimi Code CLI | 当前官方项目为 TypeScript 开发、单二进制发布；实际打包 TLS family 需在 lab 安装后确认 | Kimi、OpenAI Chat Completions、OpenAI Responses、Anthropic、Gemini、Vertex 等 | 先发现其实际 TLS family，再按实际 wire protocol 选模板 | Kimi 产品身份、ACP/MCP 运行时关系 |
| Dify | 当前 API/Celery 进程实测映射动态 libssl；plugin 进程还可能走其他 runtime | 按租户/模型选择多 provider | 动态 libssl/其他 runtime adapter、provider 模板 | workflow/app/tenant 归因 |
| LangChain | 当前测试 Python 服务实测映射动态 libssl | ChatOpenAI 自定义 base URL，也可使用 provider-specific integration | 动态 libssl、实际 provider 模板 | chain/agent/session 归因 |

Kimi Code 官方资料说明当前 CLI 以 TypeScript/Node.js 开发并提供单二进制分发，同时列出 Kimi、OpenAI Chat、OpenAI Responses、Anthropic、Gemini 和 Vertex provider 类型；这说明“产品 runtime”和“实际 wire protocol”本来就是两个维度，安装后的单二进制究竟内嵌哪种 TLS family 仍需 Phase 0 实测，不能从 TypeScript 源码直接推定。[Kimi Code getting started](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/getting-started.md)、[Kimi Code providers](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/providers.md)；LangChain 官方文档允许 OpenAI-compatible provider 使用自定义 `base_url`；Dify 官方源码按租户配置选择 provider/model 后调用统一 `invoke_llm`。[LangChain models](https://docs.langchain.com/oss/python/langchain/models)、[Dify model invocation](https://github.com/langgenius/dify/blob/main/api/core/llm_generator/llm_generator.py)[E021][E022]

因此，禁止建立以下耦合：

```text
Codex -> 只允许 OpenAI 官方 URL
Claude Code -> 只允许 /v1/messages 固定路径
Kimi Code -> 只解析 Kimi 格式
Dify/LangChain -> 按框架写一套 provider parser
```

应建立：

```text
Agent 产品身份  ──独立──> TLS/连接发现
实际明文内容   ──识别──> transport + wire protocol template
两者最终在 Conversation 读模型汇合
```

## 2. 当前链路与偏差位置

### 2.1 当前实际链路

```text
Agent exec / process graph
        |
        v
Agent 资产与 Runtime 识别 ---------------------------- 已成功
        |
        v
整文件 TLS profile
  ├─ Codex 0.149.1 / 0.150.1 精确命中 ------------ 已 attach
  └─ Claude 2.1.251 整文件不匹配 ------------------- 断点 A
        |
        v
SSL_write(_ex) / SSL_read(_ex)
        |
        v
完整 HTTP 路径哈希 allowlist
  ├─ /responses、/v1/responses 等 ------------------ 可命中
  ├─ <中转前缀>/responses --------------------------- 断点 B
  ├─ <中转前缀>/v1/messages ------------------------- 断点 B
  └─ <官网服务前缀>/.../responses ------------------- 断点 B（受支持推断）
        |
        v
HTTP/1 + JSON/SSE + provider parser
        |
        v
Interaction / Conversation
        |
        v
左栏 Conversation / asset-only 扁平列表 ------------ 断点 C
```

### 2.2 为什么现有少量记录不能证明全链路可用

当前三小时数据中存在若干旧 Codex/Claude Interaction，但这些记录来自早先的明文测试前端或失败链路：Codex response 是 HTML，Claude response 是 error JSON；它们没有 assistant text、tool call 或 tool result，却可能因为传输 framing 没有 partial reason 而被标记为 `complete`。[E011][E018]

本阶段需要把完整性拆成三层：

| 层级 | 完整条件 | 失败示例 |
| --- | --- | --- |
| Transport | request/response framing 完成，未截断 | 连接断开、body 超限 |
| Wire protocol | 出现合法终止、合法 error 或可识别非流式响应 | HTML 网关错误、未知 SSE、缺少 terminal event |
| Conversation | request + response/tool + 跨请求 tool_result 链闭合 | 只有请求、工具结果未回传、最终回复缺失 |

只有三层都满足时，UI 才能显示“正文完整”。HTTP 200/完整 Content-Length 本身不等于模型语义完整。[E011][E018]

### 2.3 v2.1 目标链路

```text
exec / process graph / runtime snapshot
        |
        v
Agent Scope（known + candidate + confirmed）
        |
        +---------------- egress / fd / SSL* / pid / cgroup 关联 ----------------+
        |                                                                         |
        v                                                                         v
TLS Discovery Plane                                                    Connection Evidence
  ├─ exported symbol                                                       endpoint/SNI/bytes/time
  ├─ runtime metadata / symbol table
  ├─ static ABI candidate scan
  └─ language adapter（Go/Rustls 等）
        |
        v
Bounded Plaintext Stream（内存、异步、非阻断）
        |
        v
Credential/header scrub -> transport decoder -> schema fingerprint
        |
        +-- known template --> normalized request/response/tool/result
        |
        +-- unknown template -> redacted raw/unparsed evidence + template discovery queue
        |
        v
Interaction -> Conversation -> logical Agent directory -> UI
```

链路中不存在“是否官网”“是否默认 base URL”“是否固定 route”的采集门。URL 和 route 只在 transport 解码后成为可搜索的元数据；用户态模板匹配失败不会使已经观测到的明文事实消失。

## 3. 固定范围、设计原则和非目标

### 3.1 本阶段固定范围

- Docker TLS lab 中的 Codex 自定义 Responses HTTPS；
- SSH 连接中通过官网登录运行的 Codex Responses HTTPS；
- Docker TLS lab 中的 Claude Code 自定义 Anthropic Messages HTTPS；
- 每轮模型请求、回复、工具指令、工具结果、错误和关键时间；
- Codex/Claude 三个当前目标继续作为第一批端到端验收样本；[E006][E007][E008]
- 在编码前完成 Kimi Code、Dify API/Worker/Plugin、LangChain 的运行时与 TLS family 发现矩阵，证明抽象不依赖单一 CLI；[E021][E022]
- 先实现当前实际需要的 HTTP/1 + JSON/SSE，Transport Adapter 接口同时为 HTTP/2 和 WebSocket 保留无产品耦合的扩展点；
- 对话追踪三栏布局保持不变，重构左栏对象与中栏会话切换；
- candidate / confirmed Agent 都可进入目录和有界 discovery；candidate 使用更低 probation 预算，confirmed 使用常规预算。两者都不以 route/provider 配置准入，正文是否形成 Conversation 由凭据清除后的 LLM-likelihood 与 Wire Template 证据决定。

Codex 官方配置允许用户级 `model_provider` 指向自定义 provider，provider 可设置 `base_url`、`wire_api=responses` 和 WebSocket 能力；provider 配置不能由项目级配置覆盖。[OpenAI Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)[E016]

Claude Code 官方支持用 `ANTHROPIC_BASE_URL` 指向 LLM gateway，并要求 Anthropic Messages gateway 转发 `/v1/messages` 等协议和必要 Header。[Claude Code：Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)、[Environment variables](https://code.claude.com/docs/en/env-vars)[E017]

### 3.2 必须保持的安全不变量

1. 不 Hook Agent，不读取 Agent 框架内存对象，不依赖 callback/SDK；
2. 不从网络 egress 密文恢复正文，正文只来自 TLS 加密前/解密后边界；
3. 只要进程位于 AnySentry 已识别的 Agent Scope，并且 TLS 调用能与该进程/连接关联，就允许进入有界 discovery buffer；product、URL、Host、route 和模型名都不是拒绝条件；
4. 内核只执行身份范围、内存读取安全、单次长度、速率和队列预算，不执行 provider 语义判断；
5. TLS 函数候选允许 probation，不要求未知版本一开始就达到全文件唯一；候选必须由运行时内容与连接行为验证后晋升；
6. Authorization、Cookie、API Key 等 Header 在用户态第一阶段清除，原值不进入持久记录、coverage、日志、审计或前端；
7. 已识别但尚未解析的文本/JSON 明文保留为 `unparsed`，二进制只保留长度、hash 和 transport evidence；
8. 采集、重组和模板解析都不得阻断 Agent；预算耗尽时丢弃低优先级 discovery sample，并报告 coverage/drop；
9. 原始、已清理的 Interaction Evidence 是权威事实，Conversation/模板字段/逻辑 Agent 目录都是可重建读模型。

### 3.3 非目标

- 不在本阶段一次性完成所有 Go `crypto/tls`、Rustls、HTTP/2、WebSocket 和 QUIC adapter，但必须完成统一接口、发现矩阵和无法解码时的原始 coverage；如果 Phase 0 证明某个本阶段目标的唯一真实路径依赖其中一种，该 adapter 自动进入当前阶段必做范围，而不是以“暂不支持”拒绝该产品；
- 不对任意非 Agent 进程做系统级全量 TLS 明文抓取；全局指跨 Agent 产品和 LLM 配置通用，不是取消 Agent Scope；
- 不读取隐藏推理、未发送给模型的 RAG/上传文件中间态；
- 不用 Agent Hook 补齐不可观测的框架内部时间；
- 不保证未来所有 TLS ABI 无需适配，但 ABI 变化是维护单位，CLI 小版本和 base URL 变化不是；
- 不在本阶段重写历史 Agent Asset ID 或历史 Interaction；历史通过新读模型兼容归组。

## 4. 通用 TLS Discovery Plane：符号优先、候选探测、运行时晋升

### 4.1 设计目标

TLS Discovery Plane 回答的是“这个 Agent 进程在哪个函数边界能看到加密前/解密后的字节”，而不是“它是什么产品、什么版本、访问哪个模型”。一个产品可同时使用多个 TLS runtime；同一个 TLS runtime 也服务多个产品。发现器因此按**实现机制**组织：

| Adapter | 发现来源 | 典型对象 | 维护单位 |
| --- | --- | --- | --- |
| ExportedSymbolAdapter | ELF 动态符号和 mapped library | Python/libssl、Node 导出 OpenSSL、动态 GnuTLS/NSS | TLS 库符号族 |
| RuntimeMetadataAdapter | ELF 符号表、Go pclntab、语言 runtime metadata | Go `crypto/tls`、未 strip runtime、可恢复函数名的单文件二进制 | 语言 ABI / runtime major |
| StaticAbiDiscoveryAdapter | executable segment 中的 masked anchors、调用关系和 ABI 候选 | Codex 静态 OpenSSL、Claude/Bun 内嵌 BoringSSL、未来 Kimi 单文件发行 | TLS 实现族，不是产品版本 |
| PlainHttpAdapter | write/writev/read syscall + socket | 本地明文 gateway、sidecar、测试服务 | HTTP transport |
| FutureTransportAdapter | 经统一接口新增 | Rustls、其他静态 TLS、专有 runtime | 实际 TLS ABI |

产品识别只用于：确定哪些进程属于 Agent Scope、提高候选优先级、生成 UI 名称。即使产品未知，只要进程已被行为/人工分类为 candidate 或 confirmed Agent，也进入 discovery。

### 4.2 发现状态机

v2.0 要求函数签名全文件唯一后才 attach；v2.1 改为有界 probation：

```text
discovered candidate
        |
        v
probing（低预算、短 TTL、不持久化原始 Header）
        |
        +-- buffer 读取失败/调用异常 ------------> demoted
        |
        +-- 有字节但无可识别 framing -----------> probation / metadata-only
        |
        +-- 单向可读 + Agent egress 相关 --------> likely
        |
        +-- 双向、连续、transport framing 成立 --> validated
                                                    |
                                                    v
                                                  active
```

运行时验证信号包括：

- 参数指针可读、长度合理、返回值与读写方向一致；
- 同一 PID/cgroup/SSL*/FD 在相邻调用中连续；
- 与 Agent 的 connect/egress/socket evidence 在时间和进程上相符；
- 明文能够组成 HTTP request line、HTTP/2 frame、WebSocket frame、JSON/SSE 或其他已登记 transport；
- read/write 双向行为合理；
- 候选调用频率、失败率和复制字节未超过预算。

不要求 probation 阶段已经知道 route、provider 或模型。无法解析 transport 也不立即否定 TLS 候选；它可能是尚未实现的 HTTP/2/WebSocket/专有 framing。

### 4.3 静态二进制候选策略

Codex/Claude 的现有证据仍用于建立初始 TLS family，但不再作为硬门：

- Codex 两版的 OpenSSL `_ex` read/write 锚点和相对关系稳定，作为高置信候选；[E004][E006][E007]
- Claude 三版的 BoringSSL read 锚点稳定，write 可由近邻候选优先排序；即使出现多个候选，也可以在小预算 probation 中分别观察，而不是整个版本拒绝；[E003][E004][E008]
- masked signature、函数顺序、距离、可执行段和 ABI 共同形成 score；
- 每个 inode 只允许有界候选数；高置信候选先 probe，失败后再尝试下一候选；
- 候选一旦由真实明文流验证，缓存 `(dev,inode,family,offsets,abi,confidence)`；
- 新 inode 自动重新发现，不读取 CLI 版本；
- product-specific offset 可以作为 bootstrap hint，但不得成为唯一生产路径。

这是一种“通用发现 + 特例加速”关系：Codex/Claude 的经验帮助更快命中，但不会要求后续 Kimi Code、Dify plugin 或其他 CLI 复制一套版本 profile。

### 4.4 动态库和语言 runtime

- OpenSSL/BoringSSL/GnuTLS/NSS 动态符号直接按名称 attach，是最低维护成本路径；
- Python/Dify/LangChain 当前进程映射 libssl，应优先走动态符号，而不是框架适配；[E022]
- Go `crypto/tls` 优先从 pclntab/符号恢复函数，再按 Go ABI adapter 读取 slice；
- Rustls 优先从保留符号/单态化模式和运行时验证定位，不能要求每个 Rust Agent 写产品 profile；
- Bun/Node 单文件发行使用 static ABI candidate + runtime promotion；
- 同一 Agent 进程可同时激活多个 adapter，真正产生有效明文的连接由运行时验证选中。

### 4.5 首请求与性能

- static targets 和当前运行 inode 在 Observer 启动时预发现；
- exec 事件触发异步候选发现，周期扫描仅处理 inode 变化；
- 扫描只读 executable segment，结果按 inode 缓存；
- probation 有独立调用/字节/时间预算，不能因错误候选放大内核开销；
- eBPF 永远使用 `probe_read_user` 失败即返回，不解引用未知复杂对象；
- 预算、drop 和候选状态通过 coverage 上报，但 Agent 不等待扫描和 attach。

## 5. 通用明文采集面：URL、route 和模型配置不再做内核 gate

### 5.1 内核侧只保留四类约束

当前完整 path hash gate 已被实测证明会因 base path 变化漏掉合法请求。[E009][E010] v2.1 将 URL/route/provider 判定全部移出 eBPF。内核只检查：

1. 当前 PID/cgroup 是否属于 Agent Scope 或受信 network runtime；
2. 当前 TLS/Plain HTTP candidate 是否处于 probing/active 且未超预算；
3. buffer 指针、长度、方向和返回值是否安全；
4. Ring/队列是否有容量。

满足后就异步复制有界 fragment。`api.openai.com`、中转域名、本地 sidecar、`/responses`、自定义 path 都走同一条采集路径。

### 5.2 连接级缓冲和 egress 的职责

egress、connect、DNS、SNI 和 socket owner 不用于拒绝自定义 provider，而用于：

- 把 `SSL*` / fd / PID / cgroup / remote peer 关联为连接；
- 区分 request 和 response，建立连接生命周期；
- 识别同一 Agent 的并发模型/RAG/tool 连接；
- 为未知协议提供 endpoint、时间和 byte evidence；
- 控制每连接内存、空闲 TTL、最大 message、最大并发和采样预算。

内核与 Collector 之间统一使用调用/切片事件，避免不同 TLS ABI 各自发明归因格式：

```text
PlaintextCallFragment
  call_id, entry_monotonic_ns, return_monotonic_ns
  pid, process_generation, cgroup_id, agent_instance_id
  adapter_id, candidate_id, tls_object, fd?, socket_cookie?
  operation = tls_read | tls_write
  requested_len, actual_len, fragment_offset, captured_len, sequence
  flags = probing | truncated | read_error | budget_drop
  payload = 仅存在于有界 Ring/Collector 缓冲中的字节
```

- write entry 保存 buffer/长度并复制有界切片，return/`actual_written` 确认真实成功字节；失败调用不进入正文；
- read entry 保存 buffer，return/`actual_read` 后复制已解密字节；classic 与 `_ex` ABI 由 adapter 统一映射；
- 大调用拆为带 `fragment_offset/sequence` 的固定上限切片，超出 per-call/per-connection 预算必须标记 `truncated`，不能把残缺正文显示为完整；
- `SSL* → fd/socket` 优先由 `SSL_set_fd/BIO` 等连接事件解析；缺少直接映射时可用进程、socket cookie 和时间关联，但质量降为 `strong/inferred`；
- HTTP/2/WebSocket 的 stream/channel ID 由 Transport Adapter 在连接内继续分流，不能仅凭 PID 或 endpoint 聚合；
- entry/return monotonic 时间原样保留，后续 Unix 时间换算和 UI 排序不能覆盖原始边界。

本地 loopback、Unix-to-TCP sidecar 或自定义网关同样可能承载 LLM，不因“不是外网”被排除。egress 是归因信号，不是官网白名单。

### 5.3 凭据清除与持久化层级

Plaintext fragment 先进入 Collector 内存缓冲，再执行 transport decode 和 Header scrub：

| 内容 | 临时内存 | 持久化 |
| --- | --- | --- |
| Authorization、Cookie、Proxy-Authorization、API Key Header | 为解析 framing 短暂存在 | 永不持久化，值在首阶段清除 |
| 已知 LLM request/response body | 有界重组 | 按 Interaction 策略保存 |
| 未知但可读文本/JSON | 有界、短 TTL | 保存为 redacted `unparsed` evidence 或按预算采样 |
| 未知二进制 | 只保留 bounded sample 用于 transport fingerprint | 默认只存长度、hash、方向、时间和 coverage |
| 超预算内容 | 不继续复制 | 记录 drop/partial reason |

这里必须区分两个决策：

```text
采集准入：Agent Scope + TLS candidate + 安全/预算
    ↓ 只进入短 TTL 的 Collector 内存
凭据清除：先移除认证 Header 和已知 secret field
    ↓
LLM-likelihood：按 transport、JSON/message shape、流式事件、tool 结构、双向时序综合评分
    ├─ confirmed LLM template ------> 保存结构化 Interaction 与必要正文
    ├─ likely LLM / unknown template -> 限长保存 redacted unparsed evidence
    └─ unlikely non-LLM ------------> 只保存连接、方向、时间、长度和分类理由
```

Endpoint、SNI、route 和产品名可以作为**弱加分证据**，但任何一个弱信号缺失或变化都不能单独否决采集，也不能覆盖内容证据。这样能同时满足两个目标：自定义 provider 和新 Agent 不漏采；Agent 的更新检查、遥测或远程文件/RAG 请求不会因为同进程 TLS 而被长期保存成模型对话。

“尚未能解析”不再等于“没有观测到”。UI 至少能显示该 Agent 在某时刻产生了双向 TLS 明文流、字节量、内容类型候选和未解析原因。

### 5.4 Transport Adapter 层

Transport Adapter 与 Agent 产品无关：

- HTTP/1 request/response、chunked、gzip；
- SSE event/data framing；
- HTTP/2 frame + HPACK（按后续真实样本实现）；
- WebSocket upgrade/frame（按后续真实样本实现）；
- 单次/连续 JSON；
- MCP JSON-RPC over HTTP/pipe；
- unknown/binary framing fingerprint。

当前 Codex/Claude 三条验收链仍先完成 HTTP/1 + SSE，但 eBPF 不再因为 H2/WS/未知路径丢数据；无法重组的连接进入 `transport_unknown`，后续新增 Transport Adapter 即可重放有限 raw evidence 和新流量，不修改产品识别器。

### 5.5 为什么不读取 Agent 的 LLM URL 作为规则

Observer 可以在测试时读取配置帮助诊断，但生产采集不应依赖 `.codex`、`.claude`、Kimi provider、Dify tenant 或 LangChain model config：

- 同一 Agent 会切换 provider/base URL；
- 配置可能来自文件、环境变量、OAuth、数据库、远端管理面或运行时参数；
- URL 可能包含租户 path，且与 wire protocol 不是一一对应；
- Dify/LangChain 一个进程可并发访问多个 provider；
- Kimi Code 一个产品原生支持多种协议。[E021]

URL 在解码后可以展示为 redacted endpoint、用于搜索和关联，但配置变化不再要求修改 Observer 规则。

## 6. Wire Protocol Template Registry：按内容结构解析，不按 Agent 产品解析

### 6.1 模板注册与匹配原则

模板匹配输入是 transport 解码后的 Header 元数据、JSON shape 和 stream event，不是 Agent 产品、URL 或模型名。一个 Conversation 可以在同一 Agent 内切换 template；一个 template 也可被任意产品复用。

```ts
interface WireProtocolTemplate {
  templateId: string;
  transports: string[];
  match: {
    requiredJsonPaths?: string[];
    anyJsonPaths?: string[];
    streamEventTypes?: string[];
    contentTypeHints?: string[];
  };
  extract: {
    model?: string[];
    conversationId?: string[];
    responseId?: string[];
    messages?: MessageExtractionRule[];
    toolCalls?: ToolCallExtractionRule[];
    toolResults?: ToolResultExtractionRule[];
    terminal?: TerminalRule[];
  };
}
```

匹配分两阶段：

1. **Schema fingerprint**：顶层 key、数组/对象类型、稳定 event type、content block 类型；不含字段值和正文；
2. **Template score**：满足 required/any/terminal 规则后选择最高分模板；分数不足或多个模板冲突时标记 `unparsed/ambiguous`，保留证据，不强行归类。

模板优先使用代码 adapter 处理流式增量、跨 event state 和复杂二进制；稳定 JSON 映射可用版本化声明规则。增加新模型/网关时，优先新增或扩展 wire template，不新增 Agent 产品分支。

### 6.2 初始模板集合

| Template family | 典型结构 | 可复用产品/框架 |
| --- | --- | --- |
| OpenAI Responses | `input`、`output_item`、`previous_response_id`、response stream events | Codex、Kimi Code `openai_responses`、LangChain Responses、Dify OpenAI-compatible provider |
| OpenAI Chat Completions | `messages`、`choices/delta`、`tool_calls`、`role=tool` | Kimi/OpenAI-compatible CLI、LangChain、Dify、其他第三方 gateway |
| Anthropic Messages | `messages`、content blocks、`tool_use/tool_result`、message stream events | Claude Code、Kimi Code `anthropic`、Dify/LangChain Anthropic integration |
| Gemini GenerateContent | `contents/parts`、functionCall/functionResponse | Kimi Code Gemini、Dify/LangChain Gemini integration |
| Kimi native | 以真实 Kimi provider 样本确定；可复用通用 message/tool 基元 | Kimi Code / Moonshot client |
| Generic role-message | 可识别 role/content/tool ID，但不满足完整厂商模板 | 未知 OpenAI-compatible 或内部 gateway |
| MCP JSON-RPC | method/params/result/id | Codex、Claude、Kimi、Dify/LangChain tool 层 |

这张表是 template registry 的初始覆盖，不是产品白名单。比如 Kimi Code 改用 Anthropic provider 时应自动命中 Messages，而不是继续强行匹配 Kimi native。

### 6.3 未知模板发现

未知内容进入 `TemplateDiscoveryRecord`：

- transport、content type、方向、时间、schema fingerprint；
- redacted body sample 或 body hash/长度；
- Agent/product 作为上下文标签，不作为解析条件；
- 相同 fingerprint 的出现次数、涉及 Agent 数和 endpoint 数；
- `unparsed_reason`：no_template、ambiguous、terminal_unknown、binary_transport 等。

运维人员仍可在 Inspector 查看 redacted raw；开发者根据重复 fingerprint 增加模板 fixture。新模板上线后可对保留 raw evidence 做离线重解析，不必重新等待同一请求发生。

### 6.4 多模态和文件的边界

TLS 边界看到的是 Agent **实际发送**的应用层字节，因此处理原则与本项目目标一致：

- 文本、图片描述、文件摘要、tool result 等只要出现在最终模型 request 中，就进入对应 content part；
- inline base64、图片、音频和文件二进制默认不把完整 blob 持久化到 Conversation，只展示类型、MIME、声明/捕获大小、hash、是否 inline/URL/reference 和截断状态；
- 如果 Agent 先把文件上传到对象存储，再只向模型发送引用，LLM Interaction 只记录这个脱敏引用，不主动抓取或还原原文件；
- 本地 RAG 解析、未发送的上传文件和隐藏中间态不会出现在 TLS 模型链路中，也不得从文件系统补采；
- 多模态请求仍参与 transport/wire/conversation 完整性判断；因预算只取得部分 blob 时，正文状态必须显示 `partial`，文本与工具字段可独立保持可读。

这意味着“能在 TLS 明文中看到”与“适合长期存储完整媒体”是两个决策。首阶段完整解析文本、角色、工具和多模态 metadata；原始媒体存储若未来有业务要求，应作为单独的数据治理能力审核，不嵌入 TLS 发现器。

### 6.5 OpenAI Responses adapter

需要对当前真实中转与官网链路验收以下事件：

- request：`model`、`input`、`tools`、`previous_response_id`、conversation/provider response ID；
- response：created、output item/content part、text delta/done；
- tool：function/custom/local shell 等 item、arguments delta/done、call ID；
- result：下一次 request 中与 call ID 对应的 function/tool output；
- terminal：completed、failed、incomplete 和合法非流式 response；
- retry：同一 model call 的 attempt、HTTP error 和 stream restart。

### 6.6 Anthropic Messages adapter

需要验收：

- request：`model`、`system`、`messages`、`tools`、thinking/stream 配置；
- response：message start、content block start/delta/stop、message delta/stop；
- tool：`tool_use` 的 ID、name、input；
- result：下一次 user message 中的 `tool_result`、content、is_error；
- terminal/error：message stop、标准 error JSON 和 gateway error。

真实 Claude 受控调用已经产生 1 个 tool_use、1 个 tool_result 和 final，证明测试链可作为验收权威输入。[E008]

### 6.7 完整性新规则

Interaction 增加：

```ts
transportCompleteness: "complete" | "partial";
wireCompleteness: "complete" | "error" | "unknown" | "partial";
conversationCompleteness: "complete" | "tool_pending" | "response_pending" | "partial";
terminalEvent?: string;
```

- HTML、未知 content type、无法识别的 SSE 即使 framing 完整，也不得显示 wire complete；
- 标准 error JSON 记录为可解释错误，不生成 assistant 回复；
- streaming 必须看到 terminal，或合法非流式响应完整结束；
- 有 tool_call 但后续窗口内没有 tool_result 时显示 `tool_pending`；
- tool_result 已发送但最终 response 缺失时显示 `response_pending`；
- 旧单一 `completeness` 字段继续兼容，但新 UI 以三层状态为准。

### 6.8 时间模型

所有时间使用 kernel monotonic 采集后经现有校准转换为 Unix ns；原始时间不因 UI 排序而覆盖。

| 时间字段 | 含义 | 来源 | 质量 |
| --- | --- | --- | --- |
| `requestStartedAt` | 第一个该模型 request TLS write | uprobe entry | exact transport boundary |
| `requestCompleteAt` | request body/framing 完整 | reassembler | exact/strong |
| `firstResponseAt` | 第一个 response TLS read | uprobe return | exact transport boundary |
| `toolCallFirstDeltaAt` | 第一个工具调用 delta 可见 | SSE read | exact visible boundary |
| `toolCallCompletedAt` | name/arguments/call ID 完整 | provider parser | exact visible boundary |
| `toolExecStartedAt` | 对应本地工具进程 exec | exec/process graph | exact 或 inferred |
| `toolExecEndedAt` | 对应工具进程 exit | exit/process generation | exact 或 inferred |
| `toolResultAvailableAt` | 工具结果首次进入下一次模型 request | provider request parser | exact visible boundary |
| `finalResponseAt` | final assistant 内容首次/全部可见 | provider parser | exact visible boundary |
| `interactionEndedAt` | terminal/error/EOF | reassembler | exact/partial |

只有 `toolCallId + 同一 Agent root + 命令/工具语义匹配 + exec generation` 都满足时，才把 exec/exit 标为 exact tool duration。否则只显示：

```text
toolCallCompletedAt → toolResultAvailableAt
```

并标注“模型可见边界耗时”，不能称为本地工具执行时长。

### 6.9 工具关联

```text
LLM response tool_call(call_id, name, arguments)
        |
        +-- exact/strong --> eBPF exec/file/network evidence
        |                     root + generation + normalized command/tool + time
        v
Agent local execution
        |
        v
next LLM request tool_result(call_id, content, is_error)
        |
        v
final LLM response
```

关联必须输出 `exact | strong | inferred | unlinked`。时间邻近本身最多是 inferred，不能把另一个并发 Agent 的 shell 进程串入当前工具调用。

## 7. Agent 身份：证据资产、逻辑 Agent 和实例分层

### 7.1 当前问题

当前 Conversation rail 的重复并不只是 CSS 问题：

- `SessionRail` 一行对应一个 ConversationSummary；asset-only 也被伪装成一条 Conversation；[E012][E013]
- 当前 30 天目录里，目标产品形成 10 行、8 个 asset ID；同一 Codex 有多个 PID 生命周期和 alias 行；[E014]
- Runtime Snapshot 已明确保存 running/exited 状态，但对话页没有使用；[E014]
- 物理 workload alias、root lifetime、人工 review 和产品名在不同读模型中混合，可能让同名实例膨胀，或让 Codex/Claude 共用物理别名时只保留一个主行。[E015]

因此不能只在 React 中按 `displayName` 分组。需要增加不会改写取证 ID 的逻辑 Agent 层。

### 7.2 三种 ID 的职责

| ID | 职责 | 是否跨重启稳定 | 是否用于证据定位 |
| --- | --- | --- | --- |
| `agentAssetId` | 现有持久资产/历史兼容 ID | 取决于现有模型 | 是，保留不改写 |
| `logicalAgentId` | 产品感知的用户目录对象 | 是 | 作为读模型，不替换原证据 |
| `agentInstanceId` | 一次 root process/container generation | 否 | 是，定位运行时实例 |

### 7.3 `logicalAgentId` 建议规则

先规范产品族：`codex/codex-cli → Codex`，`claude/claude-code → Claude Code`。产品族必须成为逻辑身份的强分区，物理 workload 只能表达 `runs_on`，不能跨产品 union。

| 环境 | 逻辑 Agent key | 实例 key |
| --- | --- | --- |
| Host/SSH CLI | product + hostId + canonical workspace + executable family | host + boot + root PID + start time |
| Docker CLI | product + physical container + canonical workspace（未知时省略） | root PID generation |
| Kubernetes | authoritative Agent label；否则 product + cluster/namespace/workload identity | pod/container/root generation |
| 证据不足 | 不跨 asset 合并，显示 `groupingQuality=inferred/unresolved` | 保留现有 instance |

同一 workspace 中同时运行两个 Codex，左栏显示一个逻辑 Codex 行和“2 个运行实例”；展开后可选具体实例。Codex 与 Claude 即使在同一 Docker TLS lab 容器也必须是两个逻辑 Agent。[E014][E015]

### 7.4 历史兼容

- 不批量重写历史 Interaction 或 Asset Lifecycle；
- 新目录保存成员 `agentAssetIds[]` 和 `instanceIds[]`；
- conversation 查询以 logicalAgentId 展开成员资产；
- product 冲突的旧 alias 不参与自动 union，作为 `identity_product_conflict` 诊断；
- product 缺失的旧数据只在证据足够时从 process signature 重建，否则保持独立历史行；
- 人工 review 仍覆盖 classification，但不能把一个容器级 review 传播成跨产品逻辑身份。

## 8. 对话追踪前端：三列保留，左栏改为 Agent 目录

### 8.1 用户任务

页面必须首先支持两个任务：[E001]

1. 一眼看到当前正在运行的所有逻辑 Agent，选择目标 Agent，查看其最新或指定全链路会话；
2. 搜索当前未运行的历史 Agent，查看历史会话和 coverage。

### 8.2 两种可行方案

| 方案 | 结构 | 收益 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| A. 左栏树内同时嵌套产品→Agent→实例→会话 | 所有对象都在左栏展开 | 一处完成全部选择 | 现有 320px 左栏内层级过深，长会话再次拥挤，键盘模型复杂 [E012] | 不推荐 |
| B. 左栏只做 Agent 目录，中栏顶部做会话切换 | 三栏职责为 Agent / Timeline / Inspector | 符合“先找 Agent，再看对话”；相同实例自然堆叠；信息密度可控 | 中栏需增加 session switcher | **推荐** |

### 8.3 推荐桌面线框

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 对话追踪  [搜索 Agent/会话] [产品] [覆盖] [身份]                       [实时跟随] [刷新]              │
├──────────────────────────────┬──────────────────────────────────────────┬───────────────────────────┤
│ Agent 目录 · 320px           │ 对话时间线                               │ 事件检查器                │
│                              │                                          │                           │
│ 运行中  3                    │ Codex · AnySentry / Host                 │ MODEL REQUEST             │
│ ▾ Codex  2                   │ ● 运行中 · 2 实例 · 正文完整             │ 16:20:10.120              │
│   ● AnySentry / Host         │                                          │                           │
│     2 实例 · 6 会话          │ [‹] 会话 3/6：“修复 observer…” [⌄] [›] │ [结构化][原始][证据]      │
│     最新 20 秒前  [完整]     │ ──────────────────────────────────────── │                           │
│     ▸ 查看实例               │ USER → LLM                               │ request/response          │
│   ● TLS lab / Docker         │ LLM → AGENT                              │ tool call/result          │
│     1 实例 · 2 会话          │ TOOL CALL · exec_command                 │ exact timestamps          │
│                              │ TOOL EXEC / EXIT                          │ asset / instance IDs      │
│ ▾ Claude Code  1             │ TOOL RESULT → NEXT REQUEST               │ coverage / correlation    │
│   ● TLS lab / Docker         │ FINAL RESPONSE                            │                           │
│     1 实例 · 1 会话          │                                          │                           │
│                              │                                          │                           │
│ 历史  24          [展开]     │                                          │                           │
│ ▸ Codex 18                   │                                          │                           │
│ ▸ Claude Code 6              │                                          │                           │
│ [加载更早 Agent]             │                                          │                           │
└──────────────────────────────┴──────────────────────────────────────────┴───────────────────────────┘
```

### 8.4 左栏信息层级

#### 一级：运行状态

- `运行中` 永远置顶，来源必须是 Runtime Snapshot 的 `running/unobserved` 与持久 lifecycle，不受当前会话时间范围影响；
- `历史` 默认折叠，包含明确 exited/lost/terminated 或没有当前 runtime 的持久 Agent；
- `unobserved` 使用“连接待确认”而不是立即移入历史；
- 显示计数文字与图标，不能只靠颜色。

#### 二级：产品族

- Codex、Claude Code、Pi、LangChain、Dify 等按 canonical product 分组；
- 显示逻辑 Agent 数量和运行实例数量；
- 产品组折叠状态保存在 URL 或 session state，不写入 localStorage 的正文数据。

#### 三级：逻辑 Agent

默认行展示：

- display name；没有人工名称时使用 `产品 + workspace/container/host`；
- 运行状态、环境、workspace/location；
- `运行实例数 / 总实例数 / 会话数`；
- 最近活动时间；
- coverage rollup：解析完整、部分解析、仅资产、TLS 未发现、候选探测中、transport 未识别、template 未识别、预算丢弃等；
- 选中后中栏自动打开其最新会话，但用户正在阅读历史时实时跟随不得抢走选择。

#### 四级：实例（按需展开）

- 只在用户点击“查看实例”时展开；
- 显示 PID generation、容器/Pod、running/exited、首末时间、coverage；
- 实例是诊断筛选，不是默认 Agent 行；
- 选择实例后仅过滤该实例的会话，标题明确“已限定实例”。

### 8.5 中栏会话切换

中栏标题区新增 `ConversationSwitcher`：

- 当前会话序号、首条用户摘要、开始/最后时间、turn/tool/error 数；
- 上一会话/下一会话按钮；
- 下拉列表按时间分页，支持只看有正文/异常；
- agent-only 时显示诊断状态，不伪造一条会话；
- URL 使用 `logicalAgentId + conversationId + eventId + interactionId`；历史 `agentAssetId` deep link 由服务端解析到 logicalAgentId；
- 浏览器前进/后退恢复 Agent、实例、会话、事件和滚动位置。

### 8.6 搜索和历史定位

- 搜索默认匹配 Agent 名称、产品、环境、workspace 和会话摘要；
- 搜索词仍只在 POST body，不进入 URL、日志、analytics 或持久存储；
- 运行中和历史分别返回命中计数；
- 历史采用 cursor 分页，不被当前 `limit=50` 的 Conversation 截断；[E012]
- 当前全局时间范围限制会话，不限制运行中 Agent 目录；历史 Agent 超出时间范围时显示“该时间范围无会话”和“查看最近历史”操作。

### 8.7 响应式与无障碍

- ≥1280px：三列；1024px：Agent + Timeline，两栏，Inspector overlay；
- <768px：目录 → 会话时间线 → Inspector 三级路由式推进；返回保留筛选和滚动；
- tree/group/option 使用正确 `aria-expanded`、`aria-selected` 和 roving tabindex；
- Arrow Up/Down 移动同级 Agent，Left/Right 折叠展开，Home/End 定位首尾；
- 点击目标不小于 44px，状态同时有文字、图标和颜色；
- 50+ 历史行采用分页或虚拟化，React key 使用稳定 `logicalAgentId/agentInstanceId/conversationId`，禁止 index key；
- loading、empty、error、partial、unobserved 都有明确恢复路径。

本方案沿用现有硬边、低圆角、语义状态色和三栏网格，不新增 UI 依赖，也不另建一套视觉语言。

## 9. API 与读模型

### 9.1 新增 Agent 对话目录接口

沿用 POST query 风格：

```text
POST /security-center/agents/conversation-directory
```

请求：

```ts
interface AgentConversationDirectoryQuery {
  lifecycleScope?: "running" | "history" | "all";
  product?: string;
  classification?: AgentClassification;
  coverageStatus?: AgentConversationCoverageStatus;
  q?: string;
  historyCursor?: string;
  historyLimit?: number;
}
```

响应：

```ts
interface LogicalAgentDirectoryItem {
  logicalAgentId: string;
  groupingQuality: "exact" | "strong" | "inferred" | "unresolved";
  product: string;
  displayName: string;
  environment: "host" | "docker" | "kubernetes" | "unknown";
  workspacePath?: string;
  locationLabel?: string;
  lifecycleState: "running" | "unobserved" | "historical";
  activeInstanceCount: number;
  totalInstanceCount: number;
  conversationCount: number;
  lastActivityAtUnixNs?: string;
  agentAssetIds: string[];
  instances: LogicalAgentInstanceSummary[];
  coverage: AgentCoverageRollup;
}
```

目录由 `agents/directory + runtime/instances + conversation summary` 在服务端组合，避免 React 用不一致 alias 自行 join。

### 9.2 扩展会话查询

`POST /security-center/agents/conversations` 增加：

- `logicalAgentId`；
- `agentInstanceId` 可选下钻；
- cursor + limit；
- `hasContent` 与三层 completeness；
- discovery/transport/template/budget coverage reason；
- `tlsAdapterId`、`transportProtocol`、`wireTemplateId` 和 `parseState`；
- 不再为每个无正文资产生成假的 Conversation 行。agent-only 状态由目录对象表达。

`POST /security-center/agents/conversations/timeline` 保持按 conversation 查询，并增加 tool process evidence 与时间质量。

### 9.3 Coverage 事实

Observer 增加无正文的轻量 coverage 事实，不包含 path/Host/body：

```ts
interface AgentPlaintextCoverageFact {
  product: string;
  agentInstanceId: string;
  tlsAdapterId?: string;
  discoveryState: "not_seen" | "probing" | "validated" | "metadata_only" | "budget_limited";
  candidateConfidence?: number;
  transportProtocol?: "http1" | "http2" | "websocket" | "json" | "unknown";
  wireTemplateId?: string;
  parseState?: "parsed" | "partial" | "unparsed" | "ambiguous" | "not_seen";
  plaintextBytesObserved: number;
  redactedSamplesRetained: number;
  droppedBytes: number;
  reasons: string[];
  lastObservedAtUnixNs: string;
}
```

UI 可以据此区分“没有 TLS 调用”“正在验证候选”“已有明文但 transport 未识别”“transport 已识别但 template 未解析”“解析完整”“预算丢弃”，不再全部显示 `no_plaintext_interaction`。Endpoint 和 route 可以在成功解码后以 redacted 元数据展示，但 coverage 不出现“非官网所以拒绝”。

## 10. 开发阶段与代码范围

审核通过后按以下顺序连续实施。Phase 0 先证明全局抽象，之后才修 Codex/Claude；避免再次从两个产品直接长出不可复用代码。

### Phase 0：Agent TLS 生态发现矩阵

1. 在隔离 lab 安装/启动 Codex、Claude Code、Kimi Code、Dify API/Worker/Plugin、LangChain；
2. 记录每个 runtime 的 ELF/语言、动态 TLS mapping、静态 TLS 候选、Go/Rust/Bun/Node/Python 特征；
3. 每个产品至少配置两种 provider/base URL，确认产品身份不决定 wire protocol；
4. 输出 `runtime → TLS family candidates → transport → wire protocols` 矩阵；
5. 不记录 Key、完整 URL 和正文，发现数据只保存 adapter family 与脱敏 schema fingerprint。

Phase 0 的退出条件不是“所有产品都已有 parser”，而是能用同一 Discovery Plane 表达每个目标；无法表达的 runtime 必须先扩展 adapter 接口。若 Kimi Code、Dify 或 LangChain 的唯一实测调用依赖当前缺失的 TLS/HTTP2/WS adapter，该 adapter 直接提升为 Phase 1/2 的交付项，不能通过选择一个更容易的 provider 绕过真实路径。

### Phase 1：通用 TLS Discovery Plane

1. 把 `TlsAttachManager` 拆成 exported symbol、runtime metadata、static ABI candidate 和 plain HTTP adapters；
2. 引入 `discovered/probing/likely/validated/active/demoted` 状态机；
3. 现有精确 profile 只保留为 bootstrap fixture，不再作为生产版本门；
4. 支持有界多候选、运行时验证、失败换候选、按 inode 缓存和自动重扫；
5. 建立统一 ABI reader 接口，为 OpenSSL/BoringSSL、Go TLS、Rustls 等扩展；
6. coverage 报告 adapter/candidate/confidence/budget，不报告产品版本拒绝。

Observer 主要范围：

- `a3s-observer-collector/src/tls_attach.rs`
- 新增 `tls_discovery.rs`、`tls_candidate.rs`、`tls_runtime_validation.rs`
- `a3s-observer-collector/src/main.rs`
- `a3s-observer-common` discovery/coverage schema
- 各 adapter fixture 与负载测试

### Phase 2：有界明文采集与 Transport Adapters

1. 从 eBPF 删除完整 route/官网/中转判断，只保留 Agent Scope、candidate 状态和预算；
2. 实现统一 `PlaintextCallFragment`，正确处理 classic/`_ex` 的 entry/return、requested/actual length、失败调用、切片序号与截断状态；
3. 建立 SSL*/fd/socket cookie/PID generation/cgroup/egress 连接解析与质量分级；
4. Collector 先做 Header credential scrub，再进入持久管线；
5. 抽象 HTTP/1、SSE、JSON、HTTP/2、WebSocket 和 unknown transport adapter；
6. 当前实现 HTTP/1/SSE，H2/WS 未实现时保留 metadata/raw fingerprint，不在内核丢弃；
7. 实现每 PID/候选/连接/调用的内存、字节、切片、TTL、并发和 drop 预算。

主要范围：

- `a3s-observer-ebpf/src/main.rs`
- `a3s-observer-common/src/lib.rs`
- `a3s-observer-collector/src/main.rs`
- 新增 transport reassembly modules
- credential redaction 与 budget tests

### Phase 3：Wire Protocol Template Registry 与时间链

1. 实现 schema fingerprint、template scoring、ambiguous/unparsed；
2. 实现与 URL 无关的 LLM-likelihood 分级，区分 known LLM、likely unknown 和 unlikely non-LLM 的持久化策略；
3. 首批模板覆盖 Responses、Chat Completions、Anthropic Messages、Gemini、generic role-message 和 MCP JSON-RPC；
4. 对三条真实 Codex/Claude 链补齐 SSE/non-stream 变体；
5. 未知 JSON/text 保存 redacted unparsed evidence，支持后续离线重解析；
6. 解析多模态 content part，正文展示文本，图片/音频/文件默认保存 metadata/hash/引用而非完整 blob；
7. 引入 transport/wire/conversation 三层 completeness；
8. 工具 call/result/final、tool exec/exit 关联和时间质量；
9. 错误 HTML、error JSON、未知 terminal 不再显示 complete。

主要范围：

- `a3s-observer-collector/src/interaction.rs`
- 新增 `wire_templates/`、`schema_fingerprint.rs`
- `a3s-observer-common` Interaction/template schema
- AnySentry `types.ts`、ingest/ClickHouse schema/query
- parser/fixture/reparse tests

### Phase 4：首批产品验证 + 逻辑 Agent 目录读模型

1. Codex、Claude Code 完成当前三条真实全链路；
2. Kimi Code、Dify、LangChain 至少各完成 TLS family 发现和一种实际 provider template 解析；
3. 增加 product canonicalization 和 `logicalAgentId`；
4. 分离 physical workload relation、forensic asset 和 logical Agent；
5. 禁止 product 冲突 alias 自动 union；
6. 组合 persistent lifecycle、runtime snapshot、conversation/coverage；
7. 新增目录 API、历史 cursor 和 deep-link alias resolution。

AnySentry 主要范围：

- `agent-semantic-identity.ts`
- `agent-directory.ts`
- `agent-conversation.ts`
- `agent-runtime-state.service.ts`
- `security-monitoring.controller.ts`
- `aggregation.service.ts`
- `types.ts`、ClickHouse/read-model tests

### Phase 5：对话追踪 UI

1. `SessionRail` 替换为 `LogicalAgentDirectoryRail`；
2. 中栏增加 `ConversationSwitcher`；
3. 实例按需展开、运行中/历史分区、产品组与 cursor；
4. URL/浏览器返回/实时跟随状态重构；
5. agent-only coverage 改为目录诊断，不伪造会话；
6. 1440/1024/820/390/375 View、键盘和 reduced-motion 验收。

主要范围：

- `apps/web/src/pages/ConversationTrackingPage.tsx`
- 拆分同目录组件和 hooks
- `apps/web/src/lib/api/security-center.ts`
- UI contract/browser verification scripts

### Phase 6：跨产品真实部署验收

1. 构建不可变 Observer/AnySentry 镜像；
2. 无本地源码 hostPath；
3. 三条 Codex/Claude 目标链各完成 text、单工具、双工具、多轮；
4. 页面从逻辑 Agent 找到对应会话并读取 request/response/tool/times；
5. Kimi Code、Pi、LangChain、Dify 覆盖 discovery/parsed/unparsed 的代表路径；
6. 同一 Agent 切换 official/custom/local provider 不修改 Observer 配置；
7. 提交前 secret、绝对路径、临时 trace、证书、config 和日志审计。

## 11. 测试与验收标准

### 11.1 TLS Discovery 测试

| 用例 | 预期 |
| --- | --- |
| Python/libssl、Dify API/Celery、LangChain | exported symbol adapter 自动发现，不读取产品版本 |
| Codex 0.149.1 / 0.150.1 | 同一 static ABI family，运行时验证后 active，不读版本字段 |
| Claude 2.1.170 / 2.1.245 / 2.1.251 fixture | read/nearby write 进入 candidate scoring，真实调用晋升 active |
| 改 1 个关键 anchor byte | 低置信候选不晋升；如果存在其他候选继续 discovery，不拒绝整个产品 |
| 构造两个近邻 write 候选 | 按 score 依次 probation；只有产生合法连接明文的候选晋升 |
| 候选参数不可读/长度异常 | probe_read 失败并 demote；Agent 不崩溃、不阻塞 |
| `SSL_write(_ex)` 返回失败或部分成功 | 只确认 actual written 字节；失败 entry sample 不形成请求正文 |
| `SSL_read(_ex)` 返回不同 actual length | 只复制 return 后有效范围，不读取未初始化尾部 |
| 普通非 Agent Bun/静态 ELF 含相同字节 | 未进入 Agent Scope，不启动正文 discovery |
| 行为识别出的未知 candidate Agent | 进入低预算 discovery，即使无产品模板也可产生 unparsed evidence |
| CLI 升级替换 inode | 自动重扫，不要求新增版本记录 |

### 11.2 采集、Transport 和 Template 测试

- 同一 Agent 分别访问官网、自定义长前缀、本地 sidecar 和动态 base URL，eBPF 采集行为不变；
- `/responses`、任意前缀 `/responses`、`/messages`、随机 path 和无 Host 的 HTTP 都能进入 bounded stream；
- Header scrub 后 Authorization/Cookie/API Key 原值为 0 命中；
- 单个 TLS 调用跨多个 fragment、一个 HTTP body 跨多个 TLS 调用和 keep-alive 多请求均按 call/sequence/connection 正确重组；
- fragment 或 ring drop 时产生 `truncated/partial`，不得把残缺 request/response 标为 complete；
- HTTP/1 + SSE、chunked、gzip 正确重组；
- H2/WS fixture 未实现 decoder 时返回 transport_unknown，不在 eBPF 丢失；
- Responses、Chat Completions、Messages、Gemini、MCP 模板按 body/schema 匹配，与 Agent 产品无关；
- Kimi Code 切换 OpenAI Responses 与 Anthropic provider 时命中不同模板，但 logical Agent 不变；
- Dify/LangChain 同进程并发两个 provider 时按 connection/template 分开，不按进程强绑协议；
- 未知 JSON 形成稳定 schema fingerprint 和 redacted unparsed evidence，模板新增后可重解析；
- Agent 的更新检查、遥测和远程 RAG 读取 fixture 不形成 Conversation；若无法判断，只留有界 unparsed/metadata 和分类理由；
- 最终发给 LLM 的多模态文本与 content part 可见；inline 媒体只留 MIME/大小/hash/引用，未发送的本地文件 sentinel 为 0；
- 二进制/超预算内容只留 metadata/hash/drop reason；
- 非 Agent PID 即使访问相同 endpoint 也不进入正文 discovery。

### 11.3 跨产品真实全链路矩阵

| 场景 | tender Codex | SSH Codex | tender Claude | Kimi Code | Dify | LangChain |
| --- | --- | --- | --- | --- | --- | --- |
| TLS family 自动发现 | 10/10 | 10/10 | 10/10 | 必测 | API/Worker/Plugin 必测 | 必测 |
| official/custom URL 切换无需 Observer 配置 | 必测 | 必测 | 必测 | 至少两 provider | 至少两 provider | 至少两 provider |
| 纯文本 request/response/final | 10/10 | 10/10 | 10/10 | 必测 | 必测 | 必测 |
| 单工具 call/exec/result/final | 10/10 | 10/10 | 10/10 | 必测 | 必测 | 必测 |
| 连续两个工具和多轮顺序 | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 未知模板仍有 unparsed evidence | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 中转错误/超时/断流 | partial/error，Agent 不受阻 | 同左 | 同左 | 同左 | 同左 | 同左 |
| URL/Key/Header 泄密扫描 | 0 | 0 | 0 | 0 | 0 | 0 |

每次使用唯一 sentinel，并断言：

- request 包含发送给模型的 user/developer/system/tool result；未发送的本地 sentinel 不出现；
- response 与 CLI 可见 final 一致；
- tool name、arguments、call ID、result、is_error 和顺序一致；
- `requestStarted <= requestComplete <= firstResponse <= tool/final <= ended`；
- exact tool process 时间必须有同 root/generation/semantic 证据；
- logicalAgentId、agentAssetId、agentInstanceId、host/docker 归因正确；
- 新 Interaction 的 capture source 是 TLS discovery adapter，不用旧明文 mock 作为成功证据；
- 修改 base URL/path/模型名后不需要发布 Observer 配置或新增产品 profile；
- 无模板时仍能从 UI 找到 unparsed TLS evidence，并能在新增模板后重建结构化时间线。

### 11.4 前端验收

- 左栏第一屏完整展示全部运行中逻辑 Agent，不被 `limit=50` 的会话截断；
- 同一 workspace/环境的两个运行 Codex 显示一行和“2 实例”，可展开实例；
- Codex 与 Claude 在同一容器仍显示两个逻辑 Agent；
- 历史区默认折叠，可搜索、分页并查看历史会话；
- 选择 Agent 后，中栏默认最新会话，可切换前后会话；
- agent-only 显示 discovery/transport/template/budget 精确 coverage，不生成假会话，也不出现“非官网 URL 被拒绝”；
- deep link 与浏览器前进/后退恢复完整选择；
- 实时新增实例/会话不抢走正在阅读的历史滚动；
- 1440、1024、820、390、375 px 无页面级横向滚动和不可达内容；
- 键盘 tree/listbox、44px 目标、状态文字/图标/颜色和 error recovery 通过；
- console/runtime exception/network failure 为 0。

### 11.5 性能与稳定性

- 静态扫描按 inode 一次，记录扫描耗时和字节数；禁止每 2 秒重读整文件；
- probation candidate 数量、调用和字节有硬预算；无效候选能自动 demote；
- unknown plaintext buffer 有内存上限和 TTL，不形成无界缓存；
- Agent 目录运行中数据首次响应目标 <1 秒，历史分页目标 <2 秒（本地基线，需实测确认）；
- 对话左栏不一次加载所有历史 Conversation 正文；
- 100 个逻辑 Agent、1000 个历史实例、10000 个会话 fixture 下滚动和选择可用；
- 采集 ring、Forwarder 或 ClickHouse 承压时不阻断 Agent，并显示 drop/partial；
- Observer/AnySentry Pod 连续验收期间重启 0。

## 12. 风险、替代方案与止损条件

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 静态候选误挂到同文件其他函数 | 读取无关内存、产生噪声，严重时影响稳定性 | 只在 Agent Scope 内按小字节/小调用预算 probation；校验指针、长度、返回值、连接连续性和 framing；逐个候选晋升或降级，不因歧义拒绝整个产品 |
| 动态符号对应进程内全部 TLS，而不只 LLM | Agent 的更新检查、遥测、RAG 远端读取等可能进入临时缓冲 | egress 只做连接归因；Collector 先清除 credential header，再按 transport/schema/双向语义判断 LLM likelihood；非 LLM 与未知流量采用短 TTL、限长和分级持久化，不把 URL 白名单重新引入内核 |
| 新 runtime 或 TLS ABI 尚无 adapter | 只有 Agent 资产和 egress，暂时没有正文 | 保留 metadata-only coverage；按出现频率扩展 TLS adapter family。维护对象是 ABI/runtime，不是 Agent 版本或 provider 配置 |
| HTTP/2、WebSocket、QUIC 或压缩未完成 | 已取得明文字节但无法重组为请求/回复 | 保存流/连接级 metadata、长度、方向、时间和脱敏 fingerprint；允许 bounded `unparsed`，按真实样本补 transport adapter，不在内核丢弃 |
| 自定义网关改变 JSON/SSE 结构 | 已知模板得分不足或工具链不完整 | 进入 `ambiguous/unparsed`；用 schema fingerprint 聚类并生成脱敏 fixture，新增 template 后离线重解析，不修改 TLS attach 或 URL 规则 |
| 未知明文中包含凭据、文件或隐私正文 | 持久化范围超出对话观测目的 | Header 凭据在持久管线前强制清除；正文按大小、字段、类型、TTL 和角色权限分级；二进制只存 metadata/hash；所有 drop/redaction 可审计 |
| multiplexing、连接复用或进程/sidecar 转交 | request/response 被串线或归因到错误 Agent | 组合 PID generation、cgroup、socket cookie/fd、连接五元组、TLS object 和 stream id；无法确定时标记 `inferred/unresolved`，不伪造 exact |
| tool exec 无 exact call ID | 执行时长或结果可能误归因 | exact/strong/inferred 分级；无证据只显示模型可见的 tool_call/tool_result 时间边界 |
| discovery 预算过大 | Agent 延迟、CPU、ring/drop 或内存压力上升 | 每 PID/候选/连接设置调用、字节、并发、TTL 和退避预算；采集始终异步且不阻断 Agent，超限产生可见 coverage/drop 事实 |
| product alias 冲突 | Codex/Claude 被错误合并 | product 作为逻辑身份强分区；物理 workload 只做 relation |
| 历史 ID 迁移 | deep link 失效 | 保留旧 asset ID，服务端 alias 解析到 logicalAgentId |
| 左栏层级过深 | 搜索仍困难 | 采用 Agent 目录 + 中栏会话切换，不把会话嵌套进四层树 |

以下条件表示原有关键假设或安全边界失效，需要暂停扩大实现并重新审核：

1. probation 候选造成 Agent 崩溃、内核 verifier/安全错误，或在最小预算下仍产生不可接受的 Agent 延迟；
2. credential scrub 无法在任何正文持久化前稳定完成，或测试发现 Key/Token/认证 Header 泄漏；
3. 为获得目标正文必须从“已识别 Agent Scope”扩大为宿主机所有进程的系统级 TLS 捕获；
4. TLS 内部仍存在客户端二次端到端加密，TLS 边界只能看到不可解析密文，必须引入新的采集边界；
5. 在预算、背压和降级均启用后，ring/Forwarder/存储仍持续影响生产 Agent 或造成不可解释的数据丢失；
6. product-aware logical identity 无法可靠区分同一 workload 中不同 Agent 产品；
7. 工具关联只能依赖时间邻近，却被产品要求展示为 exact。

以下变化**不是**止损条件：CLI 小版本升级、模型名变化、官方/中转/本地 provider 切换、URL/path 前缀变化、已知模板未命中。它们必须分别由 TLS family 自动发现、通用 transport 和 `unparsed → template` 流程吸收。

## 13. 审核项

审核通过即表示同意以下决策：

1. 采用 discovery-first 分层：Agent Scope 只限定观测对象，TLS Discovery 发现明文边界，Transport Adapter 重组字节，Wire Template 识别模型语义，产品身份只在最终归因和展示阶段参与；
2. 取消 CLI 版本、整文件 fingerprint、官网域名、固定 Host/path、模型名和 provider 配置的采集门槛；这些值只能作为脱敏后的搜索、归因和诊断元数据；
3. TLS 发现按实现机制维护：动态导出符号优先，静态二进制允许有界多候选 probation，并由运行时证据晋升/降级；既有 Codex/Claude 特征只是 bootstrap 加速器，不是产品 profile；
4. Phase 0 先建立 Codex、Claude Code、Kimi Code、Dify、LangChain 的 `runtime → TLS family → transport → wire protocol` 矩阵，验证抽象后再进入连续开发；Phase 0 不要求一次完成全部 parser；
5. 首批完整链路仍以当前两类 Codex 和 Claude Code 为交付主线；Kimi Code、Dify、LangChain 本阶段至少完成 discovery 归类和一种真实 provider 路径，后续产品复用相同 adapter/template 注册机制；
6. 当前优先实现已实测 HTTP/1/SSE，同时建立 HTTP/2、WebSocket、QUIC/unknown 的统一接口和 coverage；未支持 transport 不静默丢弃，也不为某个产品临时复制 parser；
7. Wire Template 按 Responses、Chat Completions、Messages、Gemini、Kimi native、MCP 等内容结构组织，不按 Codex/Claude/Kimi/Dify/LangChain 产品组织；未知内容经脱敏、限长和 TTL 控制后进入 `unparsed`，支持后续模板离线重解析；
8. Interaction 完整性拆为 transport/wire/conversation 三层；旧错误、HTML、截断流和模板歧义不得显示 complete；
9. 新增 product-aware `logicalAgentId`，保留现有 `agentAssetId` 和 `agentInstanceId` 作为取证/运行时 ID；对话页保持三列，但左栏变为运行中/历史 Agent 目录；
10. 工具时间优先链接 eBPF exec/exit；证据不足时明确显示模型可见边界或 `inferred`，不得伪造成 exact；
11. 审核后按 Phase 0–6 连续完成开发、真实测试、不可变镜像构建和部署；若触发第 12 节止损条件，再返回设计审核。

## 附录 A：证据索引

| Evidence | 状态 | 来源 | 支持的结论 |
| --- | --- | --- | --- |
| E001 | confirmed fact | 用户本轮确认 | 新中转配置可完成真实文本与工具调用，且不得保存秘密 |
| E002 | confirmed fact | CLI/config 无泄密检查 | 三个目标的版本、provider 类型和 HTTPS 模式 |
| E003 | superseded bootstrap fact | 原 `tls-profiles.json`，现 `tls-signature-families.json` | 产品/版本/hash profile 已移除，只保留 TLS 实现族锚点、ABI 与相对关系 |
| E004 | confirmed fact | 本机/容器 ELF 有界签名扫描 | Codex 两版唯一锚点对；Claude 三版前缀与近邻关系 |
| E005 | confirmed fact | Observer attach 日志 | Codex attach、Claude 2.1.251 fingerprint 拒绝 |
| E006 | confirmed fact | tender Codex 受控工具运行与临时 uprobe | 工具成功、目标 `_ex` ABI 和 HTTP/1 POST 实际命中 |
| E007 | corrected by implementation evidence | host Codex 官方发布符号、GDB 有界分类与正式 uprobe | 官网登录 Codex 的模型链使用 Rustls + 压缩 WebSocket；MCP 等旁路仍可能使用 OpenSSL |
| E008 | confirmed fact | tender Claude 受控工具运行与临时 uprobe | tool_use/result/final 成功，BoringSSL classic/HTTP1 命中，平台缺失 |
| E009 | confirmed fact | 配置内存解析 | 两个中转模型路径带非默认前缀；未公开实际 path |
| E010 | confirmed fact | eBPF route 源码 | 当前完整 path hash 和 64 字节 request-line gate |
| E011 | confirmed fact | AnySentry 只读 API | 新 sentinel 为 0；旧错误响应可能被误标 complete |
| E012 | confirmed fact | `ConversationTrackingPage.tsx` | 左栏按 ConversationSummary 平铺 |
| E013 | confirmed fact | `agent-conversation.ts` | 无正文资产被投影成 asset-only Conversation |
| E014 | confirmed fact | Agent directory/runtime API 快照 | 运行中/历史实例已存在，当前目录行和资产 ID 膨胀 |
| E015 | supported inference | identity/directory 跨文件追踪 | alias、product、workload、root 混合可能导致跨实例/跨产品展示冲突 |
| E016 | confirmed fact | OpenAI 官方配置参考 | 自定义 provider/base URL/Responses 配置边界 |
| E017 | confirmed fact | Claude Code 官方 gateway/env 文档 | `ANTHROPIC_BASE_URL` 与 Messages gateway 边界 |
| E018 | confirmed fact | Interaction parser 与测试 | 已实现的 provider 工具语义、时间与 completeness 当前边界 |
| E019 | confirmed fact | 临时诊断清理复核 | 动态 probe、trace instance 和 TLS 临时路径均已归零 |
| E020 | confirmed fact | 用户本轮架构纠偏与目标确认 | 可观测平台应尽可能发现；版本、官网 URL 和单产品防御规则不得成为长期维护单位 |
| E021 | confirmed fact | Kimi Code、LangChain 官方文档与 Dify 官方源码 | 同一 Agent/框架可配置多种 provider、wire protocol 和自定义 base URL，产品身份不能决定解析模板 |
| E022 | confirmed fact | 本机现有 Dify/LangChain 运行时只读进程映射检查 | Dify API/Celery 与 Python LangChain 可复用动态 libssl adapter；Dify plugin 内部可能同时存在多种 runtime/TLS 路径 |

## 附录 B：现场证据清理

本轮创建的临时 uprobe、tracefs instance、bind mount、perf 文件、CLI 结构化输出和 stderr 已全部删除；复核结果：动态诊断 probe=0、临时 trace instance=0、TLS 诊断临时路径=0。真实 Key、URL、认证内容和对话正文未进入本文或 Git。[E019]

## 附录 C：实现与实机验收记录（2026-08-30）

### C.1 最终实现链

```text
已识别 Agent 进程 / 已确认 Agent workload label
  ├─ 名称与 ELF 实现族发现（启动加速，不是产品门槛）
  └─ Docker label → Forwarder 原子 cgroup 清单 → Collector 现存 PID 扫描
                                      │
                                      ▼
动态 OpenSSL/BoringSSL 符号或静态 TLS 实现族边界
  ├─ SSL_read/write(_ex)
  └─ Rustls CommonState read/write（实现族锚点 + 相对关系）
                                      │
                                      ▼
有界 Ring → 异步 Collector → Transport Adapter
  ├─ HTTP/1.1、chunked、gzip、SSE
  └─ WebSocket upgrade、mask、跨 TLS 分片、permessage-deflate context takeover
                                      │
                                      ▼
Wire Template（与 Agent 产品、URL、模型配置正交）
  ├─ OpenAI Responses / Chat Completions
  ├─ Anthropic Messages / Gemini / MCP JSON-RPC
  ├─ Responses custom_tool_call / custom_tool_call_output
  └─ generic-http-tool / unknown evidence
                                      │
                                      ▼
Interaction + 三层完整性 + 四个时间边界
  → Forwarder/WAL → AnySentry/ClickHouse
  → product-aware Agent Directory → Conversation Timeline / Inspector
```

最终运行时不检查 Codex/Claude/Kimi 的产品版本，不检查整文件或头部 hash，不要求官网
Host/path，不读取模型名决定 TLS attach，也不因自定义 base URL 拒绝正文。静态签名清单中只
保留 `implementationFamily/readAnchor/writeAnchor/ABI/writeAfterReadOffsets`；两个 Codex 发布
样本只用于证明 Rustls 锚点和 `-5248` 关系稳定，不成为运行时条件。

### C.2 关键实现纠偏

1. **Rustls WebSocket**：真实 Codex 先发送 HTTP/1.1 Upgrade，随后使用客户端 mask、服务端
   非 mask 和 permessage-deflate context takeover。Transport Adapter 支持帧跨 TLS 调用、
   context 跨 message、控制帧和硬上限。
2. **移动的 Rustls 对象**：同一连接在握手写、101 读和应用帧阶段出现不同 `CommonState`
   地址。Collector 用同 PID/cgroup 下唯一 GET/101/合法帧关系建立有界 alias；存在多个候选
   时不猜测、不合并。
3. **复合镜像**：Observer 生产镜像必须保留 Node supervisor、Forwarder、WAL、身份和控制面
   脚本。Collector artifact 与 scripts artifact 都有单独 Dockerfile；本地镜像固定 digest，
   不再用纯 Collector 镜像覆盖复合运行时。
4. **同容器多 Agent**：模板优先、精确进程根次之、workload 只拥有物理 placement。Codex、
   Claude、Pi 等即使共用一个 Docker 容器，也获得不同 logical asset/root instance；旧物理
   asset 仅作为 alias。
5. **预存 Python worker**：Forwarder 从精确 Docker Agent label 原子发布观察专用 cgroup
   清单；Collector 严格解析并每 2 秒扫描现存/新增 PID。该清单只能增加 TLS 观察，不能授予
   enforcement，也不能绕过正文预算和模板校验。
6. **深链优先级**：URL 中已有 `conversationId` 时，页面先反查所属 logical Agent，再同步
   `logicalAgentId`；API 以 conversation ID 的全局有界投影为解析基准，asset/instance/model 只做
   投影后的归属校验，避免预过滤改变 inferred conversation 的首条锚点；初始 hot-ring 不完整时
   也不会永久锁定第一个运行中 asset-only Agent。Inspector 同样先按全局唯一 interaction ID
   读取，再对新旧 asset alias 做 canonical 等价校验，避免身份归并后历史正文不可见。
7. **目录占位路径归并**：`agent://<container>`、`agent-scope:*` 和未知 workspace 是发现阶段的
   系统占位值，不是用户工作区。目录按 `canonical product + environment + product scope` 将其
   归并为一个 logical Agent，并在实例层保留容器/PID 差异；真实项目目录仍按 workspace 分组。
8. **历史读取公平性**：Conversation Directory 不再直接取全局最近 500 条 Interaction。持久层
   先按存储的 Agent asset ID 各取最近 64 条、全局最多 2,000 条，合并热增量后再按 canonical
   asset alias 执行同一上限；高频 Agent 因此不能挤掉其他 Agent 的历史会话，同时读取保持有界
   并明确返回 partial coverage。ClickHouse 先仅对 ID/asset/time 轻量索引执行 `LIMIT BY`，再按
   已选 ID 读取正文；大 payload 不参与公平排序，避免排序阶段放大内存。

### C.3 实机矩阵

| 对象 | TLS / Transport | Wire / Tool | 实测结果 |
| --- | --- | --- | --- |
| 宿主机 Codex（官方登录） | Rustls / 压缩 WebSocket | Responses + custom tool | 两轮完整：请求、回复、tool call、同 callId result、四个时间边界 |
| 容器 Codex（自定义中转） | 静态 OpenSSL `_ex` / HTTP/1.1 | Responses | 自定义 URL 正常；成功回复和额度错误重试均可见 |
| 容器 Claude Code（自定义中转） | BoringSSL classic / HTTP/1.1 | Anthropic Messages | 成功回复与 HTTP 429 错误链均可见，时间/内容完整 |
| Pi 交互 CLI | Node/OpenSSL / HTTP/1.1 | Chat Completions | 稳定交互进程请求/回复完整；短于身份建立窗口的 2 秒一次性进程不作为负结论 |
| LangChain HTTP Agent | Python/OpenSSL / HTTP/1.1 | Chat Completions tool lifecycle | 同一 asset/root 下 tool_pending → result/final 两轮，时间与 callId 对齐 |
| Dify workflow | Python/OpenSSL / HTTP/1.1 | Chat Completions + generic HTTP tool | 预存 worker 无需重启；最终上下文进入模型请求，HTTPS tool 指令/结果/时间完整 |

当前没有宣称 Kimi CLI 实机通过。Kimi 继续复用 `Agent Scope → TLS implementation family →
Transport → Wire Template` 的 Phase 0 流程；未命中的实现族/HTTP2/QUIC 保留 metadata evidence，
而不是新增产品版本或 URL 白名单。

### C.4 验收结果

- Observer：120 项 Collector 测试、核心/公共 ABI/契约测试、`clippy -D warnings`、release build、
  双版本 Rustls 实二进制扫描和仓库卫生检查通过；
- AnySentry：Agent semantic identity、Interaction、Conversation Directory、Forwarder accounting、
  supervisor、deployment manifest、TLS cgroup publication和仓库卫生检查通过；
- 浏览器：真实历史 Codex conversation deep link；1440/1024/390 px timeline/Inspector 通过，
  页面级横向溢出=false，runtime exception=0，network failure=0；
- 读取权限：Interaction/Conversation/Timeline 不需要 management token；
- 部署：AnySentry 与 Observer 均使用 registry digest，最终 Pod Ready 且重启数为 0；
- 内容安全：仓库/镜像不包含测试 Key、实际中转 URL、私有评审文稿、验证 JSON 或截图源文件。
