# 本地 Canonical Observability Goal QA 证据

记录日期：2026-09-04（Asia/Shanghai）
记录性质：本地只读基线与 QA 门禁，不是发布说明，也不把历史设计文档中的运行声明重新计为本轮实测。

## 结论

截至 2026-09-04 的复核，Goal 仍是 **部分完成，不能报告完成**。本地代码、合同、回放和若干受控运行已经通过；新一轮补充了 `tender_jang` 中的产品运行时、LangGraph k3s `/runs` 真实调用以及耐久 API 查询证据。当前 SSH Codex 在 2026-09-03 16:14–16:22Z durable custom window 的初始快照有 60 条可解析 `LlmInteraction`（model 56、tool 4），后续异步 durable 重查可到 model 57、tool 4；身份/Session 未达到 authenticated/confirmed，且两条 Rustls plaintext evidence 只有 metadata-only。`agents/interactions` 还显示 4 个 tool 均 parsed/complete，但 conversation complete 仅 2、tool_pending 55，选定 Tool 的 EvidenceLink inspector 返回 404；两条证据 lane 尚未全部统一。既有旧镜像、未部署的 canonical GET、权限/采集和丢失计数缺口仍直接阻止 Definition of Done。

- AnySentry/Observer 构建、类型、单元/回放和 BPF object load smoke 仍通过；这不等于当前头 Observer 已在目标 workload 上完成独占 attach、转发和持久部署。
- 临时 k3s API/Web OCI overlay `anysentry:goal-current-oci-20260904` 已构建成功并通过本机 registry manifest GET 200（digest 前缀 `043180…`）；namespace `anysentry-goal-oci-web-20260904` 以 Secret/no-hostPath 完成 health、`/v1/observability/contracts`、representative replay 13/4 families/0 gap、S6、S2 shadow 后已清理。基座仍是旧 runtime + current dist overlay，非原始 Dockerfile 全链；Observer scripts overlay 也已构建并推入本机 registry（digest 前缀 `7d3b…`），但 existing formal deployment 未切换。
- `tender_jang` 已确认安装 Codex CLI 0.149.1、Claude Code 2.1.251，并包含 LangChain/LangGraph 库；产品级 fixture 闭环不自动等同于被动 eBPF 观测。
- `tender_jang` 内 LangChain 常驻 fixture 已轮换测试 CA/server cert（有效期 2026-09-04–2026-09-06），重启后 `/health=200`、HTTPS `/invoke=200`，`lookup_fixture` 一次调用/结果匹配；旧证书备份已在确认后精确清理，未写入仓库或日志。
- Dify LLM/tool 两个 workflow 本回合均 HTTP 200、脚本 rc=0；durable `dify-observation-lab` 快照有 55 条事件，但测试 CA 校验失败使 debug hash 对账为 partial，correlation method 全部 unassigned。
- LangGraph 在本地 k3s 的真实 `/runs` 调用与 durable API 查询已经产生可审计事件；但语义 lane 与 Kernel lane 当前仍有 `correlation unassigned`/`agent_adapter` 缺口，不能写成全链路统一通过。
- 当前 SSH Codex 初始 durable 快照有 60 条 `LlmInteraction`（model 56、tool 4），后续异步 `agents/interactions` 重查可到 model 57、tool 4；4 个 tool 均 parsed/complete（toolCall4/toolResult4），model57 parsed 且 request/response wire complete，但 conversation complete 仅 2、tool_pending 55，选定 Tool 的 EvidenceLink inspector 返回 404。另有 2 条 metadata-only/unparsed Rustls plaintext evidence，identity/session/run 仍是 runtime/probable 提示；不能声称当前对话正文原文已完整落盘或已确认归属。
- existing formal 旧 digest 尚未切换 canonical GET，`critical_inbox_dropped` 约 1.89M（最近观测且继续上涨）、static signature warnings，以及普通 SSH 用户无 eBPF 能力，仍是 DoD/运行风险缺口；临时 OCI overlay 的 contracts GET 仅作局部验收。

## 2026-09-04 新一轮运行复核

本节是当前回合的事实快照，优先级高于下方 2026-09-03 的历史审计段落。运行结果只记录
脱敏后的版本、状态、计数和原因；没有保存 URL 全文、凭据、Cookie 或 Prompt 正文。

### 已确认事实

