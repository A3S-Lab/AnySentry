# AnySentry 统一过滤规则系统与可视化平台 PRD

状态：已实现并验收

版本：v0.1

日期：2026-08-25

批准决策：第十五章六项决策均采用推荐方案。

实现与验收记录：[统一过滤规则系统实施验收报告](./anysentry-unified-filter-rule-system-acceptance.md)

关联现有设计：

- [可信关联与采集优化路线图](./anysentry-trusted-correlation-and-capture-roadmap.md)
- [统一资产生命周期与采集规则治理](./anysentry-unified-asset-lifecycle-and-capture-rule-governance.md)
- [File Filter Pipeline v1](./file-filter-pipeline-v1.md)
- [Infrastructure rules v1](./infrastructure-rules-v1.md)

---

## 一、审核结论摘要

### 1.1 当前判断

当前 AnySentry **还不是只有一个统一、解耦的规则系统**。

已经统一的是 Infrastructure Rule 这一条链：中央逻辑规则、revision、生命周期、Policy Snapshot、节点物化、ACK/grant 和 Collector 快照具有同一 lineage。

尚未统一的内容包括：

- Agent Runtime Signature；
- Agent Template；
- Kubernetes / Docker Agent 标签规则；
- 人工身份事实；
- Behavior Discovery；
- Capture Profile 固定矩阵；
- Forwarder non-Agent / noise 保留策略；
- API 入库与 Judgment Routing；
- Unknown Learning 候选策略；
- 不可关闭的安全保护边界。

这些能力目前分别存在于代码常量、ConfigMap JSON、环境变量、中央数据库和独立状态服务中。它们共享一部分分类事实和最终 `FilterRuleSnapshot`，但并不共享一个完整的 Rule Catalog、生命周期、解释接口和管理入口。

### 1.2 推荐决策

本 PRD 推荐：

1. 将产品名称从“采集规则”统一修改为“过滤规则”。
2. 建立一个独立的“统一过滤规则系统”，作为所有过滤和身份匹配规则的唯一权威目录。
3. 保留规则类型差异：Agent 识别规则负责产生身份事实，Infrastructure 规则负责产生角色/采集意图，Retention 规则负责阶段动作；不把它们强行压成一种无类型规则。
4. 将端到端过滤统一定义为三个阶段：
   - F1：Ring 前采集过滤；
   - F2：Forwarder 语义过滤；
   - F3：API 入库与研判路由过滤。
5. 在三级过滤前增加一个非过滤阶段 F0：身份与工作负载上下文解析。Agent 匹配规则、Template、Inventory 和人工事实在 F0 产生可信上下文，F1—F3 使用这些上下文做决策。
6. 一个中央规则定义经过编译后，为 F0、F1、F2、F3 产生不同的受限投影；不同运行时不直接解释任意通用 JSON。
7. 前端“过滤规则”页面成为用户理解、查询、模拟和治理整个平台过滤机制的唯一入口。
8. L1/L2/L3 风险研判策略不并入过滤规则生命周期；在页面中展示其关联结果并链接到策略配置，但保持独立产品边界。

---

## 二、产品目标与边界

### 2.1 产品目标

用户进入“过滤规则”页面后，应能回答：

- 系统现在用哪些规则识别 Agent？
- 哪些规则识别 Infrastructure、业务服务和 AnySentry 自身服务？
- 一个事件在 Ring 前、Forwarder 和 API 分别会发生什么？
- 当前规则在什么节点、容器、cgroup 或 Process generation 上生效？
- 多条规则同时匹配时，哪条规则获胜，为什么？
- 当前规则是内置保护、平台 Inventory、人工配置，还是学习候选？
- 规则处于 draft、shadow、enforced 还是 revoked？
- 修改一条规则会影响哪些资产、信号和过滤阶段？
- 某条真实事件为什么被完整保留、聚合、采样、结构化消费或丢弃？

### 2.2 “统一规则系统”的准确含义

统一不等于所有阶段加载同一个任意表达式文件。

统一表示：

```text
一个 Rule Catalog
+ 一个 ruleId / revision lineage
+ 一个生命周期和审批模型
+ 一个优先级与冲突模型
+ 一个服务端 Preview / Explain 模型
+ 一个审计与回滚模型
        ↓
按能力编译
        ↓
F0 Identity View
F1 Node Capture View
F2 Forwarder Semantic View
F3 API Retention View
```

原因是各阶段可用信息不同：

- F1 在完整 payload 构造和 Ring reserve 前，只能使用 cgroup、probe、少量稳定键和已物化结论；
- F2 可以使用进程树、Agent Signature、Template、Inventory、事件语义和路径等信息；
- F3 可以使用可信 Source、人工审核、历史状态、风险策略和持久化上下文。

规则系统必须保证同一逻辑规则在各阶段具有同一 lineage 和一致的安全语义，但不得让 F1 执行只有 F2/F3 才能验证的宽泛条件。

### 2.3 不属于本系统的内容

以下能力保持独立：

- L1 正则风险规则；
- L2 模型研判配置；
- L3 风险审查 Agent 配置；
- Incident、Alert、Remediation 的业务策略；
- 数据查询页的显示筛选条件。

它们可以消费过滤规则结果，也可以在页面中形成关联跳转，但不应与“是否采集、转发、入库”使用同一审批语义。

---

## 三、术语

