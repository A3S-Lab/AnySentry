# AnySentry 通用 Agent 语义聚合、可信身份归一与选择性文件读取采集 PRD

状态：已审核开发方案

版本：v0.1

日期：2026-08-26

审核结论：用户批准 `agentProduct` 与 Asset 分离、probable 仅在 exact binding 下启用 read、独立 File Read Ring、Read Scope 过期后关闭并显式记录 coverage gap；其余兼容、阶段和验收约束随本方案一并进入开发。

适用范围：Observer/eBPF、Collector、Forwarder、AnySentry API、统一过滤规则系统、资产生命周期、ClickHouse 查询、Web 控制台

关联设计：

- [AnySentry 可信关联身份、采集过滤与开发阶段设计](./anysentry-trusted-correlation-and-capture-roadmap.md)
- [AnySentry 身份语义与系统上下文闭环优化设计](./anysentry-identity-semantics-and-system-context-optimization.md)
- [AnySentry 统一资产生命周期、人工身份审核与采集规则治理优化设计](./anysentry-unified-asset-lifecycle-and-capture-rule-governance.md)
- [AnySentry 统一过滤规则系统与可视化平台 PRD](./anysentry-unified-filter-rule-system-prd.md)
- [File Filter Pipeline v1](./file-filter-pipeline-v1.md)
- [Agent Discovery and Observation Filter](./agent-discovery-filter.md)

---

## 零、审核摘要

### 0.1 本 PRD 解决的不是 Pi 特例

Pi 只是把现有系统中的通用问题完整暴露了出来：

```text
同一个真实 Agent
  ├─ 部署 Inventory 给出一种身份
  ├─ Runtime Signature 给出一种名称
  ├─ Agent Adapter 给出一种 Runtime/Process 表达
  ├─ Observer 从宿主机看到另一种 PID/Container 表达
  └─ Trace、Invocation、ToolCall 又各自有独立标识

如果这些标识未经类型化和规范化：
  → 同一 Agent 被拆成多个资产
  → 不同 Agent 可能因名称相同被错误合并
  → Tool Span 与 Kernel Evidence 无法稳定聚合
  → 采集策略无法安全下发到精确 Runtime/Root
```

这一问题同样适用于：

- 用户在宿主机或终端启动的 Codex、Claude Code、Gemini CLI、Kimi CLI；
- Docker 中运行的 Agent；
- Kubernetes 中部署的定制 Agent 服务；
- 使用 `node`、`python`、`java` 等通用运行时的自研 Agent；
- 一个业务服务进程内嵌的 Agent；
- 同一容器、cgroup、会话或进程中并发运行的多个 Agent/Invocation；
- 有 Adapter/OTLP 语义和没有 Adapter 的纯内核观测场景。

因此，本 PRD 不允许出现任何 `if agent == pi`、`if agent == codex` 式产品分支。Pi、Codex 等只作为测试夹具和 Agent Product/Runtime Family 证据，不作为聚合算法本身。

### 0.2 核心决策

本 PRD 推荐批准以下十项决策：

1. **Agent Product、Logical Agent Asset、Runtime、Root Process、Invocation 和 ToolCall 分开建模。** `pi`、`codex` 是产品/运行时家族，不自动等于资产 ID。
2. **采用“类型化身份图解析算法”。** 只允许强等价证据自动合并；名称、路径、时间邻近和单独 Trace 只能建立弱关系，不能合并资产。
3. **现有字段永久兼容。** 不重命名或覆盖 `agentId`、`agentInstanceId`、`traceId`、`sessionId`、`runId`；通过新增规范身份、binding revision 和 alias 读模型归一。
4. **文件读取作为选择性启用的独立信号。** 普通、Unknown、Infrastructure 和 non-Agent 继续默认不采集只读打开；仅对具有精确 Runtime/Root 绑定的 `probable_agent`、`confirmed_agent` 和显式调查范围启用。
5. **读采集不通过全局删除 `O_RDONLY` 跳过实现。** 必须先做 O(1) Agent Read Scope 查询，未命中时不复制路径、不 reserve Ring。
6. **读事件使用独立物理 Ring/优先级通道。** 防止 Agent 仓库扫描或依赖加载挤占写入、删除、安全和关键生命周期事件。
7. **统一规则系统新增一个 typed signal-enablement 规则。** 同一 `ruleId/revision` 编译为 F0 eligibility、F1 本地 Read Scope、F2 语义保留和 F3 持久化投影，并在“过滤规则”页面可解释。
8. **Agent 行为以 Invocation/ToolCall 为主，Kernel Evidence 为证据。** “命令追踪”升级为通用“Agent 行为追踪”，不只查询 `ToolExec`，也不把所有 FileAccess 平铺成命令。
9. **资产目录、行为统计窗口和实时审阅状态解耦。** Logical Asset 不再由当前事件窗口反推；实时更新不能抢占用户正在阅读的选择和滚动位置。
10. **持久资产容量按实体类型隔离。** Agent/Service 等长期资产不能被大量 ephemeral process 占满容量后挤出或阻止物化。

### 0.3 对既有设计的增量修正

既有 S6 设计把没有内核读探针时的 `read` 定义为 `semantic_only`。本 PRD 对它做如下增量修正：

```text
普通/未知工作负载：
  仍默认忽略 O_RDONLY，不扩大节点级读流量

精确绑定的 probable/confirmed Agent：
  启用 read-open Kernel Evidence

确实未产生本机 syscall、Adapter 不可用前已发生、能力未部署或证据不完整：
  仍允许 semantic_only / runtime-level / partial
```

本 PRD 不承诺通过 `open/openat/openat2` 证明“实际读取了多少字节”。第一阶段表达的是：

> 某个精确 Agent Process 以只读方式打开了某个文件。

这比“工具声明要读取”多了一层内核事实，但仍不同于对 `read/pread/mmap/io_uring` 的完整字节级取证。

---

## 一、背景与已确认事实

### 1.1 当前 Pi 样本揭示的身份分裂

同一个 Kubernetes Pod、同一个完整 Container ID，在当前系统中出现了至少三种身份表达：

```text
Adapter physicalWorkloadId
  k8s:<clusterId>:<podUid>:<fullContainerId>

Observer/Kubernetes agentInstanceId
  <podUid>/<fullContainerId>

Process Signature Runtime
  ari_<hash(agentProduct + rootProcessKey)>
```

同时存在两种名称语义：

```text
Runtime Signature: pi
Deployment Label: k8s-pi-agent-manual
```

当前实现把这些不同层级的标识放入相同或相邻字段参与资产派生，最终导致：

```text
agent_7fc...  ← Adapter AgentTool / AgentInvocation
agent_f3a...  ← Observer FileAccess / ToolExec / Process
ari_...       ← Process Root Runtime Registry
```

但是现场证据已经证明：Adapter `write` 和内核 `FileAccess` 具有相同的：

```text
Pod UID + Container ID
PID namespace + namespace PID
process startTimeTicks
resource hash
```

现有 ToolEvidence 关系能够返回：

```text
status     = linked
reason     = exact_process_and_resource
confidence = 1
```

所以问题不是“无法关联”，而是规范身份没有在资产、Runtime、查询和页面之间统一消费。

### 1.2 Codex 样本证明不能按产品名合并

当前宿主机中同时存在多个 Codex Root：

```text
scope/product = codex
root A = host + boot + pid A + start A
root B = host + boot + pid B + start B
root C = host + boot + pid C + start C
```

它们具有相同产品家族，但属于不同 Process Tree 和 Runtime Generation。由此得到反向约束：

> Pi 案例要求系统能把同一 Runtime 的多种表达合并；Codex 案例要求系统不能因为产品名相同而把不同 Runtime 合并。

因此不能继续让 `agentScopeId=pi/codex` 同时承担“产品类型”“资产身份”和“运行实例”的多重含义。

### 1.3 当前只读文件在规则判断前被跳过

Observer 当前在 `sys_enter_openat` 中先读取 flags，然后执行：

```text
flags & O_ACCMODE == O_RDONLY
  → return
```

该返回发生在 Capture Profile、Agent Process Promotion、路径复制和 Ring reserve 之前，见 Observer 仓库中的 `a3s-observer-ebpf/src/main.rs` 文件探针。

