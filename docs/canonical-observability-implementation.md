# AnySentry / Observer Canonical Observability：本地实现与验收记录

> 状态：本地实现复审稿（2026-09-05，Asia/Shanghai）
>
> 本文记录当前工作树的实现边界、可复核的本地验证和未完成项。它不是“所有 Agent
> 已生产支持”的声明，也不替代四份架构合同：
> [总体架构 v2](./anysentry-agent-observability-architecture-v2.md)、
> [LLM 观测 PRD](./anysentry-agent-llm-interaction-observability-prd.md)、
> [LLM 技术设计](./anysentry-agent-llm-interaction-observability-technical-design.md)、
> [会话归因与统一证据 V4](./anysentry-agent-conversation-resolution-and-unified-evidence-v4-design.md)。

## 0. 结论与证据等级

本地 Canonical contract、AnySentry API/Web 构建、Observer release 构建及定向回放均已
通过。历史 r33 段落仍保留用于追溯；当前最高优先级结果见文末 **2026-09-05 r51** 增补：
API/Web 使用本地不可变 OCI digest `sha256:bf625fe8…`，Observer 仍使用未改动的 r7
digest `sha256:45af6fa2…`。实体类 Canonical GET 的旧目录投影放大问题已修复为显式页限制、
runtime-only 分离、单次 Runtime 快照、页级 clone、Session alias fallback 和 evidence-only
degradation；兼容投影仍可能在大历史窗口受存储压力并返回 partial。
`tender_jang` 的 Codex/Claude 产品级 TUI、LangChain 服务级调用和 k3s LangGraph sandbox
均有脱敏运行证据，但 Observer 为保护约 4.23 GB WAL 已暂停，LangGraph/Dify 的 Tool→Kernel
统一 EvidenceLink、当前 SSH Codex 的 Rustls/WebSocket 正文和跨环境持续可靠性仍未通过，
所以 Goal 仍为部分完成。Canonical side-lane 现在采用有界读、hot fallback 和 forward-only
KernelFact locator；旧历史事实在大表扫描超时时返回显式 503/coverage gap，不伪造 complete。
Observer BPF 对象还在特权本地
k3s Pod 中以 Aya `Program::load` 逐项加载了
`tls_write`、`tls_sendto`、`http_writev` 和 `exec`，验证此前的 1,000,001-instruction verifier
状态爆炸已由 `bpf_loop` 路径 hash 修复；由于节点上已有 Observer 占用同类 tracepoint，不能
把这次 load smoke 扩写为当前 workload 的完整 attach。

本文使用四种标记，避免把设计、推断和实测混写：

- **已确认事实**：由当前源代码、命令输出、API 响应或受控 fixture 直接支持；
- **目标设计**：四份合同要求的方向，可能仍有分阶段实现；
- **推断**：由代码结构或负向测试支持，但尚未有生产规模统计；
- **未验证**：本机没有安全、可复现或当前头部署条件，不能写成通过。

## 0.2 当前决策增补（2026-09-04，优先于历史段落）

本节是本轮 Goal 的实现优先级和验收口径。后文保留的旧回合数字、旧镜像和旧策略是
历史证据，不得覆盖本节；当历史设计文档仍写 `probable_agent` 低采样时，以本节和当前
代码为准。

### 已确认事实

| 项目 | 当前事实 | 边界 |
| --- | --- | --- |
| 本地 checkpoint | AnySentry `b069df3`（含 `4fbd077`/`855bff9`/`adf0b91`）；Observer `3a827bf`（含 `66e27eb`/`49f183e`） | 仅本地分支和本地 checkpoint，未执行任何远程推送 |
| 构建/合同 | `pnpm build`、Canonical/identity/S5/unified/workspace/deployment 定向门禁通过；Observer release workspace test 212 项、fmt/check/build/clippy 通过；本地 OCI overlay manifest 已校验 | 原始 Dockerfile/BuildKit 受宿主 daemon/IO 阻塞，overlay 复用已验证依赖基座 |
| Canonical GET | `/v1/logical-agents`、`agent-instances`、`runtime-instances`、`sessions` 及详情、nested sessions/runtimes、timeline、coverage、`sr_`/`se_` semantic evidence alias、kernel context 均有版本化响应、bounded pagination/cursor、revision/coverage 和管理鉴权；隔离 harness 与当前 NodePort 均通过 | 当前 API/Observer 已切换到本地不可变 overlay；四环境的唯一 Tool→Kernel 深链仍非全部通过 |
| 候选身份 | `probable_agent` 保留 observed/detected provenance；默认 `effective capture/judgment=confirmed_agent`，与确认 Agent 使用同一完整 probe 矩阵，仍受 ring/payload/TTL/队列预算约束 | 不创建虚假 LogicalAgent/Session；`ANYSENTRY_CANDIDATE_EFFECTIVE_MODE=probable` 仅是显式成本降级开关，不是默认路径；管理面 token 仍只保护变更/控制操作，不再要求人工升级候选才能采样 |
| TLS 设计 | Codex/Claude 只通过实现族/ABI capability manifest 选择通用 TLS 边界；产品名仅作发现提示，版本号/二进制指纹不能作为隐藏授权条件 | 极端新 ABI 通过新增明确 capability extension 接入，复用同一 Parser/Correlation 主链 |
| CLI 与 a3s-test | 宿主 Codex/Claude TUI suite 通过；`tender_jang` 内真实 Codex `0.149.1`、Claude Code `2.1.251` 的 TUI suite 也通过（非敏感 terminal recording）；浏览器 capability 因本机 `a3s` 驱动缺少 `use` 未执行 | TUI 结果是产品级请求—工具—结果—最终回复证据，不等价于 eBPF 被动 attach |
| Runtime Source provenance | 运行时 snapshot 在 API 鉴权边界绑定 server-only `sourceId`，并在 AgentInstance/RuntimeInstance Canonical GET 中可查询；producer 伪造字段不会覆盖它 | 旧历史记录没有 sourceId 时仍按 Coverage 标 partial，不回填猜测值 |
| k3s Scanner | 代码已捕获不可读目录并跳过 `.runtime`；live `workspace-scanner` 使用本地不可变 digest、显式 `Directory` hostPath，Ready/restart=0，完成 1385 component scan | Scanner、API、Observer 已切换；未改动的 worker/streaming 镜像按“只有代码变更才滚动”原则保留旧 digest |
| Formal API/Observer rollout | API `sha256:b382…` 与 Observer `sha256:fd31…` 均已被本地 k3s 节点拉取并 Ready=1/restart=0；API NodePort health/contracts 200；Observer attached 73 probes、WAL 保留 backlog | Forwarder 曾因 API/数据库启动和节点 I/O 返回批次拒绝，后续仍保留 WAL；ClickHouse/PostgreSQL timeout、cgroup scope conflicts 和高 iowait 使“持续零丢失”未通过 |
| API/Web 交付形态 | API OCI 镜像内同时提供 `/app/dist` 和 `/app/web`，通过同源服务承载页面；因此没有独立 current-head Web Deployment 是有意的单镜像边界，不是遗漏组件 | API 已滚动到 `b382…`，NodePort 页面和 canonical client 字符串可见；可选 modules profile 的独立 Web 不属于 formal namespace |

### 目标设计

新的产品或版本只需声明 `Manifest → Transport/LLM Format capability → Adapter → Runtime`
扩展，并复用 RawObservation、Process/Connection、Session、Correlation、EvidenceLink 和
Coverage 算法。Unknown/Candidate 仍保留完整 Kernel lane；明文 Adapter 不可用只降低语义
覆盖，不删除 KernelFact、候选身份或 CoverageGap。分类管理同时区分四个维度：
`identityClassification`（观察到的身份）、`workloadRole`（工作负载角色）、`captureProfile`
（采集档位）和 `authority/provenance`（证据权威）。这样“候选按确认档位采集”不会伪造
“管理面已确认定义”。本阶段只做 observe，不引入阻断/干扰策略；Kafka/Flink 仍是可选派生支路。

### 推断与未验证

- `tender_jang` 当前确有 Codex、Claude Code、LangChain/LangGraph 运行库；其容器无 Docker
  CLI/socket，因此不能把它写成可管理嵌套 Docker 的运行环境。
- 常驻 LangChain HTTPS 和 k3s LangGraph sandbox 的服务级闭环已通过；现有旧 API 查询显示
  semantic/Kernel 记录，但尚未证明 current-head Observer → WAL → Canonical 的正式唯一深链。
- SSH 中的本次 Codex 对话已有协议/语义记录，但普通 SSH `CapEff=0` 且宿主
  `unprivileged_bpf_disabled=2`；正文完整持久化、独占 attach、Canonical Tool→Kernel 双向
  EvidenceLink 仍是未验证项。
- k3s 节点的长期抖动由共享节点高 iowait/swap、etcd/dockerd/EDR 并发和 DNS/探针超时共同
  放大；Scanner 的 EACCES 是已修复的代码缺口，不能把整个节点问题归咎于 AnySentry 代码。

## 0.1 2026-09-04 运行事实补充（优先于旧回合数字）

本节只记录当前回合直接取得的脱敏事实；旧版本、旧镜像和旧入口在后文保留为历史追溯，
不覆盖本节。任何 URL、Token、Cookie、Authorization、完整 Prompt 和真实正文均未写入本文。

### 已确认事实