| 范围 | 结果 | 证据边界 |
| --- | --- | --- |
| 当前本地代码 checkpoint | AnySentry `477f897`；Observer `030b910` | 两个仓库均为本地分支 checkpoint，未 push；本轮 publisher/Observer 身份 fence 变更已进入该快照 |
| 当前 checkpoint 测试 | scope tests 6/6；Observer full tests 159 + common 8 + root 32 + workload 7 = 206；fmt/check/build/clippy 均通过 | 这是代码/合同门禁结果，不等于旧部署已原子升级或所有 workload 已完成被动采集 |
| 身份 fence 修正 | AnySentry publisher 输出 `rootPid`、`rootStartTimeTicks`、`agentInstanceId` 并保留同 cgroup 的 distinct entries；Observer 按 process generation/cgroup/祖先链 fail-closed，mixed scope 不 broad admit | current-head 可避免旧 mixed-cgroup 广泛准入；旧 Observer/Forwarder rollout 必须原子升级 |
| 临时 k3s current-dist 验证 | namespace `anysentry-goal-dist-20260904` 的 current-dist hostPath fallback health ok；canonical contracts v1、representative replay 13 synthetic events/4 families/0 gap、S6 Tool Evidence、S2 shadow 均通过；namespace/容器已清理 | 仅为旧镜像底座 + 只读 `/app/dist`，不是 current-head OCI image，不能替代正式部署 |
| 临时 k3s API/Web OCI overlay 验证 | AnySentry `anysentry:goal-current-oci-20260904` 从本机缓存基座覆盖 current `api/dist` 与 `web/dist` 构建成功并推入本机 registry，registry manifest GET 200（digest 前缀 `043180…`）；namespace `anysentry-goal-oci-web-20260904` 以 Secret 引用 token、无 hostPath，health、`/v1/observability/contracts`、representative replay 13/4 families/0 gap、S6、S2 shadow 均通过后清理 | API/Web overlay 已生成并局部验收；基座仍是旧 runtime + current dist overlay，非原始 Dockerfile 全链；existing formal deployment 未切换，不能标 DoD 完成 |
| Observer OCI image smoke | 当前 Collector binary + Forwarder/Publisher script overlay 镜像已推入本机 registry（digest 前缀 `7d3b…`）；临时 privileged/hostPID Pod 只执行 `a3s-observer-collector --version`，返回 `0.11.0` 后清理 | 只证明镜像可拉取/二进制可启动，没有执行 tracepoint attach 或完整 Forwarder ingest；existing DaemonSet 未切换 |
| Observer OCI 组合 smoke | 同一 `7d3b…` 镜像在临时 privileged/hostPID Pod 实际附着 25 个 probe；生成的 scope 文件含 5 个 generation-fenced roots/2 个 cgroup；一个精确 batch probe 返回 201/accepted | 共享节点长跑出现批量拒绝和 spool 增长（API memory ring 7104/25000），故不标完整持续 ingest；namespace/Secret 已清理，existing DaemonSet 未切换 |
| `tender_jang` | 容器镜像为 `node:24-bookworm`；已安装 Codex CLI 0.149.1、Claude Code 2.1.251；容器内存在 LangChain/LangGraph Python 运行库 | 容器没有 published port、Docker socket 或 Docker CLI，因此这些版本是容器内可调用运行时，不等于可以从容器内编排 Docker 或已接入 Observer |
| `tender_jang` LangChain 服务 | 容器内 `service.py` 进程监听 18082，`/health=200`；运行库为 LangChain 1.3.17、LangGraph 1.2.11；宿主 loopback 由既有本地转发进程接入 | 证明当前容器确有可用服务，不证明它已由 AnySentry 当前头镜像或 Observer 被动观测 |
| `tender_jang` LangChain 证书轮换 | 旧过期测试 CA/server cert 已精确备份后轮换；HTTPS `/invoke` 两次 HTTP200、1×`lookup_fixture`，确认后旧备份已清理 | 仅修复本地测试服务生命周期；常驻服务流量进入 current-head Observer/Canonical 投影仍未验证 |
| k3s Workspace Scanner 稳定性 | 旧 ReplicaSet 反复重启（约 1688 次）直接源于 scanner 对生成 `.runtime/.../tls` 目录 `opendir` 未捕获 EACCES；另一 ReplicaSet 使用不存在 `/srv/anysentry/AnySentry` hostPath，kubelet 报 FailedMount | scanner 已加入 `.runtime` 排除和嵌套不可读目录 best-effort；新增只读 preflight/临时 Kustomize renderer，禁止 DirectoryOrCreate；正式 namespace 尚未切换新 scanner image |
| 旧 k3s 身份反例 | 旧 k3s API image digest/revision 下，同一 Docker cgroup 的历史 LangChain 与 Claude Code 均有 `LlmInteraction`，却被合并到同一旧 agentAsset/session/run；Observer source/profile 可见但 cgroup map 仍把 Codex/Claude/LangChain 标为同一 `langchain` scope | 这是旧部署的真实混合身份/误合并反例；current-head 尚未部署，必须用 ProcessGeneration + Adapter/definition fence 拆分，不能把旧 asset 当 confirmed LogicalAgent |
| Codex/Claude 本地 fixture | 本回合各完成两阶段请求—ToolCall—ToolResult—最终回复闭环 | 证明产品级协议/适配器闭环；不是当前 Observer 被动 eBPF 捕获证明 |
| LangChain 临时 HTTP 副本 | 本地 HTTP 服务的工具闭环返回 HTTP 200 | 证明 HTTP transport、工具路由和结果回传可验证；不外推到常驻 HTTPS |
| LangChain 临时 HTTPS 重试 | 新 CA 的临时 HTTPS fixture + LangChain 副本 `/invoke=200`，`lookup_fixture` tool/result 成功，临时资源已清理 | HTTPS transport/Parser/工具闭环通过；不外推到常驻服务 |
| LangChain 常驻 HTTPS 服务 | 已轮换本地测试 CA/server cert 并仅重启 fixture/service；`/health=200`、HTTPS `/invoke=200`、1×`lookup_fixture`，旧证书备份已清理 | 服务级 HTTPS/工具闭环已恢复；其流量是否进入 current-head Observer/Canonical 投影仍未验证 |
| Dify 实际重跑 | LLM 与 tool 两个 workflow 均 HTTP 200，脚本 rc=0；仅用于诊断的本地 CA-bypass 读取看到 llm-mock 3 条 `/v1/chat/completions`、tool-mock 2 条 `/tool/execute`，均 status200/HTTP1.1 且有 hash 字段，RAG selected marker=1、internal sentinel=0；官方 debug reconciliation curl 因测试 CA 校验失败 | workflow 调用与边界 marker 通过；hash 对账仍 partial，CA-bypass 不作为安全通过 |
| Dify Durable API | `detectedName=dify-observation-lab` 当前快照 55 事件：`Egress=44`、`ToolExec=8`、`LlmInteraction=3`；`captureSelected=55`，`identity exact=54/weak=1` | correlation method 全部 `unassigned`，两条 lane 尚未统一 |
| k3s LangGraph `/runs` | 本地 namespace `anysentry-observability-lab` 的 LangGraph workflow Pod（本地镜像、服务端口 8000）`/healthz=200`；本回合 POST/GET 均 200，`completed`；节点 `planner → code_generator → verifier → code_generator → verifier → finalizer`；sandbox exit0、未超时/未截断、verification pass；telemetry accepted15 | 真实本地 k3s 服务调用；对应 sandbox runner 的 KernelFact 已捕获，但仍以 physical_workload 关联，尚未形成 root-generation/LogicalAgent 唯一 EvidenceLink |
| k3s LangGraph sandbox KernelFact | 同一 Run 的两个 sandbox runner generation 各产生 `ToolExec=1` + `ProcessExit=1`，合计 Exec2/Exit2；`captureSelected=1`、`agentHasPhysicalIdentity=1`，`correlationMethod=physical_workload`、confidence0.70 | 证明 sandbox 内部受限 Python 执行没有绕过 Observer Kernel lane；当前正式旧链仍无 Tool→Kernel Canonical 双向深链，`agentHasRootIdentity=0`，状态 partial |
| LangGraph 失败路径 | 一次复杂目标返回 `RuntimeError`，但仍上报 3 个事件 | 证明失败不会静默吞掉事件；该次 Run 不是成功闭环 |
| Durable API 查询 | 上述 Session 查询到 `detectedName=langgraph-workflow-sandbox-agent`，共 19 个事件：`LlmInteraction=10`、`AgentTool=3`、`AgentInvocation=3`、`ToolExec=3` | 证明耐久读模型保留了语义/工具/执行记录；当前两条 lane 尚未统一：`correlation unassigned=13`、`agent_adapter=6` |
| 历史真实 Interaction | 既有本地审计证据中 Codex、Claude Code、LangChain 均曾产生真实 `LlmInteraction` | 历史记录与当前窗口分开统计，不覆盖下方 durable 查询 |
| 当前 SSH Codex（durable custom window 初始快照，2026-09-03 16:14–16:22Z） | native PID 1101287 有 60 条 `LlmInteraction`；全部 `parseState=parsed`、`llmLikelihood=confirmed`、`statusCode=200`、`captureSelected=true`、`wireCompleteness/transportCompleteness=complete`；model=56、tool=4；transport websocket=56（`tlsAdapterId=rustls-payload`）、HTTP/1.1=4（`openssl-ex`） | Observer 协议解析通过；identity/session/run 仍为 `tokio-rt-worker` / `probable_investigation` / `runtime_root`，不是 authenticated AgentAdapter/confirmed Session；异步写入使后续快照计数变化 |
| 当前 SSH Codex（后续 durable `agents/interactions` 快照） | 约 63 records：model=57、tool=4，另有 unsupported/unparsed=2；parsed=61；completeness 为 complete=6、partial=55、unsupported=2；toolCalls=61、toolResults=57、semanticItems=125。request role 包含 `user`、`developer`、`agent_message`、`custom_tool_call_output`、`function_call_output`、`compaction` | 证明当前 SSH 对话进入 semantic lane；旧部署读模型的 request/response body 为非零，但 Canonical 新证据继续只保留 hash/metadata-only，不在本文件复制正文 |
| 当前 SSH Codex 明文证据 | 另有 2 条 `AgentPlaintextEvidence`（`captureSource=tls_uprobe_rustls`、`encoding=metadata_only`、`parseState=unparsed`） | 不能声称正文原文完整落盘；原文保留与业务归属仍 partial |
| 当前 SSH Codex Tool/Evidence | tool=4 均 parsed/complete，toolCall=4、toolResult=4；model=57 均 parsed，request/response wire complete；但 conversation complete=2、tool_pending=55；选定 Tool 的 EvidenceLink inspector 返回 404（semantic tool event not found） | Tool protocol 闭环有事实，但 Canonical Tool→Kernel 双向 EvidenceLink 仍未闭环 |
| 当前 SSH Codex timeline-v3（旧 API 兼容投影） | 固定窗口只读返回 336 个 semantic events，全部 `completeness=complete`，每条带 `evidenceEventIds/sourceInteractionIds`；`user_message=1`、`model_progress=1`、`tool_call=105`（exact103/strong2）、`tool_result=229`（exact229）；唯一 Turn 仍 incomplete，旧 resolver 的 logical/session/terminal 字段为空 | 证明语义事件与 source evidence 可追溯；不等于 current-head Canonical EvidenceLink/UI 或 confirmed LogicalAgent |
| SSH 早期窄窗口（历史快照） | 曾只看到 17 条 Egress、无 `LlmInteraction` | 该结果属于旧时间窗，不能继续作为当前 SSH 状态；只保留作 attach/时间窗对比 |
| 权限边界 | Observer 特权 `hostPID` Pod 能看到宿主进程；普通 SSH 用户 `CapEff=0`，且 `unprivileged_bpf_disabled=2` | Pod 的宿主可见性不授予普通 SSH shell eBPF attach 权限，也不证明该 Pod 已独占捕获当前 Codex |
| 当前部署缺口 | existing formal AnySentry/Observer/Forwarder 仍有旧 image digest 或旧 rollout；临时 OCI overlay 的 canonical contracts GET 已局部通过但未切换为正式部署；`critical_inbox_dropped` 约 1.89M（最近观测且继续上涨）；static signature warnings 仍存在 | 这些是运行/可靠性 DoD 缺口和风险；旧 mixed-cgroup 身份风险要求 Observer/Forwarder 原子升级，不因临时 overlay 健康或 fixture 通过而消失 |

