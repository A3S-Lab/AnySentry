# AnySentry / Observer Canonical Observability：本地实现与验收记录

> 状态：本地实现复审稿（2026-09-03，Asia/Shanghai）
>
> 本文记录当前工作树的实现边界、可复核的本地验证和未完成项。它不是“所有 Agent
> 已生产支持”的声明，也不替代四份架构合同：
> [总体架构 v2](./anysentry-agent-observability-architecture-v2.md)、
> [LLM 观测 PRD](./anysentry-agent-llm-interaction-observability-prd.md)、
> [LLM 技术设计](./anysentry-agent-llm-interaction-observability-technical-design.md)、
> [会话归因与统一证据 V4](./anysentry-agent-conversation-resolution-and-unified-evidence-v4-design.md)。

## 0. 结论与证据等级

本地 Canonical contract、AnySentry API/Web 构建、Observer release 构建及定向回放均已
通过；当前代表对象的“产品级 loopback fixture”可以复核 Codex 和 Claude Code 的两轮
ToolCall/ToolResult，也可以复核 Dify 本地 mock 的 LLM/tool HTTP exchange。当前仍不能把
这些结果不能写成 Observer eBPF 被动 attach 的四环境端到端通过：本机 UID 没有可用的 eBPF
能力，Docker 无法创建当前工作树容器，Kubernetes 的正式 Deployment 仍是旧镜像（只做过
独立 hostPath fallback），SSH 没有 Agent 目标，
LangChain/LangGraph 的受控真实调用未完成。

本文使用四种标记，避免把设计、推断和实测混写：

- **已确认事实**：由当前源代码、命令输出、API 响应或受控 fixture 直接支持；
- **目标设计**：四份合同要求的方向，可能仍有分阶段实现；
- **推断**：由代码结构或负向测试支持，但尚未有生产规模统计；
- **未验证**：本机没有安全、可复现或当前头部署条件，不能写成通过。

## 1. 当前主链与职责边界

### 1.1 数据流

```text
Agent workload
  → Observer eBPF / uprobe / syscall collector
  → Forwarder / WAL / authenticated Source envelope
  → AnySentry Ingest/Auth
  → RawObservation commit (append-only, hash-only by default)
  → Process/Runtime/Connection normalizer
  → Transport decoder (HTTP/SSE/WebSocket boundary)
  → LLM Format registry (OpenAI/Anthropic/Gemini-compatible)
  → Agent/Application Adapter (identity and tool hints)
  → LogicalAgent / AgentInstance / RuntimeInstance / Session resolver
  → Correlation and versioned EvidenceLink
  → Sentry judgment revisions
  → Conversation / Evidence / Coverage / Operations projections
  → API and Web UI
```

Observer 只负责固定 ABI、事件时间/序列、进程与连接事实、有界明文复制、背压和导出。
Controller 负责协议入口、认证、边界校验和查询编排；通用 Parser、Resolver、Correlation
和 Sentry 核心不根据产品名称添加分支。当前仍保留 V1/V2/V3/V4 兼容投影，Canonical
记录通过 `sourceRefs`、`derivedFrom`、`revision` 和 `resolutionRevision` 指向来源，
不覆盖原始事实。

### 1.2 两条证据 lane

```text
面向人：UserMessage → LlmRequest → LlmResponse → ToolCall → ToolResult → FinalReply
面向机：Exec/Fork/Exit、File、Network、DNS、TLS、Process lineage、Security KernelFact
                         ↘ 版本化 EvidenceLink / RelationRevision ↙
```

语义 lane 说明模型/Agent 的意图和实际传输内容；Kernel lane 说明进程、文件、网络和安全
动作事实。ToolCall 不等于执行成功，只有明确的 Agent Tool 事件或匹配的 Process/File/
Network/Security KernelFact 才能升级为 observed/completed。Parser、Adapter 或 TLS 失败时，
仍保留 KernelFact、CandidateAgent 和 CoverageGap；`partial`、`unparsed`、`unsupported`
和 `ambiguous` 是可见结果，不是静默删除。