| 范围 | 事实 | 解释边界 |
| --- | --- | --- |
| 当前本地代码 checkpoint | AnySentry `4fbd077`（前序 `855bff9`/`adf0b91` 等）；Observer `3a827bf`（含 `66e27eb`/`49f183e`） | 两个仓库均为本地 checkpoint，未 push；正式 API/Observer 尚未切换到这组代码 |
| 当前 checkpoint 测试 | identity/canonical/entity/source-scope 定向门禁通过；Observer full tests 165 collector + 8 common + 32 root + 7 workload = 212；fmt/check/build/clippy 均通过 | 证明局部合同与仓库门禁，不替代部署/真实链路验收 |
| mixed-cgroup identity fence | AnySentry publisher 输出 `rootPid`、`rootStartTimeTicks`、`agentInstanceId` 并保留同 cgroup distinct entries；Observer 按 process generation/cgroup/祖先链 fail-closed，mixed scope 不 broad admit | 旧 Observer/Forwarder rollout 必须和 publisher 原子升级；只替换单侧会保留旧误合并/准入风险 |
| 临时 k3s current-dist 验证 | namespace `anysentry-goal-dist-20260904` 的 current-dist hostPath fallback health ok；canonical contracts v1、representative replay 13 synthetic events/4 families/0 gap、S6 Tool Evidence、S2 shadow 均通过；namespace/容器已清理 | 仅为旧镜像底座 + 只读 `/app/dist`，不是 current-head OCI image，不能替代正式部署 |
| 临时 k3s API/Web OCI overlay 验证 | AnySentry API/Web overlay `anysentry:goal-current-oci-20260904` 从本机缓存基座覆盖 current `api/dist` 与 `web/dist` 构建成功并推入本机 registry，registry manifest GET 200（digest 前缀 `043180…`）；namespace `anysentry-goal-oci-web-20260904` 以 Secret 引用 token、无 hostPath，health、`/v1/observability/contracts`、representative replay 13/4 families/0 gap、S6、S2 shadow 均通过后清理 | overlay 基座仍是旧 runtime + current dist overlay，非原始 Dockerfile 全链；existing formal deployment 未切换，不能标 DoD 完成 |
| Observer OCI image smoke | Collector binary + Forwarder/Publisher script overlay 已推入本机 registry（digest 前缀 `7d3b…`）；临时 privileged/hostPID Pod 只执行 `a3s-observer-collector --version`，返回 `0.11.0` 后清理 | 仅证明镜像可拉取/二进制可启动，不等同于 tracepoint attach、Forwarder ingest 或正式 DaemonSet rollout |
| Observer OCI 组合 smoke | Observer scripts+current collector overlay `7d3b…` 在临时 privileged/hostPID Pod 附着 25 probes，scope 文件 5 fenced roots/2 cgroups，精确 batch probe 201 accepted；长跑因共享节点负载出现拒绝/spool 增长 | 只证明部署接缝与 fence 文件/局部 ingest，不能标持续可靠性或正式 DaemonSet 通过 |
| `tender_jang` | `node:24-bookworm` 容器内有 Codex CLI 0.149.1、Claude Code 2.1.251；Python 运行库为 LangChain 1.3.17/LangGraph 1.2.11 | 容器无 published port、Docker socket、Docker CLI；这是运行时盘点，不是 Docker 编排或 Observer 接入证明 |
| `tender_jang` LangChain 服务 | 容器内 `service.py` 监听 18082，`/health=200`；宿主 loopback 由既有本地转发进程接入 | 证明当前容器有可达服务，不证明当前头 AnySentry/Observer 已接入 |
| `tender_jang` LangChain 证书轮换 | 旧过期测试 CA/server cert 已在容器内精确备份后轮换；HTTPS `/invoke` 两次 HTTP200、1×`lookup_fixture`，确认后旧备份已清理 | 仅修复本地测试服务生命周期；常驻服务流量进入 current-head Observer/Canonical 投影仍未验证 |
| k3s Workspace Scanner 稳定性 | 旧 ReplicaSet 反复重启（约 1698 次）的直接原因是 `workspace-scanner.mjs` 对生成的 `.runtime/.../tls` 目录 `opendir` 未捕获 EACCES；另一 ReplicaSet 使用不存在的 `/srv/anysentry/AnySentry` hostPath，kubelet 明确 `FailedMount` | 已加入 `.runtime` 排除与嵌套不可读目录 best-effort；只读 preflight/临时 Kustomize renderer 拒绝缺失路径与 `DirectoryOrCreate`。live `workspace-scanner` 已切换本地 manifest `sha256:7a20…` 和实际 checkout path，新 Pod `restartCount=0`，完成一次 1385-component scan；AnySentry/Observer 仍未整体切换 current-head |
| 旧 k3s 身份反例 | 旧 k3s API image digest/revision 下，同一 Docker cgroup 的历史 LangChain 与 Claude Code 均有 `LlmInteraction`，却被合并到同一旧 agentAsset/session/run；Observer source/profile 可见但 cgroup map 仍把 Codex/Claude/LangChain 标为同一 `langchain` scope | 这是旧部署的真实混合身份/误合并反例；current-head 尚未部署，必须用 ProcessGeneration + Adapter/definition fence 拆分，不能把旧 asset 当 confirmed LogicalAgent |
| Codex/Claude fixture | 本回合各完成两阶段请求、ToolCall、ToolResult、最终回复 | 产品级协议/适配闭环通过；不等于被动 eBPF 捕获或 durable API 投影通过 |
| LangChain 临时 HTTP 副本 | 工具闭环返回 HTTP 200 | 证明本地 HTTP transport/工具路由可运行；不外推到 HTTPS 或生产服务 |
| LangChain 临时 HTTPS 重试 | 新 CA 的临时 HTTPS fixture + LangChain 副本 `/invoke=200`，`lookup_fixture` tool/result 成功，临时资源已清理 | HTTPS transport/Parser/工具闭环通过；不外推到常驻服务 |
| LangChain 常驻 HTTPS | 已轮换本地测试 CA/server cert，仅重启 fixture/service；`/health=200`、HTTPS `/invoke=200`、1×`lookup_fixture`，旧证书备份已清理 | 服务级 HTTPS/工具闭环已恢复；其流量是否进入 current-head Observer/Canonical 投影仍未验证 |
| Dify 实际重跑 | LLM/tool 两个 workflow 均 HTTP 200、脚本 rc=0；debug reconciliation curl 因测试 CA 校验失败 | workflow 调用通过；hash 对账仍 partial |
| Dify Durable API | exact `detectedName=dify-observation-lab` 当前快照 55 事件：Egress44、ToolExec8、LlmInteraction3；captureSelected55；identity exact54/weak1 | correlation method 全 `unassigned`，两条 lane 未统一 |
| k3s LangGraph | namespace `anysentry-observability-lab` 的本地 LangGraph workflow Pod（服务端口 8000，`/healthz=200`；OpenAPI 有 `/runs` POST 和 `/runs/{run_id}` GET）；本回合 POST/GET 均 200、`completed`；节点 `planner → code_generator → verifier → code_generator → verifier → finalizer`；sandbox exit=0、未超时/未截断、verification pass；telemetry accepted=15 | 真实本地 k3s 服务证据；对应 sandbox runner KernelFact 已捕获，但仍以 physical_workload 关联，尚未形成 root-generation/LogicalAgent 唯一 EvidenceLink |
| k3s LangGraph sandbox KernelFact | 同一 Run 的两个 sandbox runner generation 各有 `ToolExec=1` + `ProcessExit=1`，合计 Exec2/Exit2；`captureSelected=1`、`agentHasPhysicalIdentity=1`；`correlationMethod=physical_workload`、confidence0.70，`agentHasRootIdentity=0` | 证明 sandbox 内部受限 Python 执行进入 Observer Kernel lane；当前旧链仍未把语义 AgentTool 与 KernelFact 建立 Canonical 双向深链 |
| LangGraph 失败路径 | 一次复杂目标返回 `RuntimeError`，但仍上报 3 个事件 | 失败事件保留通过；该次 Run 不计为成功闭环 |
| Durable API | `detectedName=langgraph-workflow-sandbox-agent` 的 Session 共 19 事件：LlmInteraction 10、AgentTool 3、AgentInvocation 3、ToolExec 3 | 两条 lane 尚未统一：`correlation unassigned=13`、`agent_adapter=6`；事件数不能代替统一关系数 |
| 历史真实 Interaction | 既有本地审计证据中 Codex、Claude Code、LangChain 均曾产生真实 `LlmInteraction` | 历史记录与当前窗口分开统计，不覆盖下方 durable 查询 |
| 当前 SSH Codex（durable custom-window 初始快照，2026-09-03 16:14–16:22Z） | native PID 1101287 有 60 条 `LlmInteraction`；全部 `parseState=parsed`、`llmLikelihood=confirmed`、`statusCode=200`、`captureSelected=true`、`wireCompleteness/transportCompleteness=complete`；model=56、tool=4 | Observer 协议解析通过；identity/session/run 仍为 `tokio-rt-worker` / `probable_investigation` / `runtime_root`，不是 authenticated AgentAdapter/confirmed Session；异步写入使后续快照计数变化 |
| 当前 SSH Codex（后续 durable `agents/interactions` 快照） | 约 63 records：model57、tool4，另 2 unsupported/unparsed；parsed61；completeness complete6/partial55/unsupported2；toolCalls61、toolResults57、semanticItems125。request role 包括 `user`、`developer`、`agent_message`、`custom_tool_call_output`、`function_call_output`、`compaction` | 证明当前 SSH 对话进入 semantic lane；旧部署读模型的 request/response body 非零，但 Canonical 新证据只保留 hash/metadata-only，本文不复制正文 |
| 当前 SSH Codex transport | websocket 56（`tlsAdapterId=rustls-payload`），HTTP/1.1 4（`openssl-ex`）；另有 2 条 `AgentPlaintextEvidence`（`tls_uprobe_rustls`、`metadata_only`、`unparsed`） | 不能写成正文原文完整落盘；原文保留和 Adapter/Session 仍是 partial |
| 当前 SSH Codex Tool/Evidence | tool4 均 parsed/complete，toolCall4/toolResult4；model57 均 parsed，request/response wire complete；conversation complete2、tool_pending55；选定 Tool 的 EvidenceLink inspector 返回 404（semantic tool event not found） | Tool 协议闭环有事实，但 Canonical Tool→Kernel 双向 EvidenceLink 仍未闭环 |
| 当前 SSH Codex `POST /agents/conversations/timeline-v3`（旧 API 兼容投影） | 固定窗口只读返回 336 个 semantic events，全部 `completeness=complete`，每条带 `evidenceEventIds/sourceInteractionIds`；`user_message=1`、`model_progress=1`、`tool_call=105`（exact103/strong2）、`tool_result=229`（exact229）；唯一 Turn 仍 incomplete，旧 resolver 的 logical/session/terminal 字段为空 | 证明语义+source evidence 可追溯；不等于 current-head Canonical EvidenceLink/UI 或 confirmed LogicalAgent |
| SSH 早期窄窗口（历史快照） | 曾只看到 17 条 Egress、无 `LlmInteraction` | 该结果属于旧时间窗，不能继续作为当前 SSH 状态；只保留作 attach/时间窗对比 |
| 权限与可见性 | Observer 特权 `hostPID` Pod 可见宿主进程；普通 SSH 用户 `CapEff=0`，`unprivileged_bpf_disabled=2` | 特权 Pod 的宿主可见性不授予普通 shell attach 权限，也不证明当前 Codex 已被独占捕获 |
| 部署缺口 | existing formal AnySentry/Observer/Forwarder 仍为旧 image digest/旧 rollout；临时 API/Web OCI overlay 的 contracts GET 已局部通过但未切换正式部署；`critical_inbox_dropped` 约 1.89M（最近观测且继续上涨）；static signature warnings 仍存在 | 是当前 DoD 的运行可靠性缺口和风险，不能被临时 overlay 健康或 fixture 通过掩盖 |

