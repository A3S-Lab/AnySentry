# AnySentry 统一资产生命周期、人工身份审核与采集规则治理优化设计

状态：已审核开发方案，待实现

审核日期：2026-08-22

适用范围：AnySentry API、Observer/Collector、资产与事件查询、历史汇总、规则控制面和 Web 控制台

关联文档：

- [AnySentry 身份语义与系统上下文闭环优化设计](./anysentry-identity-semantics-and-system-context-optimization.md)
- [AnySentry 可信关联身份、采集过滤与开发阶段设计](./anysentry-trusted-correlation-and-capture-roadmap.md)
- [Agent 身份审核、资产聚合与 UI 展示设计](./agent-identity-review-ui-design.md)
- [Infrastructure rules v1](./infrastructure-rules-v1.md)

## 结论

本轮优化不是继续扩大事件过滤范围，而是解决“身份、资产、生命周期、观测覆盖和规则变化没有形成同一条可解释链路”的问题。

最终目标是：

> 每条 Agent、Infrastructure 和 Unknown 事件都能关联到明确资产或明确的临时观察对象；人工身份裁决不会使用宽泛进程名扩大作用范围；规则变化只改变观测精度，不删除资产或伪造生命周期结束；用户能看到资产为什么改变身份、当前采集哪些信号、何时出现观测缺口、哪些规则正在生效，以及如何安全恢复。

本设计确认以下核心决策：

1. **保护 Exec、Exit、Security 不等于把所有 non-Agent 原始事件完整入库。**
   - Exec 先建立最小 Process Generation；
   - Exit 先关闭进程生命周期并建立 tombstone；
   - Security 独立进入安全链；
   - 完成必要语义消费后，non-Agent 常规原始事件可以丢弃。
2. **统一资产关系覆盖 Agent、Service、Infrastructure、Unknown 和临时进程。** `agentAssetId` 保持兼容，新增通用资产关联，不把所有对象伪装成 Agent Asset。
3. **资产生命周期与事件是否继续入库相互独立。** 没有新事件不能被解释为资产退出；规则生效也不能让资产从历史和当前视图中消失。
4. **人工审核只绑定可证明的稳定对象。** 裸 `bash`、`cat`、`python`、线程名、短 PID、缺少 start time 的进程不能产生长期可复用 Agent/non-Agent 结论。
5. **历史查询同时支持“发生时口径”和“当前资产口径”。** 不修改历史事实，不允许事件列表、汇总卡和趋势图静默使用不同口径。
6. **“恢复自动识别”和“人工设为待确认”是两个不同动作。** 默认的“重新纳入观察”必须清除人工覆盖，而不是继续写入 `manual_review + unknown`。
7. **人工 non-Agent 应当能够联动 Ring 前规则，但不能点击后直接执行 DROP。** 已批准的全局规则可以复用；没有规则时只创建安全草稿并继续经过 shadow、校验、审批、Preview、ACK 和 grant。
8. **跨容器重启的复用由 Central 根据 Inventory 物化到新物理实例。** Observer 只消费精确的 container、pod、cgroup 和 generation 绑定，不负责猜测逻辑资产。
9. **不持久保存逐条 filteredNonAgent 明细或高基数指标。** 只持久化低频状态变化、审核事实、规则版本、观测覆盖区间和低基数全局汇总。
10. **新增面向审核人员的采集规则页面。** 标准 UI 只提供新增、查看、批准和停用所需的人类语义，不显示规则 JSON，不支持原地覆盖或全量替换。

本文是已实现基线之后的后续设计。若与早期 `agent-identity-review-ui-design.md` 中以下行为冲突，以本文为准：

- Unknown、Infrastructure 和 non-Agent 的资产入口；
- “重新纳入观察”的真实语义；
- non-Agent 对 Exec/Exit/Security 的处理；
- 人工审核与 Ring 前规则的关系；
- 历史列表与汇总的分类口径；
- 规则变化期间的资产生命周期连续性。

---

## 一、背景与已确认问题

### 1.1 原始产品目标

AnySentry 需要同时完成三件事：

- 发现 Agent Asset、Runtime、Invocation、ToolCall 和真实 Process；
- 对 Agent 行为及其系统影响进行可信关联和风险判断；
- 在系统初始化和持续运行中发现已有服务、基础设施、指标、依赖和变化，将其作为 Agent 风险上下文。

Ring 前采集优化已经显著降低高频信号进入 Ring Buffer 的数量，Infrastructure Rule 也已经具备全局复用、精确 selector、Preview、ACK、grant、TTL 和 generation fence。但实际体验进一步暴露出：

- 用户看到的是事件，却不能稳定进入该事件真正所属的 Service、Infrastructure 或 Unknown 资产；
- 人工身份裁决可能绑定到过宽的 host/进程名称；
- non-Agent 分类在部分层级直接丢弃事件，可能连维持进程图和安全判断所需的结构也一起丢掉；
- 同一人工结论在 API、Forwarder 和新容器实例上的复用范围不一致；
- 历史事件列表使用当前人工结论，部分历史卡片仍使用采集时 `monitored`；
- 人工“恢复观察”没有真正恢复自动发现；
- 审核人员无法通过友好的页面查看、增加和停用当前全局规则；
- 规则更新或身份变化后，事件骤然减少可能被错误解释为资产退出或生命周期结束。

### 1.2 最近真实运行数据说明的问题

2026-08-21 一个固定五分钟窗口中：

| 阶段或类型 | 数量 | 说明 |
|---|---:|---|
| Forwarder 普通逻辑事件 | 49,934 | 不含 CaptureAggregate |
| 去重 | 1,052 | 去重后 48,882 条可分类事件 |
| 正式 non-Agent | 44,157 | 其中 39,703 条属于 Infrastructure |
| 实际抑制 non-Agent | 44,156 | 说明现有用户态过滤有效 |
| 最终入库唯一逻辑事件 | 10,598 | 用户侧总事件应采用该口径 |
| CaptureAggregate | 5,800 | 占入库逻辑事件 54.727% |
| Unknown | 3,000 | 占 28.307% |
| probable_agent | 1,446 | 占 13.644% |
| confirmed_agent | 352 | 占 3.321% |
| 正式 non_agent 入库 | 0 | 已在入库前抑制 |

这组数据说明：

- 已确认 Infrastructure 的原始噪声过滤已经有效；
- 用户在最终存储中看到的“非 Agent 类事件”主要是 Unknown 和 CaptureAggregate，不能把二者直接称为 non-Agent；
- CaptureAggregate 需要关联到资产和规则，否则用户只看到技术摘要，无法理解它代表 ClickHouse、Redis、业务服务还是 Unknown workload；
- 被过滤的 44,156 条事件只保留全局计数，无法逐条恢复，因此人工审核前必须通过现有数据做有界影响预览，而不是依赖事后追查全部被丢事件。

### 1.3 已确认的宽泛审核风险

真实 Unknown `bash` 资产曾出现：

```text
physicalWorkloadId = 空
rootStartTime = 空
reviewIdentityKeys:
  logical:host:<host>:bash
  bash
同一逻辑资产聚合 33 个运行实例
```

这类对象可以用于临时调查，但不能作为长期审核目标。否则：

- 标记 non-Agent 会批量抑制同主机大量无关 `bash`；
- 确认 Agent 会把过大范围升为 Agent，并可能触发 agent_full；
- 未来进程重启、PID reuse 或 workspace 变化后仍可能错误继承；
- 审核人员看到的是一个事件，实际修改的是多个运行实例和未来事件。

### 1.4 新增核心风险：规则变化造成“生命周期中断假象”

如果把资产分类为 non-Agent 后直接丢弃所有后续事件，系统可能产生以下错误认知：

```text
资产仍在运行
  ↓
规则开始抑制事件
  ↓
平台不再收到普通事件
  ↓
错误推断资产退出、失联或生命周期结束
```

反向变化也有风险：

```text
资产在 non-Agent 规则下运行一段时间
  ↓
后来重新确认是 Agent
  ↓
新事件恢复
  ↓
平台把它当成一个全新资产或新 Runtime
  ↓
此前被抑制的时间段没有显式观测缺口
```

因此必须明确：

> 规则控制信号精度，不控制资产存在性；身份分类变化不等于 Runtime 启动或退出；事件沉默不等于生命周期结束。

---

## 二、目标、范围与安全不变量

### 2.1 总目标

完成以下统一链路：

```text
事件产生
  ↓
绑定统一资产和当前物理实例
  ↓
独立解析身份、角色和采集档位
  ↓
先消费 Security / Exec / Exit / Agent / Conflict 的必要语义
  ↓
按规则决定常规信号 FULL / AGGREGATE / SAMPLE / DROP
  ↓
持续维护资产、Runtime、Process 和观测覆盖生命周期
  ↓
同时提供发生时与当前有效两种查询口径
  ↓
用户从事件进入正确资产，理解证据、规则、缺口和历史变化
  ↓
审核、规则新增、审批、停用和恢复全部可审计
```