## 2. 已冻结的 Canonical 合同

当前 API `GET /security-center/v1/observability/contracts` 返回的目录版本如下：

| 对象 | 版本 | 作用 |
| --- | --- | --- |
| `RawObservation` | `anysentry.raw_observation.v1` | 不可变来源事实、事件/接收时间、来源序列、payload hash/ref |
| `KernelFact` | `anysentry.kernel_fact.v1` | 机器侧进程、文件、网络、DNS、TLS、安全事实 |
| `SemanticRecord` / `LlmCall` | `anysentry.semantic_record.v1` | LLM、消息、工具和应用语义派生记录 |
| `LogicalAgentDefinition` | `anysentry.logical_agent_definition.v1` | 注册定义、工作流/服务定义及候选身份 |
| `AgentInstance` | `anysentry.agent_instance.v1` | 根进程代次或部署/工作流 revision |
| `RuntimeInstance` | `anysentry.runtime_instance.v1` | Host/SSH/Docker/Kubernetes 物理运行载体 |
| `ConnectionIdentity` | `anysentry.connection_identity.v1` | Process generation、socket/TLS context、stream 边界 |
| `SessionMembership` | `anysentry.session_membership.v1` | Session、Segment、role、质量、来源和解析 revision |
| `EvidenceLink` | `anysentry.evidence_link.v1` | 语义节点到 Kernel/Process/File/Network 的关系 |
| `RelationRevision` | `anysentry.relation_revision.v1` | 迟到事件、冲突仲裁和关系修订 |
| `CoverageGap` | `anysentry.coverage_gap.v1` | no event、权限、TLS/协议、解析、超限、丢失和存储缺口 |

### 2.1 身份和时间规则

- `ProcessGenerationKey = host + boot + pid + start marker`；`startTimeTicks` 和
  `startTimeNs` 均可作为 marker，缺少 host/boot/start 时不生成稳定 ProcessGeneration；
- Connection 保存 `socketCookie`、FD generation、TLS context、stream/direction/sequence，
  Egress 只是一条连接事实，不能直接命名为 LlmCall；
- LogicalAgent 优先管理面 `logical_agent_id`/应用/工作流/服务定义，其次为
  tenant/owner + 产品族 + workspace/repository + profile 指纹；只有候选事实时输出
  `logical_agent_candidate/unresolved`；
- `terminal_context_id` 默认属于 Runtime/Segment。只有显式 `logicalScopeMode=terminal`
  才进入 LogicalAgent 边界；同一注册定义可以在多个终端运行；
- 每次根进程启动或部署代次都会生成新的 AgentInstance。重启不复用旧进程代次；
- 有原生 `session_id`/`thread_id`/`conversation_id` 时按受信命名空间建立 Session；
  `serviceStateful=false` 时，即使 producer 重复发送 legacy/provider session label，也强制
  每个 POST 为 `ephemeral/per_request`，不跨请求合并；
- `resume` 使用旧 Session + 新 Instance/Segment；`fork` 使用新 Session +
  `parentSessionId`/`canonicalParentSessionId`，没有父 ID 时不自链；
- Alias、Membership 和 EvidenceLink 的后续判断产生新 revision，不修改 RawObservation。

Session HMAC 使用独立的 `ANYSENTRY_SESSION_HASH_SECRET`；没有配置时只使用进程级随机值
（`process_ephemeral`），不会回退到 management token。Canonical API 只返回模式和状态，
不返回密钥材料。

### 2.2 Registry 和 Adapter

当前 Registry 通过同一目录暴露：