### 推断（非通过条件）

- `tender_jang` 的安装内容足以运行受控 CLI/框架 fixture，但因无 Docker CLI/socket，不能将它描述为可从容器内启动或管理 Docker Agent。
- LangChain 临时 HTTP/新 CA HTTPS 与常驻 fixture 轮换后的 HTTPS `/invoke=200` 均说明通用 HTTP/工具路径可验证；常驻测试证书已轮换并清理旧备份，但 current-head Observer/Canonical 被动投影仍待复测。
- LangGraph 的 19 条耐久记录和两次每次 10 条 telemetry 表明 API/存储至少接收了这些事件；`unassigned` 与 `agent_adapter` 计数则表明语义 lane、Kernel lane 与 Adapter 关联仍未完成。
- 当前 SSH durable 查询已经证明协议层可解析 Interaction，request roles 也证明本次 SSH 对话进入 semantic lane；初始 60 条与后续约 63 条是不同时点的异步耐久快照，不应当作不可变总数。`metadata_only/unparsed` 的两条 AgentPlaintextEvidence、运行时级 identity/session/run、未确认的 Adapter 和 EvidenceLink inspector 404 仍限制正文与统一证据结论；早期 Egress-only 只是旧时间窗快照。

### 未验证

- 当前 SSH Interaction 的原文正文按 Canonical 合同完整持久化、authenticated AgentAdapter/confirmed Session、Tool/Kernel EvidenceLink 唯一归属和 inspector 404 修复；timeline-v3 的 336 条旧兼容投影虽可追溯 source evidence，但不替代 current-head Canonical/UI；旧部署读模型虽有非零 request/response body，本轮不将正文复制进新证据。
- `tender_jang` 中 Codex/Claude 经当前头 Observer 的独占 attach、Forwarder/WAL 投递和 canonical 投影。
- 常驻 LangChain HTTPS 轮换证书后的服务级重试已通过；其被动观测结果进入 current-head Observer/Canonical 仍未验证。
- k3s LangGraph 每个语义事件与 KernelFact 的唯一所有权、双向深链和 UI 证据展示。
- existing formal 旧 digest 替换为 current-head OCI、canonical GET 正式切换，以及 `critical_inbox_dropped` 的根因/修复前后对照仍未验证；临时 API/Web overlay 的 contracts GET 仅覆盖局部路径。

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

临时 loopback API 在本地复核时可返回 `GET /security-center/v1/observability/contracts` 的目录版本；
该 canonical GET 尚未部署到当前旧 digest 的 AnySentry 环境。目录版本如下：

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
- 当前 tracked repository hygiene 为通过；credential scan 仍发现若干既有
  untracked/protected credential-like runtime 文件。它们的 tracked finding 为 0，本地测试期间
  不删除、不覆盖；因此凭据清理项仍单独标为 blocked，不能把它们提交或写入报告；
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
GET  /security-center/v1/logical-agents[/:logicalAgentId[/instances]]
GET  /security-center/v1/agent-instances[/:agentInstanceId[/runtimes|/sessions]]
GET  /security-center/v1/runtime-instances[/:runtimeInstanceId]
GET  /security-center/v1/sessions[/:sessionId[/timeline|/coverage]]
GET  /security-center/v1/semantic-events/:semanticEventId/evidence
GET  /security-center/v1/kernel-facts/:factId/context
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
ANYSENTRY_ADMIN_TOKEN=verify-canonical-entity-admin node scripts/verify-deep-links-local.mjs scripts/verify-canonical-entity-get.mjs
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
node scripts/verify-repository-hygiene.mjs
# A3S Test TUI (host CLI and tender_jang CLI variants)
a3s-test check tests/e2e/a3s-cli-codex-smoke.acl --json
a3s-test check tests/e2e/a3s-cli-claude-smoke.acl --json
a3s-test check tests/e2e/a3s-tender-codex-smoke.acl --json
a3s-test check tests/e2e/a3s-tender-claude-smoke.acl --json
```

Observer 当前本地验证结果：

```bash
cargo fmt --all -- --check
cargo build --locked --offline --workspace --release
cargo test --locked --offline --workspace --release
cargo clippy --locked --offline --workspace --exclude a3s-observer-ebpf \
  --all-targets --all-features --release -- -D warnings