### 2.2 必须保持的不变量

- 不重命名、覆盖或重新计算旧 `traceId`、`sessionId`、`runId`、`agentId`、Incident ID、Alert dedupe key 和 Flink keyed state。
- 新通用资产字段旁路新增，不改变 `agentAssetId` 和 `serviceAssetId` 的既有语义。
- 资产 ID 不因人工分类、规则生效、规则停用、显示名变化或事件沉默而改变。
- Logical Asset 生命周期和 Runtime Instance 生命周期分开维护。
- 身份、工作负载角色、采集档位、Runtime 状态和观测状态不能合并成一个枚举。
- non-Agent 不等于安全；Security 不能只因身份为 non-Agent 被丢弃。
- Exec/Exit 可以不作为完整主事件保存，但必须先完成 Process Generation 和 tombstone 更新。
- 没有稳定物理或逻辑身份时，不允许生成可跨实例复用的人工 Agent/non-Agent 事实。
- Trace、时间邻近、进程名和路径不能单独成为身份审核键。
- 人工审核不能直接生成 authoritative DROP。
- 规则更新不能覆盖整个节点规则文件；只能通过版本化新增、状态转换和停用演进。
- 当前人工结论不能修改历史发生时分类和历史风险结论。
- 观测缺口必须显式表达，不能用空数组或资产退出伪装。
- 不持久保存逐条 filteredNonAgent 详情，不引入高基数 Prometheus label。
- 服务 syscall 被聚合或丢弃后，Service Asset、指标、拓扑、变化和告警仍必须存在。

### 2.3 不在本轮范围内

- 不把所有历史事件物理重写为当前人工分类。
- 不尝试从 CaptureAggregate 反向恢复已经丢弃的原始事件。
- 不允许 Reviewer 直接编辑底层 selector JSON、grant、epoch 或 cgroup map。
- 不提供全量规则导入覆盖或 `replace-all` 管理操作。
- 不因 Unknown 比例高而批量将 Unknown 改成 non-Agent。
- 不用长期保存每个资产、cgroup、reviewId 的过滤明细来解决可观测性。

---

## 三、统一概念与逻辑事件字段

### 3.1 五个必须独立的状态轴

| 状态轴 | 回答的问题 | 示例 |
|---|---|---|
| Asset Existence | 这个逻辑对象是否存在、是否仍被 Inventory 管理 | active / inactive / retired |
| Runtime Lifecycle | 当前实例是否运行、空闲、退出或失联 | current / idle / exited / lost |
| Agent Identity | 它是不是 Agent | confirmed / probable / unknown / non-Agent |
| Workload Role | 它在系统中承担什么职责 | Agent、AnySentry、平台、业务服务、普通进程 |
| Observation State | 当前能看到多少事实 | full / structural / aggregate / sample / suppressed / degraded / gap |

采集规则另有独立生命周期：

```text
draft → shadow → enforced → revoked
```

关键关系：

- `identity=non_agent` 时，`asset existence` 仍可为 active；
- `observation=suppressed` 时，`runtime lifecycle` 仍可为 current；
- `runtime=exited` 不要求 Logical Asset retired；
- `workloadRole=platform_infrastructure` 不要求身份立即变成 non-Agent；
- `captureProfile=infrastructure_aggregate` 不等于该资产没有安全价值。

### 3.2 逻辑事件字段说明

| 字段 | 简单含义 | 示例 |
|---|---|---|
| `eventKind` | 具体发生了什么 | FileAccess、ToolExec、ProcessExit、SecurityAction |
| `eventCategory` | UI 和统计的大类 | file、process、network、tool、security |
| `identityClassification` | 发生时判断它是不是 Agent | confirmed_agent / probable_agent / unknown / non_agent |
| `workloadRole` | 它在系统中承担什么职责 | platform_infrastructure |
| `captureProfile` | 当前应以什么精度采集 | infrastructure_aggregate |
| `unknownReason` | 为什么身份仍未知 | ancestry_incomplete |
| `detectedClassification` | 自动检测到的原始身份 | unknown |
| `reviewDecision` | 当前人工裁决 | non_agent 或空 |
| `effectiveClassification` | 当前人工覆盖后的有效身份 | non_agent |
| `attribution.source` | 判断来自哪里 | kubernetes、agent_adapter、process_graph、manual_review |
| `attribution.confidence` | 当前归因置信度 | 0.92 |
| `attribution.evidence` | 支撑判断的有界证据 | exact-container-binding |
| `judgment.profile` | 收到事件后如何研判 | full / l1_only / discard |
| `subjectAssetId` | 本设计新增的通用事件归属资产 | asset_service_xxx |
| `assetBindingQuality` | 资产绑定是否足以长期复用 | exact / logical / ephemeral / conflict |
| `observationState` | 该事件所在时间点的观测完整性 | aggregate |
| `classificationRevision` | 发生时使用的身份事实版本 | 17 |
| `assetBindingRevision` | 发生时使用的资产绑定版本 | 9 |
| `captureEpoch` | Ring 前生效的采集世代 | 1787... |
| `policyVersion` | 规则控制面版本 | 142 |

### 3.3 三个典型例子

#### ClickHouse 文件信号

```text
eventKind = FileAccess 或 CaptureAggregate
eventCategory = file 或 runtime
identityClassification = unknown 或 non_agent
workloadRole = platform_infrastructure / anysentry_internal
captureProfile = infrastructure_aggregate
subjectAssetType = service
subjectAssetId = ClickHouse Service Asset
```

它可以保持 Agent 身份未知，同时作为已知基础设施进行聚合；不需要为了降低事件量强行写 non-Agent。

#### Pi 工具调用

```text
eventKind = AgentTool / ToolExec
identityClassification = confirmed_agent
workloadRole = agent
captureProfile = agent_full
subjectAssetType = agent
agentAssetId = Pi Agent Asset
judgment.profile = full
```

#### 短命 cat 进程

```text
eventKind = ToolExec / ProcessExit
identityClassification = unknown
unknownReason = process_exited_before_enrichment
workloadRole = ordinary_process 或 unknown
captureProfile = unknown_discovery
subjectAssetType = ephemeral_process
assetBindingQuality = ephemeral
```

它可以进入临时观察页，但不能只凭 `cat` 名称产生长期 non-Agent 规则。

---

## 四、统一 Observed Asset 模型

### 4.1 为什么不能只扩展 Agent Asset

Agent Asset 只表达“一个被监控的 Agent 逻辑身份”。把 ClickHouse、Redis、普通进程和 Unknown 全部塞入 Agent Asset 会造成：

- 资产类型与身份分类混淆；
- Unknown 被误认为候选 Agent；
- Service Context 和 Agent Runtime 关系无法清晰表达；
- non-Agent 后资产从 Agent 列表消失，用户无法继续管理规则和生命周期。

因此增加通用 Observed Asset：

```text
Observed Asset
├─ Agent Asset
├─ Service Asset
├─ Infrastructure Asset
├─ Workload Asset
└─ Ephemeral Process Asset
```

### 4.2 资产和实例关系

```text
Environment / Workspace / Cluster / Host
  └─ Observed Asset
       ├─ Logical Identity
       ├─ Current Classification and Role
       ├─ Runtime Instance 0..N
       │    ├─ Physical Workload
       │    ├─ Process Instance 0..N
       │    ├─ Invocation 0..N
       │    └─ Observation Coverage Interval 0..N
       ├─ Service Metrics / Dependencies / Changes
       ├─ Human Review History
       └─ Matched Capture Rules
```

Service Asset 与 Agent Asset 可以关联同一个物理 workload，但不能互相替代。例如业务 API 内嵌 Agent Runtime：

- 业务 API 仍是 Service Asset；
- Agent 是独立 Agent Asset；
- 两者共享或关联同一个 Runtime/Workload；
- 只有强语义和 Process 证据进入具体 Invocation；
- 普通业务请求不能因为共享 cgroup 被提升为 Agent。

### 4.3 事件新增通用关联

保持现有字段，旁路新增：

```text
subjectAssetId
subjectAssetType
assetBindingQuality
assetBindingRevision
serviceAssetId?
agentAssetId?
physicalWorkloadId?
processInstanceKey?
```

约束：

- 每条持久逻辑事件必须有关联资产，或明确记录 `ephemeral/unassigned` 原因；
- CaptureAggregate 使用 cgroup、materialization report、policy version 和事件时间点 Inventory 绑定 Service/Infrastructure Asset；
- 绑定使用事件发生时的资源 generation，不能用当前 Pod 状态回写历史；
- 资产 alias 可以演进，但 canonical asset ID 不因人工分类变化；
- 旧深链和旧 `agentAssetId` 继续解析。