### 推断（不作为通过条件）

- `tender_jang` 中的二进制和库足以支撑受控产品级调用，但没有 Docker CLI/socket，不能把它写成“Docker 编排或当前头 AnySentry 容器已运行”。
- LangChain 临时 HTTP/新 CA HTTPS 与常驻 fixture 轮换后的 HTTPS `/invoke=200` 均能完成工具闭环；证书生命周期问题已修复，但不能推断 current-head Observer/Canonical 被动投影已成功。
- LangGraph 的 19 条耐久事件和每次 telemetry 10 条说明 API/存储链确实接收了记录；`correlation unassigned` 与 `agent_adapter` 计数说明语义 lane 与 Kernel lane 仍未完成统一 EvidenceLink，不能把事件数当作全链路闭环数。
- 当前 SSH durable 查询已经证明 Observer 协议层可解析 Interaction，且 request roles 证明本次 SSH 对话进入 semantic lane；初始窗口 60 条与后续约 63 条是异步耐久写入的不同时点快照，不应把任一计数当成不可变总数。2 条 Rustls plaintext evidence 仍为 metadata-only/unparsed，identity/session/run 只是 runtime/probable 提示，EvidenceLink inspector 仍 404；早期 Egress-only 是旧时间窗快照，不能覆盖当前结果。