```

当前 Observer `3a827bf` 结果为 212 项测试通过（root 32、workload contract 7、collector
165、common 8）；identity scope tests 与 TLS capability boundary 另行通过；fmt、workspace check/release build 和 clippy
通过。为绕开共享节点 BuildKit 阻塞，本地交付使用受 loopback 限制的
`scripts/publish-local-oci-overlay.mjs` 生成增量层：API/Web manifest `sha256:b382…`、Observer
binary/scripts manifest `sha256:fd31…`；上传前只校验本地 registry，未向远程 registry 写入。
`a3s-observer-ebpf` 是 no_std/no_main 的专用 BPF target；在
普通 host 上直接以 `--features build-ebpf` 做宿主链接会触发 unwinding 限制，正确门禁是
Collector 的 `aya_build`（本次 workspace build/test 已生成 BPF object），不能把该宿主链接
命令写成 eBPF attach 通过。

AnySentry `4fbd077` 的 publisher 已输出 `rootPid`、`rootStartTimeTicks` 和 `agentInstanceId`
fence，并在同一 cgroup 中保留 distinct entries；它与 Observer `3a827bf` 的 generation/cgroup/
ancestor fail-closed 规则共同解决旧 mixed-scope broad-admit。两侧合同必须一起 rollout。

额外的本地特权 load smoke 使用当前 Collector 构建产出的 BPF object，通过 Aya `Program::load`
逐项加载 `tls_write`、`tls_sendto`、`http_writev` 和 `exec`，结果全部成功；旧实现曾在
`http_request_route_kind` 的内联路径扫描/hash 上报 `BPF program is too large. Processed 1000001
insn`。前序 verifier 修复提交为 Observer `20a8aa4`，只把有界路径 hash 移到 `bpf_loop`
callback；当前 checkpoint `3a827bf` 进一步按 process generation/cgroup/祖先链 fail-closed，
mixed scope 不 broad admit，未改变固定 ABI。该 smoke 不执行 tracepoint attach；现有节点已有 Observer，实际完整 attach/目标
workload 转发仍按环境矩阵标记为未验证。

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
- 总门禁 `verify-canonical-goal.mjs --run-tests` 已在修复日期依赖后重跑；代码局部检查为绿，
  但环境矩阵仍会因 Host/SSH 未提供目标、凭据扫描发现既有 protected runtime 文件而报告
  `partial/blocked`。这类状态不能改写成完成；正式 API/Observer 当前已切换的 digest 与
  Forwarder WAL/节点 I/O 降级另见本节运行补充。

### 5.2.1 2026-09-04 运行补充（历史快照）

以下是本回合新增的本地运行证据。它们与上面的合成回放/浏览器门禁分开记录，避免把
产品级闭环误写成 Observer 被动采集通过。

| 证据 | 结果 | 当前解释 |
| --- | --- | --- |
| `tender_jang` 运行时盘点 | `node:24-bookworm`；Codex 0.149.1、Claude Code 2.1.251；LangChain 1.3.17、LangGraph 1.2.11 | 容器无 published port、Docker socket、Docker CLI；可运行库不等于容器编排或 Observer 接入 |
| Codex/Claude 本地 fixture | 各两阶段请求—ToolCall—ToolResult—final 成功 | 协议/适配器闭环；非被动 eBPF 证据 |
| `tender_jang` A3S Test TUI | 容器内 Codex 0.149.1、Claude Code 2.1.251 均通过对应 TUI suite；各有 ToolCall/ToolResult/final marker 和非敏感 terminal recording | 真实容器 CLI 版本通过产品级 fixture；Observer 当前可见 Kernel/SSL 计数，但没有把该次调用宣称为唯一 Canonical EvidenceLink |
| LangChain 临时 HTTP 副本 | 工具闭环 HTTP 200 | HTTP transport 与工具结果回传可验证 |
| LangChain 常驻 HTTPS | 已轮换本地测试 CA/server cert，仅重启 fixture/service；`/health=200`、HTTPS `/invoke=200`、1×`lookup_fixture`，旧证书备份已清理 | 服务级 HTTPS/工具闭环已恢复；其流量是否进入 current-head Observer/Canonical 投影仍未验证 |
| Dify 实际重跑 | LLM/tool 两个 workflow 均 HTTP200、脚本 rc0；debug reconciliation curl 因测试 CA 校验失败 | workflow 运行通过，hash reconciliation partial |
| Dify Durable API | exact `detectedName=dify-observation-lab` 当前快照 55 事件（Egress44/ToolExec8/LlmInteraction3）；captureSelected55；identity exact54/weak1 | correlation method 全 unassigned；统一证据 partial |
| k3s LangGraph `/runs` | namespace `anysentry-observability-lab` 的本地服务 `/healthz=200`；本回合 POST/GET 均 200、`completed`；节点 `planner → code_generator → verifier → code_generator → verifier → finalizer`；sandbox exit0、未超时/未截断、verification pass；telemetry accepted15 | 真实服务 Run 语义通过；对应 sandbox runner KernelFact 已捕获，但仍以 physical_workload 关联，尚未形成 root-generation/LogicalAgent 唯一 EvidenceLink |
| k3s LangGraph sandbox KernelFact | 同一 Run 的两个 sandbox runner generation 各有 `ToolExec=1` + `ProcessExit=1`，合计 Exec2/Exit2；`captureSelected=1`、`agentHasPhysicalIdentity=1`；`correlationMethod=physical_workload`、confidence0.70，`agentHasRootIdentity=0` | 证明 sandbox 内部受限 Python 执行进入 Observer Kernel lane；当前旧链仍未把语义 AgentTool 与 KernelFact 建立 Canonical 双向深链 |
| k3s LangGraph 失败 Run | 复杂目标 `RuntimeError`，仍上报 3 个事件 | 失败路径保留事实，不能计为成功 Run |
| Durable Session 查询 | `detectedName=langgraph-workflow-sandbox-agent`，19 事件（LlmInteraction10、AgentTool3、AgentInvocation3、ToolExec3） | `correlation unassigned=13`、`agent_adapter=6`；两条 lane 尚未统一 |
| 历史真实 Interaction | Codex、Claude Code、LangChain 曾有真实 LlmInteraction | 仅作历史能力证据，不覆盖当前实例 |
| 当前 SSH Codex（durable custom-window 初始快照，2026-09-03 16:14–16:22Z） | native PID 1101287：60 `LlmInteraction`，全部 parsed/confirmed、HTTP 200、captureSelected=true、wire/transport complete；model56、tool4 | Observer 协议解析通过；后续异步快照计数可变化，identity/session/run 仍非 authenticated AgentAdapter/confirmed Session |
| 当前 SSH Codex（后续 `agents/interactions` 快照） | 约 63 records：model57/tool4 + 2 unsupported/unparsed；parsed61；complete6/partial55/unsupported2；toolCalls61/toolResults57/semanticItems125；request roles 覆盖 `user`、`developer`、`agent_message`、`custom_tool_call_output`、`function_call_output`、`compaction` | 当前 SSH 对话进入 semantic lane；Canonical 新证据仍按 hash/metadata-only，不复制旧读模型正文 |
| 当前 SSH Codex 明文证据 | 2 条 `AgentPlaintextEvidence`，`captureSource=tls_uprobe_rustls`、`encoding=metadata_only`、`parseState=unparsed` | 不能据此写成正文原文完整落盘；原文可见性仍 partial |
| 当前 SSH Codex Tool/Evidence | tool4 parsed/complete，toolCall4/toolResult4；model57 parsed 且 request/response wire complete；conversation complete2/tool_pending55；选定 Tool inspector 404 | Tool 协议闭环有事实，统一 EvidenceLink partial |
| SSH 早期窄窗口（历史快照） | 曾为 17 Egress、0 LlmInteraction | 仅作旧时间窗对比，不代表当前 durable custom-window 状态 |
| 权限/部署 | 特权 `hostPID` Observer Pod 可见宿主；普通 SSH `CapEff=0`、`unprivileged_bpf_disabled=2`；API/Observer 已切换本地 overlay，仍有 static signature warnings 和 Forwarder backlog | 特权 Pod 的 attach/可见性不能代替四环境唯一深链；节点 I/O、数据库 timeout 与 batch reject 仍按 Coverage/WAL 保留，不伪造为零丢失 |
| 当前正式本地交付 | API/Web `sha256:b382…`、Observer `sha256:fd31…` 已在本地 k3s Ready=1/restart=0；API NodePort `/healthz`、Contracts GET 和 Web bundle 200；Observer attached=73 probes | OCI overlay 复用旧依赖基座；Forwarder WAL 约 170 MiB 且曾出现 API batch reject/数据库 timeout，持续零丢失和四环境统一深链仍 partial |

上述结果的证据等级为：版本/状态/计数、初始 60 条与后续约 63 条 Interaction 的解析字段和
2 条 metadata-only 证据是**已确认事实**；“协议已解析不等于正文已完整保留”、早期
Egress-only 与当前窗口的
差异是基于状态和协议边界的**推断**；当前 SSH authenticated AgentAdapter/confirmed
Session、原文完整读取、容器被动捕获、LangGraph 逐事件唯一 EvidenceLink 和 canonical GET
新部署仍是**未验证**。因此本地实现
状态保持 `partial`，不报告 Goal 完成。

### 5.3 四类代表对象矩阵

| 代表对象 | 当前本地实际验证 | Kernel/Evidence | Session/连续轮次 | 结论 |
| --- | --- | --- | --- | --- |
| Codex CLI | `tender_jang` 真实二进制 0.149.1；A3S Test TUI 两阶段 ToolCall/Result/final 通过；SSH durable 历史窗口仍为约 60–63 条 | 产品级 fixture 通过；SSH 旧 Observer 有 tool4 parsed/complete，但 Rustls plaintext 为 metadata-only/unparsed、正式 current-head 被动投影未验证 | TUI 运行边界明确；SSH identity/session/run 仍非 authenticated/confirmed | tender 产品级 pass；正式 Observer/Canonical partial |
| Claude Code | `tender_jang` 真实二进制 2.1.251；A3S Test TUI HTTPS 两阶段 ToolCall/Result/final 通过 | 产品级 fixture 通过；未把宿主版本失败/成功外推到 tender 之外 | 两阶段产品调用通过 | tender 产品级 pass；正式 Observer/Canonical partial |
| Dify Workflow/Chatflow | 既有本地 Docker Dify 1.14.2；本回合 LLM/tool 两个 workflow 均 HTTP200、脚本 rc0；debug reconciliation curl 因测试 CA 校验失败 | durable `dify-observation-lab` 55 事件：Egress44/ToolExec8/LlmInteraction3、captureSelected55、identity exact54/weak1；correlation 全 unassigned；hash 对账 partial | 无 conversation 的 POST 仍按 per-request；本回合未证明内部 node 与 Kernel 唯一关联 | workflow pass；hash/统一证据 partial |
| LangChain/LangGraph | LangChain 常驻 fixture 轮换证书后 `/invoke=200`；k3s LangGraph 本回合 Run completed、sandbox exit0/verification pass、telemetry accepted15；另有历史 RuntimeError 仍上报 3 事件 | 本回合 sandbox KernelFact 为 ToolExec2/ProcessExit2、physical_workload confidence0.70；既有 Durable Session 19 事件（LlmInteraction10/AgentTool3/AgentInvocation3/ToolExec3）仍有 `correlation unassigned=13`、`agent_adapter=6` | 服务/沙箱运行通过；root generation、Canonical Tool→Kernel EvidenceLink 和正式 UI 未完成 | 运行与统一证据 partial |

“产品级 loopback pass”只证明真实 CLI 能在合成 provider 上完成请求—工具—结果—最终回复，
不等于 Observer 已捕获这些字节。正文、KernelFact、EvidenceLink 和 Coverage 的真实被动
采集仍需具备权限的专用节点复测。

### 5.4 Host / SSH / Docker / Kubernetes

| 环境 | 当前状态 | 证据与限制 |
| --- | --- | --- |
| Host | partial | 本地 API/Web 构建和 CLI loopback fixture 已通过；普通 UID/SSH shell 的 `CapEff=0`、`unprivileged_bpf_disabled=2` 无直接 eBPF attach 能力，不能把 Host 结果当 Observer 被动闭环 |
| SSH | partial（协议解析、身份/正文/统一证据 partial） | VSCode SSH `notty` 链 native PID 1101287 在 2026-09-03 16:14–16:22Z durable custom window 初始有 60 条 parsed/confirmed/complete `LlmInteraction`（model56/tool4），后续异步 `agents/interactions` 约 63 records（model57/tool4 + 2 unsupported/unparsed）；另有 2 条 `tls_uprobe_rustls` metadata-only/unparsed。identity/session/run 仍 runtime/probable 提示，非 authenticated AgentAdapter/confirmed Session |
| Docker | partial | Docker daemon、Compose config 和既有 Dify 栈健康；`tender_jang` 内 Codex/Claude/LangChain/LangGraph 运行库及 CLI TUI 已验证，但无 Docker CLI/socket；当前容器产品级结果不等于 Observer/WAL/Canonical 独占闭环 |
| Kubernetes | partial | k3s LangGraph `/healthz` 与 `/runs` 真实调用、durable 查询可用；workspace-scanner、API 和 Observer 已切换本地 digest/path，Ready/restart=0；Observer attached=73 probes，但 WAL backlog、数据库 timeout、scope conflicts 和共享节点 I/O/etcd 抖动使四对象唯一深链仍 partial |

Kafka/Flink 只在已有可选 profile 中保留，未成为 Canonical 主链前置依赖；本阶段不新增时间窗
功能。Kubernetes/ Docker 的旧服务健康不被用来冒充当前工作树部署通过。

## 6. 当前限制、回滚和后续扩展

### 6.1 已知限制

1. 当前 host shell eBPF 权限不足；BPF object 的特权 load smoke 已通过，但真实 Observer attach、目标 workload 的 Ring/WAL 丢失率和生产性能没有通过证据；
2. Codex 当前 HTTPS/Rustls 路径没有可发布的被动明文保证；HTTP/2、QUIC 及协议特定边界仍需独立项目；
3. 运行器对超大 body、断流或 declared limit 可能只有 drop/truncation Coverage，尚未为所有情况生成 metadata-only partial interaction；
4. 无 Hook/Trace Adapter 时，Dify 内部 node、LangGraph checkpoint 和进程内工具开始/结束只能是 partial/semantic_only；
5. Host 当前没有 durable ClickHouse/PostgreSQL，Canonical hot state 可查但重启后不等价于持久化验证；
6. Relational sink 的兼容 bool 返回值尚未细分 conflict 与 unavailable；
7. `tender_jang` 虽有 CLI/框架运行库，但无 Docker CLI/socket；容器内产品级 fixture 不能替代当前头镜像和 Observer 端到端部署；
8. LangChain 常驻 HTTPS 测试证书已轮换，服务级 `/invoke=200`；current-head Observer 已运行并看见同窗 Kernel/LLM 计数，但该服务调用尚未取得唯一 Canonical Tool→Kernel EvidenceLink；
9. k3s LangGraph 已有真实 `/runs` 和耐久事件，但 `correlation unassigned=13`、`agent_adapter=6`，两条证据 lane 尚未统一；
10. 当前 SSH Codex durable custom-window 初始快照为 60 条 parsed/confirmed/complete `LlmInteraction`（model 56、tool 4），后续异步 `agents/interactions` 可到约 63 records（model57/tool4 + 2 unsupported/unparsed；complete6/partial55/unsupported2）；identity/session/run 仍为 runtime/probable 提示，2 条 Rustls plaintext evidence 是 metadata-only/unparsed，且 conversation complete2/tool_pending55、选定 Tool inspector 404；普通 SSH `CapEff=0` 且 `unprivileged_bpf_disabled=2`，不能据此声称正文原文完整可见；
11. API/Observer 已切换本地 overlay digest，Canonical GET 在 NodePort 已复验；Forwarder WAL backlog、ClickHouse/PostgreSQL timeout、静态 signature warnings 和节点高 I/O 仍未消除，持续可靠性/零丢失尚未通过；
12. AnySentry `4fbd077` 与 Observer `3a827bf` 已加入 mixed-cgroup fence，并已在本地 DaemonSet rollout；仍需在低负载窗口完成 WAL 清空/回放和四对象唯一关联验证；
13. 临时 namespace `anysentry-goal-dist-20260904` 的旧镜像 + 只读 `/app/dist` hostPath fallback 已清理；它不能替代 current-head OCI 镜像部署；
14. API/Web overlay `sha256:b382…` 与 Observer binary/scripts overlay `sha256:fd31…` 已在本地 registry 发布并切换 formal workloads；它们复用旧 runtime 依赖基座，原始 Dockerfile 全链仍受 daemon/IO 阻塞，Forwarder 长跑 backlog/批次拒绝和 EvidenceLink 唯一归属仍是缺口；
15. URL/hash、正文权限、30 天保留和生产容量/成本仍需安全负责人和部署环境单独批准。

### 6.2 回滚点

- 采集回滚：关闭 `A3S_OBSERVER_SSL`，或移除精确 `A3S_OBSERVER_TOOL_HTTP_ROUTES`；Observer
  仍保留 Kernel-only 事实；
- 解析回滚：停用某个 Adapter/Transport registry 版本，保留 RawObservation 和旧兼容投影；
- 身份回滚：Canonical Directory/Timeline 与旧 V1/V2 binding 并行，关闭新 feature flag；
- 存储回滚：恢复旧 API/镜像时不删除新表；停止新事件后再切换读模型，历史事实保留按 TTL 治理；
- rollout：publisher、Forwarder 和 Observer 的 identity fence 是同一兼容单元；升级/回滚都必须原子执行，避免新旧 mixed-cgroup 语义并存；
- 本轮本地镜像回滚：API/Worker 原基线为 `127.0.0.1:5000/anysentry@sha256:2a7e…`，当前 API 为
  `sha256:b382…`；Observer 原基线为 `sha256:644ed…`，当前为 `sha256:fd31…`。回滚只针对
  精确 Deployment/DaemonSet image 字段，先保存 revision，再执行 rollout status；不删除数据卷。
- Workspace Scanner 当前 digest 为 `sha256:7a20…`，旧 `/srv/...` hostPath 不存在，不能盲目回滚
  到该路径；先通过 `verify-k8s-workspace-path.mjs` 验证节点目录，再决定回滚。
- 本地代码回滚：使用本地 checkpoint commit 的父提交或按文件反向恢复，经 `git diff`、build
  和回放复验后再操作；本 Goal 不执行 reset/checkout 或远程推送。

### 6.3 后续接入步骤

先补具备权限的 Host/SSH/Docker/Kubernetes 真实运行 envelope，再分别推进：Rustls/Go TLS、
HTTP/2/WS/QUIC、Dify Trace/Hook、LangGraph checkpointer、独立加密 Content Store、typed
durable sink result 和性能压测。Kimi、Z.ai、Pi 只按 Manifest → fixture → Shadow →
Candidate → Confirmed 接入；Kafka/Flink 只作为未来的时间窗派生支路。

## 7. 凭据、日志与交付声明

本地验证使用的管理/session 值只在进程环境或受保护临时目录中短时存在；本回合的请求使用
本地受控 fixture/服务，未把真实 API key、URL 中的密钥、Cookie、Authorization、完整真实
Prompt、生产 transcript 写入仓库、日志、Trace、OCI layer、Kubernetes YAML、数据库或
本文。OCI 增量层只来自编译产物和 Observer 二进制/脚本，发布器强制 loopback registry；
临时 fixture/runner 目录已按精确路径清理，`.a3s-test/` 只保留非敏感终端记录并被忽略。
既有用户保护文件保持原状。最终交付不包含任何秘密值，也没有执行远程 push、PR、远程分支或
公共镜像发布。

## 8. 2026-09-05 续回合：当前头部署、Canonical locator 与现场边界

本节是本地 Goal 续回合的最高优先级事实记录；前文较早回合的版本、镜像和计数只用于
追溯，不覆盖本节。所有请求都在本机执行，正文和凭据不写入本文件。

### 已确认事实

| 项目 | 当前结果 | 证据边界 |
| --- | --- | --- |
| 本地 checkpoint | AnySentry `e96160c`（含 `73bb804` 的 Canonical side-lane/locator 修复）；Observer `40556f5`（r7 body-release/backpressure） | 只在本地分支提交，未执行 push、远程 PR 或公共镜像发布；用户已有未跟踪资料未改动 |
| API/Web 当前交付 | 本地 OCI manifest `sha256:8c8d407a7a585eb5100629223d3664cb8eb238093dd1f8fcb027df586d9ca20a`；Pod `anysentry-bc77d7f4f-nkxcc` `1/1`、restart 0；源码标记 `AnySentry@73bb804+kernel-locator` | 由 `apps/api/dist` 与 `apps/web/dist` 增量覆盖已验证运行时基座；不是远程 registry 发布 |
| Web 部署边界 | API 镜像同时承载 `/app/dist` 与 `/app/web`，同源 NodePort `32653` 提供页面和 API；没有独立 current-head Web Deployment | 这是有意的单镜像边界，不是漏部署；本地 NodePort patch 现在显式含 `selector.app=anysentry`，避免三方 apply 清空 endpoints |
| 未变更服务 | fast-judge/l3-worker 恢复到原本的本地 digest `sha256:2a7e0c6c…`，Ready；没有因 API r27 重建 | 直接 apply 核心 YAML 曾短暂产生远程 `:latest` ImagePullBackOff，已恢复并把本地 digest 固化到清单 |
| Canonical side-lane GET | Raw/Kernel/Semantic/Evidence/SessionMembership list/detail 统一有界；耐久读超时回退 hot store 并标 `coverage=partial`/`dataSource=memory_hot_ring`；有效但不可用的 point read 返回 503，真实不存在仍 404 | 隔离 `verify-canonical-entity-get`、deep-link verifier、ClickHouse query-bound verifier 均通过；不把空列表解释成完整历史 |
| KernelFact locator | `kernel_fact_locators_v1`（ReplacingMergeTree，按 `kernelFactId` 排序，90 天 TTL）及 forward-only MV 已在正式 ClickHouse 创建；bootstrap 没有历史 `INSERT/MATERIALIZE`；一条合成 ToolExec 事件生成 locator 并可查询 | 新事件走 PG → locator → eventId point read；旧历史无 locator 仍走最多 7 天、受 1 秒 controller deadline 的兼容扫描，超时保留 503/coverage gap，不伪造事实 |
| live locator smoke | 合成事件 `evt_b4f00fd5cd37c066` 对应 `kf_9cfa32be97905e351d6d6485`；MV 表 1 行，PG side row 1 行；Canonical detail HTTP 200、`dataSource=canonical_kernel_fact_store` | 该事件只用于本地可复核链路，未输出其命令正文；旧 LangGraph `kf_022…` 仍因历史无 PG/locator 且大表扫描受限而可能 503，这是明确降级而非 404 |
| Candidate policy | `probable_agent` 保留 observed/detected provenance，默认 effective capture/judgment 与 `confirmed_agent` 同档；无需人工 token 才能采集；管理 review 仍只用于显式身份变更（unknown/non-agent 等） | 不创建虚假 LogicalAgent/Session；`ANYSENTRY_CANDIDATE_EFFECTIVE_MODE=probable` 才启用历史低成本档位 |
| TLS policy | Codex/Claude 通过 implementation-family/ABI registry 选择 attach；manifest 中无具体版本 selector；极端 ABI 通过独立 capability extension 接入并复用 Parser/Correlation | 测试版本号只写在运行矩阵中，不是核心过滤条件 |
| a3s-test | tender Codex `a3s-test-1605080-1`、Claude `a3s-test-1606611-1`；Host Codex `a3s-test-1875658-1`、Claude `a3s-test-1878354-1` 均 PASS；host fixture 已改为自解析绝对仓库路径 | TUI 记录只含完成 marker/字节计数；`a3s-test capabilities --json` 的浏览器能力因本机 a3s 版本缺少 `use` 仍不可用，未标浏览器通过 |
| tender_jang LangChain | 常驻 service `/health=200`；一次 bounded `/invoke=200`，工具 `lookup_fixture` 只调用 1 次且结果 marker 存在 | 服务级功能通过；Observer 当前暂停，不能把这次调用写成最新被动 eBPF/Canonical 深链 |
| k3s LangGraph sandbox | 已有真实 `/runs`：completed、两次 sandbox HTTP 200/exit 0、telemetry 15/15；Observer 曾捕获同窗 ToolExec 2 + ProcessExit 2 | Kernel lane 真实捕获通过；语义 Tool→Kernel EvidenceLink 仍 `semantic_only`/`tool_result_pending`，不宣称统一关系完成 |
| Observer 现场 | r7 镜像 `sha256:45af6fa26c2c9e71aeec744edf1b3069362cef60f5fba33428429187a1fddbda` Ready；为保护 WAL，Pod 内 collector/forwarder 精确 PID 仍 `SIGSTOP`；WAL 约 4.23 GB，cgroup memory 约 2.138/2.147 GiB，OOM kill=0但 critical drop 已发生 | 暂停窗口不能算稳定性通过，也不能用于声称当前 SSH/LangChain/Dify 新请求被动捕获 |
| k3s 节点稳定性 | 节点 `Ready`、Memory/Disk/PIDPressure false、API `/readyz` ok；高负载期间 I/O wait/ClickHouse 57.7 GiB events 表和 Observer WAL 造成超时；`a3s` namespace 另有旧 registry CrashLoop（迁移缺失/拉取凭据问题） | 主要是共享节点/旧基线/下游存储压力；AnySentry 侧已修复 image pin、NodePort selector、Canonical 查询放大；未擅自修改无关 `a3s` 服务 |

### 权限与术语解释

- **eBPF 权限隔离**：普通 SSH/Codex 进程只负责被观察，当前 `CapEff=0` 且内核
  `unprivileged_bpf_disabled=2`，不能自行加载/附着 eBPF，也不能把这种权限传给子进程。
  Observer 以 `privileged + hostPID` Pod 运行，才拥有加载程序、读取宿主 `/proc` 和按
  cgroup/process-generation 建立 scope 的能力；这不等于它能读取所有明文，仍受 TLS ABI、
  精确 route、进程代次和有界复制门禁约束。权限不足时只留下 Kernel candidate/CoverageGap，
  不伪造明文。
- **本地 Kubernetes runtime**：本机 k3s（containerd）中的 Pod、Service、Deployment、
  ConfigMap、Secret、hostPath 和 NodePort 组成的运行时，不是云端集群或远程发布环境。
  `anysentry-observability-lab` 的 LangGraph agent/sandbox 是该 runtime 中的应用工作负载；
  `anysentry` namespace 的 API/ClickHouse/PostgreSQL/Observer 是正式本地观测链。没有
  NodePort 的 ClusterIP 服务只能在 Pod 内或临时 port-forward 访问。
- **分类管理**在本阶段只管理“观察到的身份、工作负载角色、采集档位、证据权威/来源”四个
  维度，不执行阻断、干扰或自动修复。Candidate 与 Confirmed 的采样档位一致，但 Candidate
  仍不自动冒充已注册 LogicalAgent；未知产品仍保留 KernelFact 与 CoverageGap。

### 当前结论与未决项

当前状态仍为 **partial**，不是完成：代码/合同/局部部署和产品级 TUI/服务级运行已通过，
但 Observer 为保护性暂停、WAL/节点存储压力未形成稳定零丢失证据；当前 SSH Codex 的
WebSocket/Rustls 明文仍是 metadata-only/unsupported 边界；LangGraph/Dify 的跨 lane
Canonical EvidenceLink、正式 UI 双向深链和所有环境持续 p95 尚未通过。后续应在低负载或
独立节点恢复 Observer，排空/分段回收 WAL 后再做一轮真实连续对话；不得删除 WAL 或以
提高采样丢弃来制造“稳定”。

总门禁 `node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-20260905-r27.json`
本回合为 `pass=57, partial=2, blocked=7, unexecuted=7, fail=0`；退出码为 0 只表示报告生成，
不改变上述 partial 结论。Observer 暂停后的 heartbeat 已 stale，WAL 与历史 drop 计数仍保留，
未被清零或覆盖。

## 2026-09-05 续回合增量：r33 实体 GET 与通用 OTLP 语义

本节覆盖 `47e1e06` 之后的本地实现和部署；早期 r27/r32 镜像、Pod 名和统计只保留为历史
追踪，不得覆盖这里的当前事实。

### 已确认事实

| 项目 | 当前结果 | 证据边界 |
| --- | --- | --- |
| AnySentry 当前代码/镜像 | AnySentry `47e1e06`（功能主体 `72d5f58`、`80fdadf`、`2f9ded2`、`a6eae68`）；API/Web 本地 OCI `sha256:e7e229e27b24875b22ea271313b9c59e94cdc4c2453f1e5b6f40383caa11847a`（r33）；Pod template annotation 与 image 一致 | 只写 loopback registry；未执行远程 push/PR |
| Canonical entity GET 根因 | 原 `/v1/logical-agents` 等 GET 调用 V4→V3→V2 兼容目录，强制构造最多 200 条 body-rich Interaction，且把约 5k runtime-only 行一起 fan-out；一次 `limit=1` 内部仍约 8.8 MB，压力下可无响应 | 由正式 Pod 的 HTTP timeout、ClickHouse query log 和 Node Inspector stack 复核 |
| GET 修复 | 旧目录接口尊重显式有界 `limit`；Canonical 目录请求设置 `includeRuntimeOnly=false`、页级上限；LogicalAgent 仅用一次 RuntimeState snapshot 和 identity map 补回候选/未知 runtime；RuntimeState.list 只 clone 返回页 | 保留旧 POST 兼容接口；精确正文/usage 仍可能走兼容 projection，覆盖状态必须标 partial |
| r33 GET 现场 | NodePort `http://127.0.0.1:32653`：logical-agent 约 0.45 s、agent-instance 0.09 s、runtime-instance 0.08 s、session 1.73 s，均 HTTP 200；20 个并发小页均 HTTP 200、无 API restart | 当前 API/ClickHouse/PG 健康窗口；不是生产容量承诺 |
| OTLP run/identity | 通用语义事件新增 `WorkflowNode/workflownode` 归一为 `NodeRun`；`anysentry.run.id`/`anysentry.run_id` 与标准 run aliases 进入 Producer correlation；受信 `agent_adapter` Source 对同一 trace 的 LlmApi/Node/Tool/Result 使用同一 enrich gate | 不按产品或版本分支；无 Adapter policy 的普通 OTLP 仍不获受信身份 |
| OTLP Tool 语义 | `gen_ai.tool.name`、tool-call ID 和 endpoint 进入统一 Interaction；endpoint 去除 userinfo/query/fragment，端口/路径有界；完成的单 Span `AgentTool` 生成 hash/ref-only ToolResult，exit/error 只来自显式属性 | 不复制 arguments/result 正文，不把 ToolResult 当 KernelFact |
| 统一关系算法 | semantic-only Interaction 仍保留 legacy `interactionType=model`，但通用 relation matcher 接受其明确 ToolCall endpoint；Egress/DNS/TLS 仍需 Runtime、时间和唯一候选，竞争候选保留 ambiguous | 纯单元与 S6 隔离 API 测试通过；跨 Runtime sandbox runner 仍不是父子关系 |
| 正式 Pod r33 smoke | 使用一次临时、无秘密的三-span OTLP trace：NodeRun/LlmApi/AgentTool 均 HTTP 201、`runIdSource=producer`；Interaction 显示工具名 `sandbox_execute`、脱敏 endpoint、1 个 ToolResult | Source 测试结束已禁用；只报告元数据，不报告 token/正文 |
| 代表服务盘点 | `tender_jang` 有 LangChain 1.3.17 常驻 `/health=200`/bounded `/invoke=200`；没有常驻 LangGraph Uvicorn，仅安装库；k3s sibling 有真实 LangGraph agent+sandbox | 服务存在不等于 Observer 被动捕获通过 |
| Observer/WAL | Pod Ready 但 forwarder/collector 仍由 root 精确 PID `SIGSTOP` 保护约 4.23 GB WAL；此前 critical/output drop 已记录，OOM kill=0 | 暂停窗口不能当稳定性通过；未清理/删除 WAL |