### 4.4 绑定质量与审核能力

| 绑定质量 | 典型身份 | 可查看资产 | 可长期人工审核 | 可创建可复用 Ring 规则 |
|---|---|---:|---:|---:|
| exact | 完整 container ID、Pod UID、ProcessKey | 是 | 是 | 需进一步映射稳定 logical selector |
| logical | K8s owner+container、Compose service、systemd unit | 是 | 是 | 是 |
| ephemeral | host+boot+pid+start，或只在当前 generation 有效 | 是 | 仅当前实例、短 TTL | 否 |
| weak | 裸进程名、短 PID、时间邻近 | 是，作为调查分组 | 否 | 否 |
| conflict | 多个资产或结论竞争同一键 | 是 | 暂停 | 否，fail-open |

### 4.5 稳定身份层级

Kubernetes Logical Asset：

```text
workspace/tenant
+ clusterId
+ namespace
+ ownerKind
+ ownerName
+ containerName
```

Kubernetes Runtime Instance：

```text
logical asset
+ podUid
+ full containerId
+ cgroup generation
```

Docker Logical Asset：

```text
workspace/tenant
+ hostGroup
+ composeProject
+ composeService
+ containerName
```

非 Compose Docker 必须增加精确 containerName 和 imageDigest。

Host Service Asset：

```text
workspace/tenant
+ hostId
+ exact systemdUnit
```

Host Process Instance：

```text
hostId + bootId + pid namespace + pid + start time
```

禁止作为长期审核或规则 selector：

```text
bash
cat
python
node
comm
线程名
短 PID
共享 session scope
路径或时间邻近
```

### 4.6 Unknown 资产入口

Unknown 不再从资产体系中消失，而是进入统一资产页的“待识别”视图：

```text
事件详情
  ↓
查看关联资产
  ↓
资产身份、角色和绑定质量
  ↓
Trace / Invocation / Process Tree / Service Context / Event Timeline
  ↓
可审核：确认 Agent / 排除 Agent / 设为待确认 / 恢复自动识别
不可审核：继续调查 / 临时升档 / 等待证据
```

Trace 是审核证据，不是身份锚点。证据优先级为：

```text
认证 Adapter / OTLP Binding
  > Inventory 物理身份
  > Process Generation
  > Trace / Invocation
  > Process ancestry
  > 行为模式
  > 名称提示
```

---

## 五、资产生命周期与观测连续性

### 5.1 核心原则

资产、Runtime、身份和观测覆盖分别变化：

```text
资产仍存在
≠ 当前有新事件
≠ 当前是 Agent
≠ 当前完整采集
≠ 当前 Runtime 仍是同一实例
```

任何规则或人工分类变化都不得：

- 删除 Logical Asset；
- 生成新的 canonical asset ID；
- 把“无普通事件”解释为 Runtime Exit；
- 关闭没有可信 end/exit 证据的 Invocation；
- 把被抑制时间段展示为“没有发生行为”；
- 用当前状态覆盖历史发生时状态。

### 5.2 独立生命周期

#### Logical Asset 生命周期

```text
discovered → active → inactive → retired
```

由 Inventory、显式删除、长期 TTL 和管理事实驱动，不由事件数量驱动。

#### Runtime Instance 生命周期

```text
starting → current → idle → exited
                    └→ lost / unknown
```

由 Runtime lease/snapshot、容器生命周期、Process Exec/Exit、Inventory 和 liveness 驱动。

#### Agent Identity 生命周期

```text
unknown ↔ probable_agent ↔ confirmed_agent
unknown ↔ non_agent
```

身份变化是版本化事实，不启动或终止资产。

#### Observation 生命周期

```text
full
structural
aggregate
sample
suppressed
degraded
gap
```

它回答“当前能看到什么”，不是“资产是否活着”。

### 5.3 最小观测包络

任何 active 资产，即使已确认 non-Agent，也必须保留下列最小包络：

```text
Inventory presence / deletion
Runtime or container lifecycle
最小 Exec ProcessKey
最小 Exit tombstone
SecurityAction
Collector / Source / policy quality
当前 Capture Profile 和规则边界
服务指标、拓扑和变更（若配置）
```

可以被规则降低或丢弃的是常规高频 payload：

```text
重复 FileAccess
重复 Egress / DNS / TLS
低价值 LLM/SSL 负载
已确认基础设施的常规明细
```

### 5.4 低频生命周期事实

为保证连续性，需要持久化低频控制事实，而不是每条被过滤事件：

```text
AssetDiscovered
AssetBindingChanged
RuntimeStarted
RuntimeExited
RuntimeLost
IdentityDecisionChanged
HumanReviewCleared
CaptureProfileChanged
RuleBindingChanged
ObservationCoverageStarted
ObservationCoverageEnded
ObservationGapStarted
ObservationGapEnded
```

每个事实至少包含：

```text
assetId
runtimeInstanceId?
effectiveAt
revision
source
reason
previousState
nextState
policyVersion?
captureEpoch?
evidenceRefs[]
```

这些事实只在有效状态变化时新增。TTL refresh、相同 intent 的重复 ACK、相同规则重新物化不得生成新历史记录。

### 5.5 Observation Coverage Interval

每个资产或 Runtime 维护有界观测区间：

```text
assetId
runtimeInstanceId?
startAt
endAt?
identityRevision
assetBindingRevision
captureProfile
policyVersion
captureEpoch
signalCoverage:
  exec = structural/full
  exit = structural/full
  security = full
  file = full/aggregate/sample/drop
  network = full/aggregate/sample/drop
  llm = full/aggregate/sample/drop
completeness
reason
```

存储规则：

- 只有有效观测矩阵变化才关闭旧区间并开启新区间；
- 相同 intent 的 TTL refresh 只更新当前状态存活时间，不新增区间；
- 连续相同区间可压缩；
- 不记录逐事件 filter detail；
- 历史查询用区间解释“为什么这段时间只有聚合，没有 raw”。

### 5.6 规则生效的无缝边界

规则更新必须经过有界交接：

```text
1. Central 解析受影响 Logical Asset 和当前 Runtime generation
2. 持久化 pending transition intent
3. 发布 Preview Snapshot
4. Collector 非 destructive 应用并 ACK
5. Central 校验 generation / intent / expiry
6. 发放 activation grant
7. Collector 在明确 epoch 边界原子切换
8. 写入生效边界和新 Observation Coverage Interval
9. Forwarder/API 在 drain fence 内同时接受旧、新 epoch
10. 确认旧队列排空后关闭旧观测区间
```

关键要求：

- 没有 grant 时不关闭旧观测区间；
- 规则变化不创建 Runtime Exit；
- 旧 epoch 的在途事件仍按旧发生时语义接收；
- 新 epoch 的事件使用新观测状态；
- ACK/grant 失败时保持 LKG 或 discovery-safe，并显示 degraded，不显示资产离线；
- rollback 使用相同交接流程。

### 5.7 晚到和乱序事件

人工审核和规则记录必须包含 `effectiveAt + revision`。API 不能只用“当前最新审核”处理所有晚到事件。

正确流程：

```text
事件携带 event time / capture epoch / policy version
  ↓
查找该事件发生时有效的身份与观测区间
  ↓
保留 as_observed 分类和当时策略
  ↓
当前人工审核只进入 current_effective 查询覆盖
```

如果事件缺少可信 event time 或 epoch：

- Security、Agent、Conflict、Exec/Exit 最小事实 fail-open；
- 常规 non-Agent 不执行无法解释的 destructive discard；
- 标记时间/版本不完整。

### 5.8 身份变化期间的生命周期行为

#### Unknown → non-Agent

- Logical Asset 保持原 ID 和 active 状态；
- 写入身份变化事实；
- 当前资产移入“已排除”视图，不从系统消失；
- 先保持最小观测包络；
- 若命中已批准规则，复用其 Observation Profile；
- 否则只在 Forwarder/API 降低常规事件，并提示创建规则草稿；
- 不因为事件减少产生 Runtime Exit。

#### probable/confirmed Agent → non-Agent

- 仍禁止一步直接转换；
- 必须先进入 Unknown 并检查强 Agent evidence；
- 存在认证 AgentTool、活跃 Invocation、强 Runtime root 或共享 cgroup Agent 时，规则只能 shadow，KEEP/Investigation 优先；
- 在途 Agent Semantic 队列必须排空；
- Agent Asset 进入历史/已排除状态，但不删除；
- 后续再次确认时继续使用同一 canonical asset ID。