因此当前结果是：

- 即使 cgroup 已是 `agent_full`，O_RDONLY 仍不会进入 Ring；
- 即使 root 已是 probable/confirmed Agent，进程内 `read` 仍没有内核读证据；
- Pi Adapter 可以生成 `AgentTool read`，但内核侧只能显示 `semantic_only`；
- 没有 Adapter 的 Codex/自研 Agent read 工具甚至可能完全没有“读取文件”的语义记录。

### 1.4 当前 FileAccess 语义不足

Observer 事件模型已有兼容字段：

```text
FileAccess { pid, path, write: bool }
```

但 API 的紧凑属性投影没有稳定保留 `write`，当前 `FileAccess` 查询主要只有 path，无法可靠区分：

```text
read_only
write_only
read_write
path_only
unknown
```

同时，当前 Capture Profile 只有一个扁平的 `file_access` action，不能表达：

```text
普通工作负载：write 按原策略，read 默认关闭
Agent Runtime：write 按 agent profile，read 精确启用
```

### 1.5 当前资产和事件阅读不稳定

当前资产查询在持续写入时可能因 committed cutoff 不可用，整体退回 API 内部 5000 条 Hot Ring。现场“近 3 小时”请求实际只覆盖约几十秒，候选 Agent 和事件数会随 Ring 淘汰消失。

当前事件页面还存在：

- 列表和 Timeline 分别每 10 秒轮询；
- 没有明确选择时自动跟随第一条事件；
- 当前选中事件暂时不在列表时自动回退第一条；
- 点击事件会同时改写 trace、run、kind、source、agent 等列表筛选；
- durable 查询竞争时可能静默退回 Hot Ring；
- API 返回了 partial coverage，但页面未清楚展示。

当前统一资产投影也已经触及 10,000 条容量上限，其中绝大多数是 ephemeral process，并返回 `asset_state_truncated/asset_materialization_degraded`。这说明“改用生命周期资产源”本身还不够：长期 Agent/Service Asset、活跃 Runtime 和短期临时进程必须使用分类型容量、优先级与 TTL，不能共享一个无差别上限。

这些问题会掩盖身份和采集优化是否真正生效，因此也纳入本 PRD 的验收范围。

### 1.6 外部规范依据

本设计采用以下成熟语义作为边界，而不是自定义一个万能 Agent ID：

