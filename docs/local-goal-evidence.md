# 本地 Canonical Observability Goal QA 证据

记录日期：2026-09-03（Asia/Shanghai）
记录性质：本地只读基线与 QA 门禁，不是发布说明，也不把历史设计文档中的运行声明重新计为本轮实测。

## 结论

本轮建立了可重复的 `scripts/verify-canonical-goal.mjs` 门禁，并完成了构建、类型检查、Observer 单元/宿主测试和一组 AnySentry 定向合同验证。当前代码可以编译，Docker Compose 配置可解析，当前 Kubernetes（`default`）集群的 AnySentry 核心服务可健康响应；但本轮没有启动新的四类代表对象连续对话，也没有把现有残留进程或历史 fixture 当作真实验收证据。

因此，本轮状态是 **部分完成（QA 基线已建立，代表性真实链路待执行）**：

- 初始基线时 Host AnySentry API 端口未监听，依赖该入口的 interaction/coverage/forwarder HTTP 验证被明确记录为 blocked；后续只读复核发现 API 已恢复，但使用 memory fallback，见“最新只读复核”；
- SSH 没有提供可安全执行的本地/远端 Agent 目标，脚本只检查本地客户端和配置，运行链路为 unexecuted；
- Docker daemon 与 Dify 1.14.2 手工栈可用，但当前没有运行中的本分支 AnySentry API，Docker 端到端链路未执行；
- 当前 `kubectl` context 指向单节点 k3s；`anysentry` 核心/Observer Pod 和 NodePort 健康检查通过，但可选 `workspace-scanner` 存在 CrashLoopBackOff，故环境标为 partial；
- `kind` 容器仍存在，但其 API 端口重置连接，未作为 Kubernetes 通过证据。

## 最新只读复核（2026-09-03 03:19 左右）

在不启动/停止/删除任何资源的前提下再次运行：

```text
node scripts/verify-canonical-goal.mjs --json-out /tmp/canonical-goal-round2-probe.json
```

结果：

- Host `healthz` 返回 2xx，服务状态为 `ok`，但 `storageMode=memory`、ClickHouse/PostgreSQL 未就绪；脚本将 Host 环境标为 `partial`，这只能证明 API 进程可响应，不能证明耐久部署；
- Docker daemon 与基础/模块 Compose 解析通过，Dify 容器仍健康；未发现本分支 AnySentry API 容器，localhost 2xx 被标为 Docker `partial`，避免误把 Host 进程当 Docker 部署；
- k3s `default` context 的 AnySentry NodePort 返回 2xx，存储为 ClickHouse/PostgreSQL，核心 workload ready；workspace-scanner CrashLoop/ContainerCreating 与残留 kind API reset 使整体保持 `partial`；
- SSH 仅检查本地 `ssh`/`ssh -G` 和 22/2222 TCP 可达性，没有执行远端命令，故 Agent 运行仍是 `unexecuted`；
- `deploy/anysentry.yaml`、`deploy/observer.yaml`、`deploy/streaming.yaml` 均通过 `kubectl apply --dry-run=client --validate=false`；Dify Compose 直接解析缺少已准备的上游 Compose/UID 变量，未运行 `prepare.sh`（避免下载或改动）；
- fixture shell `bash -n` 和四个非生成 Python 源文件的内存 compile 通过；CLI fixture 没有 Compose 文件，使用 Host 启动脚本；LangChain Compose 可解析；
- 本回合 summary 为 `fail=0`，但四类对象 runtime evidence 仍全部 `unexecuted`，凭据扫描为 `blocked`（既有 untracked/protected 文件，tracked=0），不能宣称代表性 E2E 完成。
- 该复核读取到 Observer 本地 checkpoint `b9c58ed…`；后续 agent 可能继续产生本地 checkpoint，QA 报告中的 commit 仅是快照，不代表远程发布。

Observer 完成本地 checkpoint `55190e4…`（semantic/runtime adapter 合同与 ABI 测试补齐）后，在无并发构建/编辑窗口再次执行：

```text
node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-final-round4.json
```

14 项本地测试全部 `pass`（AnySentry build、双端 TypeScript、部署清单、Canonical contract/identity、会话/目录/绑定、Asset、Semantic-Kernel、Runtime、Templates、Observer cargo）；静态合同和 streaming optional boundary 也为 `pass`，`fail=0`。环境仍为 Host/Docker/Kubernetes `partial`、SSH `unexecuted`，四类代表对象 runtime evidence `unexecuted`，凭据扫描 `blocked`（既有 untracked/protected 文件，tracked=0），所以该结果是“本地代码与 QA 门禁通过”，不是代表性真实 E2E 完成。

在 Observer checkpoint `3d50246…` 和 AnySentry QA checkpoint `0e17df8…` 均稳定后，最终复核再次执行：

```text
node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-final-round6.json
```

Round6 记录：14 项本地测试全部 `pass`；`fail=0`，tracked diff 前后为空，remote-write guard=`pass`。Host API 仅 memory fallback，Docker 没有本分支 API 容器，Kubernetes NodePort/ClickHouse/PostgreSQL 可用但存在 workspace-scanner 与 kind 降级，SSH 和四类代表对象真实 runtime evidence 仍分别为 `unexecuted`。该轮只验证本地代码/合同/运行时健康和回归，不替代代表性真实连续对话验收。

## 已确认事实