| 术语 | 当前语境含义 |
|---|---|
| Rule Definition | 中央保存的逻辑规则，不绑定短 PID、Pod UID 或 cgroup |
| Rule Fact | Inventory、人工审核、签名匹配等产生的事实；事实不是可随意编辑的过滤动作 |
| Compiled View | 中央规则针对某个消费者能力编译出的受限规则投影 |
| Materialization | 将逻辑规则绑定到当前物理容器、Pod、cgroup 或 Process generation |
| Effective Decision | 某阶段考虑优先级、冲突、TTL、ACK 和 grant 后的最终动作 |
| Decision Receipt | 记录一次决策使用了哪些 ruleId/revision、谁获胜及原因的低成本证据 |
| Guardrail | 不可关闭或只能通过更高权限改变的系统安全保护规则 |
| Capture Profile | 一组 probe → FULL/AGGREGATE/SAMPLE/DROP 的闭集动作矩阵 |

---

## 四、当前规则系统审计

### 4.1 当前规则来源

| 规则/事实类别 | 当前来源 | 生命周期/热加载 | 是否中央可视化 | 当前消费者 |
|---|---|---|---|---|
| Infrastructure Rule | PostgreSQL 权威状态 + ClickHouse 迁移镜像 | revision、draft/shadow/enforced/revoked | 已有页面 | API、Forwarder、Collector |
| Agent Runtime Signature | 内置常量或 ConfigMap JSON | 文档 version，Forwarder 热加载 | 否 | Forwarder AgentAttributor |
| Agent Template | ConfigMap JSON | 独立 schema，当前主要在启动时加载 | 否 | Forwarder TemplateRegistry |
| K8s Agent / Role Label | Kube Inventory 和代码固定标签语义 | 随 K8s Watch 更新 | 否 | API Identity Snapshot、Forwarder |
| Docker Agent / Role Label | Docker Inventory 和代码固定标签语义 | 随 Docker Discovery 更新 | 否 | Forwarder |
| 人工身份审核 | AgentMetadata / Review Revision | 中央持久化 revision | 资产页可见，不在规则目录 | API、Identity Snapshot、Forwarder |
| Behavior Discovery | Forwarder 内存检测器 | 临时、有界、重启重建 | 只有指标 | Forwarder |
| Capture Profile Matrix | `observer-capture-profile-control.js` 常量 | 随代码发布 | 否 | Forwarder、Collector |
| Forwarder Retention | 环境变量 + `handleLine()` 固定逻辑 | 部署配置，非规则 revision | 否 | Forwarder |
| API Retention / Judgment Route | `identity-judgment-routing.ts` 固定逻辑 + PolicyConfig | 部分配置化 | 策略页只展示部分 | API / Judge |
| Protected Event Guardrail | 多处代码常量 | 随代码发布 | 否 | Forwarder、API、Collector |
| Unknown Learning Policy | 独立 Unknown Learning 状态 | candidate/reviewed 等独立状态 | Unknown 页面 | 只能桥接 Infrastructure Draft |

### 4.2 当前已统一的部分

Infrastructure Rule 已经具备：

- 中央 `ruleId + revision`；
- 精确稳定 selector；
- PostgreSQL 权威持久化；
- draft → shadow → enforced → revoked；
- server-owned Inventory Preview；
- 不同创建人和批准人；
- Policy Snapshot；
- 节点 cgroup Materialization；
- Filter Rule Snapshot；
- Preview → ACK → Central acceptance → activation grant；
- TTL、generation fence、last-known-good；
- Agent KEEP 冲突优先；
- 节点回报和操作审计。

这部分应作为统一规则系统的治理基线，而不是重新发明另一套机制。

### 4.3 当前仍然分裂的部分

#### Agent 识别

当前 Agent 识别至少包含：

```text
Runtime Signature
Kubernetes label
Docker label
Agent Template
Process ancestry
Manual review
Authenticated Adapter
Behavior Discovery
```

这些来源会在 Forwarder 中合并，但没有统一 Rule Catalog。用户无法在一个页面查看“Codex 为什么被识别”“哪个签名版本生效”“K8s 标签和 Runtime Signature 冲突时谁获胜”。

#### Forwarder 过滤

Forwarder 虽然调用同一个 `FilterRulePublisher` 生成 F1 快照，但自己的语义过滤仍主要由以下配置决定：

```text
FORWARD_FILTER_MODE
FORWARD_RETAIN_UNKNOWN
FORWARD_RETAIN_NON_AGENT
FORWARD_NOISE_POLICY
FORWARD_FILE_AGGREGATION
```

`alwaysKeepEventKind`、non-Agent suppression 和 routine noise 判断也存在代码固定逻辑。这些设置没有中央 ruleId/revision。

#### API 入库过滤

API 当前根据身份分类决定：

```text
confirmed_agent → full
probable_agent  → full 或 l1_only
unknown         → l1_only
non_agent       → discard
```

Security、Agent conflict、ToolExec 和 ProcessExit 先经过独立保护/结构化消费逻辑。这套决策不读取 `InfrastructureRuleService` 或节点 `FilterRuleSnapshot`，只共享分类字段，因此不是同一规则系统的重复执行。

### 4.4 当前运行态快照

截至 2026-08-25，本机实际运行状态为：

