# AnySentry 持续 Goal 交接提示词

将本文件与原始 Goal 一起提供给下一位智能体。它不是完成报告，而是要求下一位智能体在当前本地工作区继续执行同一个未完成 Goal；不得把这里的历史结果直接当作当前事实，必须重新验证。

## 1. 角色、范围与停止条件

你是 AnySentry 项目的多智能体开发工程师和本地交付负责人。工作范围仅限本机：

- AnySentry：`/home/chensicheng/a3s/security/AnySentry`
- Observer：`/home/chensicheng/a3s/security/Observer`
- 只允许本地源码、Docker、loopback registry、kind/k3s、Kubernetes、SSH 进程和本地测试。
- 严禁 `git push`、远程 PR、远程分支修改、公共镜像推送。
- 保留用户已有未提交文件；开始前读取两个仓库的 `git status`、分支、HEAD、remote 和 diff；禁止 `git reset --hard`、`git checkout --`、工作区级递归删除。
- 任何凭据只能从受保护配置临时读取，关闭 shell tracing，不能写入仓库、日志、WAL、数据库、镜像、YAML、测试产物或最终报告。

只有以下两种情况才允许结束：全部 Definition of Done 已由当前证据证明；或同一个外部阻塞连续三个 Goal 回合都无法通过本地替代消除，并且确实需要用户改变外部状态。普通失败、慢、上下文压缩或单次超时都不是停止理由。

## 2. 当前完整目标（不得缩小）

在已经识别的 SSH Codex `AgentInstance` 和 `ProcessGeneration` 范围内，完成通用 Rustls/WebSocket 明文边界与 Session identity 解析，使后续 SSH Codex 多轮对话的用户请求、LLM 请求、LLM 回复、ToolCall、ToolResult、Exec/File/Network/DNS/TLS/Security KernelFact、Session/Segment/Turn/Run、CoverageGap、EvidenceLink 以及 API/UI 双向深链能够以同一实例和会话稳定追溯；安全地消除 `legacy_agent_fallback` 误导和不必要的身份降级，但不得用 PID、Pod、Trace、产品名或版本号伪造 Session/LogicalAgent；验证重启生成新 AgentInstance、resume 延续旧 Session、fork 生成新 Session；把 Dify Chatflow blocking/streaming 两轮、LangChain service、LangGraph+sandbox 的应用与 Kernel 结果纳入同一统一证据协议；在短窗口多轮采集、明文完整性、工具—内核唯一关联和持久化可查询性全部通过前持续执行；共享节点长期 WAL/数据库零丢失作为独立运维门禁，不得被健康瞬态掩盖。

## 3. 强制恢复步骤

每个新的 Goal 回合、自动 continuation 或不确定前序结论时，先完整读取以下四份文档，再读取当前源码和运行状态：

1. `docs/anysentry-agent-observability-architecture-v2.md`
2. `docs/anysentry-agent-llm-interaction-observability-prd.md`
3. `docs/anysentry-agent-llm-interaction-observability-technical-design.md`
4. `docs/anysentry-agent-conversation-resolution-and-unified-evidence-v4-design.md`

恢复后明确写出四类标签：

- **已确认事实**：来自当前源码、命令输出、API/Kubernetes/Docker 状态或可复核测试。
- **目标设计**：来自上述合同和用户要求。
- **推断**：基于证据的解释，不能冒充事实。
- **未验证**：尚未取得当前运行证据的要求。

## 4.1 相关既有设计与验收文档

下一位智能体必须把以下文件作为已有上下文一起阅读；这些文件是历史架构优化、产品观测设计、身份/生命周期设计、过滤治理和当前实现证据的来源。本交接文件只做索引，不复制或替代它们：

### 核心架构合同（优先级最高）

- [Agent Observability Architecture v2](anysentry-agent-observability-architecture-v2.md)
- [LLM Interaction Observability PRD](anysentry-agent-llm-interaction-observability-prd.md)
- [LLM Interaction Observability Technical Design](anysentry-agent-llm-interaction-observability-technical-design.md)
- [Conversation Resolution and Unified Evidence v4 Design](anysentry-agent-conversation-resolution-and-unified-evidence-v4-design.md)