### 仓库与工作树

| 仓库 | 分支 | HEAD | 工作树 |
| --- | --- | --- | --- |
| AnySentry | `goal/canonical-observability-20260903` | `da38f0f…` | 保留用户已有修改和未跟踪报告/资产；本轮新增 QA 脚本与本文件 |
| Observer | `goal/canonical-observability-20260903` | `fb515bd…` | 基线审计时 clean |

远程地址仅作只读基线记录；本轮未执行 `git push`、远程分支/PR 操作或镜像远程发布。脚本在运行前后比较 tracked worktree，并以不输出凭据的方式报告 remote host、ahead/behind 和变更路径。

### 本机工具与服务

- Node 24.16、pnpm 9、Cargo/Rust 1.96、Docker 29.5 + Compose v5.1.4、kubectl、kind 0.23、`bpf-linker` 可用。
- 本机没有 `psql`、`clickhouse-client`、`redis-cli`、Java 或 Maven；数据库/缓存诊断通过容器或 HTTP 健康接口完成。
- Docker 中已有 Dify manual 栈（API/Web/Worker、plugin daemon、LLM/tool mock）和本地注册表；这些是既有用户现场，不由本轮创建或清理。
- 主机上可见 Codex、Pi/LangChain 示例和 Observer supervisor 进程，但它们不是本轮启动、隔离、带 run-id 的证据，不能计为代表性通过。

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
| Codex/Claude/Dify/LangChain 连续多轮真实链路 | unexecuted | 本轮不启动真实 Agent/LLM，避免把历史或残留进程当新证据 |

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
| Codex | blocked（AnySentry host API 未启动） | unexecuted（无目标） | unexecuted（无本分支 API） | unexecuted（无本轮 workload evidence） | 静态合同 markers pass；真实运行维度 unexecuted |
| Claude Code | blocked（AnySentry host API 未启动） | unexecuted（无目标） | unexecuted（无本分支 API） | unexecuted（无本轮 workload evidence） | 静态合同 markers pass；真实运行维度 unexecuted |
| Dify Workflow/Chatflow | blocked（AnySentry host API 未启动） | unexecuted（无目标） | blocked/partial（Dify 栈可用，AnySentry API 未启动） | unexecuted（未执行新调用） | 静态合同 markers pass；真实运行维度 unexecuted |
| LangChain/LangGraph | blocked（AnySentry host API 未启动） | unexecuted（无目标） | unexecuted（无本分支 API） | unexecuted（仅有既存服务 Pod，未执行新调用） | 静态合同 markers pass；真实运行维度 unexecuted |

当前环境探针摘要：

| 环境 | 状态 | 证据 |
| --- | --- | --- |
| Host | blocked | Observer collector release artifact 存在；API health 未连接；当前 shell 非 root，不能直接宣称 eBPF attach |
| SSH | unexecuted | 本地 `ssh`/`ssh -G` 可用；没有执行远端命令 |
| Docker | partial | daemon 与 canonical/module Compose config 通过；Dify 容器健康；本分支 API health 未连接 |
| Kubernetes | partial | `kubectl` API、AnySentry NodePort health、5 个核心 workload ready；kind API reset，workspace-scanner degraded |

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
6. 高置信度凭据字面量扫描（仅报告文件/类别，不报告值）；
7. 不执行远程写入或 `git push`，并在执行前后比较工作树。

`--strict` 适合最终门禁：任何 blocked、partial 或 unexecuted 都会以非零退出；默认模式允许 QA 在环境尚未准备好时获得完整报告，而不是把缺口隐藏成失败或通过。`--run-tests` 还会运行 canonical contract/identity 脚本与 `verify-agent-asset-model`；后者若与新 unresolved-candidate 语义的旧断言不一致，会明确报告 `fail`，不会被忽略。

## 凭据与清理声明

本轮没有读取或发送真实模型请求，也没有把本机受保护配置的值写入仓库、日志、镜像、Kubernetes 对象或本文件。扫描器只在内存中读取候选文件，输出路径和类别，不输出值；发现既有本地 secret 文件时不删除、不覆盖，由后续执行者按用户授权和原有生命周期处理。`/tmp` 诊断报告可安全删除，不属于仓库交付物。

## 真正未决项与下一步

- 将当前 Host 的 memory-fallback API 替换/补充为带明确源码 revision 的本地 durable Docker/Kubernetes 部署，保持 API、ClickHouse、PostgreSQL、Redis 和 Web 健康后重跑 ingest/interaction/coverage/forwarder checks；
- 为每个代表对象生成 run-id 隔离、脱敏的 runtime evidence envelope，至少包含启动、新 Session、第二轮、ToolCall/ToolResult、KernelFact、EvidenceLink、Coverage 和失败降级状态；
- 在同一工作树上分别完成 Host、SSH（若有可用目标）、Docker、Kubernetes 的真实运行验证；不适用环境保留 unexecuted/blocked 原因；
- 在无并发构建/编辑窗口持续重跑 `verify-agent-asset-model`，并保留 canonical identity 与 legacy alias 的回放差异；
- 在无磁盘饱和环境重跑 `verify:filter-pipeline` 与 `verify:forwarder-durability`；
- Kimi/Z.ai/Pi 与 Kafka/Flink 时间窗支路仍是后续扩展，不构成本阶段四类代表对象通过条件，也不作为当前主链前置依赖。