### 目标设计与未决边界

- Canonical entity GET 的长期主路径仍应演进为 `RuntimeState + SessionMembership + SemanticRecord`
  的 metadata-only index；当前 r33 是兼容目录的有界修复，已经消除本次无响应，但尚未把
  body-heavy `agentConversationProjection` 完全从所有实体读路径移除。
- `AgentTool`、`LlmApi`、`WorkflowNode` 等语义事件只通过通用 OTLP/Adapter contract 接入；
  TLS/版本不参与核心分支。未来若某一实现族的大版本需要特殊 attach，只增加独立 capability
  manifest/adapter，不复制 Transport/LLM/Correlation 主链。
- sandbox 容器内 runner 是独立 physical workload；Agent 进程到 sandbox Service 的 Egress 可
  通过 endpoint/port 形成 `linked_strong`，但跨容器 Exec/Exit 没有父进程时只能
  `semantic_only`/`coverage_gap`，不能强连。

### 本增量测试命令

```text
pnpm build
pnpm --filter @anysentry/api exec tsc --noEmit
node scripts/verify-agent-runtime-state.mjs
node scripts/verify-agent-semantic-kernel-relation.mjs
node scripts/verify-s6-tool-evidence-linker.mjs
node scripts/verify-s6-tool-evidence-relation.mjs
ANYSENTRY_ADMIN_TOKEN=<temporary-fixture> ANYSENTRY_TRUSTED_CORRELATION_MODE=shadow \
  node scripts/verify-deep-links-local.mjs scripts/verify-s6-tool-evidence-api.mjs
node scripts/verify-deployment-manifests.mjs
```