#### non-Agent → 恢复自动识别

- 清除当前人工覆盖；
- 保留审核历史；
- 发布移除人工 binding 的新 revision；
- 恢复 Inventory、Signature、Adapter 和 Behavior 解析；
- 开启新的 Observation Coverage Interval；
- 对当前运行实例执行一次有界 Runtime/Process reconcile；
- 被抑制区间显示 partial，不伪造缺失 raw 数据。

#### non-Agent → confirmed Agent

- 必须先恢复自动识别或进入 Unknown；
- 强 Agent 事实出现后立即 KEEP；
- 当前精确 Runtime 升为 agent_full；
- 旧观测缺口保留在时间线；
- 不尝试伪造被丢弃期间的 ToolCall 或 syscall；
- 可使用 CaptureAggregate、服务指标和生命周期事实作为 partial context。

### 5.9 资产不会因分类切换“消失”

统一资产查询必须满足：

- 当前选择的 `subjectAssetId` 在分类变化后仍可访问；
- 页面只改变分类分区和状态 badge，不改变路由；
- 从 Agent 变为 non-Agent 后进入“已排除”，并保留完整身份和规则时间线；
- 从 Unknown 变为 Agent 后进入 Agent 分区，旧 Unknown 事件仍能按两个分类口径查看；
- 从 Service 中发现内嵌 Agent 时建立关联边，不把 Service Asset 替换为 Agent Asset；
- 规则停用后资产不重新创建，只开启新的观测区间。

---

## 六、Exec、Exit、Security 的正确保护方式

### 6.1 保护的含义

保护表示“先完成必要语义消费”，不是“所有原始数据永久保存”。

| 信号 | non-Agent 必须做的事 | 默认是否进 Agent 主事件表 | 默认是否走 L1/L2/L3 |
|---|---|---:|---:|
| Exec / ToolExec | 建立 ProcessKey、parent generation、进程图 | 否，除非 Agent/Security/Unknown 样本 | 否 |
| Exit / ProcessExit | 关闭 generation、建立 tombstone、更新 Runtime | 否，除非 Agent/Security/Unknown 样本 | 否 |
| SecurityAction | 保留脱敏安全事实、关联资产和上下文 | 是 | L1；必要时 L2/L3 |
| AgentTool / AgentInvocation | 形成身份冲突并保守保留 | 是 | full/investigation |
| 常规 File/Network | 按规则 FULL/AGGREGATE/SAMPLE/DROP | 视规则而定 | non-Agent 默认不走 Agent judgment |
| CaptureAggregate | 保存精确计数、窗口、profile、quality | 是 | 通常不走 Agent judgment |

这里的 `STRUCTURAL` 是目标语义，不要求第一版立即新增一种内核 action。第一版可以继续让 Exec/Exit 以 FULL 进入独立的有界生命周期通道，在 Process Graph/Tombstone 更新完成后不把无关原始 payload 写入 Agent 主事件表；后续只有在跨内核、Collector 和 API 契约同时明确后，才考虑增加独立的结构采集动作。

### 6.2 non-Agent Exec 最小事实

```text
hostId
bootId
pidNamespace
namespacePid
namespacePpid
startTimeTicks / startTimeNs
parentProcessKey
executable hash / command hash
physicalWorkloadId
eventTime
```

默认不保存：

- 完整敏感 argv；
- 无界环境变量；
- 无关文件内容；
- 重复相同生命周期明细。

### 6.3 non-Agent Exit 最小事实

```text
processInstanceKey
exit time
exit code / signal
lifecycle source
tombstone expiry
```

### 6.4 Security 独立路由

路由顺序应为：

```text
SystemContext 特殊事实
  ↓
SecurityAction / Agent semantic / identity conflict
  ↓
Exec/Exit structural consumption
  ↓
身份感知的常规事件判断
```

不能继续先执行：

```text
classification == non_agent → discard
```

否则 Infrastructure 的安全风险和误审核后的 Agent 安全信号会一起消失。

SecurityAction 的“独立路由与永久保留”不等于“自动把整个 cgroup 升为全量调查”。原始安全事实只能触发安全研判；只有已确认风险或显式调查操作才能生成绑定精确 Runtime / Process generation 的有界 `investigation_full`。这样既保护 non-Agent Security 证据，也不会让 probable / Unknown 的短命 cgroup 反复改变 Ring 前 intent。

---

## 七、人工身份审核设计

### 7.1 审核是资产事实，不是单条事件修改

用户从事件进入资产后审核的目标是：

```text
Logical Asset
或
当前精确 Runtime / Process Generation
```

不是 eventId 本身。历史事件保持不可变，但当前查询可以应用人工覆盖。

### 7.2 状态与动作

| 当前有效身份 | 允许动作 | 结果 |
|---|---|---|
| probable_agent | 确认是 Agent | confirmed_agent |
| probable_agent | 设为待确认 | manual unknown |
| unknown | 确认是 Agent | confirmed_agent |
| unknown | 标记为非 Agent | non_agent |
| confirmed_agent | 设为待确认 | manual unknown |
| confirmed_agent | 恢复自动识别 | clear review |
| non_agent | 设为待确认 | manual unknown |
| non_agent | 恢复自动识别 | clear review |

仍不允许：

- probable 一步直达 non-Agent；
- confirmed 一步直达 non-Agent；
- weak/ephemeral identity 产生长期 non-Agent；
- 身份冲突时执行 suppression。

### 7.3 修复“重新纳入观察”

UI 必须拆成：

#### 恢复自动识别

```text
清除当前 reviewDecision
保留审核历史和审计
移除 Observer 人工 binding
恢复 Inventory / Signature / Adapter / Behavior
```

这是 non-Agent 页面默认主操作。

#### 设为待确认

```text
reviewDecision = unknown
source = manual_review
继续采集
只走 L1
禁止弱 behavior 自动提升
```

这是审核人员明确希望“人工冻结为 Unknown”时使用的次操作。

### 7.4 审核前影响预览

预览只计算，不长期持久化：

```text
目标 Logical Asset
当前物理实例数
当前 Process generation 数
绑定质量
跨重启继承条件
共享 cgroup
Agent 冲突
最近五分钟现有事件量
最近五分钟身份和信号构成
当前命中规则
身份变化后 API/Forwarder 影响
是否会生成 Ring 规则草稿
```

阻断条件：

- 只有裸名称；
- 缺失强 ProcessKey 且没有稳定 workload；
- 跨 workspace/tenant；
- 多个无关 root generation；
- 共享 cgroup 中有 Agent；
- 身份键冲突；
- selector 爆炸半径超过上限。

### 7.5 审核后的明确反馈

non-Agent 成功后必须分别显示：

```text
身份：已更新
Forwarder/API：后续匹配常规事件将被抑制
Ring 前采集：仍由当前规则控制
生命周期：资产和 Runtime 不会因此结束
规则：已复用 X / 尚无规则 / 已创建草稿
预计同步：最多两个身份快照周期
```

confirmed Agent 成功后显示：

```text
身份：已确认 Agent
当前 Runtime：将优先 KEEP
Ring 前采集：精确 cgroup 可进入 agent_full
影响范围：N 个实例 / M 个 cgroup
共享范围冲突：有 / 无
```

---

## 八、人工审核与 Ring 前规则联动

### 8.1 推荐结论

应该联动 Ring 前规则，否则只能减少 Forwarder、API、存储和模型负担，不能继续降低原始 Ring 压力。但联动方式必须是：

```text
身份事实 → 规则匹配/草稿 → shadow/canary/审批 → ACK/grant
```

而不是：

```text
点击 non-Agent → 立即 DROP
```

### 8.2 审核后的规则决策

```text
人工 non-Agent
  ↓
解析稳定 Logical Asset 和 Workload Role
  ↓
查询现有全局规则
  ├─ 精确匹配且已批准：自动复用
  ├─ 匹配但有 Agent/shared conflict：KEEP，进入调查
  └─ 无匹配：提示创建安全规则草稿
```

身份审核和规则是两个独立资源：

- 身份审核可以先完成；
- 规则草稿可以稍后创建；
- 清除身份审核不自动删除被多个资产复用的全局规则；
- 只由该审核生成且仍为单资产草稿的规则，可以提示一并停用；
- 已生效全局规则必须单独停用或通过冲突 KEEP 排除 Agent。

### 8.3 默认信号矩阵

精确 non-Agent Service 推荐：

| 信号 | 默认动作 |
|---|---|
| Security | FULL |
| Exec | STRUCTURAL/FULL key，不保留无界 payload |
| Exit | STRUCTURAL/FULL tombstone |
| FileAccess | AGGREGATE |
| FileDelete | SAMPLE，安全或调查时 FULL |
| Connect/TLS/DNS | AGGREGATE |
| LLM/SSL | AGGREGATE 或 SAMPLE |
| 已审批低价值重复信号 | DROP |