| 项目 | 当前值 |
|---|---|
| Infrastructure 规则目录 | 60 条 |
| Infrastructure active/enforced | 38 条 |
| Infrastructure revoked | 22 条 |
| Active 来源 | Kubernetes 24、Platform Inventory 14 |
| Infrastructure policyVersion | 142 |
| Agent Runtime Signature | version 2，6 个 Runtime |
| Runtime | Codex、Pi、A3S Code、Claude Code、Gemini CLI、Kimi Code CLI |
| Agent Template | 0 条 |
| F1 Capture Profile Mode | enforce |
| F2 Forwarder Filter Mode | enforce |
| F3 Unknown Retention Mode | enforce |
| Forwarder retainUnknown | true |
| Forwarder retainNonAgent | false |
| Forwarder noisePolicy | balanced |
| Forwarder fileAggregation | true |
| API probable Agent pipeline | full |
| 自定义 L1 风险规则 | 0 条 |
| Unknown Learning Policy | 0 条 |

节点快照在一次检查时包含 39 个物理成员：

- 34 个 `infrastructure_aggregate`；
- 5 个 `agent_full`；
- 4 个 Agent/Infrastructure 冲突；
- `policyVersion=142`；
- Capture Profile 与 activation 均为 enforce。

该数字会随容器和 Agent Runtime 生命周期变化，不应被误认为 39 条中央逻辑规则。

### 4.5 现状结论

当前关系更准确地表示为：

```text
多个身份/角色规则来源
        ↓
Forwarder 合并分类
        ├─ 生成/更新节点 FilterRuleSnapshot
        ├─ 使用独立配置执行 Forwarder 过滤
        └─ 把分类语义发给 API
                         ↓
                API 使用独立路由逻辑
```

因此，当前前端“采集规则”只展示 Infrastructure Rule，不能代表整个平台规则系统。

---

## 五、三级过滤的统一定义

### 5.1 为什么需要重新统一术语

早期 File Filter 文档中的“三级”是：

1. Observer eBPF；
2. Collector/Forwarder fast path；
3. Forwarder semantic path。

从整个平台端到端视角，还存在 API 入库与 Judgment Routing。为了让产品页面和开发验收使用同一语言，本 PRD 将 Collector coalescing 视为 F1/F2 之间的执行动作，不再单独占用一级。

### 5.2 推荐的标准三级

```text
F0：身份与上下文解析（非过滤阶段）
  ↓
F1：Ring 前采集过滤
  ↓
F2：Forwarder 语义过滤
  ↓
F3：API 入库与研判路由过滤
```

#### F0：身份与上下文解析

输入：

- ProcessKey / ancestry；
- Runtime Signature；
- K8s / Docker Inventory；
- Agent Template；
- 人工审核事实；
- 认证 Adapter；
- Behavior Discovery；
- Infrastructure selector。

输出：

```text
identityClassification
workloadRole
captureProfile candidate
unknownReason
authority / confidence / conflict
stable asset and runtime binding
```

F0 不直接授权 DROP。它负责建立后续过滤所需的可信上下文。

#### F1：Ring 前采集过滤

位置：Collector/eBPF 在完整 payload 构造、路径复制和 Ring reserve 前。

可用条件：

- node-local cgroup；
- probe；
- 已物化 Capture Profile；
- policyVersion / epoch / TTL；
- authority / ACK / grant；
- generation-safe root 信息。

动作：

```text
FULL
AGGREGATE
SAMPLE
DROP
```

目标：直接降低 Ring submit、payload copy 和用户态排空压力。

#### F2：Forwarder 语义过滤

位置：Collector 输出之后、HTTP 批次之前。

可用条件：

- F0 完整分类；
- 事件类型与语义；
- Process ancestry；
- path/peer/command 等完整字段；
- F1 decision receipt；
- 当前规则和 Inventory；
- dedupe / aggregation window。

动作：

```text
KEEP
COALESCE / AGGREGATE
SAMPLE
SUPPRESS
PRIORITY QUEUE
```

目标：保护 Agent、安全和生命周期证据，减少重复逻辑事件、网络带宽和 API 压力。

#### F3：API 入库与研判路由过滤

位置：可信 Source 校验和服务端身份覆盖之后，ClickHouse、Kafka 和 L1/L2/L3 之前。

动作：

```text
RETAIN_FULL
RETAIN_L1_ONLY
STRUCTURAL_CONSUME
STORE_AGGREGATE
DISCARD
REJECT
```

目标：保证服务端最终权限，保留安全/冲突/生命周期语义，控制持久化和模型研判成本。

### 5.3 三级与同一规则系统的关系

同一逻辑规则不保证在三个阶段都执行相同动作，而是保证：

- 使用同一个 `ruleId/revision` lineage；
- 使用同一中央上下文和优先级；
- 每个阶段只能执行编译器允许的条件和动作；
- F1 无法验证的条件自动下沉到 F2/F3；
- 每个阶段返回统一 Decision Receipt；
- 页面能从一个逻辑规则追踪到全部 stage projection 和物理物化。

---

## 六、目标统一规则系统

### 6.1 High-level 架构

```text
                    ┌─────────────────────────────┐
                    │ Unified Filter Rule Catalog │
                    │ ruleId / revision / audit   │
                    └──────────────┬──────────────┘
                                   │
                     validate / preview / compile
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
 Identity & Role View        Capture/Forwarder View      API Retention View
        │                          │                          │
        ▼                          ▼                          ▼
 F0 Resolver               F1 Node Materializer        F3 API Evaluator
 Forwarder + API           + F2 Forwarder Evaluator    + Judge Router
        │                          │                          │
        └──────────── facts + decision receipts ─────────────┘
                                   │
                                   ▼
                       Explain / Audit / Metrics / UI
```