以上命令在本回合通过；正式 Observer 未恢复，故没有把新的被动 Kernel/LLM 捕获写成通过。

## 2026-09-05 续回合增量：当前 head 镜像、探针合同与运行门禁

### 已确认事实

| 项目 | 当前结果 | 证据边界 |
| --- | --- | --- |
| Observer 本地 checkpoint | `2eeb562`、`f3899a2`、`fb531aa`；AnySentry `d50a873`、`cf918e1` | 均为本地 commit，未执行远程 push；用户既有未跟踪文件未改动 |
| Observer 镜像 | loopback digest `sha256:9b8af95d4c44658a2e7dabe48a2cbadfaf399a279de87de4fe72366f0195bccf`；Collector 文件 SHA-256 `0f3dbb705368a1a49e5baed3d178d93b91c320188eccedc50f61c7065afe5a6f` | 镜像由 scripts overlay + 当前 release Collector binary 组成；Kubernetes Pod imageID 与 digest 一致 |
| Observer supervisor | 新增 `/run/a3s-observer.alive`，启动立即写入、每 10 秒更新时间、退出清理；Pod `a3s-observer-zlqxv` 曾以 restart=0 Ready 运行 | 探针与实现合同已对齐；当前稳定窗口仍受节点 I/O 影响 |
| eBPF method 边界 | shared `classify_http_method_prefix` 按 RFC token 识别扩展 method；eBPF/Collector 复用同一 classifier；额外 TLS process patterns 有数量/长度/控制字符限制 | 未引入产品名/版本号核心分支；225/176 项 Observer 定向测试通过 |
| 压缩 SSE | 无 `Content-Length` 时用有界解压结果进行 framing，原始 compressed bytes 仍保留为 canonical body/hash；超 2048 个事件产生 `sse_event_limit` 并降级 partial | gzip SSE、SSE event limit、已有 Collector 全测试通过 |
| AnySentry API 镜像 | loopback digest `sha256:58d24f523381551cbd03bb8202e9d453d5fa011e5144a801e1b2656e808e3dec`；活动 ReplicaSet `anysentry-67c8bb676b` Ready | Deployment 顶层、PodTemplate、活动 ReplicaSet image/provenance 均通过 `verify-live-image-provenance.mjs` |
| Source trust binding | managed Observer Source 使用 `observer_runtime` + collector allow-list；workspacePath 清空且不再从容器 rootfs 路径学习；当前 source lastResult=accepted | 旧约 90k workspace mismatch 不再新增；历史 rejected 计数保留 |
| Collector heartbeat | API 已解析并展示 cumulative `interactionReassembly` counters；当前活动 Collector 最近快照 counters 为 0，S5 snapshot/ACK 文件存在 | health 仍可能显示 degraded，因为历史 drop/WAL 和旧 down collector 仍在时间窗内 |
| 运行时 attach | 当前 Pod `attached=24/25`，基础 exec/network/dns/security/ssl tracepoint 正常；Rustls/静态 TLS attach 仍产生 `unsupported_tls_profile` 或 verifier/ABI coverage gap | 没有伪造 Rustls HTTPS 明文；Codex/Claude 当前 SSH Rustls/WebSocket 仍不算完整被动明文通过 |

