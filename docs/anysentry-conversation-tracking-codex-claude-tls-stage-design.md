# AnySentry 对话追踪与 Codex / Claude Code TLS 明文观测阶段设计

> 状态：已审核并完成本阶段开发；进入持续回归与镜像固化
>
> 文档版本：v1.1-implemented
>
> 日期：2026-08-29
>
> 实施分支：`feat/agent-tls-interaction-observability`
>
> 前序文档：[Agent—LLM 与外部工具明文观测 PRD](./anysentry-agent-llm-interaction-observability-prd.md)、[技术设计](./anysentry-agent-llm-interaction-observability-technical-design.md)
>
> 隐私边界：本文不记录中转 API 地址、API Key、认证文件内容、临时证书、二进制哈希和本机私有运行标识；这些信息也不得进入 Git、镜像层或应用日志。

## 0. 本阶段一句话目标

**在不使用 Agent Hook/SDK、不中断 Agent 的前提下，让 AnySentry 对 SSH、Docker 与 HTTP 服务中的 Codex、Claude Code 和 LangChain Agent 建立稳定资产归因，并从 TLS 明文边界还原可按会话阅读的模型请求、回复、工具指令与结果，最终在无需额外 management token 的“对话追踪”页面统一展示内容、时间、覆盖质量和证据链。**

### 0.1 实施结果与当前兼容边界

本节是开发完成后的事实更新；后文保留评审时的设计推演，二者冲突时以本节和实际代码为准。

| 范围 | 已验证结果 | 当前边界 |
| --- | --- | --- |
| SSH Codex 0.150.1 | `SSL_CERT_DIR` 保持 HTTPS REST 在内嵌 OpenSSL 3 `_ex` 路径；零 attach grace 下首轮工具指令、次轮工具结果与最终回复均形成 `complete` Interaction | `SSL_CERT_FILE` / `CODEX_CA_CERTIFICATE` 会强制切到 Rustls；Responses WebSocket/Rustls 仍明确标为不支持，不宣称正文完整 |
| Docker Codex 0.149.1 | 精确整文件 profile + OpenSSL `_ex` 双向明文验证通过 | 仅承诺已登记的整文件指纹与指令前缀 |
| Claude Code 2.1.170 / 2.1.245 | BoringSSL classic 读写 profile 验证通过；零 attach grace 下首轮 Bash 指令、工具结果与最终回复均完整 | 新版本必须新增 profile，未知指纹失败关闭 |
| LangChain HTTP 服务 | Docker 常驻 Python 服务通过全局 libssl 符号预挂载，从第一次 `/invoke` 还原两次模型调用、`lookup_fixture`、结果与最终回复 | 外部中转曾返回 `deployment_disabled`；最终验收使用等价本地 HTTPS Chat Completions fixture，避免把外部配额当产品故障 |
| 资产归因 | 同一 Docker 容器内按“物理 workload + 精确 Agent root scope”拆分 Codex、Claude、LangChain 等逻辑资产；同产品重启保持逻辑资产、Runtime instance 独立 | 旧数据保留旧 canonical ID，不离线重写历史证据 |
| 冷启动 | 精确静态 CLI profile 和标准 libssl 可按 inode 全局预挂载；采集仍需实时 verified PID + 精确 LLM 路由，关闭首请求竞态 | 生产部署需通过 `A3S_OBSERVER_TLS_STATIC_TARGETS` 提供可验证的二进制/库路径 |
| 会话组织 | provider ID 优先；Responses previous-response 链、tool call ID、消息前缀和空闲窗口分级推断；常驻 HTTP 服务的容器 ID 不再误作业务会话 | 推断会话始终显示 `inferred`，不会伪装成框架原生 session |
| 前端与权限 | `/conversations` 三栏时间线/Inspector 已实现；读取 Interaction、Conversation、Timeline 不需要额外 management token，保留读取审计 | 平台外围访问控制仍由部署环境负责；本改动不绕过平台入口权限 |

最终验证包括：Codex/Claude 零 grace TLS 工具循环、LangChain 两模型调用工具循环、API 无 token 读取、桌面/平板/手机浏览器 View、原始/结构化/证据 Inspector、无横向溢出、无浏览器运行时与网络错误。

## 1. 结论与设计决策

### 1.1 总体判断

评审阶段的问题不是单一的前端缺页，也不是“Codex 没有被发现”，而是三段链路没有同时闭合：

1. **身份链路**：SSH Codex 根进程已经进入 `probable_agent` 资产，但它的网络运行时子进程没有被正确纳入受信运行时图；
2. **采集链路**：当前 TLS profile 只覆盖少数精确版本和 ABI，测试容器中的 Codex、Claude Code 版本均未命中；Codex 的网络子运行时还呈现 Rustls 特征，不能复用 OpenSSL/BoringSSL ABI；
3. **产品链路**：现有 `/conversations` 页面为空，真实 Interaction 组件仍嵌在单个 Agent 实例详情中，并且查询接口要求 management token；现有扁平 exchange 数据也不足以直接表达一次会话中的 turn、retry 和跨 interaction 工具结果。

实施继续沿用已经审核通过的“Agent 身份准入 + TLS/HTTP 明文边界 + HTTP/provider 语义解析”路线，没有增加 SDK、框架 callback 或生产 MITM。通用性通过“**按 TLS 实现族建设 transport adapter，按精确二进制建设 profile，按 provider 协议建设 parser**”获得，而不是对每个 Agent 写一套互不相干的抓取代码。

### 1.2 评审时事实、工程解释与待验证假设

以下表格保留方案评审时的现场基线，便于审计“为什么这样设计”；已完成后的现状见 0.1。