| Registry | 当前条目 | 说明 |
| --- | --- | --- |
| Agent Adapter | Codex CLI、Claude Code、Dify Workflow/Chatflow、LangChain/LangGraph；Pi 和 generic CLI 为 future slot | 只声明产品特异字段、生命周期和 capture hint |
| Transport | HTTP/1、SSE、WebSocket、HTTP2/QUIC future | framing 不识别产品 |
| LLM Format | OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini-compatible | 工具 delta、结果和流式聚合共用 |
| Runtime | Host、SSH、Docker、Kubernetes | 只解析运行载体和代次 |

新增 Agent 的步骤是：写 Manifest → 提供正/负/边界 fixture → 复放旧 RawObservation →
Shadow → Candidate → Confirmed。新增产品不得在 Controller、Transport、LLM Format、
Correlation 或 Sentry 核心加入 `if product == ...`；Kimi/Z.ai/Pi 后续只需增加 Manifest/
Adapter/fixture，不复制主链。

## 3. 存储、降级和资源边界

### 3.1 写入顺序

```text
authenticated envelope
  → RawObservation hot commit / WAL acknowledgement
  → KernelFact and SemanticRecord
  → identity/session membership
  → EvidenceLink / RelationRevision
  → Sentry JudgmentRevision
  → compatibility and canonical projections
```

Raw lane 默认去除 body，只保留 `payloadRef`、SHA-256、字节数和 redaction state；原文读取
必须走管理权限和审计路径。关系、Session 和旧读模型均带来源引用。PostgreSQL/ClickHouse
未就绪时，AnySentry 继续使用有界 hot store，并在 Coverage/health 中显示 partial，而不是
把内存结果伪装成 durable。

当前 Host API 健康响应确认的主要上限包括：Raw 20,000 条/64 MiB/15 分钟、Kernel 50,000
条/64 MiB/30 分钟、Semantic 50,000 条/64 MiB/30 分钟、Evidence 100,000 条/64 MiB/30
分钟、SessionMembership 100,000 条/64 MiB/30 分钟、CoverageGap 20,000 条/64 MiB/24 小时。
Conversation binding hot state 为 100,000 条/64 MiB/24 小时，持久化去重索引为 200,000 条/
32 MiB/24 小时；Aggregation 的 history、interaction、relation、in-flight 和 durable
search 状态也分别有 max entries/bytes、TTL、eviction/drop/timeout 计数。所有 Map/queue
都有 close/exit 清理，不用整体 `clear()` 止压。

当前 `SemanticRecord.completeness` 表示 canonical 语义 envelope/字段是否成功解析；它不等同
于“正文可见”。没有 content/body 的 authenticated Adapter 事件可以是 metadata-complete，
同时兼容 `AgentInteraction` 明确标为 `reference_only`，只提供 `payloadRef` 和字段引用；
UI/查询应据此显示 reference-only，而不能把 metadata complete 渲染成完整 Prompt/Result。

关系候选采用唯一所有权仲裁；同分候选保留 `ambiguous`，不强选。关系和持久化写入均有
批内/已有 key 冲突检测，SQL 侧按 revision/不可变锚点保护；当前 sink 接口为兼容旧代码
返回 `boolean`，因此“数据库冲突”和“暂时不可用”在部分上层路径仍可能汇总为
`storage_unavailable`，需要后续 typed result 扩展才能完全区分。

### 3.2 安全边界

- API key、Authorization、Cookie、Prompt/Body 等字段不进入诊断明文；Coverage detail 对
  key 名和 URL/query/userinfo 形态都做 hash-only 处理；
- `deploy/install.sh` 通过权限为 0700/0600 的临时文件和 `kubectl --from-file` 写入
  ClickHouse、management 和 session-hash Secret，避免 Secret 值出现在 kubectl argv；
- Docker Compose/Kubernetes 只引用 Secret 或受控环境变量；仓库不保存真实 URL、Token、
  Cookie、完整 prompt 或 transcript；