### 目标设计与推断

- eBPF 热路径只保留固定事件和低复杂度 gate；未知 HTTP method 的通用识别与扩展解析在共享 contract/用户态完成。这样可以维护 fail-closed 边界，同时避免一个可选 route 分支阻塞 TLS metadata probe。
- verifier 长日志属于诊断路径故障，已通过 2 KiB 截断避免 Collector 因 stderr 管道耗尽而退出；这不会把 attach 失败改写成成功，仍会保留 `unsupported_tls_profile`/coverage gap。
- Candidate/Confirmed 采集档位继续相同；Unknown 或未匹配 TLS 只保留 KernelFact、候选和 CoverageGap，不升级为明文成功。

### 本增量验证命令

```text
Observer:
  cargo fmt --all -- --check
  cargo test --locked --offline -p a3s-observer -p a3s-observer-common -p a3s-observer-collector --lib --tests
  cargo clippy --locked --offline -p a3s-observer-collector -p a3s-observer-common --all-targets -- -D warnings
  cargo build --locked --offline -p a3s-observer-ebpf --release

AnySentry:
  pnpm --filter @anysentry/api exec tsc --noEmit
  pnpm build:api
  node scripts/verify-ingestion-source-correlation-claims.mjs
  node scripts/verify-s5-observer-source-bootstrap.mjs
  node scripts/verify-deployment-manifests.mjs
  deploy/manual-test/agent-llm-observability/dify/scripts/validate.sh --static
  node scripts/verify-live-image-provenance.mjs --expected-digest sha256:58d24f523381551cbd03bb8202e9d453d5fa011e5144a801e1b2656e808e3dec --expected-source AnySentry@a1c2ddb
```

### 未验证和运行限制

1. 当前共享 k3s 节点仍有持续的磁盘高利用率、PostgreSQL checkpoint/ClickHouse 写入压力和 Observer 历史 WAL；最新健康窗口虽无新 output drop，但不能据此宣称长时间零丢失。
2. Dify Chatflow harness 已加入并通过静态检查，但真实 Chatflow 两轮请求仍需要一次本地管理员导入/发布和受保护的 App API header 文件；该文件不能提交到仓库。
3. 当前没有可确认的常驻独立 LangChain/LangGraph 服务都通过 Observer→WAL→Canonical 的唯一 EvidenceLink；k3s LangGraph sandbox 的 Kernel Exec/Exit 已可见，跨 Pod 关系仍按 `semantic_only`/`coverage_gap`。
4. 当前 SSH 终端内的真实对话不能由本进程自动注入；需要用户在该终端执行短的 canary 对话并报告脱敏 marker，才能把 SSH runtime 的新窗口结果列入实测矩阵。

当前 Goal 仍为 **partial**：代码合同、构建、镜像 provenance、S5 启动快照、Kernel 基础采集和解析回归已完成；Rustls/SSH 正文、Dify/LangGraph 跨 lane 深链、共享节点长期稳定性和完整四对象被动 E2E 仍未满足 Definition of Done。

## 2026-09-05 最终本地复核：r51（当前事实优先，结论仍为 partial）

本节覆盖本 Goal 回合实际构建、部署和验收的最高版本。前面 r27/r33/r46 的镜像、Pod 名称、
耗时和计数均是历史记录，不能覆盖本节。所有动作只发生在本机；没有 git push、远程 PR、
远程分支修改或公共镜像发布。

### 当前部署与模块边界

| 项目 | 当前事实 | 说明 |
| --- | --- | --- |
| AnySentry checkpoint | repository `7ad5c41`（运行时代码 `02b745a`） | 包含 Canonical hot/evidence fallback、Session alias retry、dirty-key persistence 和覆盖刷新去重；`7ad5c41` 只补本地验收文档 |
| Observer checkpoint | `40556f5` | 本回合没有修改 Observer 源码或镜像 |
| API/Web 镜像 | `127.0.0.1:5000/anysentry:goal-head-20260905-r51-canonical-final`，digest `sha256:bf625fe8bee8019bd7121c0045cc1f8b9e00e4ee6933aaa6d65962fd6c9dfc5c` | amd64、`--provenance=false --sbom=false`，仅 loopback registry |
| Kubernetes API Pod | `anysentry-694fbdd8cd-pbj8j`，1/1 Ready，restart 0 | PodTemplate image、source annotation 与 digest 一致 |
| Observer Pod | `a3s-observer-twxn6`，1/1 Ready，r7 digest `sha256:45af6fa26c2c9e71aeec744edf1b3069362cef60f5fba33428429187a1fddbda` | collector/forwarder 为保护 WAL 而暂停；supervisor 未暂停 |
| 本地入口 | API/health：`http://127.0.0.1:32653/security-center`；SPA：`http://127.0.0.1:32653/` | API 镜像同时提供 `/app/dist`、`/app/web`；没有独立 current-head Web Deployment，不是漏部署 |
| 服务更新策略 | 只滚动了 API/Web（代码有变）；fast-judge、l3-worker、ClickHouse、Redis、Observer 沿用原本本地镜像/运行实例 | 清单中的 NodePort patch 另行叠加；直接 apply 基础 ClusterIP 清单会暂时去掉 NodePort，已恢复并验证 |

实际链路保持为：

```text
Observer eBPF/uprobes + process/connection facts
  → Collector reorder/Transport/LLM framing
  → Forwarder priority queue + WAL
  → authenticated Ingest / RawObservation commit
  → KernelFact + Runtime/Process/Connection normalization
  → LLM Format Registry + generic semantic projection
  → Agent/Application Adapter hints
  → LogicalAgent / AgentInstance / RuntimeInstance / Session resolver
  → EvidenceLink correlation + unique-owner arbitration
  → Sentry judgment/revision + CoverageGap
  → Conversation / Evidence / Operations projections
  → Canonical API and same-origin Web UI
```