### 8.4 全局规则复用

规则绑定稳定 Logical selector，不绑定短命 cgroup：

```text
Kubernetes:
cluster + namespace + ownerKind + ownerName + containerName

Docker:
hostGroup + composeProject + serviceName
或 containerName + exact imageDigest

Host:
nodeId + exact systemdUnit
```

节点 Materializer 将 Logical Rule 映射为当前：

```text
physicalWorkloadId
containerId
cgroupId
inventoryGeneration
```

### 8.5 跨容器重启的 Review Binding Reconciler

```text
Review 绑定 Logical Asset
  ↓
Central 持续消费 K8s/Docker/systemd Inventory
  ↓
找到当前物理实例
  ↓
校验 workspace / cluster / owner / container / image
  ↓
发布每节点精确 Review Binding
  ↓
Observer 只执行精确物理 binding
```

Binding 至少携带：

```text
reviewRevision
logicalAssetId
physicalWorkloadId
podUid / containerId
cgroupId
inventoryGeneration
nodeId
effectiveAt
expiresAt
```

继承规则：

- 同 cluster、namespace、owner、container 且镜像身份可接受：继承；
- image digest 变化：进入重新校验；
- workspace/tenant 变化：不继承；
- Pod sidecar 或共享 cgroup 出现 Agent：KEEP；
- 只有进程名相同：不继承；
- PID 相同但 start time 不同：不继承；
- 旧实例删除后旧 binding 由 generation/TTL 失效。

### 8.6 规则生命周期

```text
新增
  ↓
draft / candidate
  ↓
shadow
  ↓
Inventory validation
  ↓
独立审批人确认
  ↓
enforced
  ↓
Preview → ACK → grant
  ↓
停用时生成 revoked revision
```

禁止：

- 原地修改已生效规则；
- 上传完整 JSON 覆盖；
- 全量替换节点规则文件；
- 创建人批准自己的 destructive 规则；
- 没有真实 Inventory match 时生效；
- Agent conflict 下执行 DROP。

规则变更采用：

```text
基于旧规则新增后继规则
  ↓
新规则完成 shadow/canary/grant
  ↓
停用旧规则
```

避免先停旧规则再启新规则产生观测间隙。

---

## 九、发生时与当前有效双语义

### 9.1 发生时口径 `as_observed`

含义：事件发生时，系统根据当时身份、Inventory、规则和采集状态如何判断。

用于：

- 安全审计；
- Incident 和 Alert；
- Flink Episode 和复合风险；
- 历史回放；
- 发生时证据完整性；
- 原始风险 verdict、tier 和 reason。

它永远不可被后续人工审核改写。

### 9.2 当前资产口径 `current_effective`

含义：按照当前最新资产合并、alias、人工审核和角色事实，历史事件现在归属于谁。

用于：

- 资产运营；
- 当前身份分布；
- 当前资产的历史事件查询；
- 人工审核影响预览；
- 当前规则覆盖和资产归属。

它不能修改历史风险结论，只改变查询分组和当前身份展示。

### 9.3 页面和 API 规则

所有事件、图表和汇总必须接收统一分类口径：

```text
classificationView = as_observed | current_effective
```

默认建议：

| 页面 | 默认口径 |
|---|---|
| Incident / Alert / Evidence / Flink | as_observed |
| 安全运行总览 | as_observed |
| 统一资产页 | current_effective |
| 事件高级检索 | 保留用户上次选择，默认 as_observed |
| 人工审核影响预览 | current_effective，并同时显示 as_observed 对照 |

页面必须显示当前口径及解释：

```text
发生时：保持原始审计结论
当前资产：应用最新资产与人工审核，不改写历史风险结果
```

### 9.4 查询实现原则

```text
不可变事件事实
+ 版本化 Asset/Review Overlay
+ 统一 Classification Resolver
```

- 不批量更新历史 ClickHouse 事件；
- 当前视图按稳定资产键关联 overlay；
- 所有列表、卡片、图表和导出共用 resolver；
- 缓存键包含 `classificationView + reviewVersion + assetBindingVersion`；
- 旧 dashboard bucket 继续表示 as_observed；
- current_effective 对受影响资产做有界查询或增量合并；
- 不允许一个响应混合两种语义而不标注。

### 9.5 历史分类变化示例

```text
2026-08-21 事件发生：unknown
2026-08-22 人工确认：non_agent
```

展示：

```text
发生时身份：Unknown
当前有效身份：非 Agent
人工变化时间：2026-08-22 ...
历史风险结果：保持原值
当前资产分组：已排除资产
```

---

## 十、观测汇总指标与存储边界

### 10.1 汇总必须声明四种口径

| 维度 | 允许值 |
|---|---|
| 计数单位 | decision operation / physical record / logical event / asset |
| 流水线阶段 | Ring 前 / Ring submit / Collector / Forwarder 前 / 过滤后 / 入库后 |
| 分类口径 | as_observed / current_effective |
| 分类轴 | identity / workload role / capture profile / unknown reason |

示例：

```text
入库逻辑事件：10,598
发生时 Agent：1,798
当前有效 Agent：1,650
Ring 前代表决策：213,616
Forwarder non-Agent 抑制：44,156
```

### 10.2 长期只保留低基数维度

允许长期汇总：

```text
pipelineStage
identityClassification
workloadRole
captureProfile
eventKind
probe
action
reasonCode
bounded time window
```

禁止把以下字段作为长期监控 label 或逐条过滤事实保存：

```text
reviewId
agentAssetId / subjectAssetId
identityKeyHash
physicalWorkloadId
cgroupId
path
command
peer
```

### 10.3 允许持久化的低频高价值事实

以下虽包含 assetId，但只在状态变化时产生，数量与规则/生命周期变化成正比，不与事件量成正比：

- Human Review revision；
- Asset Binding change；
- Runtime lifecycle change；
- Observation Coverage Interval；
- Rule revision 和审计；
- materialization 状态变化；
- Alert/Incident；
- Process lifecycle 的有界结构索引。

### 10.4 审核影响不长期保存

审核前和审核后短期影响通过：

```text
最近 5 分钟已有事件
+ 当前 Collector 低基数计数
+ 当前 Inventory
+ 当前规则 Materialization
```

临时计算。结果：

- 可保存在内存或 Redis；
- TTL 5～10 分钟；
- 不写长期 ClickHouse 明细；
- 不产生 per-review Prometheus label；
- 审计只记录审核对象、决定、作用范围摘要和规则关联，不复制事件 payload。

---

## 十一、面向用户的资产与生命周期体验

### 11.1 用户通常关心什么

| 用户问题 | 平台必须回答 |
|---|---|
| 这个对象现在还在运行吗 | Inventory/Runtime 状态，不用事件数量猜测 |
| 它为什么被认为是 Agent 或 non-Agent | 发生时证据、当前人工结论、来源、时间和审核人 |
| 这是哪个服务、容器或进程 | Logical Asset、物理实例和 Process Generation |
| 当前在采集什么 | 当前 Capture Profile 和信号覆盖矩阵 |
| 哪些数据看不到 | 聚合、采样、DROP、degraded 和 gap 区间 |
| 哪条规则影响它 | 规则名称、自然语言范围、生效状态和版本 |
| 重启后是否继续生效 | 继承边界、当前 binding 和重新校验状态 |
| 规则是否导致资产消失 | 资产生命周期和观测生命周期并列展示 |
| 之前是否曾经是 Agent | 身份变化时间线和双分类口径 |
| 能否撤销 | 恢复自动识别、停用规则和回滚结果 |
| 服务上下文是否还存在 | 指标、拓扑、变化、告警和 partial 状态 |

### 11.2 平台作为安全观测系统必须记录什么

平台不是为了证明“收了很多事件”，而是要保存足以回答以下问题的证据：

```text
对象是谁
何时存在和运行
身份与角色如何变化
当时采集了什么、没有采集什么
哪个规则在何时改变了观测范围
哪些安全、进程和 Agent 证据被保留
风险结论使用了哪些事实
当前结论和历史结论为什么不同
```

因此平台应展示：

- 稳定资产与实例关系；
- 身份、角色、Runtime、观测和规则的独立状态；
- 事件、Trace、Invocation、Process Tree 和 Service Context；
- 规则/审核/绑定/观测覆盖时间线；
- 数据完整性、采样、聚合和缺口；
- 可恢复操作及其生效结果。

### 11.3 统一资产页

建议新增“资产与身份”入口：

```text
全部
Agent
服务与基础设施
待识别
已排除
```

现有“智能体资产”保留为 Agent 过滤视图或跳转别名，避免破坏用户习惯和旧链接。