### 6.2 核心模块

#### Rule Catalog

职责：

- 统一保存所有逻辑规则；
- 全局唯一 ruleId；
- immutable revision；
- 分类、来源、owner、authority；
- draft/shadow/enforced/revoked；
- 依赖和后继关系；
- 审计和回滚。

#### Typed Rule Validator

职责：

- 按 ruleKind 验证 matcher 和 effect；
- 限制低可信规则最大权限；
- 禁止宽泛 Agent/non-Agent destructive selector；
- 检查字段在哪个阶段可用；
- 检查冲突与循环依赖。

#### Rule Compiler

职责：

- 从一个 Rule Catalog 产生 F0/F1/F2/F3 投影；
- 生成内容 hash、domain version 和能力声明；
- 只有 effective intent 变化才推进对应 stage version；
- 不因 TTL 刷新或短期成员变化重编译整个目录。

#### Materializer

职责：

- 把稳定 Logical selector 绑定到当前 Pod/container/cgroup/process generation；
- 处理重启、TTL、epoch、ACK/grant；
- Agent/conflict 强制 fail-open；
- 回报实际节点状态。

#### Evaluator / Explain

职责：

- 对真实资产、事件引用或测试上下文运行规则；
- 返回所有候选规则、失败条件、获胜规则和最终动作；
- 同时展示 F0→F1→F2→F3 因果链；
- Preview 与实际运行使用同一编译产物。

### 6.3 统一规则基础结构

所有规则共享基础 envelope：

```text
schemaVersion
ruleId
revision
name
category
ruleKind
source
owner
lifecycleStage
authority
priority
matcher（typed）
effect（typed）
consumerCapabilities
createdBy / approvedBy
createdAt / updatedAt
reason / ticket
contentHash
predecessorRuleId
```

不同 ruleKind 使用不同受限结构，而不是任意脚本：

| category | ruleKind | 输入 | 允许输出 |
|---|---|---|---|
| Agent 识别 | runtime_signature | comm/exe/argv 精确签名 | probable_agent fact |
| Agent 识别 | deployment_binding | K8s/Docker 精确标签与容器 | confirmed/probable Agent fact |
| Agent 识别 | agent_template | deployment + workload/process fields | typed identity fact |
| 人工身份 | reviewed_identity_binding | 稳定资产/物理工作负载 | reviewed identity fact |
| Infrastructure | workload_role_binding | K8s/Docker/Host 稳定 selector | role + capture intent |
| Capture | capture_profile | identity/role/risk/context | probe action matrix |
| Forwarder | semantic_retention | classification/role/event kind | keep/aggregate/sample/suppress |
| API | persistence_retention | classification/role/event kind | retain/l1/structural/discard |
| 安全保护 | safety_guardrail | protected kind/conflict | full/structural/keep |
| 调查 | investigation_override | 精确 runtime/process generation + TTL | temporary full |
| 学习 | learning_candidate | 审核后的稳定 family/scope | candidate rule only |

### 6.4 规则与事实必须分开

规则回答“满足什么条件时产生什么结论”；事实回答“这次实际观测到了什么”。

例如：

```text
规则：commExact=codex → probable_agent
事实：2026-08-25 在 root ProcessKey X 命中 rule r2
```

页面可以从规则查看事实，也可以从事实反查规则，但不能把一次事件命中自动升级为永久 authoritative 规则。

### 6.5 版本模型

推荐同时维护：

```text
catalogVersion       所有规则目录变化
identityVersion      F0 身份/角色投影变化
captureVersion       F1 Capture intent 变化
forwarderVersion     F2 语义投影变化
retentionVersion     F3 入库投影变化
nodeEpoch            当前节点物理 Capture 世代
```

这样 Agent 显示名变化不会无意义推进 Ring epoch；只有 Probe action 或稳定匹配语义变化才更新 Capture intent。

### 6.6 统一优先级

推荐固定优先级：

```text
P0  不可变安全保护：Security、关键生命周期、控制面、自身健康
P1  confirmed Agent / authenticated Adapter / Agent conflict KEEP
P2  显式 investigation_full（精确范围 + TTL）
P3  authoritative reviewed identity / Infrastructure rule
P4  probable Agent / business context / reviewed candidate
P5  Unknown discovery default
P6  map miss / stale / capability mismatch → fail-open discovery
```

安全不变量：

- Unknown 不允许 authoritative DROP；
- probable Agent 不允许被 Infrastructure DROP 覆盖；
- 冲突时 Agent KEEP/FULL 获胜；
- 过期、未 ACK、未 grant、版本不一致时不得 destructive；
- Process Signature 单独命中最多产生 probable_agent；
- 人工 non-Agent 不能点击后直接让 F1 DROP；
- Exec/Exit 可以结构化消费，但必须先更新 Process generation/tombstone；
- Security 永不因身份分类被丢弃。

### 6.7 持久化和兼容

推荐：

- PostgreSQL 继续作为权威可变规则状态；
- ClickHouse 保存低频审计、时间线和迁移镜像，不作为频繁控制写入的唯一依赖；
- 保留现有 Infrastructure ruleId 和 revision；
- `/infrastructure-rules` 在迁移期成为统一服务的 category adapter；
- `agent-runtime-signatures.json`、`agent-templates.json` 和环境变量由中央规则编译生成兼容投影；
- 旧 Forwarder/Collector 继续读取 v1 snapshot；
- 新消费者使用带 stage/domain version 的 v2 projection；
- `/capture-rules` 保留兼容重定向，canonical route 改为 `/filter-rules`。