### 未验证

- 当前 SSH Codex 的正文原文按 Canonical 合同完整持久化、authenticated AgentAdapter/confirmed Session、Tool/Kernel EvidenceLink 唯一归属和 inspector 404 修复；timeline-v3 的 336 条旧兼容投影虽可追溯 source evidence，但不替代 current-head Canonical/UI；虽然旧部署读模型有非零 request/response body，本轮不把正文复制进新证据。
- `tender_jang` 中 Codex/Claude 进程经当前头 Observer 的独占 attach、Forwarder/WAL 投递和 AnySentry canonical 投影。
- 常驻 LangChain HTTPS 服务轮换证书后的服务级重试已通过；其 HTTPS 流量是否进入 current-head Observer/Canonical 仍未验证。
- k3s LangGraph 本回合成功 Run 的每条语义事件与具体 KernelFact 的唯一所有权、双向深链和 UI 展示；当前已确认 sandbox KernelFact 为 ToolExec2/ProcessExit2、physical_workload confidence0.70，但 Canonical EvidenceLink 仍未统一。
- existing formal 旧 digest 替换为 current-head 镜像、canonical GET 正式切换和 `critical_inbox_dropped` 的根因/清零前后对照仍未验证；临时 OCI overlay 的 contracts GET 仅作局部验收。

### 本回合对代表对象的状态更新

| 对象 | 产品/服务级结果 | 被动观测与统一证据状态 | 本回合结论 |
| --- | --- | --- | --- |
| Codex CLI | `tender_jang` 0.149.1；本地 fixture 两阶段 ToolCall/Result 闭环；SSH durable custom-window 初始快照 60（model 56/tool 4），后续异步 `agents/interactions` 约 63 records（model 57/tool 4 + 2 unsupported/unparsed） | Observer 解析通过；tool4 parsed/complete、toolCall4/toolResult4；conversation complete2/tool_pending55；2 条 Rustls plaintext evidence metadata-only/unparsed，identity/session/run 非 authenticated/confirmed，选定 Tool inspector 404 | partial |
| Claude Code | `tender_jang` 2.1.251；本地 fixture 两阶段 ToolCall/Result 闭环 | 本回合未取得该容器进程的被动 LLM Interaction | partial |
| Dify Workflow/Chatflow | LLM/tool 两个 workflow 本回合均 HTTP 200、脚本 rc=0；debug reconciliation curl 因测试 CA 校验失败 | durable snapshot `detectedName=dify-observation-lab` 共 55 事件（Egress44/ToolExec8/LlmInteraction3，captureSelected55，identity exact54/weak1）；correlation method 全 unassigned；hash 对账 partial | partial |
| LangChain/LangGraph | LangChain 常驻 fixture 轮换证书后 `/invoke=200`；k3s LangGraph 本回合 Run completed、sandbox exit0/verification pass、telemetry accepted15；另有历史 RuntimeError 仍上报 3 事件 | 本回合 sandbox KernelFact 为 ToolExec2/ProcessExit2、physical_workload confidence0.70；既有 durable LangGraph 19 事件仍有 `unassigned=13`、`agent_adapter=6`，两 lane 未统一 | partial |

## 上一轮冻结 QA 回合（2026-09-03，历史 dirty 工作树快照）

当前 API 进程曾由源码构建后在 `127.0.0.1:29653` 运行并完成短验收，随后已停止（仅作为
本地验证入口，memory fallback；管理/session 值为临时专用环境变量）。以下结果均不包含
凭据或真实 Prompt：

```text
pnpm build                                      PASS
API/Web tsc --noEmit                            PASS
Observer fmt/build/test/clippy                  PASS
Observer tests                                   32 + 7 + 155 + 8 = 202 PASS
Observer privileged BPF load smoke               PASS (tls_write/tls_sendto/http_writev/exec; no verifier overflow)
canonical representative replay                 PASS (13 synthetic authenticated events)
S2 trusted-correlation (temporary off/shadow)    PASS (5/5, 70/70)
S2 trusted-correlation (fixed API shadow)        PASS (70/70)
final health/contracts + representative/S6     PASS (health/contracts 200; replay/S6 pass)
heterogeneous ingest / interactions / S6         PASS
Conversation Tracking browser (4 viewports)       PASS (temporary API, synthetic interaction)
Agent/Event + Tool Inspector browser               PASS (temporary API, synthetic model/tool)
```

固定 API 短验收回合的结果为 `pass=57`、`partial=5`、`blocked=4`、`unexecuted=7`、
`fail=0`（73 个状态）。在 API 已按清理流程停止后再次执行提交后总门禁，环境探针如实变为
`pass=56`、`partial=3`、`blocked=7`、`unexecuted=7`、`fail=0`；新增的 blocked 主要是
故意关闭的 Host API 和无本分支容器，而不是代码测试失败。两回合的静态 raw/kernel/semantic/
identity/correlation/coverage、产品分支、Observer ABI、Kafka/Flink optional boundary 和
bounded-state guard 均为 pass；credential scan 仍为 blocked（10 个既有 untracked/protected
文件，tracked finding=0），remote-write guard 为 pass。

验证脚本创建的 Source（包括 negative-path 自动发现的 Source）在最终固定 API 上均已设为
`enabled=false`；Source 记录保留用于审计，没有删除业务数据。最终临时 API 进程已停止，
监听端口与临时测试目录已清理。另识别并停止了本 Goal 早期遗留的本地临时 API（PID
1133482、端口 29660）；既有 k3s API/Observer 与 InternOS 进程未停止。

上一轮额外受控运行（2026-09-03，历史记录）：

- 真实安装的 Codex CLI 与 Claude Code 通过 loopback mock 完成两轮产品级请求、工具调用、
  工具结果和最终回复；这证明产品交互闭环，不证明本机 Observer 已被动捕获；Codex HTTPS
  运行器超时，按当前 Rustls/协议边界记为未通过；
