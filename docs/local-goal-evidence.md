# 本地 Canonical Observability Goal QA 证据

记录日期：2026-09-03（Asia/Shanghai）
记录性质：本地只读基线与 QA 门禁，不是发布说明，也不把历史设计文档中的运行声明重新计为本轮实测。

## 结论

本轮建立了可重复的 `scripts/verify-canonical-goal.mjs` 门禁，并完成了构建、类型检查、Observer
单元/宿主测试、Canonical 合同验证、真实 loopback CLI fixture 和本地 Dify mock workflow
验证。当前代码可以编译，Docker Compose 配置可解析，当前 Kubernetes（`default`）集群的
AnySentry 核心服务可健康响应；但 eBPF attach、当前头 Docker/Kubernetes 部署、SSH 目标和
LangChain/LangGraph 真实受控调用仍未满足发布条件。

因此，本轮状态是 **部分完成（代码与受控替代链路通过，代表性被动观测和部分环境待完成）**：

- Host AnySentry API 已用当前源码构建并在 loopback 运行，health 200，但使用 memory fallback；interaction、ingest、S2 off/shadow、S6、canonical representative replay 和 persistence single-flight 均已在该入口复核；
- SSH 没有提供可安全执行的本地/远端 Agent 目标，脚本只检查本地客户端和配置，运行链路为 unexecuted；
- Docker daemon 与 Dify 1.14.2 手工栈可用；本地 mock workflow 的两次 LLM HTTP/1.1 stream 与一次 `/tool/execute` 均返回 200，RAG sentinel 边界通过，但当前没有运行中的本分支 AnySentry API 容器；
- 当前 `kubectl` context 指向单节点 k3s；既存 `anysentry` 核心/Observer Pod 和 NodePort 健康检查通过，但镜像不是当前 dirty 工作树，且可选 `workspace-scanner` 存在不稳定副本，故环境标为 partial；
- `kind` 容器仍存在，但其 API 端口重置连接，未作为 Kubernetes 通过证据。

## 最新冻结 QA 回合（2026-09-03，当前 dirty 工作树）

当前 API 进程曾由源码构建后在 `127.0.0.1:29653` 运行并完成短验收，随后已停止（仅作为
本地验证入口，memory fallback；管理/session 值为临时专用环境变量）。以下结果均不包含
凭据或真实 Prompt：

```text
pnpm build                                      PASS
API/Web tsc --noEmit                            PASS
Observer fmt/build/test/clippy                  PASS
Observer tests                                   32 + 7 + 155 + 8 = 202 PASS
canonical representative replay                 PASS (13 synthetic authenticated events)
S2 trusted-correlation (temporary off/shadow)    PASS (5/5, 70/70)
S2 trusted-correlation (fixed API shadow)        PASS (70/70)
final health/contracts + representative/S6     PASS (health/contracts 200; replay/S6 pass)
heterogeneous ingest / interactions / S6         PASS
Conversation Tracking browser (4 viewports)       PASS (temporary API, synthetic interaction)
Agent/Event + Tool Inspector browser               PASS (temporary API, synthetic model/tool)
```

最新 `verify-canonical-goal.mjs --run-tests` 结果为 `pass=57`、`partial=5`、`blocked=4`、
`unexecuted=7`、`fail=0`（73 个状态）。静态 raw/kernel/semantic/identity/correlation/
coverage、产品分支、Observer ABI、Kafka/Flink optional boundary 和 bounded-state guard
均为 pass；credential scan 仍为 blocked（10 个既有 untracked/protected 文件，tracked
finding=0），remote-write guard 为 pass。

验证脚本创建的 Source（包括 negative-path 自动发现的 Source）在最终固定 API 上均已设为
`enabled=false`；Source 记录保留用于审计，没有删除业务数据。最终临时 API 进程已停止，
监听端口与临时测试目录已清理。

额外受控运行：

- 真实安装的 Codex CLI 与 Claude Code 通过 loopback mock 完成两轮产品级请求、工具调用、
  工具结果和最终回复；这证明产品交互闭环，不证明本机 Observer 已被动捕获；Codex HTTPS
  运行器超时，按当前 Rustls/协议边界记为未通过；
- 既有 Dify Docker lab 运行两次 LLM stream 和一次外部工具 POST（均 200），只在临时 0700
  结果目录记录 bytes/hash 前缀，运行后清理；
- LangChain/LangGraph 仅完成合同/回放验证；既有服务 health 可达但 `/invoke` 超时，未写成真实通过；
- Docker 当前头镜像 build/create 在本地 mirror 401、高 I/O legacy build 和 container create
  timeout 下未完成；Kubernetes 既有部署保持旧 digest 健康，但本轮曾在独立临时 namespace
  以旧本地运行时镜像只读挂载当前 `apps/api/dist` 做 hostPath fallback，Canonical replay、
  S6 和 S2 shadow 70/70 通过后已删除该 namespace；正式当前头镜像仍未部署；SSH 无 Agent 目标。

> 下面原“Round2/Round4/Round6”以及旧的“最新冻结”段落是历史审计记录。它们保留用于追溯，
> 不覆盖本节的当前状态，也不应把旧 Observer clean/旧计数当成现状。

## 历史最新冻结 QA 回合（2026-09-03，Observer 10cebf5）