---

## 七、过滤规则前端定位

### 7.1 页面定位

“过滤规则”是用户与 AnySentry 整个过滤机制交互、理解和治理的唯一主入口。

它不是：

- Infrastructure 规则的平铺列表；
- 底层 JSON 编辑器；
- cgroup map 编辑器；
- L1/L2/L3 风险规则配置页；
- 仅展示最终 DROP 的页面。

它需要同时展示：

- 识别规则；
- 过滤规则；
- 不可变安全边界；
- 各阶段编译结果；
- 当前物化；
- 决策解释；
- 生命周期和审计。

### 7.2 页面整体结构

```text
顶部：统一规则系统健康
Catalog / F0 / F1 / F2 / F3 版本、节点一致性、冲突、LKG
────────────────────────────────────────────────────────
阶段流程：F0 解析 → F1 Ring 前 → F2 Forwarder → F3 API
每个节点显示当前模式、规则数、决策量、降级和丢失
────────────────────────────────────────────────────────
视角切换：按类别 | 按阶段 | 按资产/信号
────────────────────────────────────────────────────────
左侧分类树       中间规则目录              右侧规则详情/Explain
```

### 7.3 默认“按类别”视角

左侧分类树：

```text
全部规则
├─ Agent 识别
│  ├─ Runtime Signature
│  ├─ Deployment Label
│  ├─ Agent Template
│  ├─ 认证 Adapter
│  ├─ 人工身份绑定
│  └─ Behavior Candidate
├─ Infrastructure 与服务
│  ├─ Kubernetes
│  ├─ Docker
│  ├─ Host/systemd
│  └─ AnySentry Self
├─ Capture Profile
│  ├─ Agent Full
│  ├─ Probable / Unknown Discovery
│  ├─ Business Context
│  └─ Infrastructure Aggregate
├─ Forwarder 语义保留
├─ API 入库与研判路由
├─ 安全保护边界
├─ 临时调查升档
└─ 学习候选
```

每个分类显示：总数、enforced、candidate、conflict、未物化、异常节点。

### 7.4 “按阶段”视角

```text
F0 身份与角色
  当前生效 Agent Signature / Template / Label / Review

F1 Ring 前
  当前 Profile、Probe Matrix、节点 Epoch、ACK/grant、物化成员

F2 Forwarder
  Keep / Aggregate / Sample / Suppress、优先队列、噪声策略

F3 API
  Retain Full / L1 Only / Structural / Discard
```

选择一条规则时，其他阶段显示：

- 生效；
- 间接影响；
- 不适用；
- 等待物化；
- shadow only；
- 被高优先级规则覆盖；
- 因能力不足下沉到后续阶段。

### 7.5 “按资产/信号”视角

用户可以从以下入口反查：

- Agent Asset；
- Service / Infrastructure Asset；
- Runtime Instance；
- Node；
- Event kind / Probe；
- ruleId；
- eventId。

示例：选择 `FileAccess` 后展示所有会改变 FileAccess 的 Profile、Infrastructure Rule、Agent KEEP 和安全保护规则，而不是展示无关的 DNS/TLS 规则。

### 7.6 规则列表

列表默认按分类分组，不把所有规则直接堆叠。

每行显示：

```text
名称
类别 / ruleKind
自然语言 matcher
产生的事实或动作
影响阶段
状态 / authority
source
当前匹配资产与物化数量
冲突/降级状态
revision / 更新时间
```

### 7.7 规则详情

详情采用五个 Tab：

1. 概要：这条规则是什么、为什么存在、谁管理；
2. 匹配条件：人类可读 matcher、允许字段、范围；
3. 阶段影响：F0/F1/F2/F3 的编译结果；
4. 当前物化：节点、实例、ACK/grant、TTL、冲突；
5. Revision 与审计：历史、批准人、后继规则、回滚。

标准页面不展示或直接编辑：

- 原始 cgroup map；
- activation grant JSON；
- 任意正则/脚本；
- 全量 replace-all；
- 内部 content hash 原文。

管理员诊断模式可以下载经过脱敏的 compiled projection，但不能在浏览器直接覆盖节点文件。

### 7.8 Explain 与 Simulation

页面提供两个核心动作：

#### 为什么匹配

输入真实 assetId/eventId，服务端返回：

```text
读取了哪些可信事实
哪些规则成为候选
每条规则哪些条件通过/失败
优先级和冲突如何处理
F0 产生了什么身份/角色
F1/F2/F3 最终分别执行什么
```

#### 修改后会怎样

草稿只能使用服务端当前 Inventory 和有界历史样本模拟：

```text
受影响资产/实例/节点
Agent conflict
共享 cgroup
各 Probe 决策变化
Ring submit 预计变化
Forwarder/API 预计变化
Service Context 连续性
Observation Coverage 变化
```

### 7.9 管理动作

| 规则类型 | Viewer | Reviewer | Approver | System |
|---|---:|---:|---:|---:|
| 内置 Guardrail | 查看 | 不可修改 | 不可修改 | 随版本更新 |
| Agent Signature | 查看 | 新建 candidate revision | 批准启用，但最高仍为 probable | 编译/分发 |
| Inventory 规则 | 查看 | 新建/停用 | destructive 批准 | 自动物化 |
| Capture/Retention | 查看 | 新建/Preview | 批准 destructive | 编译/ACK/grant |
| Learning Candidate | 查看 | 审核/拒绝 | 必要时批准后继规则 | 不直接 enforce |