资产页头部固定显示：

```text
资产名称与类型
当前身份
发生时最近身份
工作负载角色
Runtime 状态
观测状态
当前规则
绑定质量
最近活动
```

### 11.4 资产详情信息结构

按用户理解顺序组织：

1. **当前结论**：它是什么、是否运行、当前采集状态；
2. **身份依据**：自动事实、人工审核、冲突和绑定质量；
3. **生命周期时间线**：发现、重启、身份变化、规则变化、退出和缺口；
4. **观测覆盖矩阵**：每类信号当前和历史是否 FULL/AGGREGATE/SAMPLE/DROP；
5. **事件与行为证据**：Trace、Invocation、ToolCall、Process、File、Network、Security；
6. **服务上下文**：指标、依赖、部署变化和告警；
7. **当前规则**：命中原因、生效范围、节点、ACK/grant 和停用入口；
8. **审核与审计**：审核人、时间、理由、revision 和恢复操作。

### 11.5 生命周期时间线

时间线必须能表达：

```text
10:00 发现 Service Asset
10:01 Runtime 启动
10:02 身份 Unknown，进入 discovery
10:05 人工确认 non-Agent
10:05 Forwarder/API 抑制开始
10:06 复用 Infrastructure 规则，Ring 前 aggregate 生效
10:20 容器重启，Logical Asset 不变
10:21 新 container/cgroup binding 生效
10:35 清除人工裁决，恢复自动识别
10:36 发现强 Agent Runtime，进入 agent_full
```

任何被聚合或丢弃的区间显示：

```text
这段时间资产仍在运行；普通文件/网络明细未保留；Security 和进程结构持续可用。
```

### 11.6 观测覆盖矩阵

| 时间区间 | 身份 | Runtime | Exec/Exit | Security | File | Network | 完整性 |
|---|---|---|---|---|---|---|---|
| 10:00–10:05 | Unknown | current | full | full | sample | sample | discovery |
| 10:05–10:06 | non-Agent | current | structural | full | sample | sample | pending rule |
| 10:06–10:35 | non-Agent | current | structural | full | aggregate | aggregate/drop | bounded |
| 10:35–10:36 | auto | current | full | full | sample | sample | reconcile |
| 10:36–现在 | confirmed Agent | current | full | full | full | full | complete |

### 11.7 分类变化后的导航连续性

- 用户在资产详情点击审核后保持当前页面，不跳回列表；
- 页面以 transition 状态展示“正在同步身份/规则”；
- 分类变化后路由和 canonical asset ID 不变；
- 列表分区发生变化时给出可点击提示，例如“该资产已移动到已排除”；
- 已排除资产仍可查看历史、规则、服务上下文和恢复操作；
- 不能因为列表过滤而让详情页面 404；
- 旧 eventId、asset alias 和深链接继续可用。

---

## 十二、采集规则管理前端

### 12.1 产品定位

侧边栏“运维”增加：

```text
采集规则
```

它与“L1/L2/L3 策略配置”分开：

- 采集规则决定哪些信号进入 Ring、聚合、采样或丢弃；
- 研判策略决定已经收到的事件如何分析。

资产详情页同时显示当前命中的规则并可跳转。

### 12.2 标准审核人员不看 JSON

标准页面展示：

```text
规则名称
目的
自然语言作用范围
当前匹配资产/实例/节点
采集结果
固定保护边界
生命周期状态
创建人 / 批准人 / 更新时间
冲突和未生效原因
```

不展示：

```text
完整 selector JSON
schemaVersion
contentHash
intentHash
activation grant JSON
cgroup map JSON
```

工程诊断可继续通过受限 CLI、日志或管理员诊断面进行，不进入 Reviewer 标准界面。

### 12.3 页面结构

采用现有 AnySentry 高密度、证据优先的连续工作区：

```text
顶部：规则总览与控制面健康
────────────────────────────
左侧：筛选和规则列表
右侧：选中规则详情
────────────────────────────
新增规则：分步抽屉或独立工作区
```

顶部显示：

```text
已生效
观察中
待审核
已停用
存在 Agent 冲突
节点未 ACK
控制面 degraded
```

筛选：

```text
状态
环境
资产类型
工作负载角色
来源
采集意图
搜索资产/规则名称
```

### 12.4 人类可读规则详情

示例：

```text
AnySentry ClickHouse 常规噪声

状态：已生效
范围：Kubernetes / anysentry / StatefulSet clickhouse / container clickhouse
当前匹配：1 个服务、1 个容器、1 个节点
采集结果：文件与网络重复信号聚合；已批准低价值信号丢弃
固定保护：安全事件完整保留；进程启动/退出保留结构
来源：平台 Inventory
创建人：operator-a
批准人：operator-b
更新时间：2026-08-22 10:30
跨重启：同 owner/container 且身份校验通过时自动复用
```

规则详情还应显示：

- 当前物理 Materialization；
- Agent/shared cgroup conflict；
- 最近 Preview/ACK/grant 结果；
- 当前 Observation Coverage Interval；
- 预计和实际的低基数阶段计数；
- 作用资产的生命周期不受规则启停影响。

### 12.5 新增规则向导

#### 第一步：选择已有资产

审核人员从统一资产清单选择，不手填底层 selector：

```text
Kubernetes
└─ default-cluster
   └─ namespace anysentry
      └─ StatefulSet clickhouse
         └─ container clickhouse
```

显示：

```text
当前实例数
当前镜像
当前身份与角色
绑定质量
是否共享 cgroup
是否存在 Agent
最近五分钟事件量
现有命中规则
跨重启继承范围
```

#### 第二步：选择意图

```text
保持完整采集
减少重复基础设施信号
有界发现未知工作负载
停止已确认低价值信号
```

内部映射：

| 用户意图 | 采集动作 |
|---|---|
| 保持完整采集 | FULL |
| 减少重复信号 | AGGREGATE |
| 有界发现 | SAMPLE |
| 停止低价值信号 | DROP，需严格审批 |

详细结果以自然语言展开：

```text
进程启动/退出：保留结构
安全事件：完整保留
文件访问：聚合
网络连接：聚合
DNS：聚合
文件删除：有界采样
```

受保护项不可由普通 Reviewer 关闭。

#### 第三步：影响预览

```text
预计匹配 Logical Asset
当前物理实例和节点
Agent conflict
共享 cgroup
最近五分钟现有数据
预计 Ring/Forwarder/API 变化
服务上下文是否继续存在
生命周期是否连续
预计观测覆盖矩阵
```

#### 第四步：新增

新增只生成版本化规则，不直接覆盖任何现有规则。默认进入 draft/shadow。DROP 等 destructive 行为等待独立审批。

### 12.6 只允许新增和停用

标准 Reviewer 允许：

```text
查看
新增
基于现有规则新建
停用
```

新增后由系统自动进入 draft/shadow 和 Inventory 校验流程，Reviewer 不需要手工操作底层阶段、epoch 或 grant。

禁止：

```text
原地编辑已生效规则
全量覆盖
上传 JSON
直接修改 cgroup/epoch/grant
物理删除历史 revision
```

规则变更使用“新增后继规则 → 验证生效 → 停用旧规则”。

### 12.7 停用不是物理删除

按钮使用：

```text
停用规则
```

流程：

```text
填写原因
  ↓
生成 revoked revision
  ↓
重新 Preview / ACK / grant
  ↓
关闭旧 Observation Coverage Interval
  ↓
开启恢复后的新区间
  ↓
历史规则和审计继续可查
```

### 12.8 权限

| 角色 | 权限 |
|---|---|
| Viewer | 查看规则、范围、状态和影响 |
| Reviewer | 新增规则、基于现有规则新建、停用规则；观察阶段由系统自动推进 |
| Approver | 批准 destructive 规则；不能批准自己创建的规则 |
| System | Inventory 校验、物理物化、Preview/ACK/grant |

### 12.9 响应式与 View 验收

- 1440px：列表和详情并排；
- 1024px：列表收窄或可折叠，详情仍可读；
- 390px：列表和详情拆分成独立页面，不整体缩小；
- 不产生文档级横向滚动；
- 状态色分别表达 evidence、review、safe、blocked 和 degraded；
- 交互目标至少 44px；
- 键盘和 screen reader 能完成新增、确认和停用；
- reduced-motion 下状态切换直接完成；
- 实现后必须真实浏览器查看所有关键状态，不能只以 build/typecheck 通过作为 UI 验收。

---

## 十三、服务上下文在规则变化中的连续性

服务 syscall 是否保存与 Service Context 是否存在是两条独立数据面。

即使 ClickHouse、Redis、业务 API 被确认 non-Agent 并执行 Ring 前聚合：