在没有启动、停止或删除任何外部资源的前提下，使用当前本地工作树执行：

```text
node scripts/verify-canonical-goal.mjs --run-tests --json-out /tmp/canonical-goal-qa-10ce.json
```

结果为 `pass=56`、`partial=5`、`blocked=4`、`unexecuted=7`、`fail=0`（72 个门禁状态）。这是历史回合的结果；当前回合已增加 per-request、secret isolation 和回放验证，见上节。

本回合仍不能宣称四类代表对象的真实 E2E 完成：Codex、Claude Code、Dify、LangChain/LangGraph 在 Host/SSH/Docker/Kubernetes 的 runtime evidence 均为 `unexecuted`。Host API 是 memory fallback，Docker 未检测到本分支 AnySentry 容器，SSH 没有目标，Kubernetes 虽有既存 AnySentry/Observer Pod 但 workspace-scanner 为 1/2 Ready 且不是当前工作树镜像。凭据扫描为 `blocked`（10 个既有 untracked/protected 文件，tracked finding=0），remote-write guard 为 `pass`。该 JSON 仅写入权限为 0600 的 `/tmp` 路径，不属于仓库交付物。

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
| AnySentry | `goal/canonical-observability-20260903` | `a1cda4d…`（工作树含本地未提交重构） | 保留用户已有修改和未跟踪报告/资产；本轮新增 QA 脚本与本文件 |
| Observer | `goal/canonical-observability-20260903` | `10cebf5…` | 本地 checkpoint，工作树 clean；未 push |

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
| Codex | partial（Host API memory fallback） | unexecuted（无目标） | unexecuted（无本分支 API 容器） | unexecuted（无本轮 workload evidence） | 静态合同 markers pass；真实运行维度 unexecuted |
| Claude Code | partial（Host API memory fallback） | unexecuted（无目标） | unexecuted（无本分支 API 容器） | unexecuted（无本轮 workload evidence） | 静态合同 markers pass；真实运行维度 unexecuted |
| Dify Workflow/Chatflow | partial（Host API memory fallback） | unexecuted（无目标） | partial（既有 Dify 栈健康，但无本分支 AnySentry API 容器） | unexecuted（未执行新调用） | 静态合同 markers pass；真实运行维度 unexecuted |
| LangChain/LangGraph | partial（Host API memory fallback） | unexecuted（无目标） | unexecuted（无本分支 API 容器） | partial（既存服务 Pod，不是本轮 workload evidence） | 静态合同 markers pass；真实运行维度 unexecuted |

当前环境探针摘要：

| 环境 | 状态 | 证据 |
| --- | --- | --- |
| Host | partial | API health 200 但 memory fallback；Observer collector release artifact 存在；当前 shell 非 root，不能直接宣称 eBPF attach |
| SSH | unexecuted | 本地 `ssh`/`ssh -G` 可用；没有执行远端命令 |
| Docker | partial | daemon 与 canonical/module Compose config 通过；Dify 容器健康；未发现本分支 AnySentry API 容器 |
| Kubernetes | partial | `kubectl` API、AnySentry NodePort health、核心 workload ready；workspace-scanner 1/2 Ready 且重启频繁；既存镜像不是当前 dirty 工作树 |

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

本轮没有读取或发送真实模型请求，也没有把本机受保护配置的值写入仓库、日志、镜像、Kubernetes 对象或本文件。扫描器只在内存中读取候选文件，输出路径和类别，不输出值；发现既有本地 secret 文件时不删除、不覆盖，由后续执行者按用户授权和原有生命周期处理。`/tmp` 诊断报告可安全删除，不属于仓库交付物。

## 真正未决项与下一步

- 当前文档与 v2/V4 历史设计仍有少量旧现场数字/镜像/入口声明；这些声明不作为本轮通过证据，后续应继续以最新脱敏 gate JSON 和本地 checkpoint 替换或明确标注历史。
- Semantic Inspector 已能显示部分 canonical EvidenceLink/Raw/Kernel/Session 标识，但完整 UI 深链接和多竞争 EvidenceLink 展示仍需浏览器验收；管理认证缺失时必须显示明确的 coverage/权限状态。
- 将当前 Host 的 memory-fallback API 替换/补充为带明确源码 revision 的本地 durable Docker/Kubernetes 部署，保持 API、ClickHouse、PostgreSQL、Redis 和 Web 健康后重跑 ingest/interaction/coverage/forwarder checks；
- 为每个代表对象生成 run-id 隔离、脱敏的 runtime evidence envelope，至少包含启动、新 Session、第二轮、ToolCall/ToolResult、KernelFact、EvidenceLink、Coverage 和失败降级状态；
- 在同一工作树上分别完成 Host、SSH（若有可用目标）、Docker、Kubernetes 的真实运行验证；不适用环境保留 unexecuted/blocked 原因；
- 在无并发构建/编辑窗口持续重跑 `verify-agent-asset-model`，并保留 canonical identity 与 legacy alias 的回放差异；
- 在无磁盘饱和环境重跑 `verify:filter-pipeline` 与 `verify:forwarder-durability`；
- Kimi/Z.ai/Pi 与 Kafka/Flink 时间窗支路仍是后续扩展，不构成本阶段四类代表对象通过条件，也不作为当前主链前置依赖。