修改规则遵循：

```text
新增后继 revision
  → server Preview
  → shadow
  → 独立批准
  → stage projection
  → ACK/grant
  → enforced
  → 必要时停用旧 revision
```

不允许原地修改 enforced 内容。

---

## 八、规则匹配案例

### 8.1 场景

某 Kubernetes ClickHouse 容器中意外启动了一个 Codex 进程，并产生 `FileAccess`：

```text
cluster       = default-cluster
namespace     = anysentry
owner         = StatefulSet/clickhouse
container     = clickhouse
cgroupId      = 18412
process.comm  = codex
eventKind     = FileAccess
```

### 8.2 候选规则

#### Infrastructure 规则

```text
匹配：cluster + namespace + owner + container
输出：workloadRole=platform_infrastructure
Profile：infrastructure_aggregate
意图：FileAccess aggregate/drop，Exec/Exit/Security full
authority：authoritative
```

#### Agent Runtime Signature

```text
匹配：commExact=codex
输出：identityClassification=probable_agent
authority：candidate
来源：runtime signature version 2
```

#### 安全优先级规则

```text
Agent fact 与 Infrastructure destructive rule 冲突
→ conflict_keep_preferred
→ agent_full / KEEP 获胜
```

### 8.3 各阶段结果

```text
F0：
  Infrastructure selector 命中
  Runtime Signature 命中
  输出 probable_agent + platform_infrastructure + conflict

F1：
  原 Infrastructure FileAccess DROP/AGGREGATE 被覆盖
  当前 cgroup 使用 agent_full
  FileAccess FULL 进入 Ring

F2：
  事件按 Agent evidence 保留
  不执行 non-Agent suppression

F3：
  当前 probable pipeline=full
  事件入库并可进入 L1/L2/L3
```

页面 Explain 应展示：

```text
最终结果：完整保留
获胜原因：Agent/Infrastructure conflict fail-open
获胜规则：Agent conflict guardrail
关联规则：Codex Runtime Signature r2、ClickHouse Infrastructure Rule rN
节点状态：epoch X，ACK accepted，grant active
```

如果没有 Codex 进程签名，普通 ClickHouse FileAccess 则按 Infrastructure Profile 在 F1 聚合/丢弃原始明细，仅保留 CaptureAggregate、结构化生命周期和安全证据。

该案例说明：统一页面必须展示“规则因果链和优先级”，不能只显示一条最终 Infrastructure 规则。

---

## 九、产品功能需求

### P0：统一可视化与理解

- FR-001：导航和页面名称改为“过滤规则”。
- FR-002：保留 `/capture-rules` 深链兼容并跳转 `/filter-rules`。
- FR-003：建立统一只读 Rule Catalog API，聚合所有现有规则来源。
- FR-004：所有规则必须标记来源、是否中央管理、是否只读、生命周期能力。
- FR-005：提供按类别、按阶段、按资产/信号三种视角。
- FR-006：提供 F0→F1→F2→F3 High-level 流程视图。
- FR-007：展示每一级当前 mode、版本、规则数、节点一致性和降级原因。
- FR-008：展示 Agent Runtime Signature、Template、K8s/Docker Label 和人工身份规则。
- FR-009：展示 Infrastructure、Capture Profile、Forwarder、API Retention 和 Guardrail。
- FR-010：提供规则详情和阶段影响矩阵。
- FR-011：提供基于真实 assetId/eventId 的服务端 Explain。
- FR-012：Infrastructure 现有 60 条规则和历史 revision 不丢失。

### P1：统一治理与编译

- FR-101：抽取统一 rule envelope、生命周期、审计和权限。
- FR-102：Agent Signature/Template 从 ConfigMap 源迁入中央 Catalog，旧文件改为编译输出。
- FR-103：Capture Profile Matrix 作为可视化、受版本控制的 Guardrail/Profile 规则。
- FR-104：Forwarder 环境变量策略迁入 typed semantic-retention 规则。
- FR-105：API identity route 迁入 typed persistence-retention 规则。
- FR-106：编译 F0/F1/F2/F3 独立投影和 domain version。
- FR-107：每一级返回统一 Decision Receipt。
- FR-108：提供 Draft Preview、Simulation、shadow、promote、revoke。
- FR-109：提供规则冲突、能力不支持和 stage drift 检测。
- FR-110：提供后继规则替换流程，不支持 enforced 原地编辑。

### P2：反馈闭环

- FR-201：Unknown Learning Candidate 进入同一目录的“学习候选”分类。
- FR-202：候选只能生成低权限 typed draft，不能直接 authoritative DROP。
- FR-203：身份审核能查找并复用已有全局规则，或创建安全后继草稿。
- FR-204：规则效果通过低基数指标回流到页面。
- FR-205：支持选择历史窗口比较修改前后的 Stage Decision 分布。

---

## 十、API 与读模型建议

推荐新 API：

```text
GET  /security-center/filter-rules/catalog
GET  /security-center/filter-rules/:ruleId
GET  /security-center/filter-rules/stages/status
GET  /security-center/filter-rules/materializations
POST /security-center/filter-rules/explain
POST /security-center/filter-rules/simulate
POST /security-center/filter-rules/drafts
POST /security-center/filter-rules/:ruleId/shadow
POST /security-center/filter-rules/:ruleId/promote
POST /security-center/filter-rules/:ruleId/revoke
GET  /security-center/filter-rules/operations
```