```text
Service Asset
Service Metrics
Dependency Edges
Deployment / Config Changes
Alerts / Health
Inventory Presence
```

仍必须持续更新。

规则变化时 System Context Bundle 需要显示：

```text
服务仍在运行
文件/网络 raw evidence 在某区间被聚合或丢弃
聚合计数是否可用
指标和拓扑是否可用
当前数据完整性和 partial 原因
```

如果某个 Agent 在被抑制区间访问该服务：

- 可以使用 Agent 侧 Tool Span、Agent Kernel Evidence、服务指标和聚合网络边；
- 不能伪造服务端被丢弃的逐 syscall 明细；
- Bundle 标记 `aggregated/partial`；
- 风险结论必须能回指当时 Observation Coverage Interval。

---

## 十四、潜在风险与控制

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 裸进程名人工审核 | 批量误抑制或误升档 | 后端硬拒绝 weak key；只允许临时调查 |
| 事件沉默被当成退出 | 生命周期中断、错误告警 | Inventory/lease/Exec/Exit 驱动生命周期；Observation 独立展示 |
| 规则切换丢在途事件 | 策略边界出现证据洞 | epoch fence、双 epoch drain、边界事实 |
| 晚到旧事件使用新审核 | 历史语义错误、误丢 | effectiveAt/revision/event-time resolution |
| non-Agent Security 被丢 | 基础设施入侵和上游风险不可见 | Security 独立路由 |
| Exec/Exit 完全丢失 | PID reuse、Process Tree、ToolEvidence 错误 | 先保存最小结构，再丢原始 payload |
| 跨 workspace 继承 | 影响其他租户 | workspace/tenant/cluster/hostGroup 进入边界 |
| Pod sidecar/shared cgroup | 一个容器影响 Agent | container 优先；Agent KEEP；冲突调查 |
| 镜像升级身份漂移 | 旧 non-Agent 事实误用于新程序 | digest/owner revision 变化触发重新校验 |
| Trace 被伪造 | 错误资产合并 | Trace 只作证据，不单独授权身份 |
| 全局规则作用范围过宽 | 多资产同时失去数据 | 精确 selector、impact preview、match 上限 |
| 规则重叠 | 动作不确定、震荡 | 确定性优先级；KEEP 优先；显示最终动作 |
| 先停旧规则再启新规则 | 短暂 profile 跳变 | 后继规则先 grant，再 revoke 旧规则 |
| 当前分类覆盖历史 | 审计被改写 | as_observed 不可变；current_effective 只作 overlay |
| 高维过滤指标 | 存储和监控基数爆炸 | 低基数汇总；影响预览临时计算 |
| UI 过度简化 | 用户看不到爆炸半径 | 自然语言展示资产、实例、冲突、覆盖和生命周期 |
| 控制面断连 | 误认为资产退出或错误 DROP | LKG/discovery-safe；显示 degraded，不改生命周期 |
| 规则停用后自动发现未恢复 | 长期 Unknown 冻结 | clear review 与 rule revoke 独立对账 |
| CaptureAggregate 无资产 | 用户无法理解摘要来源 | 使用发生时 materialization 将摘要绑定 Service/Asset |

---

## 十五、异常与降级流程

### 15.1 Inventory 不可用

```text
现有 binding 仍在 TTL
  → 使用 LKG，显示 stale/freshness

TTL 过期
  → destructive action 失效
  → 进入 discovery-safe
  → 保留 Security、Agent 和最小生命周期
  → Asset 状态为 unknown/degraded，不是 exited
```

### 15.2 Review Binding 无法物化到新容器

```text
Logical Review 存在
  ↓
新 physical workload 无法精确匹配
  ↓
Observer 使用 Unknown discovery
  ↓
API 不伪造旧 container binding
  ↓
资产页显示 pending_revalidation
```

### 15.3 规则 Preview/ACK/grant 失败

- 不关闭旧观测区间；
- 不显示新规则已生效；
- 不把事件减少归因到失败规则；
- 显示具体失败节点和 generation；
- 超过 TTL 后进入安全降级。

### 15.4 API 或存储不可用

- Collector/Forwarder 保持有界 LKG；
- Critical/Structural 通道优先；
- 生命周期状态不因 API 不可用被标为 Exit；
- 恢复后按 revision/epoch 对账；
- 无法补回的区间标记 gap/partial。

### 15.5 规则变化时仍有活跃 Invocation

- 认证 Agent Invocation/ToolCall 触发 KEEP/Conflict；
- 不在 Invocation 中途执行 destructive suppression；
- 允许等待 bounded drain 或临时 investigation_full；
- 超时后仍保留语义事件和最小进程证据；
- 页面展示“规则等待活跃 Agent 调用结束”。

### 15.6 清除审核但全局规则仍匹配

- 清除 review 只恢复身份自动解析；
- 全局规则独立存在；
- 如果新解析为 Agent，KEEP 冲突自动覆盖规则；
- 如果仍为服务角色，规则继续生效；
- UI 明确显示“身份已恢复自动识别，但采集规则仍生效”。

---

## 十六、开发阶段

### Phase A：安全路由和审核键

- 将 non-Agent 路由改成 event-kind-aware；
- Security 独立保留；
- Exec/Exit 写入最小 Process Graph/Tombstone；
- 后端拒绝弱审核键；
- AgentTool/AgentInvocation 与 non-Agent 形成保守冲突；
- 补齐 event-time/review effectiveAt 解析。

退出门槛：

- `bash/cat/python` 裸身份不能产生长期审核；
- non-Agent Security 仍能进入风险链；
- non-Agent Exec/Exit 不进入 Agent 主事件流，但 PID reuse 和 ancestry 正确；
- 晚到旧事件不被新审核错误丢弃。

### Phase B：统一资产和生命周期

- 增加通用资产关联和 binding quality；
- Agent、Service、Infrastructure、Unknown 和临时进程进入统一资产模型；
- CaptureAggregate 关联资产；
- 建立独立 Asset/Runtime/Identity/Observation 状态；
- 建立低频生命周期事实和 Observation Coverage Interval。

退出门槛：

- 每条逻辑事件有资产或明确 ephemeral/unassigned 原因；
- 分类或规则变化不改变 canonical asset ID；
- 事件沉默不产生虚假 Runtime Exit；
- 规则生效和停用在资产时间线上可见。

### Phase C：双语义查询和人工恢复

- 所有事件、卡片、趋势、导出支持统一分类口径；
- 修复历史列表和汇总混用；
- 默认“恢复自动识别”调用 clear；
- 单独提供 manual unknown；
- 缓存按 review/binding revision 隔离。

退出门槛：

- 同一口径下列表、总数和趋势守恒；
- as_observed 历史不被修改；
- clear 后弱 behavior 和其他自动识别恢复；
- 历史 risk verdict 不因 current_effective 变化。

### Phase D：跨实例物化和 Ring 联动

- 增加 Review Binding Reconciler；
- 新 Pod/container 绑定当前物理 ID 和 cgroup；
- 旧 generation 自动失效；
- 人工 non-Agent 匹配现有规则或生成安全草稿；
- 实现无缝 rule boundary 和双 epoch drain；
- 控制面异常时保持生命周期连续。

退出门槛：

- 容器重启后两个快照周期内恢复准确早期分类；
- 新镜像或 workspace 变化不盲目继承；
- 旧 cgroup 不继续生效；
- active Asset 不因 suppression 进入 exited；
- DROP 仍必须完成审批、ACK 和 grant。

### Phase E：资产和规则前端

- 新增统一“资产与身份”页面；
- 保留 Agent 过滤视图和旧深链；
- 增加生命周期时间线和观测覆盖矩阵；
- 增加采集规则列表、详情、新增向导、影响预览和停用；
- 标准审核人员不接触 JSON；
- 资产详情与规则详情双向跳转；
- 完成响应式和可访问性 View 验收。

退出门槛：

- 用户能从任何 Unknown/Infrastructure/Agent 事件进入正确资产；
- 分类变化后当前详情页不中断；
- 用户能看到规则是否改变 Ring、Forwarder 或 API；
- 只能新增和停用，不能原地覆盖；
- 1440/1024/390 关键状态均通过真实浏览器验收。

### Phase F：长期运行和总验收

- 24 小时以上连续运行；
- 控制面断连、API 重启、Collector 重启、Pod rollout；
- 大量规则、重叠规则和 revision churn；
- 历史冷查询和 Flink 稳定性；
- 存储增长和指标基数；
- Agent recall 和 false-Agent 回归。

---

## 十七、端到端测试场景

### 场景一：Unknown 在运行中被标记 non-Agent