- 当前扫描仍发现若干既有 untracked/protected credential-like 文件。它们的 tracked
  finding 为 0，本地测试期间不删除、不覆盖；因此 hygiene gate 如实为 blocked；
- 远程地址只读记录，整个 Goal 没有 `git push`、远程 PR、远程 registry 或公共镜像写入。

## 4. API、投影和 UI

兼容入口继续保留：`/security-center/ingest`、`/ingest/batch`、`/events/list`、
`/agents/interactions`、`/agents/conversations` 和 V2/V3 timeline。Canonical 查询入口为：

```text
GET  /security-center/v1/raw-observations
GET  /security-center/v1/kernel-facts
GET  /security-center/v1/semantic-records
GET  /security-center/v1/evidence-links
GET  /security-center/v1/session-memberships
GET  /security-center/v1/coverage-gaps
GET  /security-center/v1/observability/contracts
POST /security-center/agents/conversation-directory-v3
POST /security-center/agents/conversations/timeline-v3
POST /security-center/agents/semantic-events/evidence
POST /security-center/agents/kernel-events/semantic-context
```

Controller 只处理认证、参数、权限和查询编排；页面使用同一个 Selection/Canonical ID，
Timeline response 带 request key、canonical conversation ID 和 revision，旧异步响应不会
覆盖新选择。人类视图默认显示 User/Model/Tool；initialize、tools/list、bootstrap 和
后台活动保留在 Technical Activity/原始证据中但默认折叠。Evidence inspector 可从 Tool
跳 KernelFact/原始事件和既有 Verdict，也可从 KernelFact反查 Semantic/Session；关系不确定
时展示 `ambiguous`、`semantic_only` 或 `coverage_gap`。

## 5. 本地验证结果

### 5.1 构建、类型和合同

以下命令在当前工作树通过（命令输出不含秘密）：

```bash
pnpm build
pnpm --filter @anysentry/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @anysentry/web exec tsc -p tsconfig.json --noEmit
node scripts/verify-deployment-manifests.mjs
node scripts/verify-canonical-contract.mjs
node scripts/verify-canonical-observability.mjs
node scripts/verify-agent-conversation-resolution-v2.mjs
node scripts/verify-agent-conversation-directory.mjs
node scripts/verify-agent-conversation-binding.mjs
node scripts/verify-agent-metadata-boundaries.mjs
node scripts/verify-agent-asset-model.mjs
node scripts/verify-agent-semantic-kernel-relation.mjs
node scripts/verify-agent-runtime-state.mjs
node scripts/verify-agent-semantic-identity.mjs
node scripts/verify-agent-templates.mjs
node scripts/verify-s2-persistence-canonical.mjs
```

Observer 当前本地验证结果：

```bash
cargo fmt --all -- --check
cargo build --locked --offline --workspace --release
cargo test --locked --offline --workspace --release
cargo clippy --locked --offline --workspace --exclude a3s-observer-ebpf \
  --all-targets --all-features --release -- -D warnings
```

结果为 202 项测试通过（root 32、workload contract 7、collector 155、common 8），fmt、
release build 和 clippy 通过。`a3s-observer-ebpf` 是 no_std/no_main 的专用 BPF target；在
普通 host 上直接以 `--features build-ebpf` 做宿主链接会触发 unwinding 限制，正确门禁是
Collector 的 `aya_build`（本次 workspace build/test 已生成 BPF object），不能把该宿主链接
命令写成 eBPF attach 通过。

### 5.2 AnySentry API 和回放

使用当前源码构建的本地 API（loopback、memory fallback、专用 session hash secret）复核：

- Canonical representative replay：Codex、Claude Code、Dify、LangChain/LangGraph 四类
  合成 authenticated event；13 个事件均保留 Raw/Kernel/Semantic/Session/Evidence 关系，
  结果为 `status=pass`。Dify 的 ToolCall 和 ToolResult 在同一个 stateless POST interaction
  内闭环，另一个 POST 仍是独立 per-request Session；这避免测试为了视觉完整而放宽真实
  stateless 规则；