| 类型 | 结论 | 证据或后续验证 |
| --- | --- | --- |
| 已确认事实 | `/conversations` 路由和侧栏入口已经存在，但页面主体为空 | `ConversationTrackingPage.tsx` 只有标题和空 `main` |
| 已确认事实 | 当前交互列表只在 Agent 详情页中展示，并按 `agentAssetId + agentInstanceId` 精确过滤 | `AgentsPage.tsx` 中 `AgentInteractionTrace` |
| 已确认事实 | `/security-center/agents/interactions` 当前带 `@RequireManagementAuth()` | API controller 实现 |
| 已确认事实 | SSH 中运行的 Codex 已形成 `probable_agent` 资产和行为事件，但没有 Codex/Claude Interaction | 当前部署数据与 Observer attach 日志 |
| 已确认事实 | 当前“TLS attach 成功”同时决定进程能否进入 plaintext allow map | `TlsAttachManager::mark_attached` 与 `PLAINTEXT_AGENT_PROCESSES` |
| 已确认事实 | Collector 每 2 秒扫描一次 TLS attach；普通 Codex/Claude 子进程目前被主动排除，以避免工具子进程扩大 attach 面 | Observer collector 实现 |
| 已确认事实 | 测试容器中的 Codex CLI 与 Claude Code 都是静态、strip 后的独立二进制，未导出可直接挂载的 OpenSSL 动态符号 | 容器内 ELF、符号和字符串检查 |
| 已确认事实 | 测试容器 Codex 呈现 Rustls 特征；Claude Code 呈现 BoringSSL 特征；现有精确 profile 与它们的版本不匹配 | 二进制与 profile 检查，日志为 `unsupported_binary_fingerprint` |
| 已确认事实 | 现有中转服务的 Responses、Messages 流式与非流式最小请求可成功；Claude Code 在临时进程级配置后可完整返回 | 受控网络验证；具体地址和认证信息未留存 |
| 已确认事实 | Codex CLI 的完整请求仍会在流结束前重试或超时 | 受控 `codex exec` 验证 |
| 强假设，待证实 | `codex-code-mode-host` 是当前 SSH Codex 的实际网络运行时，根 Codex 本身只承担编排 | 子进程关系、二进制特征和 attach 拒绝日志支持；需用 socket owner 与明文 probe 同时确认 |
| 假设，待证实 | Codex 完整请求失败来自中转对复杂 Responses/SSE 序列或终止语义的兼容差异，而非基础网络不可达 | 最小流式调用成功、CLI 调用失败；需用只记录协议元数据的测试 TLS front 定位 |

当前需要纳入本阶段精确验证的运行版本如下。版本是 profile 的公开兼容边界，不属于私密配置：

| 环境 | 当前版本 | 当前观测结论 |
| --- | --- | --- |
| SSH Codex | Codex CLI 0.150.1 | 根进程资产已识别；已有根二进制 profile 能 attach，但疑似实际网络子运行时未覆盖 |
| `tender_jang` Codex | Codex CLI 0.149.1 | Agent signature 可识别；静态 Rustls 特征，当前 profile 拒绝 |
| `tender_jang` Claude | Claude Code 2.1.245 | 临时网络配置可完成 Messages 调用；静态 BoringSSL 当前 profile 拒绝 |
| `tender_jang` Pi | 容器内现有版本 | 已能看到进程、对话和工具，作为回归基线 |
| `tender_jang` Python | Python 3.11.2 | 用于新增 LangChain + OpenSSL fixture |

### 1.3 本阶段固定决策

- 不使用 Agent Hook、SDK、LangChain callback、Claude hooks 或 Codex 内部插件作为正文来源；
- 不从 HTTPS egress 密文事后恢复正文；正文仍在 Agent 进程加密前、解密后的 TLS API/运行时边界复制；
- egress、DNS、SNI 和 socket owner 用于身份、目标与 coverage 证据，不把它们当正文来源；
- 读取对话不再要求额外 management token，但保留平台原有访问边界与内容读取审计；
- Agent 详情页只保留“最近对话摘要”，完整阅读、搜索和诊断统一进入 `/conversations`；
- 本阶段实现并实测固定版本 Codex、Claude Code 与 LangChain fixture；不宣称已经通用支持所有 Rustls/BoringSSL 版本；
- 本阶段以 HTTPS + HTTP/1.1 + JSON/SSE 为验收主路径。HTTP/2、WebSocket 和 QUIC 若被协商，必须明确显示不支持，不能伪装为完整正文。

## 2. 当前链路与偏差位置

### 2.1 当前实际链路

```text
exec / fork / egress
        |
        v
Agent 身份聚合 --------------------------------------+
        |                                            |
        | probable / confirmed                       | Agent 资产页行为事件
        v                                            v
TlsAttachManager --每 2 秒扫描--> 精确二进制/profile 匹配
        |
        | attach 成功后才写入 plaintext PID map
        v
TLS uprobe 或 plain HTTP syscall
        |
        v
HTTP/1.1 + SSE + provider parser
        |
        v
Interaction NDJSON -> Forwarder -> API -> Hot Ring / ClickHouse
                                              |
                                              v
                         Agent 详情页中的扁平 Interaction 列表

当前断点：
  A. 受信 Agent 子运行时未进入解析候选
  B. 目标版本 profile 不命中，或 ABI 不受支持
  C. /conversations 没有产品实现
  D. Interaction 内容接口需要 management token
  E. exchange 缺少 conversation / turn / attempt 组织字段
```

### 2.2 为什么“能看到进程”仍然“看不到对话”

Agent 资产识别和 TLS 明文观测是两条相关但不同的证据链：

- 资产识别只需证明“该进程/容器表现为 Codex、Claude、Pi、Dify 等 Agent Runtime”；
- 明文观测还要证明“哪个运行时真正持有模型连接”“它使用哪种 TLS 库和 ABI”“profile 是否精确命中”“请求是否为准入模型路径和合法 provider body”。

因此，SSH Codex 当前更准确的状态应是：

```text
Agent 资产：已识别（probable_agent）
行为事件：有
对话覆盖：asset_only / unsupported_tls_profile
失败原因：网络运行时角色和 Rustls profile 尚未完成
```

前端必须直接展示这一状态，而不是把空列表解释成“没有发生对话”。

### 2.3 TLS 观测与工具调用的关系

Codex、Claude Code 的本地 shell、文件读写等工具本身未必经过网络，但它们的**调用指令**通常由模型响应中的 function/tool call 下发，**工具结果**通常被 Agent 放入下一次模型请求。因此，即使不 Hook Agent 框架，TLS 请求/响应仍可还原：

```text
LLM response: tool_call(name, arguments, call_id)
        |
        | Agent 在本地执行；eBPF 行为链可提供进程/文件证据
        v
next LLM request: tool_result(call_id, content)
```

这里可精确得到的是“指令被模型返回的时间”和“结果重新进入模型请求的时间”。二者之差应标为**可见边界耗时**，不是框架内部真实执行时长。只有显式外部 HTTP 工具的 request/response 都被捕获时，才能展示更接近网络调用的请求—响应耗时。