- 既有 Dify Docker lab 运行两次 LLM stream 和一次外部工具 POST（均 200），只在临时 0700
  结果目录记录 bytes/hash 前缀，运行后清理；
- LangChain/LangGraph 仅完成合同/回放验证；既有服务 health 可达但 `/invoke` 超时，未写成真实通过；
- Docker 当前头镜像 build/create 在本地 mirror 401、高 I/O legacy build 和 container create
  timeout 下未完成；Kubernetes 既有部署保持旧 digest 健康，但本轮曾在独立临时 namespace
 以旧本地运行时镜像只读挂载当前 `apps/api/dist` 做 hostPath fallback，Canonical replay、
 S6 和 S2 shadow 70/70 通过后已删除该 namespace；正式当前头镜像仍未部署。该历史回合未对
 SSH Agent 做独立运行，但不覆盖 2026-09-04 当前 VSCode SSH 观测。

> 下面原“Round2/Round4/Round6”以及旧的“最新冻结”段落是历史审计记录。它们保留用于追溯，
> 不覆盖本节的当前状态，也不应把旧 Observer clean/旧计数当成现状。

## 历史最新冻结 QA 回合（2026-09-03，Observer 10cebf5）

在没有启动、停止或删除任何外部资源的前提下，使用当前本地工作树执行：

```text
node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-qa-10ce.json
```

结果为 `pass=56`、`partial=5`、`blocked=4`、`unexecuted=7`、`fail=0`（72 个门禁状态）。这是历史回合的结果；当前回合已增加 per-request、secret isolation 和回放验证，见上节。

本回合仍不能宣称四类代表对象的真实 E2E 完成：这是 2026-09-03 的历史快照，当时脚本未执行
Codex、Claude Code、Dify、LangChain/LangGraph 的产品运行。Host API 是 memory fallback，
Docker 未检测到本分支 AnySentry 容器，Kubernetes 虽有既存 AnySentry/Observer Pod 但
workspace-scanner 为 1/2 Ready 且不是当前工作树镜像；当前 SSH 事实以文首 2026-09-04 回合为准。
凭据扫描为 `blocked`（10 个既有 untracked/protected 文件，tracked finding=0），remote-write
guard 为 `pass`。该 JSON 仅写入权限为 0600 的 `/tmp` 路径，不属于仓库交付物。

本回合还验证了 persisted-anchor scope isolation：SQL 按 `logical_scope_key` 预过滤并以 membership scope/base 兼容旧数据；Thread 绑定比较 definition fingerprint、LogicalAgent scope、应用 deployment fence，并保留 CLI synthetic-workspace resume。新增的不同 definition/deployment 回归均通过；deployment scope 使用可存储的 opaque digest，避免向 PostgreSQL TEXT/JSONB 写入 NUL。

> 以下“Round2/Round4/Round6”段落是早期回合的保留审计记录，仅用于追溯，不覆盖上面的最新冻结回合。

## 历史只读复核（2026-09-03 03:19 左右）

在不启动/停止/删除任何资源的前提下再次运行：

```text
node scripts/verify-canonical-goal.mjs --json-out /tmp/canonical-goal-round2-probe.json
```

结果：

- Host `healthz` 返回 2xx，服务状态为 `ok`，但 `storageMode=memory`、ClickHouse/PostgreSQL 未就绪；脚本将 Host 环境标为 `partial`，这只能证明 API 进程可响应，不能证明耐久部署；
- Docker daemon 与基础/模块 Compose 解析通过，Dify 容器仍健康；未发现本分支 AnySentry API 容器，localhost 2xx 被标为 Docker `partial`，避免误把 Host 进程当 Docker 部署；
- k3s `default` context 的 AnySentry NodePort 返回 2xx，存储为 ClickHouse/PostgreSQL，核心 workload ready；workspace-scanner 历史 CrashLoop/ContainerCreating 已定位为代码 EACCES 与错误 hostPath 两类问题，代码/preflight 修复已完成但正式 Deployment/image 尚未切换，故整体仍为 `partial`；
- SSH 在该历史回合仅检查本地 `ssh`/`ssh -G` 和 22/2222 TCP 可达性，没有执行独立远端命令；当前会话的实际观测以 2026-09-04 durable 结果为准；
- `deploy/anysentry.yaml`、`deploy/observer.yaml`、`deploy/streaming.yaml` 均通过 `kubectl apply --dry-run=client --validate=false`；Dify Compose 直接解析缺少已准备的上游 Compose/UID 变量，未运行 `prepare.sh`（避免下载或改动）；
- fixture shell `bash -n` 和四个非生成 Python 源文件的内存 compile 通过；CLI fixture 没有 Compose 文件，使用 Host 启动脚本；LangChain Compose 可解析；
- 本回合 summary 为 `fail=0`，但当时四类对象 runtime evidence 尚未执行；该历史状态不覆盖当前回合，凭据扫描为 `blocked`（既有 untracked/protected 文件，tracked=0），不能宣称代表性 E2E 完成。
- 该复核读取到 Observer 本地 checkpoint `b9c58ed…`；后续 agent 可能继续产生本地 checkpoint，QA 报告中的 commit 仅是快照，不代表远程发布。

Observer 完成本地 checkpoint `55190e4…`（semantic/runtime adapter 合同与 ABI 测试补齐）后，在无并发构建/编辑窗口再次执行：

```text
node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-final-round4.json
```

14 项本地测试全部 `pass`（AnySentry build、双端 TypeScript、部署清单、Canonical contract/identity、会话/目录/绑定、Asset、Semantic-Kernel、Runtime、Templates、Observer cargo）；静态合同和 streaming optional boundary 也为 `pass`，`fail=0`。这是历史回合的 Host/Docker/Kubernetes partial 与 SSH 未独立执行快照；当前 SSH 以 2026-09-04 durable 结果为准，四类代表对象仍不能据此宣称完整 E2E，凭据扫描 `blocked`（既有 untracked/protected 文件，tracked=0）。

