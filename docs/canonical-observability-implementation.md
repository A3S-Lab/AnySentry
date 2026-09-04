# AnySentry / Observer Canonical Observability：本地实现与验收记录

> 状态：本地实现复审稿（2026-09-04，Asia/Shanghai）
>
> 本文记录当前工作树的实现边界、可复核的本地验证和未完成项。它不是“所有 Agent
> 已生产支持”的声明，也不替代四份架构合同：
> [总体架构 v2](./anysentry-agent-observability-architecture-v2.md)、
> [LLM 观测 PRD](./anysentry-agent-llm-interaction-observability-prd.md)、
> [LLM 技术设计](./anysentry-agent-llm-interaction-observability-technical-design.md)、
> [会话归因与统一证据 V4](./anysentry-agent-conversation-resolution-and-unified-evidence-v4-design.md)。

## 0. 结论与证据等级

本地 Canonical contract、AnySentry API/Web 构建、Observer release 构建及定向回放均已
通过；截至 2026-09-04，`tender_jang` 中的 Codex 0.149.1、Claude Code 2.1.251 和
LangChain/LangGraph 运行库已完成只读盘点。本回合的 Codex/Claude 两阶段 ToolCall/ToolResult
fixture、LangChain 临时 HTTP 工具闭环以及 k3s LangGraph `/runs` 真实调用均有结果；对当前
SSH Codex 的 2026-09-03 16:14–16:22Z durable custom-window 初始快照还得到 60 条已解析的
`LlmInteraction`（model 56、tool 4），后续异步 `agents/interactions` 重查可到约 63 records
（model 57、tool 4，另 2 unsupported/unparsed）；request roles 已证明当前 SSH 对话进入
semantic lane，但身份/Session 仍是运行时提示，原文只留有 metadata-only evidence，选定
Tool 的 EvidenceLink inspector 仍为 404，不能写成 Observer eBPF 被动 attach 的四环境端到端完成。LangGraph
的耐久记录也显示两条 lane 尚未统一。Dify LLM/tool 两个 workflow 本回合均 HTTP 200、脚本
rc=0，但 debug reconciliation 因测试 CA 校验失败，hash 对账仍为 partial；因此 Goal 仍为部分完成。
本轮通过本地 registry 的 OCI 增量层交付了 API/Web `sha256:b382…` 和 Observer
`sha256:fd31…`（原始 Dockerfile/BuildKit 在共享节点上仍不可用）；API Deployment 与 Observer
DaemonSet 已切换并 Ready，NodePort health、同源 Web、Canonical contracts/entity GET 均已复验。
该交付保留旧依赖基座，完整构建链仍记录为未通过；Forwarder/WAL 受节点 I/O/ClickHouse/轮询
抖动影响，不能把当前部署写成零丢失或生产容量通过。
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

### 5.2.1 2026-09-04 运行补充

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