```text
Unknown workload 持续运行并产生 File/Exec/Exit
  ↓
人工确认稳定资产为 non-Agent
  ↓
资产 ID 和 Runtime 状态不变
  ↓
Forwarder/API 抑制常规信号
  ↓
Exec/Exit 更新结构和 tombstone
  ↓
资产时间线记录身份和观测边界
  ↓
最终 Exit 正确关闭 Runtime
```

验收：资产不中断、不消失、不因事件减少提前退出。

### 场景二：规则在 active Runtime 中生效

```text
Service Runtime active
  ↓
新增 Infrastructure aggregate/drop 规则
  ↓
Preview / ACK / grant
  ↓
旧 epoch 在途事件排空
  ↓
新 epoch 原子生效
  ↓
开启新 Observation Coverage Interval
```

验收：无策略边界丢失，生命周期保持 current。

### 场景三：晚到事件跨越人工审核边界

```text
事件在审核前发生
  ↓
人工审核生效
  ↓
旧事件延迟到达 API
```

验收：旧事件按审核前 as_observed/epoch 接收；当前资产视图可显示最新人工结论；不静默覆盖历史。

### 场景四：误将活跃 Agent 候选降为 non-Agent

```text
probable Agent 有活跃 Runtime/Invocation
  ↓
审核尝试 non-Agent
  ↓
状态机要求先 Unknown
  ↓
强 Agent/semantic evidence 形成冲突
  ↓
KEEP / investigation 优先
```

验收：Agent 召回 100%，活跃 Invocation 不被中途截断。

### 场景五：non-Agent 后重新发现为 Agent

```text
资产在 non-Agent/aggregate 下运行
  ↓
清除人工审核
  ↓
恢复自动发现
  ↓
认证 Adapter 或强 Runtime 证据出现
  ↓
同一资产/当前 Runtime 升为 agent_full
```

验收：不创建重复资产；旧 suppression 区间显示 partial；不伪造缺失 raw。

### 场景六：Kubernetes Pod 重建

```text
Logical Service/Review/Rule 已存在
  ↓
旧 Pod/container 删除
  ↓
旧 cgroup binding 失效
  ↓
新 Pod/container 创建
  ↓
Central 校验 owner/container/image/workspace
  ↓
发布新 binding
```

验收：Logical Asset 连续；Runtime Instance 正确切换；新 cgroup 两个快照周期内生效。

### 场景七：镜像变化

```text
owner/container 相同
  ↓
image digest 改变
```

验收：non-Agent destructive binding 不盲目继承；进入重新校验或 discovery-safe；资产不丢失。

### 场景八：共享 cgroup 或 sidecar 出现 Agent

验收：Agent KEEP 优先；Infrastructure Rule 显示冲突；不丢 Agent、Security 或生命周期证据。

### 场景九：停用规则

```text
规则 enforced
  ↓
Reviewer 停用
  ↓
revoked revision
  ↓
新 Preview/ACK/grant
  ↓
普通信号恢复
```

验收：资产不重新创建；规则和观测区间时间线完整；恢复事件使用同一资产 ID。

### 场景十：控制面断连

验收：固定期限 LKG 后进入 discovery-safe；不误 DROP；资产显示 degraded 而不是 exited；恢复后 revision/epoch 对账。

### 场景十一：non-Agent SecurityAction

验收：即使主体是 ClickHouse/Redis/普通服务，SecurityAction 仍进入安全 L1；风险成立时可升 L2/L3；Bundle 包含相关服务上下文。

### 场景十二：non-Agent Exec/Exit 高负载

验收：主事件表不保存无界原始事件；Process Generation 和 tombstone 100% 正确；存储与内存有界；PID reuse 无误链。

### 场景十三：双分类口径

同一历史窗口先以 as_observed、再以 current_effective 查询。

验收：

- 两个口径各自列表、卡片、趋势完全守恒；
- 页面明确显示口径；
- Incident/Flink/历史 verdict 不变；
- 当前资产分组随人工审核变化。

### 场景十四：规则 UI

验收：

- Viewer 能理解规则范围和结果，不需要 JSON；
- Reviewer 只能新增和停用；
- 创建人不能批准自己的 DROP；
- impact preview 显示实例、冲突、生命周期和观测范围；
- 无全量覆盖入口；
- 停用保留历史 revision。

### 场景十五：弱审核键

对 `bash`、`cat`、`python`、缺失 start time 的 host event 尝试长期审核。

验收：前端不可提交，后端也拒绝；只能建立临时调查对象或等待更多证据。

---

## 十八、最终验收矩阵

| 维度 | 指标 | 必须结果 |
|---|---|---|
| Agent 召回 | 已知和新 Agent root/tool marker | 100% |
| false-Agent | ClickHouse/Postgres/Redis/control plane | 0 |
| 弱键安全 | 裸进程名长期审核 | 0 次允许 |
| 资产绑定 | 事件有资产或明确 unassigned 原因 | 100% |
| 资产连续性 | 分类/规则变化导致新 canonical asset | 0 |
| Runtime 连续性 | suppression 导致虚假 exit | 0 |
| protected Security | non-Agent Security 被丢 | 0 |
| protected lifecycle | Exec/Exit ProcessKey/Tombstone 完整性 | 100% |
| 原始 non-Agent 成本 | Exec/Exit 无界主表入库 | 不允许 |
| 规则边界 | 在途旧 epoch 丢失 | 0 |
| 晚到事件 | 新审核覆盖旧发生时语义 | 0 |
| 观测缺口 | suppression/degraded/gap 显式标记 | 100% |
| 双口径 | 同一口径列表/卡片/趋势不守恒 | 0 |
| 历史审计 | current_effective 改写 verdict/tier | 0 |
| 恢复自动识别 | clear 后自动发现恢复 | 100% |
| 跨容器复用 | 新实例两个快照周期内精确 binding | 100% |
| 旧 binding | 已删除 cgroup 继续生效 | 0 |
| Agent 冲突 | Infrastructure DROP 覆盖 Agent KEEP | 0 |
| 规则管理 | 原地覆盖/全量替换入口 | 0 |
| 双人审批 | 创建人批准自己的 destructive rule | 0 |
| UI 可理解性 | Reviewer 必须阅读 JSON 才能操作 | 0 |
| UI 连续性 | 分类后详情 404/资产消失 | 0 |
| 指标基数 | asset/review/cgroup 进入长期 label | 0 |
| 存储有界 | filtered raw 明细长期持久化 | 0 |
| 服务上下文 | syscall 聚合后 Service Context 丢失 | 0 |
| Ring 安全 | Ring/Collector/Critical 物理丢失 | 0 |
| 兼容性 | 旧 Trace/Incident/Alert/Flink key 变化 | 0 |

---

## 十九、完成后的 High-level 运行流程

```text
Inventory / SDK / OTLP / Kernel / Human Review / Existing Rules
        ↓
统一 Observed Asset 解析
Agent / Service / Infrastructure / Workload / Ephemeral Process
        ↓
独立维护：
Asset Existence
Runtime Lifecycle
Agent Identity
Workload Role
Observation State
        ↓
Central 将逻辑审核和规则物化到当前物理实例
container / pod / cgroup / process generation
        ↓
Preview → Collector ACK → Central acceptance → activation grant
        ↓
写入规则生效边界和 Observation Coverage Interval
        ↓
Ring 前：
FULL       Agent / Security / Investigation
STRUCTURAL Exec / Exit 最小生命周期
AGGREGATE  Service / Infrastructure 重复上下文
SAMPLE     probable / Unknown discovery
DROP       精确、审批、canary 后的低价值常规信号
        ↓
Forwarder / API 先消费受保护语义
Security / Agent / Conflict / Process lifecycle
        ↓
常规 non-Agent 信号有界抑制
        ↓
分层存储：
高保真 Agent Evidence
最小 Process Lifecycle
Capture Aggregate
Service Context
低频 Asset/Rule/Observation Timeline
低基数 Quality/Accounting
        ↓
统一查询：
as_observed 历史审计
current_effective 当前资产运营
        ↓
资产与身份页 / 事件页 / 生命周期时间线 / 覆盖矩阵 / 规则管理
        ↓
风险、调查、人工审核、规则新增与停用
        ↓
反馈进入下一次安全控制闭环
```

最终系统不再把“没有事件”误认为“没有资产”，也不再把“non-Agent”误认为“没有安全价值”。规则可以显著降低 Ring、网络、API 和存储成本，但任何一次身份或规则变化都能明确回答：

```text
资产是否仍在运行
身份为什么变化
哪些信号从何时开始被聚合或丢弃
Security 和进程结构是否仍完整
当前规则作用于哪些实例
重启后如何继承
历史数据在哪些区间是 partial
如何恢复自动识别和完整采集
```

这才是面向用户和安全观测平台都完整的资产生命周期与采集治理闭环。