在 Observer checkpoint `3d50246…` 和 AnySentry QA checkpoint `0e17df8…` 均稳定后，最终复核再次执行：

```text
node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-final-round6.json
```

Round6 记录：14 项本地测试全部 `pass`；`fail=0`，tracked diff 前后为空，remote-write guard=`pass`。Host API 仅 memory fallback，Docker 没有本分支 API 容器，Kubernetes NodePort/ClickHouse/PostgreSQL 可用但存在 workspace-scanner 与 kind 降级；SSH 与四类代表对象的“未独立执行”是该历史快照，不覆盖当前 durable 观测。该轮只验证本地代码/合同/运行时健康和回归，不替代代表性真实连续对话验收。

## 已确认事实

### 仓库与工作树

| 仓库 | 分支 | HEAD | 工作树 |
| --- | --- | --- | --- |
| AnySentry | `goal/canonical-observability-20260903` | `477f897` | 当前本地 checkpoint；tracked/index clean；保留用户已有未跟踪报告/资产 |
| Observer | `goal/canonical-observability-20260903` | `030b910` | 当前本地 checkpoint（process-generation/cgroup/ancestor fail-closed），工作树 clean；未 push |

远程地址仅作只读基线记录；本轮未执行 `git push`、远程分支/PR 操作或镜像远程发布。脚本在运行前后比较 tracked worktree，并以不输出凭据的方式报告 remote host、ahead/behind 和变更路径。

### 本机工具与服务

- Node 24.16、pnpm 9、Cargo/Rust 1.96、Docker 29.5 + Compose v5.1.4、kubectl、kind 0.23、`bpf-linker` 可用。
- 本机没有 `psql`、`clickhouse-client`、`redis-cli`、Java 或 Maven；数据库/缓存诊断通过容器或 HTTP 健康接口完成。
- Docker 中已有 Dify manual 栈（API/Web/Worker、plugin daemon、LLM/tool mock）和本地注册表；这些是既有用户现场，不由本轮创建或清理。
- `tender_jang` 为 `node:24-bookworm` 运行容器，内有 Codex 0.149.1、Claude Code 2.1.251 及 LangChain 1.3.17/LangGraph 1.2.11 运行库；`service.py` 监听 18082 且 `/health=200`。容器无 published port、Docker socket 或 Docker CLI；容器内可见 Codex 进程，但没有常驻 Claude 进程。
- 本地 k3s 的 LangGraph workflow service（`langchain` runtime label）健康且暴露 `/healthz`、`/runs`；本轮真实调用与 durable 查询证据见“2026-09-04 新一轮运行复核”。
- 主机上还可见其他 Codex、Pi/LangChain 示例和 Observer supervisor 进程；除本节明确列出的 run evidence 外，不能仅凭进程名计为代表性通过。

### 构建与测试基线

通过：

```text
timeout 180s pnpm build
pnpm --filter @anysentry/api exec tsc --noEmit
pnpm --filter @anysentry/web exec tsc --noEmit
pnpm verify:deployment-manifests
node scripts/verify-agent-conversation-resolution-v2.mjs
node scripts/verify-agent-conversation-directory.mjs
node scripts/verify-agent-conversation-binding.mjs
node scripts/verify-agent-semantic-kernel-relation.mjs
node scripts/verify-agent-runtime-signatures.mjs
node scripts/verify-agent-runtime-state.mjs
node scripts/verify-agent-templates.mjs
node scripts/verify-agent-semantic-identity.mjs
node scripts/verify-agent-read-capture-policy.mjs
node scripts/verify-agent-runtime-ui.mjs
node scripts/verify-forwarder-attribution.mjs
node scripts/verify-forwarder-spool-replay.mjs
node scripts/verify-collector-health-channels.mjs
node scripts/verify-repository-hygiene.mjs
cargo test --locked --offline -p a3s-observer -p a3s-observer-common -p a3s-observer-collector --release
cargo test -p a3s-observer --release
cargo build --release
```

当前 checkpoint 的增量门禁为：identity scope tests 6/6；Observer full tests 206（root 32、
workload 7、collector 159、common 8）；`cargo fmt --check`、workspace `cargo check`/build 和
clippy `-D warnings` 均通过。下方 202 项计数属于 2026-09-03 旧 checkpoint，不覆盖本节。

Observer release collector build通过 `a3s-observer-collector/build.rs` 生成并嵌入 eBPF `out/probes`。直接执行 `cargo build -p a3s-observer-ebpf --release` 会因为把 no_std eBPF crate 当作 host binary（unwinding panics）失败；该命令不是正确的 Collector/eBPF 构建入口，不能据此判定 Collector 构建失败。

随后在 Observer 工作树完成 ABI 对齐后，QA 门禁的完整本地回合重新通过：

```text
node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-run-tests-final.json
```

该回合中 AnySentry build、API/Web TypeScript、部署清单、会话解析/目录/绑定、语义内核关系、Runtime 状态、Agent templates，以及 Observer `cargo test --locked --offline ... --release` 全部为 `pass`。门禁汇总为 `fail=0`；环境和凭据状态仍按下文的 `blocked/partial/unexecuted` 真实记录，故不能把该回合描述成四类代表对象的端到端完成。

未通过或未执行（原因不是静默忽略）：

| 检查 | 状态 | 原因 |
| --- | --- | --- |
| `verify:coverage-runtime` | blocked | 本轮默认 API localhost 入口连接被拒绝 |
| `verify-agent-interactions` | blocked | 依赖同一未启动的 API |
| `verify:forwarders` / `verify-observer-ingest` | blocked | HTTP ingest 入口未监听 |
| `verify-agent-asset-model` | fail | legacy event-backed asset ID 断言不一致（实际/预期均只在本地日志中保留短哈希） |
| Codex/Claude/Dify/LangChain 连续多轮真实链路 | 历史快照（当时未执行） | 2026-09-03 该轮未启动真实 Agent/LLM；2026-09-04 新结果见文首，不沿用本行状态 |

## 目标设计对 QA 的约束

四份合同文档均已在本轮完整读取。QA 只接受以下证据顺序：