只读 human projection 可供 Viewer 使用；raw matcher、compiled projection、operations 和所有写操作必须受管理鉴权和角色权限保护。

Catalog 列表必须使用服务端 cursor 分页，不能沿用当前 500 条硬上限后宣称“全部规则”。

---

## 十一、可观测性与非功能要求

### 11.1 性能

- 2,000 条逻辑规则下目录首屏 P95 `< 2s`；
- Explain P95 `< 1s`，不扫描无界历史数据；
- F0/F2 evaluator 不做全量线性规则扫描，使用字段索引；
- F1 只加载编译后的有界 node-local projection；
- 规则目录更新不阻塞 Ring 排空或事件写入；
- TTL 刷新不推进无意义的全局 epoch。

### 11.2 一致性

- 页面显示 Catalog version 和各 Stage version；
- 节点必须回报已加载 version、epoch、ACK/grant 和 LKG；
- 版本漂移明确标记，不能显示“已生效”但节点仍在旧规则；
- Preview 和 Runtime 必须共享 compiler 与 golden fixture；
- TypeScript、Node 和 Rust 投影使用跨语言一致性测试。

### 11.3 安全

- 不允许任意脚本 matcher；
- 不允许 Regex/Glob 直接进入 F1 destructive selector；
- 低可信 Agent Signature 最高为 probable；
- destructive 规则要求 server-owned Inventory、独立批准、ACK/grant；
- 浏览器不能自报 approver 身份；
- 标准页面不暴露原始 cgroup、grant 或敏感 path/command；
- 所有规则变更写入审计。

### 11.4 指标边界

长期指标允许：

```text
stage
category
ruleKind
action
reasonCode
authority
lifecycleStage
bounded source type
```

禁止在 Prometheus 或逐条持久过滤日志中使用：

```text
ruleId
assetId
cgroupId
pid
path
command
peer
```

规则级命中详情使用按需 Explain 和有界近期状态，不建立无界高基数时间序列。

---

## 十二、验收标准

### 12.1 目录完整性

- 当前所有 Infrastructure Rule 可见；
- 6 个实际 Agent Runtime Signature 可见；
- Agent Template 为 0 时明确显示“已加载 0”，不能假装不存在该规则类别；
- K8s/Docker label 语义、人工审核、Capture Profile、Forwarder policy、API route、Guardrail 均可见；
- 每个现有规则来源都能映射到统一 catalog category；
- 不存在页面外静默生效且无法解释的过滤策略。

### 12.2 三级一致性

- 用户能看到同一 ruleId/revision 在 F0/F1/F2/F3 的适用性；
- 每个 Stage 显示当前编译版本和运行态版本；
- 修改 Capture 意图后，F1/F2/F3 只更新受影响 projection；
- 节点未 ACK 时页面不得显示 destructive 已完全生效；
- API/Forwarder/Collector 版本漂移能被检测并告警。

### 12.3 Explain

- Codex Signature 案例能展示匹配字段、身份输出和三级结果；
- Infrastructure + Agent conflict 明确显示 Agent KEEP 获胜；
- Unknown/map miss 显示 fail-open；
- non-Agent Exec/Exit 显示先 structural consume 再省略原始明细；
- SecurityAction 在任何身份下都显示 FULL；
- Explain 使用真实编译产物，不维护另一套前端规则解释逻辑。

### 12.4 过滤安全和效果

- Agent marker recall `100%`；
- Unknown destructive drop `0`；
- Agent/Infrastructure 冲突 destructive drop `0`；
- F1 DROP/AGGREGATE 不增加 raw ring submit；
- Ring、Collector、Forwarder 队列的物理丢失分别可测量；
- F2/F3 suppression 不伪装成 Ring 前过滤；
- Observation Coverage 和 Service Context 在规则变化时连续或明确标记 gap。

### 12.5 前端

- 1440px：分类树、列表、详情并排；
- 1024px：阶段视图与详情可读；
- 390px：目录和详情路由化，不产生文档级横向滚动；
- 键盘可完成查询、Preview、新增和停用；
- 页面不直接堆叠所有类别；
- URL 可保留视角、category、stage、ruleId 和查询条件；
- 旧 `/capture-rules?ruleId=...` 深链保持有效。

---

## 十三、迁移阶段

### Phase 0：术语与只读盘点

- 页面改名“过滤规则”；
- 建立统一 category taxonomy；
- 通过 adapter 聚合现有 Infrastructure、Signature、Template、环境策略和代码 Guardrail；
- 只读展示，不改变运行行为；
- 建立当前 Stage version/status API。

退出门槛：页面能完整解释当前实际运行配置，没有规则来源遗漏。

### Phase 1：统一 Rule Core

- 抽取 rule envelope、Catalog Store、revision、lifecycle、audit、permissions；
- 迁移 Infrastructure Rule 到 adapter/facade，保留 ID；
- 建立 Explain 和 compiler contract；
- 建立 cursor 分页。

退出门槛：Infrastructure 行为与当前版本 golden replay 一致。

### Phase 2：统一 Agent 识别规则

- Runtime Signature、Template、Deployment Label 定义进入 Catalog；
- ConfigMap JSON 变为编译兼容产物；
- 人工审核事实作为 reviewed binding 投影；
- Behavior Discovery 作为 candidate/fact，不直接成为 authoritative rule。