## 3. “对话追踪”前端产品与交互设计

### 3.1 用户目标和信息优先级

主要用户是平台运维、安全分析和 Agent 资产运营人员。页面首先回答四个问题：

1. 哪个 Agent 在什么环境中进行了这次会话；
2. 用户/系统最终给模型发送了什么，模型实际返回了什么；
3. 模型按什么顺序调用了哪些工具，参数、结果和异常是什么；
4. 内容为什么完整、为什么缺失，以及可以去哪里查看底层证据。

信息层级按以下顺序组织：

```text
会话选择 > 对话与工具时间线 > 当前事件正文 > 采集/归因证据 > 原始协议细节
```

原始 JSON、hash、connection ID、PID 等不应抢占主阅读区，但必须可在 Inspector 中核验。

### 3.2 页面对象模型

页面不再把“一次 HTTP exchange”等同于“一次对话”。界面使用四层对象：

| 层级 | 用户含义 | 数据来源 |
| --- | --- | --- |
| Agent Asset | 一个 Codex、Claude、Dify、Pi、LangChain 等智能体资产 | 现有 Agent inventory |
| Conversation / Session | 一次连续任务或会话；无 provider session ID 时允许推断 | 显式 ID，或 asset + workspace + process root + idle window |
| Turn | 一轮用户输入、模型调用、工具循环和最终回复 | provider item/tool ID + 时间顺序 |
| Interaction / Evidence | 一次模型/外部工具 transport exchange 和底层证据 | 现有 Interaction、event、egress、exec/file evidence |

推断得到的 Conversation 必须带 `inferred` 标签和质量说明，不能伪装成框架原生 session ID。

### 3.3 桌面布局