- S2 trusted-correlation：临时 API 的 off 5/5、shadow 70/70；固定 API shadow 70/70。
  测试进程显式设置 `ANYSENTRY_TRUSTED_CORRELATION_MODE`，避免把 verifier 自身默认 off
  误报成服务回归；
- Heterogeneous ingest、interaction ingest/query、S6 Tool Evidence 和 persistence
  single-flight 均通过；旧字段、无管理 token 读取保护、hash/分类边界和 canonical reader
  first 均有断言；
- Web 浏览器验收在临时 API 上通过：Conversation Tracking 覆盖 1440/1024/390/375、
  reduced-motion、User/Model/Tool、历史 Agent 折叠、selection/revision 防旧响应覆盖；
  Agent/Event inspection 与外部 Tool interaction 也分别通过 responsive/overflow/runtime
  检查。外部 Tool 场景使用合成 `interactionType=tool` 记录，不能替代真实 Observer attach；
- 最新总门禁 `verify-canonical-goal.mjs --run-tests` 的失败数为 0。环境状态和 hygiene
  缺口仍按下节报告，不能把总门禁的 `status=partial` 改写成完成。

### 5.3 四类代表对象矩阵

| 代表对象 | 当前本地实际验证 | Kernel/Evidence | Session/连续轮次 | 结论 |
| --- | --- | --- | --- | --- |
| Codex CLI | 仓库 loopback fixture 启动真实 `codex 0.151.0`；HTTP 两次 POST，第二次带回 tool result 并输出 final | 产品级 fixture 有工具闭环；当前 shell 无权证明 eBPF 被动 attach | 两轮产品调用通过；HTTPS fixture因当前 CLI/运行器等待超时，不能宣称 HTTPS | 产品级 loopback pass；Observer attach partial |
| Claude Code | loopback fixture 启动真实 `claude 2.1.170`；Anthropic Messages/SSE 两次 exchange | 产品级 fixture有 Bash intent/result；BoringSSL 被动 attach 未在本机验证 | 两轮产品调用通过 | 产品级 loopback pass；Observer attach unverified |
| Dify Workflow/Chatflow | 既有本地 Docker Dify 1.14.2 + mock provider/tool；2 次 LLM HTTP/1.1 stream + 1 次 `/tool/execute` 均 200，RAG 选中标记与内部 sentinel 边界通过 | mock 结果和 hash/bytes 可对账；当前 Dify stack 未证明本分支 Observer attach | 无 conversation 的两个 POST按 per-request；canonical replay覆盖同一 POST工具闭环 | 本地 mock workflow pass；被动 attach/内部 node 归因 partial |
| LangChain/LangGraph | Canonical/adapter replay pass；宿主既有服务 health 200，但受控 `/invoke` 超时；当前 Docker fixture 创建受 daemon 阻塞 | replay 保留 Kernel candidate/Evidence contract；真实运行 Kernel relation 未验证 | thread/run 与 per-request 规则有 fixture；真实连续调用未完成 | synthetic/contract pass；真实服务 partial/unverified |

“产品级 loopback pass”只证明真实 CLI 能在合成 provider 上完成请求—工具—结果—最终回复，
不等于 Observer 已捕获这些字节。正文、KernelFact、EvidenceLink 和 Coverage 的真实被动
采集仍需具备权限的专用节点复测。

### 5.4 Host / SSH / Docker / Kubernetes