### 身份、生命周期与跨环境设计

- [Agent Lifecycle, Conversation Attribution and Tracking v3](anysentry-agent-lifecycle-conversation-attribution-and-tracking-v3-design.md)
- [Discovery-first Agent TLS Observability v2](anysentry-discovery-first-agent-tls-observability-v2-design.md)
- [Conversation Tracking Codex/Claude TLS Stage Design](anysentry-conversation-tracking-codex-claude-tls-stage-design.md)
- [Trusted Correlation Compatibility Contract](trusted-correlation-compatibility-contract.md)
- [Identity Semantics and System Context Optimization](anysentry-identity-semantics-and-system-context-optimization.md)
- [Trusted Correlation and Capture Roadmap](anysentry-trusted-correlation-and-capture-roadmap.md)

### 明文、工具、KernelFact 与规则治理

- [Agent LLM Tool Plaintext Observability Design](agent-llm-tool-plaintext-observability-design.md)
- [General Agent Semantic Aggregation and Selective Read Capture PRD](anysentry-general-agent-semantic-aggregation-and-selective-read-capture-prd.md)
- [Unified Asset Lifecycle and Capture Rule Governance](anysentry-unified-asset-lifecycle-and-capture-rule-governance.md)
- [Unified Filter Rule System PRD](anysentry-unified-filter-rule-system-prd.md)
- [Unified Filter Rule System Acceptance](anysentry-unified-filter-rule-system-acceptance.md)
- [Agent Discovery Filter](agent-discovery-filter.md)
- [File Filter Pipeline v1](file-filter-pipeline-v1.md)
- [Infrastructure Rules v1](infrastructure-rules-v1.md)

### 当前实现、测试与交付证据

- [Canonical Observability Implementation](canonical-observability-implementation.md)
- [AnySentry Multi-agent Refactor Execution Prompt](anysentry-multiagent-refactor-execution-prompt.md)
- [Local Goal Evidence](local-goal-evidence.md)
- [Performance Testing](performance-testing.md)
- [Data Lifecycle Phase 1–16](data-lifecycle-phase1.md) 至 [data-lifecycle-phase16.md](data-lifecycle-phase16.md)
- [Data Lifecycle Window Audit](data-lifecycle-win-audit.md)
- [Technical Report](technical-report.md)
- [Weekly Report: Agent Observability Architecture](weekly-report-agent-observability-architecture.md)

### Observer 相关文档

- [Observer Agent Discovery Filter](../../Observer/docs/agent-discovery-filter.md)
- [Observer Enforcement](../../Observer/docs/enforcement.md)

阅读顺序建议为：核心架构合同 → 身份/生命周期与 TLS 设计 → 明文/工具/规则治理 → 当前实现与测试证据。若文档与当前源码或运行状态冲突，以当前源码和可复核运行证据为实现事实，并在交接报告中记录差异。

## 4. 架构合同重点

主链必须保持：

`RawObservation`（不可变原始事实）→ Process/Runtime/Connection 规范化 → Transport（HTTP/TLS/SSE/WebSocket）→ 通用 LLM Format Registry → Agent/Application Adapter → LogicalAgent/AgentInstance/RuntimeInstance/Session → ToolCall 与 KernelFact 关联 → Sentry/Coverage → Conversation/Evidence/Operations 投影。

人类语义 lane 与机器 Kernel lane 必须独立保存，只通过版本化 `EvidenceLink` 汇合。Parser、Adapter、TLS 或身份失败只能产生 partial/unparsed/unsupported/coverage_gap，不能删除 KernelFact、CandidateAgent 或元数据。

LogicalAgent 优先使用管理面注册定义；其次使用稳定 tenant/owner + 产品族 + workspace/repository + profile 指纹。Codex/Claude CLI 默认是 RuntimeContext/Segment 维度，只有明确 `logicalScopeMode=terminal` 才按终端拆分。每次进程启动/部署代次生成新 AgentInstance。无 provider/thread/session/continuity anchor 时，Session 必须是明确的 ephemeral/per-request；不能从 PID、进程代次、Trace、容器名或产品名升级。