推荐采用“会话列表—对话时间线—证据检查器”三栏连续工作区。它符合运维人员从发现异常、阅读上下文到下钻证据的顺序，也避免在多个页面间来回跳转。

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 对话追踪  [时间: 近24h⌄] [Agent/产品⌄] [覆盖状态⌄] [模型⌄] [搜索内容或工具]      [● 实时跟随] [刷新] │
├────────────────────────────┬────────────────────────────────────────────┬────────────────────────────┤
│ 会话 / Agent 资产           │ 对话时间线                                  │ 事件检查器                  │
│ 320px                       │ min 520px                                  │ 380–440px                   │
│                            │                                            │                            │
│ [全部 26] [有正文 18]       │ Codex · workspace-a                        │ MODEL REQUEST              │
│ [仅资产 5] [异常 3]         │ probable · inferred session · active       │ 14:32:10.120               │
│                            │ 4 turns · 7 model calls · 3 tools          │                            │
│ ● Codex  完整               │ ────────────────────────────────────────── │ [结构化] [原始] [证据]     │
│   “分析这个仓库……”          │ ① USER → LLM                  14:32:10     │                            │
│   4轮 / 3工具 / 2分钟前      │   分析这个仓库并定位……                     │ Final messages             │
│                            │   [查看完整发送上下文]                       │ system …                   │
│ ◐ Claude  部分              │                                            │ user …                     │
│   “修复测试……”             │ ② LLM → AGENT               +1.42s        │                            │
│   2轮 / attach 后开始        │   我先查看目录结构。                         │ model / endpoint / status  │
│                            │                                            │ request bytes / sha256     │
│ ⚠ Codex  仅资产             │ ③ TOOL CALL · exec_command   14:32:11     │ request complete           │
│   未获得正文                │   { cmd: "rg --files" }                    │ first response / end       │
│   Rustls profile 不支持      │   ↳ 进程证据  ↳ 文件证据                    │ capture / correlation      │
│                            │                                            │                            │
│ ● Dify   完整               │ ④ TOOL RESULT               +86ms         │ [复制正文] [复制 hash]      │
│   workflow / 多实例          │   exit 0 · 132 files                         │ [查看原始事件]             │
│                            │   “可见边界耗时”；非框架精确执行时长         │                            │
│ [加载更早会话]              │                                            │                            │
└────────────────────────────┴────────────────────────────────────────────┴────────────────────────────┘
```

#### 顶部工具栏

- 时间范围沿用现有安全中心时间模型；
- Agent 筛选同时支持产品、资产 ID、classification 和运行环境；
- coverage 是一等筛选项，便于立即找到“资产有、正文无”的问题；
- 内容搜索只把关键词送入 POST body，不写进 URL、浏览器标题或前端持久化存储；
- “实时跟随”只在用户位于最新会话且未向上滚动时自动追加；用户阅读历史内容时不得抢夺滚动位置。

#### 左栏：会话与资产

左栏必须同时包含“有 Conversation 的 Agent”和“已经识别但没有正文的 Agent”。每行优先展示：

- 产品图标/名称、Agent classification、环境（host/container/service）；
- 最近一次用户输入或会话目标摘要；无正文时显示 coverage 原因；
- 最近活动时间、turn/model/tool/error 计数；
- coverage 状态点：完整、部分、等待 attach、不支持协议、不支持 profile、仅资产；
- Dify 等跨实例 Agent 默认按 asset 聚合，实例只作为二级筛选和证据字段。

默认选择当前筛选下最新活动的会话；如果最新项只有资产证据，中栏展示诊断状态，不自动跳到其他 Agent，避免用户误以为所选 Agent 有正文。

#### 中栏：Agent 视角时间线

中栏是页面核心，按用户可理解的顺序交错展示以下事件：

| 事件 | 默认展示 | 展开后 |
| --- | --- | --- |
| `USER_TO_LLM` | 本轮新增 user/developer 内容摘要、发送时间 | 模型实际收到的完整 messages/input |
| `LLM_TO_AGENT` | 聚合后的可见回复、首响应和结束耗时 | SSE event、usage、finish/stop reason |
| `TOOL_CALL` | 工具名、关键参数、模型指令时间 | 完整 arguments、toolCallId、来源 response |
| `TOOL_RESULT` | 成功/失败、结果摘要、结果可见时间 | 完整 result、来源 request、关联行为证据 |
| `EXTERNAL_TOOL` | method/path/status/网络边界耗时 | request/response body 与 endpoint 证据 |
| `RETRY/ERROR` | attempt 编号、错误、退避时间 | 对应 transport、partial reason、原始错误 |

模型请求经常重复携带完整历史。为了让运维人员看到“这一轮发生了什么”，中栏默认显示相对上一请求新增的 message/item；Inspector 始终可查看本次真正发送的完整原始 body。差异视图只是展示层派生结果，不能替代原始证据。

同一次逻辑模型调用的 retry 应折叠为 `Attempt 1/2/3`，不能在主时间线上伪装成三轮用户对话。tool call 和 tool result 以 provider `call_id/tool_use_id` 优先关联；没有稳定 ID 时只做弱时间关联，并显示 `inferred`。

#### 右栏：事件检查器

Inspector 只显示当前时间线事件，分为三个页签：

1. **结构化**：messages/input/content block、tool 参数和结果、模型、usage；
2. **原始**：实际 request/response body、encoding、bytes、SHA-256、完整性；
3. **证据**：Agent asset/instance、runtime role、PID/cgroup、connection、capture source、归因质量、egress/exec/file 原始事件链接。

Authorization、Cookie、代理认证和 API Key 不进入 Interaction schema，因此 Inspector 也不得展示。多模态内容按“模型实际收到的表示”展示：

- URL/file ID：显示引用、类型和 hash，不自动联网下载；
- inline base64/data URI：默认只显示 MIME、大小和 hash，用户主动展开后才本地预览；
- 超出正文上限：显示 `truncated/reference_only`，不得制造完整预览。

### 3.4 Coverage 与诊断状态

coverage 不能只有 `complete/partial`，需要区分导致“无对话”的节点：

| 状态 | 用户文案 | 诊断动作 |
| --- | --- | --- |
| `complete` | 已获得完整请求、响应与时间 | 可查看正文和证据 |
| `partial` | 已获得部分正文 | 显示缺片、超限、断流或存储原因 |
| `attach_pending` | Agent 已识别，正在匹配 TLS 运行时 | 显示发现时间、扫描/attach 状态 |
| `unsupported_tls_profile` | 当前二进制版本未通过 TLS profile 验证 | 显示产品版本、TLS family，不显示私有 hash |
| `unsupported_protocol` | 已观察连接，但协议为 H2/WS/QUIC 等当前不支持类型 | 显示协议和后续能力边界 |
| `no_final_response` | 已发送请求，但响应未正常结束 | 展示 retry、timeout、partial body |
| `asset_only` | 只有 Agent/行为证据，尚无正文证据 | 链接 Agent 行为链和 egress |
| `no_activity` | 时间范围内没有模型调用证据 | 建议扩大时间范围，不暗示故障 |

空状态必须回答“没有什么”和“为什么”，例如：

```text
Codex 资产已识别，但当前版本的 Rustls 网络运行时尚未命中已验证 profile。
最近一次相关 egress：14:32:09；TLS attach：unsupported_binary_fingerprint。
[查看 Agent 行为] [查看覆盖证据]
```

### 3.5 页面跳转与 URL 状态

```text
Agent 资产页 ──“查看全部对话”──> /conversations?agentAssetId=...
事件时间线 ──“查看所属对话”────> /conversations?...&interactionId=...
工具证据 ──“定位工具调用”──────> /conversations?...&turnId=...&eventId=...
对话列表 ──选择会话────────────> URL 替换 conversationId，不新增历史栈
用户主动打开另一会话───────────> 新增历史栈，浏览器返回恢复筛选/滚动/选中项
```

URL 只保存稳定 ID 和非敏感筛选，不保存 prompt、response、tool arguments、API 地址或搜索关键字。建议参数：

- `agentAssetId`
- `conversationId`
- `turnId`
- `interactionId`
- `timeType/startTime/endTime`
- `product/classification/coverage`

Agent 详情页原 `AgentInteractionTrace` 改成最近 3 个会话的紧凑摘要和“进入对话追踪”按钮，避免维护两套完整阅读体验。

### 3.6 响应式、可访问性与性能

- ≥ 1280 px：固定三栏；允许 Inspector 折叠；
- 768–1279 px：会话列表 + 时间线两栏，Inspector 使用右侧 Drawer；
- < 768 px：会话列表 → 时间线 → 全屏 Inspector 三级导航，不做嵌套横向滚动；
- 所有交互目标至少 44 px；键盘支持上下选择会话、Enter 打开、Escape 关闭 Inspector；
- 使用 `aria-current`、可见 focus ring、文本+图标共同表示 coverage，不能只靠颜色；
- 请求超过 300 ms 展示保持布局的 skeleton；错误状态保留筛选和已加载数据；
- 会话/时间线超过 50 项开始虚拟化或增量加载；使用稳定 event ID 作为 React key；
- 复制正文/hash 后提供可读反馈；遵循 `prefers-reduced-motion`；
- 延续 AnySentry 当前深色连续画布、语义 token、Lucide 图标和字体层级，不引入另一套品牌色或 HUD 风格。

## 4. 后端与 Observer 开发方案

### 4.1 目标链路

```text
                        ┌──────────── 身份证据链 ────────────┐
exec/fork/cgroup/argv -> Agent Asset -> Runtime Graph         |
                                      ├─ agent_root           |
                                      ├─ network_runtime      |
                                      └─ tool_runtime         |
                                                |              |
                                                v              |
                                     Verified Process Map <────┘
                                                |
                           ┌────────────────────┴──────────────────┐
                           v                                       v
                 Plain HTTP syscall lane                 TLS Attach Resolver
                                                           | family/profile
                                                           v
                                            OpenSSL / BoringSSL / Rustls adapter
                           └────────────────────┬──────────────────┘
                                                v
                                  bounded plaintext fragments
                                                |
                                      HTTP framing / SSE
                                                |
                     Responses / Messages / Chat parser + route/semantic gate
                                                |
                  conversation / turn / attempt / tool correlation + coverage
                                                |
                         Forwarder -> API -> ClickHouse/Hot Ring
                                                |
                                      /conversations UI
```

采集依旧异步、非阻断：probe 只做有界 map lookup、copy 与 ring submit；ring 满、解析失败或存储不可用只产生 drop/partial/coverage，不回压 Agent 请求。

### 4.2 拆分身份准入与 TLS attach 状态

当前实现把“TLS attach 成功”和“允许 plain HTTP capture”绑定在同一 `plaintext_pids` 集合中。这会导致不支持 TLS profile 的 Agent 连 plain HTTP 路径也无法被观测。本阶段拆成两个状态：

```text
VERIFIED_AGENT_PROCESSES
  含义：该 PID/cgroup 已由 Agent 身份链验证，可进入准入 HTTP 路径检查