```text
Observer → Forwarder/WAL → Ingest → RawObservation →
KernelFact/Runtime/Connection → Transport/LLM Format →
Agent Adapter → Logical/Instance/Runtime/Session/Segment/Turn/Run →
EvidenceLink/Correlation → Sentry → Conversation/Evidence/Coverage projection
```

人类可读 lane（用户请求、模型请求/回复、ToolCall/ToolResult）与机器可读 lane（Exec/Fork/Exit、File、Network、DNS、TLS、Security）必须分别保留，只通过带 authority、method、confidence、algorithm/version 和 revision 的关系汇合。Parser、Adapter、TLS 或环境不可用时，QA 期待 `partial/unparsed/unsupported/coverage_gap`，而不是删除 KernelFact 或伪造完整会话。

## 能力矩阵（本轮）

下表是 `verify-canonical-goal.mjs` 输出的**状态模板**。`fixture` 只证明仓库存在适配/回放材料；`runtime` 必须来自显式、脱敏的 run evidence envelope，不能由进程名、Pod 名或历史 Markdown 推断。

| 对象 | Host | SSH | Docker | Kubernetes | Raw/Kernel/Semantic/Correlation/Coverage |
| --- | --- | --- | --- | --- | --- |
| Codex | partial（Host API memory fallback；SSH durable custom window 初始 60、异步重查约 63） | partial（当前 VSCode SSH `notty` 会话，未执行独立远端登录） | partial（`tender_jang` 产品级 fixture，两阶段闭环；无本分支 API 容器） | partial（当前 SSH 进程有协议观测，未形成 k3s Codex workload evidence） | SSH semantic lane pass/partial（model57/tool4；tool/evidence 与正文/身份仍 partial） |
| Claude Code | partial（Host API memory fallback） | partial（当前 VSCode SSH `notty` 会话，未执行独立远端登录） | partial（`tender_jang` 产品级 fixture，两阶段闭环；无本分支 API/被动捕获证据） | partial（当前会话环境可见，未形成 k3s Claude workload evidence） | 产品级 fixture pass；当前容器进程被动 LLM Interaction 未验证 |
| Dify Workflow/Chatflow | partial（Host API memory fallback） | partial（当前 VSCode SSH `notty` 会话，未执行独立远端登录） | partial（Dify 两个 workflow 本回合 HTTP200/rc0；durable 55 事件但 hash/correlation partial） | partial（当前 k3s/本机服务证据存在，Dify workload 全链路仍 partial） | `detectedName=dify-observation-lab`；Egress44/ToolExec8/LlmInteraction3；correlation 全 unassigned |
| LangChain/LangGraph | partial（Host API memory fallback） | partial（当前 VSCode SSH `notty` 会话，未执行独立远端登录） | partial（LangChain 常驻 fixture 轮换证书后 `/invoke=200`；LangGraph `/runs` 本回合 completed、sandbox exit0/verification pass） | partial（LangGraph 本回合 telemetry accepted15；另有 RuntimeError 仍上报 3 事件） | 本回合 sandbox KernelFact 为 ToolExec2/ProcessExit2、physical_workload confidence0.70；durable LangGraph 仍有 `correlation unassigned=13`、`agent_adapter=6` |

当前环境探针摘要：

| 环境 | 状态 | 证据 |
| --- | --- | --- |
| Host | partial | API health 200 但 memory fallback；特权本地 k3s Pod 的 Observer BPF load smoke 通过；当前 shell/SSH 用户 `CapEff=0` 且 `unprivileged_bpf_disabled=2`，未把当前 workload 的完整 attach/转发链写成通过 |
| SSH | partial（协议解析通过，身份/原文/统一证据 partial） | VSCode SSH `notty` 链 native Codex PID 1101287 在 2026-09-03 16:14–16:22Z durable custom window 初始有 60 条 parsed/confirmed/complete `LlmInteraction`（model 56、tool 4）；后续异步 `agents/interactions` 快照约 63 records（model57/tool4 + 2 unsupported/unparsed）。request roles 证明 semantic lane 已进入，identity/session/run 与 EvidenceLink 仍 partial |
| Docker | partial | daemon 与 Compose config 通过；Dify 容器健康；`tender_jang` 可调用 CLI/库但无 Docker CLI/socket；未发现本分支 AnySentry API 容器 |
| Kubernetes | partial | `kubectl` API、LangGraph `/healthz` 与 `/runs` 真实调用可用；本回合 sandbox KernelFact 为 ToolExec2/ProcessExit2（physical_workload confidence0.70）；临时 API/Web OCI overlay 与 Observer 组合 smoke 已局部验证后清理，但 existing AnySentry/Observer 仍旧 digest、canonical GET 未切换正式部署，workspace-scanner 路径/镜像尚未正式切换且 critical inbox 缺口未消除 |

本轮 identity fence 代码已进入 AnySentry `477f897` / Observer `030b910`，但线上旧 Observer/Forwarder
仍可能把同 cgroup 的混合进程 broad-admit；升级必须以 Observer、Forwarder 和对应 publisher 的
兼容版本原子切换，不能只替换单个组件。

## QA 门禁脚本

运行：

```bash
# 只读环境/合同/凭据/远程写入检查（默认不跑长测试）
node scripts/verify-canonical-goal.mjs

# 同时执行本地 build、TypeScript、AnySentry 定向合同和 Observer cargo 测试
node scripts/verify-canonical-goal.mjs --run-tests

# 生成脱敏 JSON；只写显式指定的临时路径，正文/凭据不会进入报告
node scripts/verify-canonical-goal.mjs --json-out /tmp/anysentry-canonical-goal.json
```

脚本覆盖：