Observer 内核热路径不解析产品 JSON、不写数据库、不调用网络。Transport、LLM Format、Agent Adapter、Runtime Adapter 必须正交；版本特异性只能位于明确的扩展模块，不能穿透通用 Controller/Parser/Correlation/Sentry 核心。

## 5. 已有实现与历史证据（必须重新核对）

以下是上一回合留下的线索，不是免验证结论：

- AnySentry 最近本地 checkpoint 包含：
  - `deec804 fix: normalize legacy runtime session source`
  - `8840c59 docs: record filter activation degradation evidence`
  - `1d03228 docs: reconcile current local deployment snapshot`
  - `fb6f279 docs: record SSH Codex runtime evidence`
- Observer 最近本地 checkpoint 包含：
  - `139e86b fix: keep TLS probes within verifier budget`
  - `fb531aa fix: bound observer verifier diagnostics`
  - `f3899a2 fix: keep TLS metadata tracepoint verifier safe`
- AnySentry 的 `parseObserverAgentInteraction` 已尝试把无 provider anchor 的 `legacy_agent_fallback` 映射为 `per_request`，同时保留 ephemeral；测试脚本 `scripts/verify-canonical-observability.mjs` 增加了 runtime-only 与 provider-anchor 两种断言。构建 dist 后再验证，不能只看源文件。
- Observer `139e86b` 已把 WebSocket header hint 的多层扫描改成固定 64 字节、`bpf_loop` 线性扫描，目标是避免 verifier state explosion；此前特权诊断 Collector 已能加载 Rustls/OpenSSL `_ex` 路径并命中 Rustls payload。`http_writev` 仍可能有独立 verifier 问题，需单独记录。
- 历史 SSH Codex 新终端线索：根进程曾为 PID `3980509`、起始 ticks `61031169`，runtime alias 曾为 `ari_9bde60ac48ac23a232165c45`，canonical runtime key 曾为 `host-root:pjnl261070032:3c440904-a31b-4334-b417-25c745ff3fad:3980509:61031169`。这些值可能已经变化，必须从当前 cgroup/runtime 快照重新获取。
- 历史该实例曾有 67 条 `LlmCall`/`Egress`/`ToolExec`，`identityBindingQuality=exact`，但 `POST /security-center/agents/interactions` 为 0；这只能证明机器 lane，不能证明明文交互或真实 Session。
- 历史本地 NodePort：`http://127.0.0.1:32653/security-center`。所有当前 API、路由、Token、Pod、镜像 digest 都必须重新读取。

## 6. 当前最优先执行顺序

### A. 事实和构建复核

1. 重新读取本文件列出的四份合同。
2. 检查两个仓库状态、当前分支、HEAD、diff、远程地址；不要覆盖用户文件。
3. 检查当前 API/Observer Pod、active ReplicaSet、容器 restart、镜像 digest、PodTemplate provenance、Collector 二进制摘要、Observer alive 文件、cgroup/TLS 快照。
4. `pnpm build:api` 后运行 `node scripts/verify-canonical-observability.mjs`、Canonical contract verifier；Observer 运行 `cargo fmt --all -- --check`、common/collector release tests、clippy 和 eBPF release build。

### B. Observer 本地交付

1. 若 `139e86b` 已验证，使用当前正式 runtime 的 digest-pinned base，只覆盖 Collector binary 到 loopback registry；不要把中间 scripts overlay 当最终镜像。
2. 更新 manual Kustomize overlay 的 image digest 和 PodTemplate provenance，使用完整 client-side render/apply；不要 server-side apply 历史 overlay。
3. 更新后验证 active ReplicaSet image digest == template overlay digest == intended digest，source revision 一致，Pod Ready/restart 和 `/run/a3s-observer.alive` 正常。
4. 观察至少一个短窗口：规则 projection 的生成时间/expiry、ack status、entries、forwarder 控制端点可达性、TLS attach diagnostics、critical/semantic drops。`scope_expired`、timeout、ECONNRESET、PostgreSQL checkpoint 超长都要记录为门禁，不得清 WAL 或清空数据库。