TLS_ATTACHED_SESSIONS / TLS_ATTACHED_PROCESSES
  含义：某个精确 TLS family/profile 已成功 attach，可接收 TLS 明文
```

两个集合都必须继续使用 host PID + cgroup identity，处理容器 PID namespace 和 PID reuse。HTTP lane 只依赖已验证身份；TLS lane 还必须有成功 attach。这样不会为了“支持 HTTP”放宽未知进程的 TLS attach。

### 4.3 建立受信 Runtime Graph，而不是放开全部子进程

普通工具子进程（shell、git、python 脚本）不能因为是 Codex/Claude 的后代就自动获得明文资格。本阶段只增加角色化的受信子运行时：

| 角色 | 例子 | 允许能力 |
| --- | --- | --- |
| `agent_root` | `codex`、`claude`、Pi 主进程、LangChain service | 资产根与 model route 候选 |
| `network_runtime` | 经精确验证的 Codex code-mode host、Dify provider worker | TLS/HTTP attach 候选，可归因回根资产 |
| `tool_runtime` | shell、git、用户脚本、MCP 工具进程 | 只保留行为链；默认不得读取 TLS 正文 |

`network_runtime` 必须同时满足：

1. 是已识别根进程的直接或可证明后代；
2. 位于相同 cgroup/container/workspace 信任边界；
3. 命中精确产品 runtime signature 和二进制 profile；
4. 其 socket/egress 与模型 endpoint 证据相符；
5. 进程退出或身份变化后及时撤销 map 状态。

这条规则解决 Codex 辅助网络进程问题，同时不把 Agent 调用的任意工具提升为正文采集目标。

### 4.4 从定时扫描升级为 exec 驱动，保留扫描兜底

2 秒扫描可能错过 CLI 启动后的第一个短请求。本阶段使用已有 exec/fork 生命周期事件触发候选解析：

```text
exec commit -> identity candidate -> runtime role resolve -> profile resolve -> attach
                                                        |
                                               2 秒扫描仅作漏事件兜底
```

验收要求是 Collector 已运行时，受支持 CLI 启动后的第一轮模型请求能进入捕获窗口。attach 失败必须留下结构化原因：`unsupported_product_version`、`unsupported_tls_family`、`profile_mismatch`、`attach_failed`、`protocol_unsupported`，供 coverage API 使用。

### 4.5 按 TLS 实现族建设 adapter

| Adapter | 明文位置 | 当前复用程度 | 本阶段工作 |
| --- | --- | --- | --- |
| 动态 OpenSSL | `SSL_write/read(_ex)` | Node/Python/Pi/LangChain 已有 | 回归，不改变核心 ABI |
| 静态 BoringSSL | 内嵌 `SSL_write/read(_ex)` 精确偏移 | Claude 旧版本已有 | 为测试版本生成、验证和加入精确 profile |
| 静态 OpenSSL | 内嵌 C ABI 精确偏移 | Codex REST 旧 profile 已有 | 保留，按实际二进制决定是否使用 |
| Rustls | plaintext writer/read buffer 边界；不是 `read_tls/write_tls` 的密文边界 | 当前未实现通用 adapter | 为 Codex 实际网络 runtime 新增独立 ABI、profile 与 probe |
| Plain HTTP | socket read/write/send/recv 上的 HTTP 明文 | 已有 | 改为依赖 verified Agent map，不依赖 TLS attach 成功 |

Rustls 不能套用 `SSL_write` 参数约定。`read_tls/write_tls` 处理的通常是 TLS record 密文，真正的应用明文需要在版本对应的 writer/write 与解密后 reader/read 边界确认。由于 Rust ABI、泛型单态化和 strip 后偏移随构建变化，本阶段只对受控二进制做以下闭环：

1. 对实际 socket owner 定位 TLS family；
2. 用反汇编、调用关系和受控唯一 sentinel 请求生成候选函数；
3. 同时验证写入明文、读取明文、方向、长度和 connection/session 关联；
4. 固化版本、架构、整文件 hash、大小、函数前缀和偏移；
5. 用正确 fixture、错误 hash、相邻版本和非 Agent 二进制做正负验证；
6. 任一条件不符即 fail closed，不盲猜 offset。

profile 仍放在 Observer 的版本化 JSON 中，由受控镜像发布；本阶段不引入远程热更新。这样保持实现简单，也避免未经审核的 profile 在运行时扩大正文读取范围。

### 4.6 HTTP、SSE 与 provider parser

本阶段继续以“最终传输 body”为权威内容，完善以下协议事件：

- OpenAI Responses：`input`、`response.output_item.*`、`response.content_part.*`、text delta、function call arguments、function call output、`response.completed/failed/incomplete`；
- Anthropic Messages：`message_start`、`content_block_start/delta/stop`、`tool_use`、后续 `tool_result`、`message_delta/stop`；
- Chat Completions/LangChain：messages、stream delta、`tool_calls`、后续 `role=tool` 结果；
- retry：同一逻辑 call 的多个 attempt、错误和终止原因；
- 多模态：保留最终 URL/file ID/inline 表示，不额外读取 Agent 内部文件或联网下载引用。

route gate 和 body semantic gate 继续存在。不能因为某个 PID 是 Codex 就捕获它的全部 TLS 数据；只有 POST + 精确模型路径 + provider 请求结构，或运维显式准入的外部工具路径，正文才进入 Interaction。

HTTP/2、WebSocket 和 QUIC 在本阶段不做重组。测试 TLS front 只宣告 HTTP/1.1 ALPN；如果真实环境不可降级而协商其他协议，coverage 必须返回 `unsupported_protocol`。

### 4.7 Codex 网络与测试路径

官方 Codex 配置支持自定义 `model_providers.<id>.base_url`、`wire_api="responses"`、`supports_websockets=false` 和 provider 认证环境变量；用户级配置位于 `~/.codex/config.toml`。[OpenAI Codex 配置参考](https://developers.openai.com/codex/config-reference/)

本阶段测试不改写并提交现有配置，而是使用临时、进程级或专用 test profile：

```text
Codex CLI
  -> HTTPS test front（本地临时 CA，HTTP/1.1 only）
  -> 通过已允许的 VPN 路径访问现有中转
  -> Responses/SSE