1. 两仓库分支/HEAD/工作树/remote host 只读快照及 tracked 变更保护；
2. Host、SSH、Docker、Kubernetes/kind 客户端与健康状态；
3. Codex、Claude Code、Dify、LangChain/LangGraph fixture 存在性与显式 runtime evidence envelope；
4. RawObservation、KernelFact/Process/Connection、SemanticRecord/LLM、Identity、EvidenceLink/RelationRevision、CoverageGap 合同 marker；
5. 禁止产品名分支的核心文件扫描；
6. bounded state pressure path 扫描（禁止 Agent attribution/Observer socket state 通过整体 `clear()` 止压，并要求淘汰/过期计数）；
7. 高置信度凭据字面量扫描（仅报告文件/类别，不报告值）；
8. 不执行远程写入或 `git push`，并在执行前后比较工作树。

`--strict` 适合最终门禁：任何 blocked、partial 或 unexecuted 都会以非零退出；默认模式允许 QA 在环境尚未准备好时获得完整报告，而不是把缺口隐藏成失败或通过。`--run-tests` 还会运行 canonical contract/identity 脚本与 `verify-agent-asset-model`；后者若与新 unresolved-candidate 语义的旧断言不一致，会明确报告 `fail`，不会被忽略。

## 凭据与清理声明

本回合请求限定在本地受控 fixture/服务；没有把本机受保护配置的值写入仓库、日志、镜像、Kubernetes 对象或本文件。扫描器只在内存中读取候选文件，输出路径和类别，不输出值；发现既有本地 secret 文件时不删除、不覆盖，由后续执行者按用户授权和原有生命周期处理。`/tmp` 诊断报告可安全删除，不属于仓库交付物。

## 真正未决项与下一步

- 当前文档与 v2/V4 历史设计仍有少量旧现场数字/镜像/入口声明；这些声明不作为本轮通过证据，后续应继续以最新脱敏 gate JSON 和本地 checkpoint 替换或明确标注历史。
- `tender_jang` 的 Codex/Claude 产品级 fixture 与 LangChain HTTP/新 CA HTTPS/常驻证书轮换后的服务级 `/invoke=200` 已通过，但尚未证明这些进程经过当前头 Observer 被动捕获并进入 canonical API。
- Dify 两个 workflow 已重跑成功，durable `dify-observation-lab` 也有 55 条事件；但 debug hash reconciliation 因测试 CA 校验失败，且全部 correlation method 为 `unassigned`，所以 hash 对账和两 lane 关联仍是 partial。
- k3s LangGraph `/runs` 已有同 Session 的成功 Run、失败 Run 的 3 事件保留和 19 条耐久记录；本回合 sandbox KernelFact 进一步核验到 ToolExec2/ProcessExit2（physical_workload confidence0.70），但 `correlation unassigned=13`、`agent_adapter=6` 和 `agentHasRootIdentity=0` 仍表明两条 lane 尚未统一，需补 Adapter/Relation revision 与双向查询验证。
- 当前 SSH Codex（native PID 1101287）的初始 custom-window 快照有 60 条 parsed/confirmed/complete `LlmInteraction`（model 56、tool 4），后续异步 `agents/interactions` 可到约 63 records（model57/tool4 + 2 unsupported/unparsed）；request roles 已证明 semantic lane 进入，但 2 条 Rustls plaintext evidence 为 metadata-only/unparsed，identity/session/run 未达到 authenticated AgentAdapter/confirmed Session，且选定 Tool 的 EvidenceLink inspector 404。没有证据表明本助手对话正文已按 Canonical contract 完整落盘或可按业务会话确认归属。
- existing formal AnySentry 旧 digest/未切换的 canonical GET、约 1.89M 且继续上涨的 `critical_inbox_dropped` 和 static signature warnings 仍需在本地部署/运行窗口中处理并复验；临时 OCI overlay 只做局部验证，特权 `hostPID` Pod 的可见性不能替代普通 SSH 用户的 eBPF 权限。
- AnySentry `477f897` 与 Observer `030b910` 已修正 mixed-cgroup identity fence，但旧 Observer/Forwarder rollout 仍有误合并风险；必须原子升级 publisher、Forwarder 和 Observer 后重放验证，不能只替换一侧。
- 临时 namespace `anysentry-goal-dist-20260904` 的 hostPath fallback 验证已清理；其旧镜像底座和只读 `/app/dist` 只能证明当前 dist 的局部 API/回放门禁，不能算 current-head OCI 部署通过。
- `anysentry-goal-oci-web-20260904` 的 API/Web OCI overlay 已局部验收并清理，本机 registry digest 前缀为 `043180…`；它基于旧 runtime + current dist overlay，非原始 Dockerfile 全链。Observer scripts overlay 也已在本机 registry 生成（digest 前缀 `7d3b…`）并完成 25-probe/5-fence 组合 smoke，但共享节点负载导致批量拒绝，existing formal deployment 仍未切换。
- Semantic Inspector 已能显示部分 canonical EvidenceLink/Raw/Kernel/Session 标识，但完整 UI 深链接和多竞争 EvidenceLink 展示仍需浏览器验收；管理认证缺失时必须显示明确的 coverage/权限状态。
- 将当前 Host 的 memory-fallback API 替换/补充为带明确源码 revision 的本地 durable Docker/Kubernetes 部署，保持 API、ClickHouse、PostgreSQL、Redis 和 Web 健康后重跑 ingest/interaction/coverage/forwarder checks；
- 为每个代表对象继续生成 run-id 隔离、脱敏的 runtime evidence envelope，补齐启动、新 Session、第二轮、ToolCall/ToolResult、KernelFact、EvidenceLink、Coverage 和失败降级状态；当前 LangGraph 已有部分真实 envelope，但关系统一仍待完成；
- 在同一工作树上分别完成 Host、当前 VSCode SSH `notty`、Docker、Kubernetes 的真实运行验证；尚未覆盖的产品/环境组合保留 partial/blocked 原因；
- 在无并发构建/编辑窗口持续重跑 `verify-agent-asset-model`，并保留 canonical identity 与 legacy alias 的回放差异；
- 在无磁盘饱和环境重跑 `verify:filter-pipeline` 与 `verify:forwarder-durability`；
- Kimi/Z.ai/Pi 与 Kafka/Flink 时间窗支路仍是后续扩展，不构成本阶段四类代表对象通过条件，也不作为当前主链前置依赖。