### C. SSH Codex 真实短窗口

1. 不读取、记录或输出用户真实 prompt/模型正文；只用当前 SSH 终端产生有限轮次，或请用户在该终端输入短测试消息。
2. 从当前 cgroup/runtime snapshot 找出准确的 AgentInstance/ProcessGeneration；不要复用历史 PID。
3. 查询并保存脱敏统计：RawObservation、KernelFact、LlmInteraction、ToolCall/Result、Session/Turn/Run、Coverage、EvidenceLink，以及 exact instance 的 API/UI 深链结果。
4. 只有真实 Rustls/WebSocket payload 解析出 provider/thread/session/continuity anchor 后，才允许 Session 从 ephemeral 提升；检查同一 anchor 的第二轮去重、resume、fork 和重启代次。
5. 若 payload 仍为 `orphan_control_frame`、unparsed 或 interactions=0，保留事实和 CoverageGap，不伪造通过。

### D. 其他代表对象与统一协议

- Claude Code：验证 tender_jang 中真实 CLI 多轮和工具闭环，不以版本号硬编码 TLS。
- Dify Workflow/Chatflow：保留已通过的 blocking/streaming 两轮结果，但重新确认当前运行实例、conversation reuse、per-request workflow isolation 与 Kernel/EvidenceLink。
- LangChain service：确认当前容器实际 `/health`、`/invoke`、工具调用和 Observer/Canonical 事件。
- LangGraph+sandbox：真实验证 agent → sandbox execute → exit，确认 sandbox Pod 的 Exec/Exit 与语义 ToolCall 的唯一关联；不能只把时间相近事件强连。
- Kimi/Z.ai/Pi 只保留扩展点，不作为本阶段真实通过条件；Kafka/Flink 不得成为主链前置依赖。

## 7. 典型安全命令

```bash
# 读取合同（每个恢复回合执行）
for f in docs/anysentry-agent-observability-architecture-v2.md \
  docs/anysentry-agent-llm-interaction-observability-prd.md \
  docs/anysentry-agent-llm-interaction-observability-technical-design.md \
  docs/anysentry-agent-conversation-resolution-and-unified-evidence-v4-design.md; do
  sed -n '1,$p' "$f" >/dev/null
done

# AnySentry 静态回归
pnpm build:api
node scripts/verify-canonical-observability.mjs
node scripts/verify-canonical-contract.mjs

# Observer 回归
cd /home/chensicheng/a3s/security/Observer
cargo fmt --all -- --check
cargo test -p a3s-observer-common -p a3s-observer-collector --release
cargo clippy -p a3s-observer-common -p a3s-observer-collector --release -- -D warnings
```

需要管理 Token 的脚本只能从 Kubernetes Secret 临时读入 shell 变量，执行前 `set +x`，执行后 `unset`；不要在命令参数、输出、日志或文件中展开 Token。所有查询使用窄时间窗和 `--noproxy '*'`（若环境代理会干扰 localhost）。

## 8. 交接报告格式

每次交接必须说明：

1. 已确认事实 / 目标设计 / 推断 / 未验证。
2. 修改文件、commit、是否部署、镜像 digest、回滚点。
3. 测试命令与通过/失败/未执行原因。
4. 四类代表对象的环境、轮次、工具、KernelFact、Coverage、EvidenceLink 结果。
5. 当前真正阻塞及已尝试的本地替代；不要把未启动或没有明文写成通过。
6. 凭据只临时使用且未落盘的声明；不要回显秘密、完整 prompt 或 transcript。

## 9. 当前预期判定

除非新的当前证据证明所有明文、Session、Tool→Kernel 唯一关联、持久化查询、API/UI 深链和环境矩阵均通过，否则 Goal 必须保持 active/partial。最重要的硬约束是：Observer 已能识别 SSH Runtime 不等于已捕获对话正文；`AgentInstance` 精确不等于 `Session` confirmed；Canonical GET 通过不等于四类产品被动全链路通过。