| 环境 | 当前状态 | 证据与限制 |
| --- | --- | --- |
| Host | partial | API health 200，当前使用 memory fallback；CLI loopback fixture 已在 Host 执行；UID 1001、`unprivileged_bpf_disabled=2`，无直接 eBPF attach 能力 |
| SSH | unexecuted | `ssh`/本地配置可解析，但没有用户提供的 Agent 目标；未执行远端登录或命令 |
| Docker | partial | Docker daemon、Compose config 和既有 Dify 栈健康；当前头 AnySentry 镜像 BuildKit 受本地 mirror 401、legacy build/新容器 create 在高 I/O 下超时，未创建当前头 API 容器 |
| Kubernetes | partial | `default` k3s NodePort health、ClickHouse/PostgreSQL 和核心 Pod 可响应；既有 AnySentry Pod 使用旧本地 digest，曾有 OOM/restart，workspace-scanner 还有不稳定副本。另在独立临时 namespace 用旧本地运行时镜像只读挂载当前 `apps/api/dist` 做了 hostPath fallback：Canonical replay、S6 和 S2 shadow 70/70 通过后已清理；这不是可发布镜像部署 |

Kafka/Flink 只在已有可选 profile 中保留，未成为 Canonical 主链前置依赖；本阶段不新增时间窗
功能。Kubernetes/ Docker 的旧服务健康不被用来冒充当前工作树部署通过。

## 6. 当前限制、回滚和后续扩展

### 6.1 已知限制

1. 本机 eBPF 权限不足；真实 Observer attach、Ring/WAL 丢失率和生产性能没有通过证据；
2. Codex 当前 HTTPS/Rustls 路径没有可发布的被动明文保证；HTTP/2、QUIC 及协议特定边界仍需独立项目；
3. 运行器对超大 body、断流或 declared limit 可能只有 drop/truncation Coverage，尚未为所有情况生成 metadata-only partial interaction；
4. 无 Hook/Trace Adapter 时，Dify 内部 node、LangGraph checkpoint 和进程内工具开始/结束只能是 partial/semantic_only；
5. Host 当前没有 durable ClickHouse/PostgreSQL，Canonical hot state 可查但重启后不等价于持久化验证；
6. Relational sink 的兼容 bool 返回值尚未细分 conflict 与 unavailable；
7. URL/hash、正文权限、30 天保留和生产容量/成本仍需安全负责人和部署环境单独批准。

### 6.2 回滚点

- 采集回滚：关闭 `A3S_OBSERVER_SSL`，或移除精确 `A3S_OBSERVER_TOOL_HTTP_ROUTES`；Observer
  仍保留 Kernel-only 事实；
- 解析回滚：停用某个 Adapter/Transport registry 版本，保留 RawObservation 和旧兼容投影；
- 身份回滚：Canonical Directory/Timeline 与旧 V1/V2 binding 并行，关闭新 feature flag；
- 存储回滚：恢复旧 API/镜像时不删除新表；停止新事件后再切换读模型，历史事实保留按 TTL 治理；
- 本地代码回滚：使用本地 checkpoint commit 的父提交或按文件反向恢复，经 `git diff`、build
  和回放复验后再操作；本 Goal 不执行 reset/checkout 或远程推送。

### 6.3 后续接入步骤

先补具备权限的 Host/SSH/Docker/Kubernetes 真实运行 envelope，再分别推进：Rustls/Go TLS、
HTTP/2/WS/QUIC、Dify Trace/Hook、LangGraph checkpointer、独立加密 Content Store、typed
durable sink result 和性能压测。Kimi、Z.ai、Pi 只按 Manifest → fixture → Shadow →
Candidate → Confirmed 接入；Kafka/Flink 只作为未来的时间窗派生支路。

## 7. 凭据、日志与交付声明

本地验证使用的管理/session 值只在进程环境或受保护临时目录中短时存在，测试内容为合成
短字符串或本地 mock；没有把真实 API key、URL 中的密钥、Cookie、Authorization、完整真实
Prompt、生产 transcript 写入仓库、日志、Trace、Docker layer、Kubernetes YAML、数据库或
本文。测试结束后临时 fixture 目录已清理；既有用户保护文件保持原状。最终交付不包含任何
秘密值，也没有执行远程 push、PR、远程分支或公共镜像发布。