- OpenTelemetry 将 `invoke_agent` 与 `execute_tool` 建模为不同操作，`gen_ai.tool.call.id` 用于 ToolCall；工具参数和结果可能敏感，应按 opt-in/脱敏策略处理。[OpenTelemetry GenAI Spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
- OpenTelemetry Entity 指南强调使用“足以唯一识别实体的最小属性集”，并以 `process.pid + process.creation.time` 作为进程实体示例；多 Observer 必须尽量使用双方都能观察到的标识或显式关系。[OpenTelemetry Resource and Entities](https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/resource-and-entities/)
- Kubernetes 名称可以复用，而 UID 用于区分历史上相似对象的不同实例；Pod、Deployment、StatefulSet 等都有 UID 语义。[Kubernetes Object Names and IDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/)、[OpenTelemetry Kubernetes Resources](https://opentelemetry.io/docs/specs/semconv/resource/k8s/)
- W3C Trace Context 定义 Trace 为分布式请求传播上下文，不是资产身份注册协议。因此 Trace 可以作为关联证据，但不能单独合并 Agent Asset。[W3C Trace Context](https://www.w3.org/TR/trace-context/)
- Linux `O_RDONLY/O_WRONLY/O_RDWR` 是 access mode，位于 flags 的低两位；`O_RDONLY` 的数值为 0，不能用普通 bit-presence 思路判断。`O_PATH` 和特殊 access mode 3 也必须单独处理。[Linux open(2)](https://man7.org/linux/man-pages/man2/open.2.html)

---

## 二、目标、范围与成功标准

### 2.1 总目标

实现一条不依赖具体 Agent 产品名称的统一链路：

```text
Inventory / Runtime Signature / Adapter / Process / Behavior
  ↓
类型化身份事实
  ↓
Physical Workload、Agent Root、Runtime、Logical Asset 分层解析
  ↓
规范身份与 Alias/Binding Revision
  ↓
对精确 probable/confirmed Runtime 启用选择性 File Read Capture
  ↓
AgentTool / Invocation + Kernel File/Process/Network Evidence
  ↓
通用 Agent Action
  ↓
持久资产目录、行为时间窗、稳定审阅界面
```

### 2.2 功能成功标准

- Pi、Codex、Claude Code、Gemini CLI、Kimi CLI、Docker 自研 Agent、Kubernetes 自研 Agent 使用同一身份和行为聚合算法。
- 同一真实 Runtime 的 Adapter、Observer、Inventory 和 Runtime Snapshot 事件归入同一规范 Runtime/Asset 视图。
- 同产品、不同 Process Root 的多个 Codex 不会因为 `agentProduct=codex` 被合并。
- 同一容器中的 sidecar、业务进程和多个 Agent Root 不会因共享 cgroup 被错误归入一个 Agent。
- 具有精确 Runtime/Root 绑定的 `probable_agent` 和 `confirmed_agent` 的只读打开进入专用 File Read Ring。
- Unknown、ordinary process、Infrastructure 和 non-Agent 的普通只读打开不进入 File Read Ring。
- AgentTool `read/write/bash/custom` 均能显示通用行为语义；存在内核证据时严格关联，不存在时明确 `semantic_only`。
- Logical Agent Asset 不因 Hot Ring 淘汰、事件沉默、规则变化或 Runtime 退出而从资产目录消失。
- 用户阅读事件或行为时，新数据不自动替换当前选择和滚动位置。

### 2.3 可量化成功标准

| 维度 | 指标 | 必须结果 |
|---|---|---|
| Agent 召回 | 已知/新 Agent Root marker | 100% |
| Read 召回 | 已启用精确 Agent Scope 的 read-open canary | 100% |
| Read 隔离 | 未启用 Scope 的 read-open Ring submit | 0 |
| Asset Split | 同一强 Runtime 被拆成多个 current canonical asset | 0 |
| False Merge | 不同 tenant/runtime/root 被合并 | 0 |
| ToolEvidence | 强证据关联错误 | 0 |
| PID reuse | 继承旧 Runtime/Read Scope | 0 |
| Sidecar | Agent 容器 sidecar 读事件被放行 | 0 |
| Ring 安全 | 两倍目标峰值下 write/delete/security/exec/read Ring drop | 0 |
| 过载隔离 | Read burst 导致 Write/Delete/Security 丢失 | 0 |
| 资产连续性 | Hot Ring churn 导致资产消失 | 0 |
| 审阅连续性 | 轮询导致选择、Trace、滚动自动切换 | 0 |
| 兼容性 | 旧 Trace/Incident/Alert/Flink key 变化 | 0 |

### 2.4 不在本轮范围内

- 不采集文件内容。
- 不默认保存完整 Tool 参数和结果。
- 不把 read-open 解释为“已读取全部文件内容”或“读取了某个字节数”。
- 第一阶段不承诺覆盖 `mmap`、预先继承 FD、`io_uring`、远端文件系统内部读以及所有语言运行时特殊路径。
- 不用时间邻近单独创建 ToolCall 关系。
- 不按 `pi`、`codex`、`node`、`python`、Pod 名、容器名、workspace path 或 traceId 单独合并资产。
- 不重写历史事件中的旧 ID。
- 不通过全局开启 O_RDONLY、扩大 Ring 或无界缓存代替精确 Read Scope。
- 不把过滤规则和 L1/L2/L3 风险规则合并成同一生命周期。

---

## 三、统一语义模型

### 3.1 八层对象必须分开

```text
Agent Product / Runtime Family
  例如 codex、pi、claude-code；描述“是什么产品”，不是唯一资产

Logical Agent Asset
  用户管理、审核、命名和长期查看的稳定对象

Physical Workload Instance
  Host cgroup/systemd、Docker Container、K8s Pod+Container

Agent Runtime Instance
  能安全接收同一采集档位的最小运行范围

Agent Root Instance
  host + boot + pid + process start marker 对应的一次根进程生命期

Process Instance
  某个具体进程 generation

Invocation / ToolCall
  一次 Agent 请求及其工具行为

Event
  一条语义或内核事实
```

### 3.2 Agent Runtime 的当前语境定义

Agent Runtime Instance 不是固定等于容器或 PID，而是：

> 能够在不连带无关进程的前提下，安全应用同一个 Agent 身份与 Capture Profile 的最小运行范围。

典型映射：

| 场景 | Runtime 范围 | Root 范围 |
|---|---|---|
| 独占 Agent Kubernetes Container | 完整 Container Instance | 容器内一个或多个 Agent Root generation |
| 独占 Agent Docker Container | 完整 Container Instance | 容器内 Agent Root generation |
| Host 直接启动 Codex | 精确 Host Agent Root | 同 Runtime |
| 共享 SSH/session cgroup | 精确 Agent Root，不使用整个 session | Agent Root generation |
| 业务服务内嵌 Agent | 精确服务 Process generation 或已认证内部 Runtime | 具体进程/线程上下文能力范围 |
| 同一进程多个 Agent | 共享物理 Runtime；Logical Agent 由 Adapter 区分 | Kernel 事件可能只能到共享 Runtime |

### 3.3 身份、分类和关联置信度分开

```text
identityClassification
  它是不是 Agent

identityBindingQuality
  当前 Event/Runtime 是否稳定绑定到某个 Asset

correlationConfidence
  当前 Event 是否属于某个 Invocation/ToolCall

captureEligibility
  当前精确 Scope 是否可以启用某类信号
```

例如：

```text
某 FileAccess 100% 属于一个 confirmed Agent Runtime
但没有 Adapter，无法确认具体 ToolCall

identity = confirmed_agent
binding = exact
correlation.scope = runtime
toolCallId = empty
```

### 3.4 名称字段的正确职责

| 字段/概念 | 正确用途 | 禁止用途 |
|---|---|---|
| agentProduct | 产品/运行时家族，如 codex/pi | 唯一资产键 |
| displayName | 用户可读名称 | 合并键 |
| agentScopeId | 旧兼容、来源声明或局部逻辑标签 | 未经 authority 判断的全局唯一 ID |
| agentAssetId | 旧/当前资产引用 | 静默改变历史含义 |
| canonicalAgentAssetId | 当前读模型中的规范资产 | 回写覆盖旧事件 |
| agentInstanceId | 旧兼容实例字段 | 同时表达容器、Root 和 Runtime 三种含义 |
| physicalWorkloadId | 规范物理实例 | Invocation ID |
| agentRootInstanceId | 一次 Agent 根进程生命期 | Logical Asset ID |
| invocationId/toolCallId | Agent 应用语义 | 物理工作负载 ID |
| traceId | 分布式 Trace | Agent 资产身份 |

---

## 四、目标 High-level 架构

```text
                     身份与规则控制面
┌────────────────────────────────────────────────────────────┐
│ Inventory / Labels / Registration / Review                 │
│ Runtime Signature / Behavior Candidate / Adapter Binding   │
│                           ↓                                │
│                  类型化身份图解析                           │
│ Product / Asset / Workload / Runtime / Root / Process      │
│                           ↓                                │
│ Canonical Binding + Alias + Revision + Conflict             │
│                           ↓                                │
│ Unified Rule Compiler                                      │
│ F0 context → F1 capture → F2 semantic → F3 retention       │
│                           ↓                                │
│ Node-local Capture Profile + Agent Read Scope              │
└───────────────────────────┬────────────────────────────────┘
                            │
                            ▼
                         数据面
┌────────────────────────────────────────────────────────────┐
│ open/openat/openat2                                        │
│   ↓ access mode classification                             │
│ read_only?                                                 │
│   ├─ no → 原有 File Write/Delete 流程                       │
│   └─ yes → O(1) Agent Read Scope lookup                    │
│              ├─ miss → counter only，不复制 path/不 reserve │
│              └─ hit  → 独立 File Read Ring                 │
│                                                            │
│ Exec/Exit/Security/File/Network + Adapter/OTLP              │
│   ↓                                                        │
│ Process/Runtime canonical binding                          │
│   ↓                                                        │
│ Invocation/ToolCall + Kernel Evidence                      │
│   ↓                                                        │
│ Generic Agent Action                                       │
│   ↓                                                        │
│ Durable Asset Directory + Window Metrics + Stable UI       │
└────────────────────────────────────────────────────────────┘
```

---

## 五、类型化身份图解析算法

### 5.1 为什么不能使用一个“更聪明的 agentId 哈希”

当前问题不是哈希算法本身，而是哈希前输入的语义不稳定：

```text
physicalWorkloadId
agentInstanceId
podUid/containerId
rootProcessKey
agentScopeId
```

这些值分别描述物理实例、Root、来源标签和产品家族。继续选择一个字段优先级并哈希，必然在不同事件来源下产生 split；反过来把所有值直接 union，又会在共享容器和多个 Codex Root 场景产生 false merge。

因此推荐采用“类型化证据节点 + 受限关系边 + 规范读模型”。

### 5.2 第一步：将原始证据解析成类型化 Atom

每个来源只能提交自己有权观察的事实：

```text
Security Domain
  tenantId / environmentId / clusterId / hostId

Physical Workload Atom
  podUid / fullContainerId / containerRuntime / cgroupId / systemdUnit

Process Atom
  hostPid / namespacePid / pidNamespace / bootId / startTime

Agent Semantic Atom
  registeredAssetId / deploymentAgentId / sourceBinding / reviewBinding

Agent Product Atom
  runtime signature family: codex / pi / ...

Invocation Atom
  authenticated invocationId / toolCallId / traceId / spanId
```

来源权限：

| 来源 | 可以建立的强事实 | 不能单独决定 |
|---|---|---|
| Kubernetes/Docker Inventory | Pod/Container/Owner/Label/物理生命周期 | ToolCall |
| Observer | Process/Cgroup/Root/Kernel Event | Logical Agent 名称、Invocation |
| Runtime Signature | Agent Product + probable candidate | confirmed Asset、跨 Root 合并 |
| Authenticated Adapter/OTLP | Invocation/ToolCall + 绑定范围内的 Process 声明 | 越权 tenant/workload、任意 confirmed Asset |
| 人工审核 | 已存在稳定对象的当前身份结论 | 凭空创建物理实例 |
| Behavior Discovery | probable candidate | authoritative merge/DROP |

### 5.3 第二步：规范化物理和进程身份

#### Kubernetes Physical Workload Key

```text
k8s-runtime:v1
  tenantId
  environmentId
  clusterUid
  podUid
  fullContainerId
```

规范化规则：

- 移除 `containerd://`、`docker://`、`cri-o://` 等 transport prefix；
- Container ID 使用 Inventory 提供的完整值，小写规范化；
- 短 ID 只能作为查找 alias，不能单独建立长期等价；
- Pod name、Deployment name 用于展示；Pod UID、Owner UID 用于实体关系；
- `<podUid>/<containerId>` 与 `k8s:<cluster>:<podUid>:<containerId>` 解析到同一 typed atom，但保留各自原始 alias。

#### Docker Physical Workload Key

```text
docker-runtime:v1
  tenantId
  environmentId
  hostId
  containerRuntime
  fullContainerId
```

#### Host Root Key

```text
host-root:v1
  hostId
  bootId
  rootPid
  rootStartTime
```

#### Cross-namespace Process Key

Adapter 在容器内看到 namespace PID，Observer 在宿主机看到 host PID。两者使用以下强等价面：

```text
container Process:
  physicalWorkloadKey
  + pidNamespace
  + namespacePid
  + startTimeTicks/startTimeNs

host Process:
  hostId
  + bootId
  + hostPid
  + startTimeTicks/startTimeNs
```

PID 没有 start marker 时只能产生 `weak/ephemeral`，不能继承旧进程结论。

### 5.4 第三步：建立不同类型的关系边

| 边 | 含义 | 是否允许自动合并 |
|---|---|---|
| `exact_equivalent` | 两种表示指向同一 Physical/Process entity | 只合并同类型实体 |
| `contained_in` | Process 位于 Container/cgroup | 不合并 Asset |
| `root_of` | Root 是 Process 后代根 | 继承 Runtime Scope，不合并其他 Root |
| `runtime_member_of` | Root/Physical Scope 属于 Runtime | 是，要求精确约束 |
| `asset_member_of` | Runtime 属于 Logical Asset | 是，要求权威逻辑 anchor |
| `semantic_bound_to` | Adapter Invocation/Tool 绑定 Runtime/Process | 是，受 Source scope 限制 |
| `legacy_alias_of` | 旧 ID 指向 canonical read model | 是，可版本化/回滚 |
| `same_product` | 都是 Codex/Pi 等产品 | 否 |
| `same_workspace` | workspace 相同 | 否 |
| `time_near` | 时间邻近 | 否，只用于候选检索 |
| `same_trace` | Trace 相同 | 否，只用于调用关联证据 |

核心原则：

> Physical Workload 相同只证明共享运行位置，不自动证明是同一个 Logical Agent；Agent Product 相同只证明产品家族，不自动证明是同一个 Runtime。

### 5.5 第四步：两阶段解析，而不是一次全局 union

#### 阶段 A：Runtime/Process 等价解析

只使用强实体证据：

```text
normalized full container identity
exact root Process generation
cross-namespace exact Process tuple
inventory lifecycle relation
```

该阶段可以使用确定性 union-find/等价类，但必须先按以下边界分区：

```text
tenantId
environmentId
cluster/host security domain
entity type
```

不同 tenant/environment 永不自动 union。

#### 阶段 B：Runtime → Logical Asset 归属

按以下优先级选择逻辑 anchor：

```text
1. 服务端验证的显式 AgentAsset binding / 人工 canonical binding
2. 认证 Adapter Source binding + Inventory/Process 一致
3. K8s/Docker Agent label + 稳定 owner/controller binding
4. Operator Agent Template + 精确 Runtime/Root
5. Runtime Signature 命中的独立 Root → 新建 ephemeral probable Asset
6. Behavior Candidate 的独立 Root/Physical Scope → 新建 ephemeral candidate
7. 证据不足 → unassigned / investigation group
```

`same_product`、`same_workspace`、`same_trace` 不进入该优先级。

### 5.6 第五步：Canonical ID 与 Alias 选择

如果多个旧资产被强证据证明属于同一 Logical Asset，规范 ID 选择顺序：

```text
已有人工审核/管理元数据的 Asset
→ 显式平台注册 Asset
→ 已存在最早的稳定 Logical Asset
→ 根据规范逻辑 anchor 新建 Asset
```

其余 ID 进入：

```text
agentAssetAliases[]
legacyIdentityAliases[]
```

需要写入低频、可审计事实：

```text
AssetAliasAdded
AssetMergeProposed
AssetMergeApplied
AssetMergeReverted
RuntimeBindingChanged
IdentityConflictDetected
```

禁止：

- 更新 ClickHouse 中所有历史 `agentAssetId`；
- 修改旧 Trace/Incident/Alert key；
- 删除旧深链接；
- 形成 alias 环；
- 因一次弱事件永久合并资产。

### 5.7 第六步：冲突和拒绝合并

以下情况必须保持分离并显示 conflict：

- 同一时间两个不同完整 Container ID 声称同一个 physical runtime；
- 不同 tenant/environment 的 Adapter 声明相同 Agent；
- 同一容器存在两个不相交 Agent Root，且没有共同权威 Logical Asset；
- 同一进程存在多个并发 Agent，但 Adapter 不能区分上下文；
- Source workspace 与 server-owned binding 冲突；
- PID 相同但 start marker 不同；
- 只有产品名、显示名、workspace、路径或时间邻近相同。

冲突时：

```text
事件继续保留
Read Capture 只对可证明的精确 Root 生效
Logical Asset 不自动合并
Invocation/ToolCall 可保持 semantic_only
页面展示冲突和待审核原因
```

### 5.8 第七步：热路径物化

类型化图解析不在每个事件上遍历完整图。Central/Forwarder 异步生成版本化快照：

```text
PhysicalKey -> RuntimeBinding
RootProcessKey -> RuntimeBinding
ProcessKey -> Root/Runtime
LegacyAlias -> CanonicalAsset
Runtime -> ReadCaptureEligibility
```

事件热路径仅进行 O(1) Map/Cache 查询，并携带：

```text
identityResolutionRevision
assetBindingRevision
bindingQuality
bindingAuthority
bindingReasonCode
```

### 5.9 通用案例

#### 案例 A：Kubernetes Pi/自研 Agent

```text
Deployment label 给出 Logical Agent anchor
Runtime Signature 给出 agentProduct=pi
Adapter 给出 Invocation/ToolCall + namespace Process
Observer 给出 host Process + Kernel Event
Pod UID/Container ID + namespace Process tuple 归一
  ↓
一个 Logical Asset
一个 Container Runtime
多个 Root/Invocation
ToolCall 与 Kernel Evidence 精确关联
```

#### 案例 B：同一 Host 多个 Codex 窗口

```text
product 都是 codex
rootPid/startTime 不同
Process Tree 不相交
  ↓
不得按 codex 合并 Runtime
默认创建多个 ephemeral Agent Asset/Runtime
只有显式平台 binding 才可归到同一管理 Asset
```

#### 案例 C：Docker 自研 Python Agent

```text
process=python 不是 Agent 证据
Docker fullContainerId 建立 Physical Runtime
认证 Adapter / Agent label / Template 建立 Agent anchor
  ↓
确认 Agent
```

#### 案例 D：业务服务进程内嵌 Agent

```text
Service Asset 保持 business_service
Agent Runtime 绑定精确 Process generation
只对该 Root/Process Read Scope 启用
同 cgroup 其他服务进程不启用
```

#### 案例 E：同一进程多个 Agent/并发 Invocation

```text
Kernel Event 最多确认 shared Runtime/Process
Adapter 区分 Invocation/ToolCall
证据冲突或并发资源相同 → ambiguous，不强行分配
```

---

## 六、选择性文件读取采集

### 6.1 目标语义

新增一个可审计信号：

```text
signal = file_open_read
eventKind = FileAccess                 # 保持兼容
fileOperation = open
accessMode = read_only
evidenceMeaning = process opened path with read-only access intent
```

不得显示为“已读取文件全部内容”。

### 6.2 Access Mode 闭集

在路径复制之前只解析 flags 的闭集状态：

```text
read_only
write_only
read_write
path_only       # O_PATH，不等同于 read
special_mode    # Linux access mode 3
unknown
```

兼容字段 `write: boolean` 保留，但新增 `accessMode` 成为规范查询字段。

### 6.3 Read Capture Eligibility

| 身份/状态 | Binding 要求 | Read Capture |
|---|---|---|
| confirmed_agent | exact Runtime 或 exact Root | enabled/full |
| probable_agent | exact Runtime 或 exact Root，短 TTL | enabled/full，成本有界且可观测 |
| investigation_full | 精确 Runtime/Process + TTL | enabled/full |
| Agent/Infrastructure conflict | 只允许精确 Agent Root；专用 Agent container 可按 container | enabled on exact scope |
| unknown | 无 | disabled |
| non_agent | 无 | disabled |
| business/infrastructure/anysentry service | 无精确 Agent Root | disabled |
| stale/map miss | 无有效 LKG | disabled + coverage gap |

`probable_agent` 只有名称/弱 behavior、但没有精确 Runtime/Root 时：

```text
身份仍可显示 probable
Read Capture 状态 = pending_identity_binding
不得扩大到 session/cgroup
```

### 6.4 为什么 Read 的 stale 行为不能复用普通 fail-open

现有规则中“控制面 stale → FULL”适用于已经启用的信号，避免 destructive filtering 错丢事件。

对于默认关闭的高频 read 信号，如果 map miss/stale 时全局 FULL，会变成：

```text
控制面短暂异常
  → 整个节点所有 O_RDONLY 进入 Ring
  → Ring/Collector 立即过载
```

因此必须定义：

> `file_open_read` 是 opt-in signal。stale 时可以继续使用未过期的精确 LKG Read Scope，但绝不把未绑定 Scope 全局开启。

这不是把 Unknown 判断为 non-Agent，也不是 destructive DROP，而是“没有获得该可选高频信号的启用资格”。页面必须显示相应 Observation Coverage。

### 6.5 Ring 前目标流程

```text
sys_enter_open/openat/openat2
  ↓
读取 access mode（固定字段，不读取 path）
  ↓
write_only/read_write
  → 原有 File Write Capture 决策

read_only
  ↓
查询专用 Agent Read Scope Map
  ├─ exact dedicated runtime cgroup hit
  ├─ exact root/process generation hit
  └─ descendant promotion hit
  ↓
miss/stale/conflict-unsafe
  → read_not_enabled counter
  → return，不复制 path、不 reserve
  ↓
hit
  → 复制 path
  → reserve 独立 File Read Ring
  → submit read-open event
```

### 6.6 为什么推荐独立 File Read Ring

Agent 可能发生：

- 启动时加载大量 runtime/module/config；
- Codex 扫描大型仓库；
- read/grep/index 工具批量打开文件；
- language server、package manager 或 child tool 在 Agent Root 下工作。

如果 Read 与 Write 共用同一 Ring，Read burst 可能挤掉更重要的写入和删除证据。

推荐：

```text
File Write/Open Ring     保留现有行为和 ABI 顺序
File Delete Ring         保持独立
File Read/Open Ring      新增，独立容量和 loss accounting
```

对外逻辑事件仍统一为 `FileAccess`，通过 `accessMode` 区分；物理传输和优先级独立。

### 6.7 精确 Scope 的两种物化

#### Dedicated Agent Workload

满足以下条件时可按 cgroup/container 启用：

```text
trusted Inventory 声明专用 Agent container
+ full Container ID
+ classification probable/confirmed
+ 无 sidecar/container ambiguity
+ 有效 policy version/TTL
```

#### Shared Workload / Host Session

使用：

```text
cgroupId
+ rootPid
+ rootExecGeneration/start marker
+ epoch
+ descendant inheritance
```

不能把 `session-*.scope`、Pod 级 cgroup 或整个业务服务 cgroup 直接启用。

### 6.8 新 Agent 的首轮 Read 覆盖

安全事实：在 Agent 被识别并物化 Read Scope 之前已经发生的 O_RDONLY 无法恢复。

改进顺序：

```text
首次 Exec 始终保留
  ↓
本地 Runtime Signature 命中 Root
  ↓
立即建立短 TTL probable Read Scope
  ↓
后续 read-open 开始采集
  ↓
Central/Inventory/Adapter 确认后续期或升级
```

如果 Agent 只能在较晚的 behavior evidence 后被识别：

- 之前的 read-open 保持不可用；
- Observation Coverage 从 Read Scope effectiveAt 开始；
- UI 不得伪造此前完整性；
- 可以通过显式模板、Label、Adapter 或预注册提高首轮覆盖。

### 6.9 子进程和工具继承

确认/候选 Agent Root 启用后：

```text
fork/clone
  → child 继承 Read Scope

exec
  → 更新 child Process generation
  → 只有 generation fence 一致才继续生效

exit
  → 删除活跃 Scope
  → 保留短 TTL tombstone 接收晚到事件
```

因此 Agent 启动的 `cat`、`rg`、`python` 等子进程不靠通用进程名识别，而是通过精确 ancestry 继承。

### 6.10 F2/F3 成本控制

“进入 Read Ring”不等于“每个重复打开永久保存一条大事件”。

F2 允许在语义完全相同时合并：

```text
canonical Runtime
+ Process generation
+ normalized resource key/path hash
+ accessMode
+ identity/binding revision
+ capture rule/revision
+ time bucket
```

保留：

```text
firstAt / lastAt / exact repeatCount
first event evidence
AgentTool link status
security-sensitive marker
coverage and decision receipt
```

优先级：

```text
sensitive/security read
> authenticated AgentTool target
> confirmed Agent workspace read
> probable Agent read
> runtime dependency/cache repeated read
```

发生预算压力时：

- 不能静默丢失；
- 重复普通 read 可以转 exact aggregate；
- Security、已认证 ToolCall 目标和首次证据优先；
- Read 降级不得影响 Write/Delete/Security/Exec；
- 页面显示 `partial/aggregated`。

### 6.11 路径和资源身份

eBPF 捕获的是调用方提供的 path，不一定是最终解析后的 inode 路径。通用关联使用：

```text
raw path（脱敏/有界）
cwd
mount namespace（可用时）
lexically normalized path
resource hash
device/inode（未来可选）
```

匹配优先级：

```text
1. same exact Process + same normalized resource hash
2. same exact Process + cwd-resolved relative path
3. same Runtime + attested resource identity
4. 不足 → semantic_only / unassigned，不靠纯时间猜测
```

### 6.12 syscall 覆盖边界

第一阶段要求审计并逐平台支持：

```text
openat
openat2
必要架构上的 open 兼容路径
```

后续独立评估：

```text
read/pread/readv
mmap page access
io_uring
pre-opened/inherited fd
network/remote filesystem internal reads
```

这些后续信号不得在本 PRD 第一版中被错误宣称为已覆盖。

---

## 七、统一规则系统中的新增规则

### 7.1 新增 typed rule kind

推荐新增：

```text
category = capture_profile
ruleKind = signal_enablement
```

用途：控制“默认未启用的高频子信号是否可以进入采集决策”，与普通 retention DROP 区分。

### 7.2 新增内置规则

```text
ruleId: fr_guardrail_agent_file_read_enable
name: Agent File Read Evidence Enablement
management: builtin
editable: false
lifecycle: enforced
```

自然语言语义：

```text
当身份为 probable_agent 或 confirmed_agent，
并且当前事件可以绑定到 exact Agent Runtime 或 exact Agent Root，
为该物理 Scope 启用 file_open_read；
共享 cgroup 只能物化到精确 Root/descendant；
策略过期、绑定冲突或 map miss 不扩大范围。
```

逻辑输入：

```text
identity.classification in [probable_agent, confirmed_agent]
binding.quality = exact
runtime.state in [starting, current, idle]
signal.name = file_open_read
```

逻辑输出：

```text
enable signal=file_open_read
captureAction=full
scopeMode=dedicated_runtime_or_exact_root
reasonCode=agent_file_read_enabled
```

### 7.3 基线行为

平台保留一个可见但不可编辑的默认能力边界：

```text
file_open_read default = disabled
```

它表达“该高频信号没有被启用”，不是把 Unknown 判为 non-Agent，也不产生人工审核语义。

### 7.4 四阶段投影

| 阶段 | 投影 |
|---|---|
| F0 | 计算 `readCaptureEligible`、binding quality、scope mode 和原因 |
| F1 | 物化 cgroup/root Process Read Scope，执行 O(1) enablement lookup |
| F2 | Agent read keep/coalesce/priority，保留 decision lineage |
| F3 | confirmed/probable read retain，relation/aggregate 持久化 |

所有阶段携带同一：

```text
ruleId
ruleRevision
identityVersion
captureVersion
nodeEpoch
assetBindingRevision
reasonCode
```

### 7.5 规则优先级

```text
P0 Security / protected lifecycle
P1 exact investigation read enablement
P2 exact confirmed Agent read enablement
P3 exact probable Agent read enablement（短 TTL）
P4 baseline read disabled
```

冲突原则：

- Agent 与 Infrastructure 冲突时，精确 Agent Root 的 read enablement 获胜；
- 不允许因此启用整个共享 Infrastructure cgroup；
- Source/tenant/workload 冲突时不建立高置信 Read Scope；
- binding stale 时使用未过期 LKG，过期后关闭可选 read 并记录 coverage gap。

### 7.6 Shadow 的特殊语义

现有普通 Capture Profile shadow 会把动作强制为 FULL，以比较 would-drop。

该行为不能直接用于 `file_open_read`，否则 shadow 本身会全局开启读采集。

Read Enablement shadow 必须是：

```text
未命中 Scope：只增加 would_enable/miss counter，不复制 path、不 reserve
命中 Agent Scope：仅在显式 canary 配置下提交 raw read
```

### 7.7 过滤规则页面要求

页面在“Agent 语义 / Capture Profile”中展示：

```text
文件读取默认状态：未启用
启用条件：候选或确认 Agent + 精确 Runtime/Root
适用阶段：F0 / F1 / F2 / F3
节点能力：支持/不支持 selective read
当前物化 Scope 数
匹配方式：dedicated cgroup / exact root
TTL、epoch、ACK、coverage
```

Explain 示例必须至少覆盖：

- Host Codex Root 的 read 为什么启用；
- 同 session 普通 shell 的 read 为什么未启用；
- Kubernetes Agent container 的 read 为什么启用；
- 同 Pod sidecar 的 read 为什么未启用；
- probable 但 binding weak 时为什么处于 pending；
- stale 时为什么不全局 fail-open。

---

## 八、通用 Agent 行为聚合

### 8.1 页面对象从“命令”升级为“行为”

`ToolExec` 只代表创建了新进程，无法覆盖：

- 进程内 read/write；
- MCP/HTTP/数据库工具；
- SDK 内函数工具；
- 远端工具；
- 纯语义 Agent 操作。

因此目标对象为：

```text
AgentAction
  actionId
  agentAsset / runtime / root
  invocationId?
  toolCallId?
  toolName / operation
  startedAt / endedAt / status
  target summary
  semantic evidence
  kernel evidence[]
  relation status / confidence / reason
  observation completeness
```

### 8.2 聚合优先级

```text
1. Authenticated AgentTool start/end
2. Authenticated AgentInvocation
3. ToolExec + exact Process lineage
4. File/Network/Security Kernel Evidence
5. Runtime-level kernel_inferred action
```

禁止：

- 把所有 FileAccess 直接当成 ToolCall；
- 仅凭几秒内发生就把文件事件归入一个工具；
- 把 Tool start/end 显示为两个用户行为；
- 把 AgentTool bash 和其 ToolExec 子进程重复显示成两个顶级行为。

### 8.3 read/write/bash/custom 的统一表现

```text
write
  AgentTool write
    └─ FileAccess write/read_write evidence

read
  AgentTool read
    └─ FileAccess read_only evidence（Scope 已启用时）
       或 semantic_only（无 syscall/能力/gap）

bash
  AgentTool bash
    └─ ToolExec shell/command
       └─ File/Network evidence

custom/remote
  AgentTool custom
    └─ 本机证据存在则关联，否则 semantic_only
```

### 8.4 不修改 Trace

目标行为页按以下顺序导航：

```text
Invocation
→ ToolCall
→ Process/Kernel Evidence
→ Raw Trace
```

原有 Trace 页面和 `traceId` 查询保持不变。Runtime-level synthetic trace 必须明确标记，不伪装成单次 Invocation。

### 8.5 无 Adapter 的 Agent

Codex 或自研 Agent 没有 Adapter 时：

```text
FileAccess/ToolExec
  → exact Process
  → exact Agent Root/Runtime
  → Generic Runtime Action

invocationId/toolCallId 留空
relation = runtime_level / kernel_inferred
```

页面仍能展示“这个 Agent Runtime 读取/写入/执行了什么”，但不能虚构“这是某次具体 ToolCall”。

---

## 九、稳定资产目录与查询语义

### 9.1 资产目录不再从窗口事件反推

资产列表成员来自：

```text
Observed Asset Lifecycle
+ Agent Metadata/Review
+ Runtime Lifecycle
+ Canonical Alias/Binding
```

时间窗口只提供：

```text
eventCount
riskCount
actionCount
lastActivity
trend
```

资产存在性由 Inventory、Runtime、显式退出/删除和长期保留策略驱动，不由 Hot Ring 或窗口事件数驱动。

资产状态容量必须分层：

```text
受保护长期层
  Agent Asset / Service Asset / reviewed Asset / active Runtime

有界调查层
  probable / unknown workload candidate

短期临时层
  ephemeral process / weak investigation group
```

临时进程容量饱和时只能淘汰或压缩临时层，不能阻止 Agent/Service 生命周期事实写入。低频 Asset/Runtime/Binding 事实持久化，详细 Process 临时投影使用独立 TTL 和预算。

### 9.2 Logical Asset 与 Runtime 分层

```text
Codex / 自定义名称                     probable/confirmed
  ├─ Runtime A：current
  ├─ Runtime B：exited
  └─ Runtime C：historical
```

默认列表一行一个 canonical Logical Asset；Runtime 在详情或展开区展示。

### 9.3 Durable + Hot Delta

禁止：

```text
committed cutoff 暂时不可用
→ 整个三小时查询退回 5000 条 Hot Ring
```

目标：

```text
持久历史事实/聚合 bucket
+ 当前 pending/hot delta
+ eventId/revision 去重
→ 一致快照
```

Heartbeat 写缓冲不能阻断事件历史读取。后台查询繁忙时返回 last-known-good/stale 状态，不能用更小的 Hot Ring 结果覆盖完整列表。

### 9.4 时间选择器语义

资产页拆成：

```text
资产范围：当前 / 最近出现 / 历史 / 已归档
行为统计：近 15m / 1h / 3h / 自定义
```

“近 3 小时”只影响行为统计，不决定资产是否存在。

### 9.5 Coverage 必须可见

页面至少显示：

```text
请求范围
真实 dataFrom/dataTo
source
partial reason
total mode
snapshot revision
```

例如：

```text
请求近 3 小时；当前仅覆盖最近 43 秒；来源为 Hot Ring；结果不完整。
```

---

## 十、稳定实时审阅体验

### 10.1 两种模式

#### Live

- 后台获取新数据；
- 用户位于顶部且未进入详情时可自动跟随；
- 新项目进入 pending buffer；
- 显示“有 N 条新事件/行为”。

#### Inspect

用户选中 Agent、Action、Event、Invocation 或 Trace 后：

- 固定 snapshotAsOf/snapshotRevision；
- 当前选择、顺序和滚动不变；
- 新数据不自动插入可见列表；
- 用户点击“加载更新”或“恢复实时”后应用。

### 10.2 Query 与 Selection 分离

```text
QueryState
  time / source / classification / kind / asset filters

SelectionState
  selectedAssetId / selectedEventId / selectedActionId / selectedTraceId
```

点击事件不能再自动修改 kind、source、run、trace 和 Agent 等列表筛选。

### 10.3 选择不存在于当前页时

禁止自动回退第一条。目标行为：

```text
按稳定 ID 读取详情
保留本地 last-good detail
显示“不在当前页/当前数据 partial”
```

### 10.4 同一快照

列表、详情、Action、Timeline 必须使用同一个 snapshot revision。独立轮询不能互相竞争后静默得到不同存储来源。

---

## 十一、兼容优先的数据模型

### 11.1 新增规范身份读模型

推荐新增可选结构，不替换旧字段：

```text
identityResolution
  schemaVersion
  resolutionRevision
  canonicalAgentAssetId?
  canonicalAgentRuntimeInstanceId?
  agentRootInstanceId?
  physicalWorkloadId?
  processInstanceId?
  agentProduct?
  bindingQuality
  authority
  reasonCode
  evidenceRefs[]
  legacyAliases[]
  conflicts[]
```

规范 Asset 可以随人工 merge/alias 演进，因此历史事件中保存的是发生时 binding/revision；当前查询通过 overlay 返回 canonical ID。

### 11.2 FileAccess 增量字段

```text
fileOperation = open
accessMode = read_only | write_only | read_write | path_only | special_mode | unknown
path
pathHash
pathScope = workspace | system | dependency | cache | sensitive | unknown
readCaptureRuleId?
readCaptureRuleRevision?
readScopeType?
```

兼容字段 `write` 保留；旧消费者仍可按原逻辑读取。

### 11.3 Decision Receipt

```text
captureDecision
  signal=file_open_read
  selected=true/false
  action=full/aggregate/sample/not_enabled
  scopeType=runtime/root/process
  profile
  ruleId/revision
  epoch
  reasonCode
  bindingRevision
```

### 11.4 Agent Action 读模型

```text
actionId = hash(domain + canonicalRuntime + invocationId/toolCallId/fallback key)
actionOrigin = semantic | kernel_inferred
relationStatus = linked | semantic_only | runtime_level | ambiguous | unavailable
```

ToolCall ID 只在认证 Source/Invocation scope 内唯一，不能裸用 `toolCallId` 作为全局 key。

### 11.5 兼容迁移顺序

```text
1. schema/readers first
2. Flink/ClickHouse/Web 接受可选字段
3. identity normalization shadow
4. canonical alias read overlay
5. F1 capability advertisement
6. selective read shadow counters
7. canary raw read
8. generic action dual-read
9. 默认读取路径切换
```

旧节点不支持 selective read 时：

- v1 Profile 继续运行；
- read coverage 明确为 unsupported；
- 不能显示“已启用”；
- 混合版本滚动升级不阻断其他信号。

---

## 十二、安全、性能和可观测性

### 12.1 热路径约束

- 每个 read-open 最多执行 O(1) Map lookup；
- 未启用 Scope 不复制 path；
- 未启用 Scope 不 reserve Ring；
- 不访问 Kubernetes/Docker API；
- 不读 `/proc`；
- 不执行字符串/正则 Agent 匹配；
- 不遍历父进程树；
- 不调用 LLM。

### 12.2 队列与优先级

```text
Critical
  Security / Exec / Exit / Control

Semantic
  AgentTool / linked read/write/bash evidence

Read Bulk
  普通 Agent read-open / aggregate

Context Bulk
  Infrastructure/Service/Unknown aggregate
```

Read Bulk 饱和不能阻塞 Critical 或 File Write/Delete。

### 12.3 Accounting

每个窗口必须守恒：

```text
file_read_attempted
  = scope_not_enabled
  + scope_stale
  + scope_conflict
  + aggregate
  + sample_rejected
  + ring_submitted
  + probe_error

ring_submitted
  = collector_received
  + ring_dropped
```

后续继续记录：

```text
collector_enqueued/dropped
forwarder_received/coalesced/forwarded
api_received/persisted/duplicate/rejected
tool_evidence_linked/semantic_only/ambiguous
```

Prometheus 不使用 assetId、PID、path、toolCallId 等高基数 label。

### 12.4 隐私与敏感信息

- 不采集文件内容；
- path 按现有脱敏和长度限制；
- Tool 参数/result 默认 hash/metadata，完整内容 opt-in；
- 敏感路径可以用于安全规则，但 UI 受权限控制；
- Explain 使用资源摘要或 hash，不在标准页面暴露秘密路径；
- 审计记录谁开启了 investigation read scope。

### 12.5 降级语义

| 故障 | 行为 |
|---|---|
| Control 短暂断连 | 使用未过期精确 LKG Read Scope |
| Read Scope TTL 过期 | 关闭可选 read，记录 gap，不全局开启 |
| Read Ring 满 | 计数 drop；Write/Delete/Security 不受影响 |
| Adapter 不可用 | Runtime-level Kernel Evidence；不伪造 ToolCall |
| Kernel read 能力未部署 | AgentTool semantic_only + unsupported coverage |
| Identity conflict | 精确 Root 可启用；宽 cgroup 不启用 |
| Durable store 不可用 | 返回 partial/LKG，不用空数组表示无证据 |
| Alias conflict | 保持资产分离，进入审核，不自动 union |

---

## 十三、开发阶段

阶段依赖：

```text
Phase 0 可测量性与兼容基线
  → Phase 1 类型化身份规范化
    → Phase 2 Canonical Asset/Runtime 与稳定目录
      → Phase 3 Selective Read ABI 与规则 Shadow
        → Phase 4 Read Canary 与行为聚合
          → Phase 5 稳定查询和前端审阅
            → Phase 6 长期总验收
```

### Phase 0：兼容基线与现场回放

开发内容：

- 固化 Pi、多个 Host Codex、Docker Agent、K8s sidecar、普通服务黄金事件；
- 固化当前旧 ID、Trace、Incident、Alert、Flink 行为；
- 增加 split/merge/conflict/read accounting；
- 建立 Read Scope decision-only benchmark；
- 建立当前资产 Hot Ring 抖动回放。

退出门槛：

- 新能力关闭时行为完全兼容；
- 任意事件能解释当前 raw identity atoms；
- 读事件路径的 attempted/not-enabled 可测量但不提交 raw；
- 现有消费者接受新增可选字段。

### Phase 1：类型化身份规范化 Shadow

开发内容：

- 解析 Agent Product 与 Logical Agent ID 的不同语义；
- 标准化 K8s/Docker/Host Physical Key；
- 标准化跨 PID namespace Process Key；
- 生成新旧资产 split/merge proposal；
- 强/弱关系分离；
- 冲突和 tenant boundary。

退出门槛：

- Pi Adapter/Observer 指向同一规范 Process/Runtime；
- 多个 Codex Root 保持分离；
- 同 Pod sidecar 不合并；
- shadow false merge 为 0；
- 所有 proposal 可回指强证据。

### Phase 2：Canonical Asset/Runtime 与稳定目录

开发内容：

- 版本化 Alias/Merge/Revert；
- 当前读模型返回 canonical asset；
- 统一 Asset Lifecycle 与 Runtime Lifecycle；
- 将长期 Agent/Service、候选和 ephemeral process 的容量、TTL 与淘汰策略隔离；
- 资产目录使用持久生命周期主源；
- 窗口 metrics 通过 Durable + Hot Delta join；
- 修复 committed cutoff 导致的 Hot Ring 整体退化。

退出门槛：

- 同一 Pi/自研 Runtime 不再出现两个 current canonical asset；
- API 重启、Ring churn、事件沉默不让资产消失；
- 旧 ID/深链仍可访问；
- Logical Asset 与 Runtime 列表分层正确。
- 大量 ephemeral process churn 不会使 Agent/Service 物化进入 degraded 或被淘汰。

### Phase 3：Selective Read ABI v2 与规则 Shadow

开发内容：

- accessMode 闭集；
- 独立 File Read Ring 和 counters；
- Read Scope Map/Process generation fence；
- `signal_enablement` rule 与 F0/F1/F2/F3 projection；
- Collector capabilities 和混合版本兼容；
- 特殊 read shadow 语义；
- openat/openat2 覆盖审计。

退出门槛：

- 未启用 Scope 的 path copy/ring reserve 为 0；
- Shadow 不全局输出 O_RDONLY；
- probable/confirmed exact Scope would-enable 100%；
- shared cgroup 只命中精确 Root；
- cross-language compiler/ABI golden 一致。

### Phase 4：Read Canary 与通用 Agent Action

开发内容：

- Host Codex、Docker 自研 Agent、K8s Agent 分别 canary；
- 子进程继承、PID reuse、TTL 回收；
- AgentTool read/write/bash/custom 聚合；
- read/write resource hash 和 Process 关系；
- F2 coalesce、F3 relation；
- Read Bulk 优先级隔离。

退出门槛：

- 三种部署 read-open recall 100%；
- 非 Agent read submit 0；
- Pi write/read 和通用自研 Agent 行为正确；
- Codex 无 Adapter 时以 runtime_level 展示；
- Read burst 不影响 Write/Delete/Security。

### Phase 5：稳定查询与前端审阅

开发内容：

- 通用 Agent 行为页；
- Invocation/ToolCall/Runtime/Raw Trace 多视角；
- 资产范围与行为窗口分离；
- Live/Inspect；
- pending updates；
- 选择状态与筛选状态分离；
- coverage/snapshot revision；
- 过滤规则页展示 Read Enablement 和 Explain。

退出门槛：

- 不存在 Pi/Codex 专用页面分支；
- 用户能解释 read 为什么采集/未采集；
- 轮询不改变当前选择、滚动和 Trace；
- partial/LKG/unsupported 不伪装为空或完整。

### Phase 6：长期运行与总验收

开发内容：

- 24 小时以上混合负载；
- 峰值与两倍峰值 read/write/network；
- API/Observer/Forwarder 重启；
- K8s rollout、Docker restart、Host PID reuse；
- 控制面断连、TTL、LKG；
- 大型仓库 Codex 扫描；
- 同容器多 Agent/sidecar；
- 历史 3h/7d/30d 行为查询。

退出门槛：

- 最终验收矩阵全部通过；
- High-level 实际流程与本 PRD 一致；
- Read/Identity/Asset/Action 计数可对账；
- 无 Ring/Collector/Critical 物理丢失；
- 无 false merge、跨 tenant 错链或资产消失。

---

## 十四、测试与验收场景

### 14.1 单元和模块测试

#### 身份规范化

- `containerd://ID`、`docker://ID`、裸 ID 归一；
- `<podUid>/<containerId>` 与规范 Physical Key 对应；
- 短 Container ID 不能独立建立长期 identity；
- Host PID 相同、start 不同不等价；
- namespace PID 与 host PID 通过精确 tuple 对应；
- alias 无环、merge 可回滚。

#### Access Mode

- O_RDONLY → read_only；
- O_WRONLY → write_only；
- O_RDWR → read_write；
- O_PATH → path_only；
- mode 3 → special_mode；
- 不以 `flags & O_RDONLY` 判断；
- openat/openat2 参数读取正确。

#### Read Scope

- exact dedicated container hit；
- exact Root hit；
- descendant inheritance；
- PID reuse fence；
- TTL expiry；
- stale LKG；
- map miss 不全局开启；
- shared cgroup 普通进程 miss。

#### 行为聚合

- Tool start/end 合一；
- write/read resource link；
- bash ToolExec 嵌套；
- semantic_only；
- ambiguous 并发不误链；
- toolCallId 跨 Source 不冲突。

### 14.2 端到端场景

#### 场景 A：Host 多 Codex

```text
同一 SSH session 启动两个 Codex
→ 两个 Root/Runtime
→ product 都为 codex
→ 各自 read 只归自己 Process Tree
→ 不互相合并
```

#### 场景 B：Kubernetes Agent + sidecar

```text
Agent container + sidecar
→ Agent read enabled
→ sidecar read disabled
→ Pod 级名称相同不改变结果
```

#### 场景 C：Pi/通用 Adapter Agent

```text
一次 Invocation 执行 write/read/bash/custom
→ 一个 Logical Asset/Runtime
→ 每个 Tool 独立 ToolCall
→ write/read 与正确 Kernel Evidence 链接
→ custom 无 syscall 时 semantic_only
```

#### 场景 D：Docker Python Agent 与普通 Python 服务

```text
两个容器都运行 python
→ 只有 label/Adapter/template 对应的 Agent Container 启用 read
→ 普通 Python 服务不启用
```

#### 场景 E：同一业务服务内嵌 Agent

```text
业务服务和 Agent 共享 cgroup
→ 只物化精确 Agent Root
→ 其他服务线程/进程 read 不进入 Ring
```

#### 场景 F：候选后识别

```text
首个 read 发生时仍 unknown
→ 不采集
→ Runtime Signature 命中 probable Root
→ Scope effectiveAt 后的 read 被采集
→ UI 显示之前 coverage gap
```

#### 场景 G：控制面断连

```text
现有 exact Read Scope 在 LKG TTL 内继续
→ TTL 到期关闭 read
→ 不全局启用
→ 资产仍显示 current/degraded
```

#### 场景 H：Ring 压力

```text
大型仓库 read burst
→ Read Ring/Read Bulk 有压力
→ Write/Delete/Security/Exec 仍零丢失
→ 重复 read 聚合并显示 partial/aggregate
```

#### 场景 I：资产和页面稳定性

```text
持续注入超过 Hot Ring 容量的背景事件
→ 已发现 Agent Asset 不消失
→ 当前选中 Agent/Event/Action 不变
→ 新数据进入 pending updates
```

#### 场景 J：Ephemeral Process 容量冲击

```text
持续生成超过临时投影预算的短命进程
→ ephemeral 层独立压缩/淘汰
→ Agent/Service Asset 和 active Runtime 仍可物化
→ 页面明确显示临时层 truncation，不把长期资产标为丢失
```

### 14.3 最终验收矩阵

| 领域 | 必须结果 |
|---|---|
| 通用性 | 新增 Agent 产品无需修改聚合核心，只需规则/Adapter/Inventory 事实 |
| Product 语义 | pi/codex 等不作为唯一 Asset key |
| Runtime 等价 | Adapter/Observer/Inventory 强身份归一 |
| Runtime 隔离 | 同产品不同 Root、同 cgroup 多 Root 不误合并 |
| Read 资格 | probable/confirmed exact Scope 100% 启用 |
| Read 默认 | 未绑定 Scope 0 raw submit |
| Read Truth | UI 明确是 read-open evidence，不声称字节读取 |
| Read Ring | 独立 accounting，burst 不影响其他关键 Ring |
| Action | read/write/bash/custom 使用同一模型 |
| Correlation | 有强证据才 linked；否则 semantic_only/runtime_level/ambiguous |
| Asset | Ring churn、事件沉默、规则变化不导致消失 |
| Asset Capacity | ephemeral process 饱和不挤出 Agent/Service/active Runtime |
| Query | Durable + Hot Delta，不静默退回更小结果覆盖 LKG |
| UX | Live 更新不抢占 Inspect 状态 |
| Rules | 一个 Catalog、同一 lineage、F0/F1/F2/F3 可解释 |
| Compatibility | 旧字段、Trace、Incident、Alert、Flink key 保持 |
| Security | 跨 tenant/workload 误链 0，文件内容采集 0 |

---

## 十五、完全实现后的 High-level 流程

```text
系统发现 Agent 或 Agent 候选
  ↓
解析来源事实类型
Product / Deployment / Physical / Process / Adapter / Review
  ↓
规范化实体
Physical Workload / Root / Process
  ↓
强等价解析 + 逻辑归属
  ↓
Canonical Agent Asset + Runtime + Alias + Binding Revision
  ↓
统一规则系统计算
identity + role + profile + readCaptureEligibility
  ↓
物化到节点
cgroup profile + exact root/process Read Scope + epoch/TTL
  ↓
内核事件发生
  ├─ 非 read：沿用既有 Probe/Profile 决策
  └─ read-only：O(1) Read Scope lookup
       ├─ miss：仅计数，不进入 Ring
       └─ hit：进入独立 File Read Ring
  ↓
Collector 快速排空与优先级隔离
  ↓
Forwarder 完成身份补全、去重、聚合、Decision Receipt
  ↓
API 执行 Source 认证和 canonical binding overlay
  ↓
AgentTool / Invocation 与 Kernel Evidence 严格关联
  ↓
Generic Agent Action
  ↓
ClickHouse / Relation Store / Asset Lifecycle 持久化
  ↓
稳定资产目录
  + 行为统计窗口
  + Live/Inspect 审阅
  + Coverage/Rule Explain
```

最终系统应能回答：

```text
这是哪个 Logical Agent？
当前是哪个 Runtime 和 Root？
它是 Codex、Pi 还是自研 Runtime Family？
为什么这些 Adapter/Kernel 事件属于同一对象？
为什么这个文件读取被采集，而旁边服务的读取没有被采集？
这次行为属于哪个 Invocation/ToolCall，还是只能确认到 Runtime？
当前数据是 full、aggregate、semantic_only 还是存在 gap？
哪条统一规则在 F0/F1/F2/F3 生效？
```

---

## 十六、待审核决策

建议本次整体批准以下决策，开发时按阶段连续实施：

1. `pi/codex/...` 正式降为 `agentProduct/runtimeFamily` 语义，不再作为自动资产合并键。
2. 使用类型化身份图和强关系边完成 Runtime/Asset 归一，禁止名称/时间/Trace 单独 merge。
3. 新增 additive canonical identity/alias 读模型，不修改旧字段和历史 Trace。
4. `file_open_read` 作为默认关闭、精确 Agent Scope 启用的独立信号。
5. probable Agent 在具有 exact Runtime/Root 时也启用 read；使用短 TTL、独立 Ring、F2 聚合和完整 accounting 控制成本。
6. Read stale/map miss 不执行节点级全局 fail-open；未过期 LKG 后进入 explicit coverage gap。
7. 新增独立 File Read Ring，逻辑上仍输出兼容 `FileAccess + accessMode`。
8. 统一规则目录新增不可编辑的 `fr_guardrail_agent_file_read_enable`，并对四阶段可视化。
9. “命令追踪”升级为通用 Agent Action，Invocation/ToolCall 优先、Kernel Evidence 嵌套。
10. 资产目录和行为窗口分离，实时列表采用 Live/Inspect，不再自动抢占用户阅读。

本 PRD 审核通过后，下一步应先完成 **Phase 0 基线与 Phase 1 身份规范化**。在 identity shadow 没有证明 false merge 为 0 之前，不应直接全量启用 File Read Ring。