```

test front 只记录诊断元数据：method/path、HTTP status、content type、transfer encoding、SSE event type 顺序/数量、首尾时间和终止事件。它不得记录 Authorization、request/response body、API Key。当前 Codex 的流终止问题先由这些证据定位；只有证明是中转的 SSE 兼容差异后，才增加最小、可测试的协议归一化，不能凭猜测修改正文。

测试 TLS front 不是生产 MITM：它只是让当前 HTTP 中转具备一个可控的 HTTPS/HTTP1 实验入口，Observer 的验收证据仍来自 Codex 客户端进程加密前/解密后的 TLS 边界。

### 4.8 Claude Code 网络与测试路径

Claude Code 官方支持 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`、`NODE_EXTRA_CA_CERTS` 和 `ANTHROPIC_BASE_URL`，并在进程启动时读取这些配置。[企业网络配置](https://code.claude.com/docs/en/corporate-proxy)、[LLM Gateway 配置](https://code.claude.com/docs/en/llm-gateway)

测试采用临时环境变量和运行时证书信任，不把配置写进仓库。Messages 最小调用已确认可用；开发重点是：

- 为目标 Claude Code 版本生成并验证 BoringSSL exact profile；
- 确认短生命周期 CLI 在首请求前完成身份与 attach；
- 解析 `tool_use -> tool_result -> final text`；
- 通过错误 profile 和普通 Node 进程验证不会越权 attach。

### 4.9 LangChain HTTP 服务 fixture

在 `tender_jang` 中运行一个最小 LangChain 服务，绑定 `0.0.0.0:18082`，宿主机通过容器 bridge IP 访问；现有容器无需重建或提交为包含私密配置的新镜像。服务包含：

- `GET /health`：仅返回进程就绪状态；
- `POST /invoke`：接受一段用户文本并运行一次 Agent；
- 一个确定性工具，例如 `lookup_fixture` 或 calculator；
- `ChatOpenAI` 指向同一临时 HTTPS test front；认证只从运行时环境读取；
- 返回最终回答和 test run ID，不返回 provider credential。

LangChain 的标准 `create_agent` 会在模型产生 tool call 后执行工具，再把 tool result 交回模型，适合验证完整循环。[LangChain Agents](https://docs.langchain.com/oss/python/langchain/agents)、[Models 与自定义 base URL](https://docs.langchain.com/oss/python/langchain/models)

为暴露 HTTP 服务，fixture 需要固定版本的 `langchain`、`langchain-openai`、`fastapi` 和 `uvicorn`。前两者提供待测 Agent/模型客户端，后两者只提供最小 HTTP 入口；依赖会单独固定在 lab requirements 中，不混入 AnySentry 生产依赖。

该场景需要同时验收两条链：

```text
宿主机 POST /invoke -> 识别 Python LangChain Agent 资产
                               |
                               v
                    LangChain -> HTTPS -> LLM
                               |
                               v
          user -> model -> tool call -> tool result -> final model response
```

## 5. 会话数据模型与 API

### 5.1 保留 Interaction，新增会话组织字段

现有 `AgentInteractionRecord` 仍是 transport 证据，不应被 UI 会话模型替换。建议以可选字段向后兼容扩展：

```ts
interface AgentInteractionRecord {
  // existing transport evidence ...
  conversationId?: string;
  conversationIdSource?: "provider" | "runtime" | "inferred";
  turnId?: string;
  modelCallId?: string;
  attemptId?: string;
  providerResponseId?: string;
  parentInteractionId?: string;
  runtimeRole?: "agent_root" | "network_runtime" | "tool_runtime";
  correlationQuality?: "exact" | "strong" | "inferred" | "unlinked";
}
```

无显式 conversation ID 时，服务端可使用 `agentAssetId + workspace + process root + bounded idle gap` 生成稳定推断 ID。Dify 等共享 worker 场景如果 workspace/tenant 证据不足，宁可分成未链接 interaction，也不能按时间邻近伪造 workflow 归因。

### 5.2 新增读模型

```ts
interface AgentConversationSummary {
  conversationId: string;
  idSource: "provider" | "runtime" | "inferred";
  agentAssetId: string;
  agentInstanceIds: string[];
  product: string;
  environment: "host" | "container" | "service";
  classification: "probable_agent" | "confirmed_agent";
  workspace?: string;
  startedAtUnixNs?: string;
  lastActivityAtUnixNs?: string;
  firstPromptPreview?: string;
  turnCount: number;
  modelCallCount: number;
  toolCallCount: number;
  errorCount: number;
  coverage: ConversationCoverage;
}

interface AgentConversationEvent {
  eventId: string;
  kind: "user_to_llm" | "llm_to_agent" | "tool_call" |
        "tool_result" | "external_tool" | "retry" | "error";
  sequence: number;
  atUnixNs: string;
  turnId?: string;
  attemptId?: string;
  interactionId?: string;
  parentEventId?: string;
  correlationQuality: "exact" | "strong" | "inferred" | "unlinked";
  summary: unknown;
  contentRef?: string;
}
```

会话列表接口不加载完整 raw body，避免首页读取大量重复上下文；用户选中时间线事件后再查询 Interaction 内容。

### 5.3 API 设计

沿用项目现有 POST query 风格：

| API | 用途 | 是否返回原文 |
| --- | --- | --- |
| `POST /security-center/agents/conversations` | Agent + session 摘要、coverage、分页 | 只含受限 preview |
| `POST /security-center/agents/conversations/timeline` | 指定会话的 turn/tool/retry 时间线 | 结构化摘要，不含完整 raw body |
| `POST /security-center/agents/interactions` | Inspector 读取单个或少量 Interaction | 是 |
| 现有 event/tool evidence API | 下钻行为和内核证据 | 按现有模型 |

所有读取接口不再要求 management token。原文查询继续写入 `agent.interaction.content.read` 审计；会话时间线读取增加 `agent.conversation.content.read` 审计。审计只保存 actor、asset/conversation/interaction ID、数量和时间，不保存正文或搜索词。

去掉二次 token 不等于把内容公开到公网：本阶段只取消观测平台内部的 management token 门槛，不改动平台入口、部署网络边界和未来统一账号权限。前端不得把正文放入 localStorage、analytics、错误上报或 URL。

### 5.4 存储与查询

- ClickHouse 在 Interaction 表增加低基数字段和用于过滤/排序的会话列，原始 body 继续只存一份；
- 会话聚合必须先按筛选/group 计算，再应用 limit，不能先取 100 条 exchange 后在前端猜 session；
- Hot Ring 与 ClickHouse 合并时以稳定 Interaction/Event ID 去重；
- session rail 只取 preview 和计数，避免重复加载长上下文；
- payload 超限、ClickHouse 不可用或 ring 覆盖时返回明确 coverage，不悄悄显示为空。

OpenTelemetry 的 GenAI 语义约定已定义 conversation ID、input/output messages、tool call ID/arguments/result 和 `execute_tool` 等概念，本阶段字段命名尽量与这些语义对应，但不把尚未采到的框架字段伪造出来。[OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

## 6. 开发顺序与代码范围

审核通过后按以下顺序连续完成；只有关键假设被现场证据推翻时才暂停扩大实现范围。

### Phase 1：建立可复现、无泄密的 TLS 测试链

1. 在容器运行时目录生成临时 CA/证书，配置系统/进程信任；不写入仓库和镜像；
2. 启动 HTTPS、HTTP/1.1-only test front，经现有 VPN 访问中转；
3. 只记录协议元数据，定位 Codex CLI 的 Responses/SSE 终止问题；
4. 用临时环境和专用 test config 运行 Codex/Claude；
5. 固化可重复的 text、tool call、stream、retry fixture，fixture 不含真实密钥和私有 URL。

### Phase 2：修复身份与 attach 链

1. 拆分 verified Agent map 与 TLS attached 状态；
2. 增加 `agent_root/network_runtime/tool_runtime` 角色和受信子运行时规则；
3. exec 事件触发 attach，2 秒扫描保留为兜底；
4. 确认 Codex 实际 socket owner；
5. 为目标 Claude BoringSSL、Codex Rustls/实际 TLS family 增加精确 profile 和 adapter；
6. 结构化输出 coverage/attach failure，不记录正文或凭据。

Observer 主要修改范围预计为：

- `a3s-observer-collector/src/tls_attach.rs`
- `a3s-observer-collector/src/tls-profiles.json`
- `a3s-observer-collector/src/main.rs`
- `a3s-observer-ebpf/src/main.rs`
- `a3s-observer-common/src/lib.rs`
- Interaction reassembly/provider parser 与相关 tests

### Phase 3：完善 provider parser 与会话关联

1. 覆盖 Responses 与 Messages 的完整流式终止、tool call/result 和 retry；
2. 新增 conversation/turn/attempt/runtime role/correlation 字段；
3. 建立明确 ID 优先、推断 ID 次之、证据不足不关联的规则；
4. 对跨 interaction 的 tool result 建立稳定链接；
5. 保留 raw body/hash 为权威证据，结构化时间线作为派生视图。

### Phase 4：API、存储与 token 调整

1. 增加 conversation summary/timeline query 和 ClickHouse 查询；
2. 从 Interaction 只读接口移除 `@RequireManagementAuth()`；
3. 保留读取审计并新增会话审计；
4. 扩展前后端 types，保持旧 Interaction 字段兼容；
5. 增加无 token 200、有无数据、ClickHouse fallback、非法 ID 和权限边界测试。

AnySentry 主要修改范围预计为：

- `apps/api/src/security-monitoring/types.ts`
- `apps/api/src/security-monitoring/security-monitoring.controller.ts`
- `apps/api/src/security-monitoring/aggregation.service.ts`
- Interaction ClickHouse schema/query 与测试
- `apps/web/src/lib/api/security-center.ts`

### Phase 5：实现 Conversation Tracking UI

1. 将 `ConversationTrackingPage.tsx` 实现为三栏工作区；
2. 拆分 SessionRail、ConversationTimeline、InteractionInspector、CoverageState 等小组件；
3. 实现 URL deep link、浏览器返回恢复、实时跟随和分页；
4. 将 Agent 详情页改为最近会话摘要与跳转入口；
5. 完成 loading/empty/error/partial/unsupported 状态；
6. 进行 1440、1024、768、390 px 截图和交互验证，修复溢出、焦点、对比度与滚动问题。

### Phase 6：LangChain 服务与完整回归

1. 在 `tender_jang` 运行最小 LangChain HTTP 服务并从宿主机访问；
2. 验证服务进程资产、LLM request/response、tool call/result；
3. 回归 Pi 和 Dify，确保身份 map 拆分、会话聚合和 UI 没有造成退化；
4. 构建 Observer、API、Web 新镜像，更新部署并记录 revision；
5. 交付 URL、容器进入命令、测试命令、已验证版本矩阵和剩余 coverage 边界。

## 7. 测试矩阵与验收标准

### 7.1 功能测试矩阵

| 场景 | Codex SSH | Codex tender | Claude tender | LangChain service | Pi/Dify 回归 |
| --- | --- | --- | --- | --- | --- |
| Agent 资产识别 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 纯文本 request/response | 必测 | 必测 | 必测 | 必测 | 必测 |
| 单工具 call/result/final | 必测 | 必测 | 必测 | 必测 | 必测 |
| 连续两个工具与顺序 | 必测 | 必测 | 必测 | 必测 | 抽测 |
| streaming 终止 | 必测 | 必测 | 必测 | 必测 | 必测 |
| retry/timeout/partial | 必测 | 必测 | 必测 | 抽测 | 抽测 |
| 首次请求 attach | 必测 | 必测 | 必测 | 必测 | 必测 |
| 错误 profile fail closed | 必测 | 必测 | 必测 | 不适用 | 抽测 |
| 非 Agent 同 endpoint 负例 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 无 management token 查看 | 必测 | 必测 | 必测 | 必测 | 必测 |

### 7.2 内容与时间断言

每个正向 fixture 使用唯一 sentinel，逐项断言：

- 最终 user content 出现在 request，未发送的本地 sentinel 不出现；
- assistant content 与 provider 原始 stream 聚合一致；
- tool name、arguments、call ID、result、error 与顺序一致；
- `started <= requestComplete <= firstResponse <= ended`；异常断流允许缺少后部时间，但必须为 partial；
- tool 可见边界耗时与外部工具网络耗时使用不同标签；
- agentAssetId、root/runtime role、container/host、PID/cgroup 归因正确；
- raw body hash 可复算；Authorization/API Key 不出现在任何 record 或日志。

### 7.3 页面验收

- `/conversations` 默认可见最近 Agent/会话，不再是空页面；
- 能从 Agent 资产页、原始事件和工具证据定位到对应会话/turn；
- 同一会话按 `user -> model -> tool call -> tool result -> model` 顺序阅读；
- 完整请求、响应、工具参数/结果和四个时间边界可查；
- 已识别但无法采集正文的 Codex 显示具体 coverage 原因；
- Dify 跨实例 interaction 在 asset 会话中聚合，仍能下钻实际 instance；
- 不配置 management token 也能查看，读取审计仍产生；
- 390–1440 px 无关键内容遮挡、嵌套横向滚动或无法键盘操作的问题。

### 7.4 稳定性与回归

- Collector 已运行时，受支持 CLI 连续启动 10 次，第一轮请求均进入捕获窗口；
- 正向 text/tool fixture 各连续 10 次不串 Agent、不串 conversation、不丢终止事件；
- 错误 hash、相邻未知版本和普通 curl/Node/Python 负例不产生正文 Interaction；
- ring/forwarder/ClickHouse 故障不阻断 Agent，并生成 drop/partial/coverage；
- Pi、Dify 现有成功链路保持可用；
- 新镜像带源码 revision，部署版本与当前分支一致。

## 8. 风险、边界与止损条件

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| Codex 实际 socket owner 与当前强假设不同 | profile 做在错误进程上 | 先用 socket owner + exec ancestry + sentinel 明文同时证实，再开发 adapter |
| Rustls strip/单态化导致偏移高度版本相关 | 升级即失效，维护成本高 | 精确 fail-closed profile、版本矩阵、自动 fixture；不声称语言级通用 |
| Codex 中转 SSE 终止语义不兼容 | CLI 无法完成，无法形成完整响应 | metadata-only test front 定位；只做有证据的最小归一化 |
| HTTPS 协商 H2/WS/QUIC | H1 parser 无法重组 | lab 强制 H1；生产显示 unsupported，后续单独立项 |
| exec 后首请求太快 | attach 前丢失第一轮 | exec 驱动 attach、扫描兜底、10 次启动验收 |
| Dify/多进程错误归因 | 把其他 workflow 内容并入当前会话 | 明确 ID 优先；证据不足标 unlinked，不按时间强绑 |
| 取消 management token 后原文可见范围扩大 | 敏感对话暴露 | 以平台访问边界为权限边界；保留审计；不进入 URL、日志、telemetry、本地存储 |
| 临时 CA/密钥/中转信息污染 Git 或镜像 | 凭据泄露 | 只放 runtime 私有目录；提交前 secret/path/status 审核；不 commit 容器快照 |

出现以下任一情况时，应暂停扩大实现并回报审核，而不是继续猜测：

1. 证实 Codex 当前 TLS 明文边界无法用稳定、可验证的 uprobe ABI 获取；
2. 真实必需协议只能是 HTTP/2/WebSocket/QUIC，无法通过受控 H1 路径完成本阶段验收；
3. 中转必须改写业务正文才能让 CLI 工作；
4. runtime 归因无法把网络辅助进程与普通工具进程可靠区分；
5. 需要把真实 API Key、私有 URL 或证书打进镜像/仓库才能复现。

## 9. 本阶段非目标

- 不实现所有 Go `crypto/tls` 或所有 Rustls Agent 的通用观测；
- 不使用 SDK/Hook 补齐看不到的内部框架时间；
- 不读取 provider 未返回的隐藏推理；
- 不从 Agent 本地 RAG、上传文件解析或 OCR 中间态补正文；
- 不自动下载远端多模态 URL/file ID；
- 不在本阶段实现 HTTP/2/HPACK、WebSocket、HTTP/3/QUIC 通用重组；
- 不把测试 TLS front 变成生产流量网关或生产 MITM；
- 不提交测试容器内已有的私有配置、认证文件、临时证书和 API 信息。

## 10. 方案依据

- Pixie 的 eBPF TLS 方案同样在 TLS 库 API 的加密前/解密后边界挂 uprobe，而不是从网络出口密文恢复正文：[Pixie eBPF 与 TLS](https://docs.px.dev/about-pixie/pixie-ebpf/)
- AgentSight/Anolisa 的探针设计采用 Agent 进程发现后动态 attach SSL read/write，并以受控 process map 限定采集目标：[AgentSight eBPF probes](https://github.com/alibaba/anolisa/blob/main/src/agentsight/docs/design-docs/ebpf-probes.md)
- AgentSight 的 session-centric 设计强调会话行、证据来源和只有进程证据时的显式降级，支持本设计把 coverage/provenance 放入主要工作流：[Session-centric top design](https://github.com/eunomia-bpf/agentsight/blob/master/docs/design/session-centric-top.md)
- Tetragon 的动态 uprobe/selector 能力说明运行时选择与精确挂载可行，同时也提示低层探针策略必须保持严格边界：[Tetragon Tracing Policy](https://tetragon.io/docs/concepts/tracing-policy/)
- Codex、Claude Code、LangChain 的配置与调用方式采用各自官方文档，不把测试中转的私有配置固化为产品假设。

## 11. 待审核结论

审核通过即表示同意以下开发边界：

1. `/conversations` 按三栏工作区实现，Agent 详情页降为最近会话摘要；
2. 对话读取取消 management token 二次验证，但保留平台访问边界与读取审计；
3. Observer 拆分身份授权与 TLS attach 状态，并引入受信 `network_runtime`；
4. Claude 使用精确 BoringSSL profile，Codex 按实际 socket owner 实现 Rustls/实际 TLS family adapter，均 fail closed；
5. 使用容器内临时 HTTPS test front、临时 CA 和现有 VPN 完成测试，但不提交任何私有配置；
6. LangChain fixture 通过容器 bridge 端口提供 HTTP 调用入口，完成资产、对话和工具全链路验收；
7. HTTP/2、WebSocket、QUIC 和通用 Go/Rustls 支持留到后续阶段，当前必须清晰展示 coverage 边界。