退出门槛：Agent recall 不下降，六类现有 Runtime 完整迁移，冲突结果一致。

### Phase 3：统一 F1/F2/F3 决策

- Capture Profile、Forwarder retention、API retention 迁入 typed rules；
- 编译 domain projection；
- 双读 shadow 比较旧逻辑和新逻辑；
- 统一 Decision Receipt。

退出门槛：长窗口 shadow diff 可解释，受保护事件差异为零。

### Phase 4：统一治理写入

- 前端新增 typed rule wizard；
- Simulation、shadow、审批、ACK/grant、promote、revoke；
- 环境变量和旧文件停止作为权威写入口；
- 保留只读兼容和回滚窗口。

退出门槛：只能通过统一 Rule Catalog 改变过滤行为，旧入口无法产生未审计漂移。

### Phase 5：反馈闭环与最终验收

- Unknown Learning 候选并入目录；
- 规则效果比较；
- 24h 运行、Pod rollout、控制面断连、规则 churn；
- 最终跨语言和端到端验收。

退出门槛：用户可以从任意真实事件解释 F0/F1/F2/F3 全链路，并安全完成规则变更。

---

## 十四、风险

| 风险 | 影响 | 控制方式 |
|---|---|---|
| 为追求统一引入万能 matcher | F1 误过滤或性能不可控 | typed rule + stage capability compiler |
| Agent Signature 被当成 confirmed | 误扩大 Agent 范围 | signature authority 上限为 probable |
| 将所有版本合成一个 epoch | 节点频繁重载 | domain version + intent hash |
| 前端 Explain 与运行时分叉 | 用户看到错误原因 | Explain 消费真实 compiled projection |
| 大爆炸迁移 | 过滤语义不可审计变化 | adapter → shadow diff → 分阶段切换 |
| per-rule 指标高基数 | 监控系统自身过载 | 低基数汇总 + 按需 Explain |
| 旧 ConfigMap/环境变量继续生效 | 双权威漂移 | Phase 4 后只允许编译输出，不允许独立写入 |
| L1 风险规则混入过滤规则 | 权限和语义混乱 | 独立产品边界、关联展示 |

---

## 十五、待用户审核的关键决策

### 决策 1：三级定义

推荐批准：

```text
F0 身份/上下文解析（非过滤）
F1 Ring 前
F2 Forwarder
F3 API
```

Collector aggregation 作为 F1/F2 执行动作，不再独立称为一级。

### 决策 2：统一范围是否包含 L1/L2/L3 风险规则

推荐：不并入。

过滤规则决定事实能否进入后续链路；风险规则判断已进入的事实是否危险。二者在页面关联，但使用独立生命周期和权限。

### 决策 3：Agent Signature 的最大权限

推荐：单独 Signature 最高只能产生 `probable_agent`，不能直接 confirmed，也不能直接授权 F1 DROP/FULL 的永久 destructive 变化。

K8s/Docker 明确标签、认证 Adapter、人工事实等强证据可以产生更高 authority。

### 决策 4：内置安全规则是否允许编辑

推荐：页面完整可见但不可修改，只能通过经过测试的软件版本升级。否则普通规则变更可能关闭 Security、Exec/Exit 或 Agent conflict 保护。

### 决策 5：标准 UI 是否允许手工推进底层阶段

推荐：用户操作保持“新增、Preview、批准、停用”的产品语义；系统自动完成 compiler、epoch、ACK 和 grant。高级诊断页可以查看底层阶段，但不能直接编辑 cgroup/epoch/grant。

### 决策 6：现有 Infrastructure 页面如何迁移

推荐：当前页面升级为统一“过滤规则”页面，Infrastructure 作为其中一个分类；保留 `/capture-rules` 和现有 ruleId 深链兼容，不再维护第二个独立页面。

---

## 十六、现状审计依据

| 判断 | 主要实现依据 |
|---|---|
| Infrastructure 有中央状态、revision 和 Policy Snapshot | `apps/api/src/security-monitoring/infrastructure-rule.service.ts` |
| Infrastructure API 与人类投影 | `apps/api/src/security-monitoring/infrastructure-rule.controller.ts`、`infrastructure-rule-governance.ts` |
| Runtime Signature 是独立 JSON/ConfigMap/热加载 Registry | `scripts/observer-agent-runtime-signatures.js`、`deploy/observer.yaml` |
| Agent Template 是另一套独立 schema/Registry | `scripts/observer-agent-templates.js` |
| K8s/Docker Agent 和 Role 标签语义在各自 Inventory 实现中 | `kube-identity.service.ts`、`observer-docker-discovery.js` |
| Forwarder 合并多种分类来源并发布 FilterRuleSnapshot | `scripts/observer-forward.js`、`observer-filter-rule-publisher.js` |
| Capture Profile Matrix 当前为代码闭集 | `scripts/observer-capture-profile-control.js` |
| F2 non-Agent/noise 过滤仍由环境变量和固定分支决定 | `scripts/observer-forward.js` 的 `handleLine()` |
| F3 non-Agent/Unknown/Agent 路由为独立实现 | `identity-judgment-routing.ts`、`sentry-judge.service.ts` |
| Security、冲突、Exec/Exit 保护在 API 有独立 Guardrail | `protected-event-routing.ts` |
| 当前前端只读取 Infrastructure human projection | `apps/web/src/pages/CaptureRulesPage.tsx` |