Kafka/Flink 仍只在可选 streaming profile 中存在，没有成为这条主链的前置依赖。

### 本回合实现修复

1. **Canonical GET**：Session 精确查询在窄页为空时执行一次最多 500 条的别名范围读取并本地
   精确过滤；即使兼容页错误报告 `complete` 也不会把别名漏项直接当 404。Session/Timeline
   保留 hot interaction fallback 和 projection timeout coverage。
2. **语义证据双向深链**：当耐久 EvidenceLink 已存在而 Session/Timeline 或旧 relation
   projection 超时，返回 `evidence-only` 结果，来源标为 `canonical_store`、
   `canonical_store+hot_delta` 或 `memory_hot_ring`，并附 direct/hot-delta coverage reason；
   不凭空生成 KernelEvent 或关系。
3. **KernelFact 身份**：`kf_*` 是主身份，`evt_*`、`ob_*`、server-derived sourceRefs 是有界
   兼容别名；新事实可跨 API 重启三路 point read 到同一个 fact。旧历史无 locator 时仍会
   明确 partial/503，不做启动期大表 materialize。
4. **持久化稳定性**：Alert/Source/Remediation 改为 dirty-key/generation 的 changed-only
   写入；coverage refresh 保留原 `createdAt`，忽略 observation-only timestamp 漂移；失败保留
   dirty key 并退避重试，不整体清空队列。
5. **候选与版本策略**：`probable_agent` 保留 observed/detected provenance，但默认与
   `confirmed_agent` 使用同一完整采集和判断档位；没有人工 token 升级路径。Codex/Claude 的
   TLS 由 implementation-family/ABI capability 选择，版本号只出现在测试记录；未来特异版本
   只能增加独立 capability/Manifest，不复制 Transport、LLM Format 或 Correlation 主链。

### 代码、合同与兼容迁移

Canonical 合同仍是 `RawObservation` → `KernelFact`/`SemanticRecord` → `EvidenceLink`/
`RelationRevision` → `JudgmentRevision`/Projection。新增字段保持 additive-first；旧
`events`、`agent_interactions_v1`、V1/V2 binding 和旧 API 继续作为兼容投影。Controller 的
产品无关入口不识别 Codex/Claude/Dify/LangChain 分支；产品特异字段只由 Manifest/Adapter
或通用 LLM Format Registry 提供。原始事实、候选智能体和 CoverageGap 永远不因解析失败删除。

### 实测矩阵（只写本回合可复核的最小结论）

| 对象 | 环境/轮次 | 应用/语义结果 | Kernel / EvidenceLink | Coverage / 结论 |
| --- | --- | --- | --- | --- |
| Codex CLI | Host 与 tender TUI fixture；各有连续工具回合 | `a3s-test` TUI artifacts PASS，User→Model→Tool→Result→Final marker 可见 | 历史 fixture 有 ToolExec；当前 SSH/HTTPS Rustls 被动正文未能形成稳定 canonical link | 产品回路通过；当前正式 Observer 被保护性暂停，不能宣称本回合被动全链路通过 |
| Claude Code | tender_jang，2 次最小真实 CLI 调用，版本 `2.1.251` 仅作测试样本 | 两次 rc=0，第二次 `num_turns=2`、无 permission denial | `last_1h agentId=claude-code` 事件数为 0；不是“没有调用”，而是当前采集窗口/cgroup 不可见 | CLI 功能通过；Observer/Canonical 被动观测未通过 |
| Dify Workflow/Chatflow | 本地 Compose 1.14.2；llm、tool 两个 bounded workflow | console、LLM HTTP/HTTPS mock、Tool HTTPS mock ready；两次 workflow HTTP 200，hash/bytes 账本可读 | 本回合 Observer 暂停；不把应用 mock response 当 Kernel relation | 应用层通过；被动 Kernel/跨 lane durable link partial |
| LangChain service | tender_jang Docker，LangChain 1.3.17、LangGraph 1.2.11；一次 `/health` + `/invoke` | `/health=200`，`/invoke=200`，`lookup_fixture` 一次闭环，响应只记录字节/hash 元数据 | AnySentry 最近窗口 `lookup_fixture` 事件 0；日志显示 cgroup conflict、`write_route_candidates=0` 和批量拒绝 | 服务功能通过；被动观测未通过，不能把常驻服务误称为 LangGraph daemon |
| LangGraph + sandbox | 本地 k3s namespace；agent/sandbox Pod Ready/restart0；历史真实 Run 多轮 retry→passed | 语义事件、NodeRun/AgentTool、sandbox `/execute` 200/exit0；最近窗口有 LlmApi/NodeRun/AgentTool | sandbox runner 的 ToolExec/ProcessExit 曾被 Observer 直接捕获；Agent 与 sandbox 是不同 Pod/Runtime，当前关系为 `semantic_only`/`coverage_gap`，不按时间强连 | sandbox 内核采集和应用执行通过；跨 Pod Tool→Kernel 统一 EvidenceLink 未通过 |

### k3s 稳定性结论

节点 `pjnl261070032` 本身保持 Ready，Memory/Disk/PIDPressure 均 false，k3s systemd active；
问题不是单一 API 崩溃。已确认的放大链是：ClickHouse `anysentry.events` 约 57.8 GiB/2.55 亿行、
宿主 swap 约 7/8 GiB、I/O wait 约 28–47%、Observer WAL 约 4.23 GiB，以及旧 `a3s-registry`
旁路镜像/迁移错误。AnySentry 代码层已修复最明显的全量 dirty 写放大和 Canonical 查询 fan-out，
但共享磁盘/历史大表仍会令 ClickHouse 5 秒查询超时；API health 仍可能返回 `status=ok`，所以
验收同时检查 persistence dirty/failure/retry、Pod restart 和实际 endpoint，不能只看 healthz。
保护性暂停 collector/forwarder 是可逆的风险控制，不是把节点标成通过；WAL、drop、orphan
计数均未清理或覆盖。

### 权限、分类和页面语义

- 普通 SSH/Codex 进程 `CapEff=0` 且 `unprivileged_bpf_disabled=2`，不能自行加载 eBPF；特权
  `hostPID` Observer 才能读取宿主 PID/cgroup 并 attach。即使权限满足，TLS ABI、精确 POST route、
  进程代次和 payload 上限仍是独立门槛。
- 当前阶段是 observe-only：分类管理只维护 observed identity、workload role、capture
  profile、authority/provenance，不执行阻断、注入或干扰。Candidate 与 Confirmed 的采样行为一致，
  但 Candidate 仍不是已注册 LogicalAgent 的证明。
- 当前 SSH 对话是这个终端中的 Codex 会话。它可产生进程/网络/部分语义线索，但由于 Observer
  窗口暂停、Rustls/WebSocket 与会话身份缺口，不能把“我和你的当前聊天”写成已经完成的
  User→LLM→Tool→Kernel→Evidence 全链路。
- A3S standalone browser driver（agent-browser 0.26.0）已通过 NodePort 根路径 UI smoke（session
  `nodeport-ui-smoke-final`）：桌面 1440×900、移动 390×844 均加载 SPA，并导航到 Agent 列表和
  `/conversations`，console/page errors 均为空；`/security-center` 是 API 前缀，SPA 页面在根路径
  `/`。本次没有抓 HAR/network body，以免把管理 Authorization 写入 artifact；证据 Inspector 的
  HAR 级双向网络审计仍未完成。默认 `a3s-test capabilities --json` 仍因安装的 a3s 0.3.0 缺少
  `a3s use` 不可用，但 standalone 能力已按要求实际执行。

### 本地测试与回滚

通过的定向命令包括：

```text
pnpm --filter @anysentry/api exec tsc --noEmit
pnpm --filter @anysentry/api build
node scripts/verify-agent-conversation-binding.mjs
node scripts/verify-canonical-contract.mjs
node scripts/verify-canonical-observability.mjs
node scripts/verify-agent-semantic-kernel-relation.mjs
node scripts/verify-persistence-single-flight.mjs
node scripts/verify-data-lifecycle-phase7.mjs
node scripts/verify-data-lifecycle-phase8.mjs
node scripts/verify-agent-conversation-resolution-v2.mjs
node scripts/verify-agent-conversation-directory.mjs
node scripts/verify-s6-tool-evidence-linker.mjs
node scripts/verify-s6-tool-evidence-relation.mjs
node scripts/verify-deployment-manifests.mjs
ANYSENTRY_ADMIN_TOKEN=<temporary> node scripts/verify-deep-links-local.mjs scripts/verify-canonical-entity-get.mjs
cargo test -p a3s-observer-common -p a3s-observer-collector --release
```

以上本地静态/单元/隔离回放均通过；Observer 结果为 165 collector + 8 common tests passed。
`verify-canonical-entity-get.mjs` 在最新 NodePort 低负载窗口返回 `status=pass`；高负载窗口曾
返回 partial/503，修复后降为 evidence-only/partial，不伪造完整历史。回滚点是将 API Deployment
恢复到上一条已验证的本地 digest（例如 r50 `sha256:0a4c61d7…`），保留 additive schema/表，
不删除 WAL；Observer 可单独关闭 SSL/capture 或恢复原镜像。

### 当前交付判定

本 Goal 仍是 **partial**。代码合同、兼容迁移、API/Web 镜像、Canonical point/deep-link 在低负载
窗口、Dify 应用回放、LangChain 服务功能、LangGraph sandbox 执行和 Observer Kernel 单元测试
均有证据；但正式 Observer 当前为保护性暂停且曾出现 Critical drop，LangChain/Claude 当前
被动事件为空，Dify/LangGraph 跨 Runtime Tool→Kernel 关系未闭合，SSH/Docker/Kubernetes 的
连续被动矩阵、完整 UI 业务深链和无磁盘饱和容量/p95 仍未满足 Definition of Done。
