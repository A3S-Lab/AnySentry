# PR 标题

feat(agent-security): 引入工作负载级 Agent 发现、身份治理与分级风险研判

## 合并信息

- Base：`main`
- Compare：`feat/identity-aware-judgment`
- AnySentry 当前分支：`feat/identity-aware-judgment`
- Observer 前置能力：PR #11 已审批，稳定 process/cgroup/boot/start-time 观测契约已进入发布流程
- Sentry 前置能力：Rust/Linux `v0.8.0` 与 npm `@a3s-lab/sentry@0.3.0` 已发布
- 变更规模：116 个文件，新增约 17,878 行，删除约 763 行（最终以 GitHub PR 为准）

> 这是一个跨 Collector、AnySentry API、Sentry 分级研判、ClickHouse 数据语义和前端信息架构的大型功能 PR。建议按本文“审阅指南”的模块顺序审阅，不建议只按文件顺序逐个查看。

## 摘要

本 PR 将 AnySentry 从“接收 Observer 事件后统一研判”的模式，扩展为一套面向真实 Agent 运行环境的观测、发现、身份治理和分级风险研判链路：

1. Observer/Collector 在用户态从全机内核事件中解析物理工作负载，优先使用 Kubernetes、Docker、systemd、进程实例和用户模板等稳定证据识别 Agent。
2. 未知工作负载通过有界、确定性的行为序列分析发现候选 Agent；该过程不调用 LLM，也不会自动确认 Agent。
3. 身份分类、事件保留、页面可见性和 L1/L2/L3 风险研判路由被拆分为四套明确语义，不再由一个 `FORWARD_SCOPE` 或页面 scope 同时决定。
4. Agent 资产使用唯一 `agentAssetId` 聚合；人工审核、显示名和资产信息都附加到同一个底层观测资产，不创建第二条“人工 Agent”。
5. Unknown 事件默认保留并进入 L1，以便审计人员发现漏检 Agent；Confirmed 和 Candidate 按策略进入完整的 L1/L2/L3 链路；Non-Agent 后续常规事件在 Collector 侧停止入库。
6. L2 和 L3 模型连接独立配置。L2 与 AI 身份辅助审核共享“快速研判模型”连接；L3 使用独立“深度研判模型”连接。
7. 新增基于 `@a3s-lab/code` SDK 的只读身份辅助审核 Agent。它只能读取被允许的事件、进程、工作负载和受限文件证据，不能编辑文件、执行任意 shell、控制进程或自动修改身份结论。
8. 首页新增以 Agent 资产为主视角的风险概览，并保留时间窗复合研判视角；事件详情、资产页和运行链路统一 Agent 名称、运行位置、分类颜色和双向跳转语义。

整个 Collector 方案仍是 observation-only：本 PR 不安装阻断式 eBPF hook，不阻止系统调用，也不宣称内核操作被拒绝。风险判定和身份过滤只影响观测事件的保留、研判深度和页面展示。

## 背景与问题

现有链路已经能够通过 Observer eBPF 捕获系统事件，并在 AnySentry 中完成 L1/L2/L3 风险研判和面板展示，但在真实主机测试中暴露出以下问题：

- 全机内核事件量大，普通服务、数据库目录、共享 SSH session 和基础设施容器可能被误认为 Agent。
- `session-*.scope`、`cri-containerd-*.scope` 等运行边界可帮助定位工作负载，却不适合作为 Agent 主名称或永久资产键。
- 只保留已识别 Agent 会丢失 Unknown 证据，使审计人员无法从事件中发现漏检 Agent。
- 身份分类、ClickHouse 保留、页面过滤和 L1/L2/L3 路由此前存在耦合，一个 scope 参数可能同时改变多种行为。
- 同一 Agent 的事件、人工审核、显示名、流式窗口和资产聚合缺少统一的稳定身份，容易出现重复资产、深链接空页面或改名后证据断链。
- L2、L3 和 AI 辅助审核需要不同的性能、安全和权限边界，不能继续被视为同一个模型调用场景。

本 PR 的目标是把“发现运行边界”“判断是否为 Agent”“决定是否存储”“决定页面是否显示”“决定最多研判到哪一级”拆成可解释、可审计和可独立配置的系统能力。

## 设计原则与不变量

### 1. 不修改历史证据

- `displayName` 只影响当前展示和搜索，不参与事件关联、Kafka/Flink keyed state、身份缓存键或证据哈希。
- 采集时名称、原始 `agentId`、进程信息、工作负载信息和 attribution evidence 不会因改名或人工审核被覆盖。
- 已经进入 ClickHouse 的事件不会因为后续人工身份裁决而删除或改写。

### 2. 身份发现默认 fail-open

- 缺少快照、进程已经退出、PID 信息不完整、身份冲突或元数据暂不可用时保持 `unknown` 并继续观测。
- 未命中 Agent 模板不等于 Non-Agent。
- 只有稳定身份上的明确 Non-Agent 结论才会停止后续常规事件入库。
- 生命周期、高价值安全、删除、网络和 LLM 证据不会仅因 Unknown 身份而被静默丢弃。

### 3. 热路径有界且不调用模型

- Collector 逐事件热路径只进行快照、缓存、Map、计数器、优先级队列和有界行为窗口操作。
- Kubernetes API、Docker API、ClickHouse 查询、全量正则扫描和 LLM 调用不进入逐事件路径。
- 队列、缓存、候选 TTL、行为窗口、证据集合和抑制统计都有上限或过期策略。

### 4. 人工审核不创建新资产

- 每个 Agent 资产只有一个 `agentAssetId`。
- 人工审核、显示名、负责人、团队、标签和说明只更新规范资产注册表。
- 元数据不能在没有真实观测身份时凭空创建一个 Agent。
- 旧资产 ID 作为 alias 解析到规范资产，避免旧深链接断开。

### 5. observation-only 边界

- Collector 的“过滤”表示不再转发低价值观测事件，不是阻止 Agent 执行命令。
- L1 返回的高风险或 escalate 结果仍被保留；页面不会将 pass-through 描述成内核 block。
- 可选的内核态 observation prefilter 未在本 PR 中启用。

## 架构概览

```text
Observer eBPF
  └─ 内核事件 + PID/TGID/PPID/cgroup/process facts
       ↓ NDJSON
Observer Collector / AnySentry node forwarder
  ├─ Kubernetes/Docker/host workload snapshot
  ├─ operator templates
  ├─ ProcessKey / cgroup / workload cache
  ├─ bounded behavior discovery
  ├─ retention + independent noise policy
  ├─ bounded priority queue + adaptive batching
  └─ structured filter/identity metrics
       ↓ batched ingest
AnySentry API
  ├─ canonical agent asset registry
  ├─ human review state machine
  ├─ effective identity resolver
  ├─ immutable judgment routing snapshot
  ├─ ClickHouse storage/search
  └─ runtime model connections
       ↓
Sentry staged judgment
  ├─ L1 deterministic/rule judgment
  ├─ L2 A3S Code structured judgment
  └─ L3 A3S Code deep-investigation Agent
       ↓
Kafka/Flink time-window correlation + dashboard
```

## 核心语义：四分类与三条独立策略

### 身份四分类

| 内部分类 | 页面名称 | 含义 |
| --- | --- | --- |
| `confirmed_agent` | 已确认 Agent | 可信平台身份、强签名、可信模板或人工确认 |
| `probable_agent` | 候选 Agent | 多条非权威行为/运行时证据达到候选阈值 |
| `unknown` | 尚未识别 | 证据不足、身份暂不可用或人工要求重新观察 |
| `non_agent` | 已排除 | 权威基础设施配置或人工明确排除 |

### 采集保留、页面可见性和研判路由

| 有效分类 | 新事件进入 ClickHouse | 全部事件/检索 | Agent 运行链路 | 智能体资产 | 风险研判上限 |
| --- | ---: | ---: | ---: | ---: | --- |
| 已确认 Agent | 是 | 是 | 是 | 是 | 完整配置链路 L1 → L2 → L3 |
| 候选 Agent | 是 | 是 | 是 | 是 | 默认完整链路，可配置仅 L1 |
| 尚未识别 | 默认是 | 是 | 否 | 否 | 仅 L1 |
| 已排除 | 后续常规事件否 | 历史可审计 | 否 | 否 | 不进入新事件研判 |

这三类决定不再由同一个 `FORWARD_SCOPE` 或 scope 参数控制：

- retention 决定事件是否被接收和存储；
- visibility 决定某个页面是否展示已存储事件；
- judgment routing 决定已经接收的事件最多进入 L1、L2 还是 L3。

Unknown 的 L1 `allow`、`block` 或 `escalate` 原始结果会被保留。如果 L1 要求升级，但身份策略限制为 L1，系统记录 `unknown_identity_l1_only` 停止原因，而不是把结果改写成低风险 allow。

## 主要变更

### 1. 工作负载优先的 Collector 过滤链路

新增并集成：

- `scripts/observer-workload-filter.js`
- `scripts/observer-agent-templates.js`
- `scripts/observer-docker-discovery.js`
- `scripts/observer-behavior-discovery.js`
- `scripts/observer-priority-queue.js`
- 扩展 `scripts/observer-agent-attribution.js`
- 扩展 `scripts/observer-forward.js`

逐事件流程为：

```text
parse Observer event
  → ToolExec exact dedup
  → physical workload snapshot lookup
  → ProcessKey / cgroup / lineage cache
  → automatic + reviewed classification
  → independent noise/retention policy
  → bounded priority queue
  → adaptive batch ingest
```

默认部署策略：

```text
FORWARD_FILTER_MODE=enforce
FORWARD_RETAIN_UNKNOWN=true
FORWARD_RETAIN_NON_AGENT=false
FORWARD_NOISE_POLICY=balanced
FORWARD_BATCH_SIZE=32
FORWARD_BATCH_FLUSH_MS=50
FORWARD_MAX_QUEUE=4096
```

`shadow` 模式计算完全相同的分类和 would-drop 指标，但继续转发事件，可用于正式启用前比较误过滤率。

### 2. 两种 Agent 发现模式

#### 用户模板

用户可以只描述 Agent 名称和部署方式，模板支持：

- Kubernetes namespace/Pod/container/owner；
- Docker container/image；
- 裸机 systemd unit/executable；
- deployment-agnostic 名称匹配；
- 显式 `non_agent` 基础设施模板。

模板可以保持简洁，不要求用户提前提供完整容器 ID、Pod UID 或 PID。解析器使用自然身份字段进行受控匹配；非法或冲突模板 fail-open，不执行任意表达式。

示例位于 `deploy/agent-templates.example.json`。

#### 框架行为发现

对没有模板和平台标签的工作负载，系统维护有界行为窗口并检查：

- LLM endpoint/activity；
- ToolExec 次数和不同工具数；
- LLM/tool 交替；
- tool → decision/network → different tool → workspace change 序列；
- 文件、网络、子进程和工作区变化；
- 服务数据目录、主 executable 占比和无 Agent 序列等负向证据。

行为发现只能从 Unknown 提升为 Candidate，不能直接形成 Confirmed。大量 exec、文件访问或子进程数量本身不足以确认 Agent，也不会在热路径调用 LLM。

ClickHouse、PostgreSQL、MySQL、Redis 等服务状态目录不会作为 Agent workspace 变化计分。成熟单一 server executable、固定服务数据目录、无 LLM 活动、无工具交替时，负向证据可以提前结束 Candidate TTL，但不会自动生成永久 `non_agent`。

### 3. Kubernetes、Docker 与裸机身份

#### Kubernetes

- 初始 Pod list + watch，保存 Pod UID、namespace、Pod、owner、labels、完整 Container ID、container name/image。
- 先将原始 `cri-containerd-*.scope` 映射为 `namespace/pod/container`，再进行 Agent 分类。
- Agent container 与 sidecar 使用完整 Container ID 分开识别。
- 默认通过只读 ClusterRole/ClusterRoleBinding 获取跨 namespace Pod 元数据。
- 可用 `ANYSENTRY_IDENTITY_NAMESPACES` 限制命名空间；限制后需接受跨 namespace 名称解析不完整。
- 支持 in-cluster、kubeconfig、context 和 token/certificate 访问。

#### Docker

- 通过 Docker list + container event stream 异步维护容器快照。
- Docker API 访问不在逐事件热路径。
- 稳定实例身份使用 host + full container ID；容器名和镜像只用于展示与证据。

#### 裸机

- PID 不单独作为稳定身份，使用 node/host、boot ID、PID 和 process start marker 防止 PID reuse。
- `session-*.scope` 只作为运行环境标签，不作为 Agent 主名称或永久资产 ID。
- 共享 SSH session 内按根进程树进一步拆分的完整 HostProcessTreeKey 仍是后续工作，本 PR 不夸大当前精度。

### 4. 唯一 Agent 资产与人工审核状态机

新增规范 Agent 资产注册表：

- `agentAssetId` 是资产唯一 ID；
- `agentInstanceId` 表示一次具体运行实例；
- `physicalWorkloadId` 保存物理工作负载实例；
- `agentAssetAliases` 兼容旧 ID 和旧深链接；
- `displayName` 是可变展示名；
- `detectedName`、原始 Agent、采集时名称和 attribution evidence 保持不可变。

人工状态迁移：

```text
候选 Agent
  ├─ 确认是 Agent → 已确认 Agent
  └─ 证据不足，降为未知 → 尚未识别

尚未识别
  ├─ 确认是 Agent → 已确认 Agent
  └─ 标记为非 Agent → 已排除

已确认 Agent
  └─ 撤销确认，重新观察 → 尚未识别

已排除
  └─ 重新纳入观察 → 尚未识别
```

Candidate 和 Confirmed 都不能一步直接进入 Non-Agent，降低误停采集风险。后端集中校验状态迁移，不能仅依赖前端隐藏按钮。

人工裁决通过版本化 identity snapshot 分发给 Collector。Collector 只在稳定身份命中时应用 Non-Agent 抑制；冲突、快照缺失或身份不完整时 fail-open。

### 5. Unknown 保留和 ClickHouse 查询语义

- 全部观测事件默认包含 Unknown。
- 已识别 Agent 视图只包含 Confirmed 和 Candidate。
- 智能体资产只聚合 Confirmed 和 Candidate。
- Unknown 高风险 L1 结果仍出现在全部事件和事件检索中。
- 历史 Non-Agent 可通过审计/历史检索访问，但不作为活跃 Agent 资产。
- 查询 DTO 在返回时通过规范资产索引补充当前显示名，不改写 ClickHouse 历史行。
- 查询路径使用批量索引/O(1) resolver，避免每条事件访问一次 ClickHouse。

Agent 元数据使用 `anysentry.agent_metadata.v2` 包装格式持久化，同时兼容读取旧 metadata。旧事件不要求重写或迁移。

### 6. 身份感知的 L1/L2/L3 路由

新增身份研判策略：

```ts
interface IdentityJudgmentPolicy {
  candidatePipeline: "full" | "l1_only";
}
```

在 ingest 时生成不可变路由快照，包含：

- 接收时有效分类；
- 稳定身份键；
- policy/routing version；
- route profile；
- 最大研判层级；
- route reason。

后续人工身份变化只影响未来事件，不改变已经进入队列的研判任务。

路由规则：

- Confirmed：完整配置链路；
- Candidate：默认完整链路，可配置仅 L1；
- Unknown：只调用 staged L1；
- Non-Agent：采集阶段已经停止新常规事件，不进入研判。

L3 仍只在符合 Sentry escalation 条件时进入，不会因为身份是 Confirmed 就无条件调用模型。

### 7. L2/L3 独立运行时模型连接

策略页面新增两套连接：

| 页面名称 | 消费方 | 隔离方式 |
| --- | --- | --- |
| 快速研判模型 | L2 单次结构化研判、AI 身份辅助审核 | 共用 endpoint/model/key，但使用独立 Agent、Session、prompt、历史和权限 |
| 深度研判模型 | L3 深度研判 Agent | 独立 endpoint/model/key、上下文和 Agent pool |

连接流程：

1. 浏览器提交 key 做一次有界连接测试；
2. 测试通过后服务端返回短期 opaque apply token，不返回 key；
3. 用户显式应用后，凭据只保存在进程内存；
4. 通过 Redis Pub/Sub 向 fast-judge、L3 worker 等进程热更新；
5. worker 轮换缓存的 L2 judge 或 L3 Agent pool；
6. API 重启后 UI 输入的 key 消失；部署环境变量仍作为可重启的 secret-manager 兼容来源。

API key 不写入 PolicyConfig、ClickHouse、BullMQ job、Redis key/list/stream、审计详情、日志、API 响应或浏览器存储。

环境变量兼容入口：

```text
A3S_SENTRY_LLM_URL
A3S_SENTRY_LLM_MODEL
A3S_SENTRY_LLM_KEY

A3S_SENTRY_L3_URL
A3S_SENTRY_L3_MODEL
A3S_SENTRY_L3_KEY
```

### 8. 只读 AI 身份辅助审核

新增基于 `@a3s-lab/code` SDK 的定制身份审核 Agent：

- 只在智能体资产审核上下文提供入口；
- 使用快速研判模型配置；
- 输出 Agent / Not-Agent 二分类、confidence、描述、原因、正负证据和限制；
- 结果是不可变的辅助审核历史，不自动更新人工身份结论；
- 审核人员阅读建议后，仍需使用合法人工状态迁移完成裁决。

允许的工具仅包括有界、只读证据：

- 事件、trace、run、行为和 LLM 活动查询；
- PID-reuse-safe 的进程、祖先、cgroup 和 runtime 查看；
- Docker/Kubernetes metadata 查询；
- 限制在审核 workspace 内的目录、搜索和文本读取。

明确禁止：

- shell 和任意命令执行；
- 文件编辑、写入、patch、git 修改；
- 任意外部网络访问；
- 进程、容器和 Kubernetes workload 控制；
- delegation/sub-Agent；
- 自动应用身份结论。

### 9. 前端信息架构与交互

#### 首页

- 保留现有总体指标和运行链路。
- 将原流式复合研判区域调整为“智能体风险概览”。
- 默认以 Agent 资产为主体展示 8 个资产，支持展开更多。
- 可切换到“时间窗研判”视角，展示一定时间窗口内的复合行为结果。
- UI 不暴露 Flink 等实现名称。

#### 运行链路与事件详情

- Agent 运行链路显示 Confirmed/Candidate 的单条事件。
- 全部事件仍默认显示 Unknown。
- 点击事件进入事件检索，保留历史运行记录、来源事件和筛选上下文。
- 事件页提供跳转到规范 Agent 资产的入口，但不重复放置只能在资产页执行的身份审核动作。

#### 智能体资产

- 只展示 Confirmed 和 Candidate。
- Confirmed 始终排在 Candidate 前面，再按风险、时间和事件数量稳定排序。
- 同名 Agent 通过 workspace、namespace/pod/container、Docker container 或 Root PID 定位信息区分。
- 从首页固定某个 Agent 深链接进入后，左侧仍可切换其他 Agent，不再把 deep-link filter 误当成列表数据源约束。

#### 名称与标签

- 主名称优先 `displayName`，其次 detected workload name、Pod/container、service/executable 和原始 Agent ID。
- 已确认与候选使用不同名称颜色。
- Kubernetes、Docker、本地服务使用紧随名称的小标签。
- workspace/Pod/container/Root PID 作为第二行定位信息，不拼接进名称。
- 详情同时展示当前显示名、采集时名称和原始执行者。

#### 人工确认交互

- 使用页面内嵌确认条，不使用浏览器原生 confirm 弹窗。
- 身份信息配置默认折叠，避免每次审核都展示低频配置字段。
- 页面使用“已确认 Agent”“候选 Agent”“尚未识别”“已排除”等审核人员可理解的词，不展示 `probable_agent` 等内部值。

### 10. Kafka/Flink/OSV 兼容

- 当前分支已经包含 `feat/flink-osv-risk-streaming` 的完整历史。
- `origin/main` 当前比本分支多一个合并该功能的 merge commit，但双方共享同一个 Flink/OSV 内容祖先。
- `git merge-tree origin/main HEAD` 已验证可自动合并，没有内容冲突。
- Agent 改名不改变 Flink `agentCorrelationId` 或窗口 keyed state。
- 查询时解析显示名，不重放 Kafka，也不重建 Flink state。
- 修复 Compose streaming profile，使 Flink checkpoint-init、taskmanager 和 job-submit 能从本地 `streaming/flink` 构建一致镜像。
- 复合判断兼容 fenced model response，并保留无模型场景的 synthetic/历史 episode 保护。

## API 与数据契约

主要新增/扩展接口包括：

```text
GET  /security-center/identity/snapshot
POST /security-center/identity/ai-review
GET  /security-center/identity/ai-reviews
PUT  /security-center/agents/:agentId/review

GET  /security-center/config/model-connections
POST /security-center/config/model-connections/test
PUT  /security-center/config/model-connections/:profile
POST /security-center/config/model-connections/:profile/clear
```

新增/扩展的主要响应字段：

```text
agentAssetId
agentAssetAliases
agentInstanceId
physicalWorkloadId
detectedClassification
effectiveClassification
reviewDecision
detectedName
displayName
locationLabel
runtime
instanceCount
judgmentRouteProfile
judgmentMaxTier
judgmentStopReason
```

兼容策略：

- 新字段 additive；旧 Collector、旧事件和旧 Agent metadata 继续可读。
- 旧 `workspacePath + agentId` 作为兼容查找索引，不再作为新资产主键。
- 旧深链接通过 alias 解析到规范资产。
- 人工显示名不会回写 `agentScopeId`、`agentCorrelationId` 或历史 attribution。

## 部署和配置变化

### Kubernetes RBAC

为了将所有 CRI/containerd ID 先映射到 namespace/Pod/container，默认部署由 namespaced Pod reader 调整为只读 ClusterRole/ClusterRoleBinding：

```text
resources: pods
verbs: get, list, watch
```

该权限只读取 Pod metadata，不读取 Secret、ConfigMap 内容或执行 workload 操作。安全要求更严格的部署可使用 `ANYSENTRY_IDENTITY_NAMESPACES` 和等价 namespaced Role，但需要接受跨 namespace 名称解析不完整。

### Observer DaemonSet

新增：

- Agent template ConfigMap；
- identity snapshot URL 和刷新周期；
- 独立 retention/noise 配置；
- 有界 batch/queue 配置；
- workload、Docker、behavior、priority queue 模块打包。

### Docker Compose

- L2 与 L3 URL/model/key 分开注入 API、fast-judge 和 L3 worker。
- 默认 key 为空，不再使用 `proxy-managed` 占位凭据。
- 增加身份辅助审核整体、单轮 LLM 和 preflight timeout。
- 增加本地 Sentry 源码 overlay：`docker-compose.local-source.yml`。

### 新依赖

- API 新增 `yaml@^2.9.0`，用于解析安全边界内的配置/协议内容。

## 安全性

- 模型 key 默认不持久化，不出现在 API 响应、日志或审计详情。
- 连接失败原因进行分类和裁剪，避免泄露完整 endpoint、响应体或密钥。
- AI 身份审核权限默认 deny，只开放显式只读工具。
- workspace 路径 canonicalize，拒绝 symlink escape，并限制文件尺寸和返回数量。
- 进程证据使用 host/boot/PID/start-time 约束，避免 PID reuse 读取错误进程。
- Non-Agent 抑制要求稳定身份，不能只按进程名、短 PID、容器短 ID 或共享 session scope 执行。
- 抑制统计只保存计数、时间、身份 hash 和 event kind，不复制命令、路径或网络负载。
- Kubernetes 权限仅为 Pod metadata 的 get/list/watch。
- 本 PR 不启用内核阻断、任意 shell 或自动身份变更。

## 性能与可观测性

Collector 热路径优化包括：

- ProcessKey、cgroup、workload 和 negative/tombstone cache；
- 避免常规逐事件 `/proc` 遍历；
- exact ToolExec dedup；
- discovery budget；
- priority buckets；
- persistent HTTP connection；
- bounded queue；
- adaptive batching；
- 结构化 heartbeat metrics。

本次提交前记录的 filter-core 基准：

```text
events:       60,000
throughput:   439,068 events/s
p50 latency:  1.40 μs
p95 latency:  5.21 μs
p99 latency:  7.44 μs
RSS growth:   5.85 MiB
```

该数字只覆盖过滤核心，不包含 Observer 内核采集、HTTP、ClickHouse、Sentry 研判或页面请求。

主要可观测指标：

```text
events_observed_total
events_forwarded_total
events_filtered_total
events_sampled_total
events_deduplicated_total
identity_cache_hits_total
identity_cache_misses_total
identity_snapshot_version
identity_snapshot_age_seconds
identity_resolution_errors_total
queue_depth
batch_size
output_drops_total
filteredNonAgent
wouldFilterNonAgent
```

## 测试与验证

### 当前提交已验证

- [x] `pnpm --filter @anysentry/api exec tsc --noEmit`
- [x] `pnpm --filter @anysentry/web exec tsc --noEmit`
- [x] `pnpm -r build`
- [x] `pnpm verify:contracts:local`
- [x] `pnpm verify:identity-judgment-routing`
- [x] `pnpm verify:l2-code-judge`
- [x] `pnpm verify:identity-review-agent`
- [x] `pnpm verify:runtime-model-pubsub`（隔离 Redis）
- [x] `pnpm verify:l2-runtime`（隔离 Redis/ClickHouse + 本地 OpenAI-compatible mock，验证异步 L2 worker）
- [x] `pnpm verify:streaming-phase1:local`
- [x] `pnpm verify:streaming-phase2:local`
- [x] `pnpm verify:supply-chain:local`
- [x] `pnpm verify:l3-agent-pool:local`
- [x] `pnpm verify:real-agent-discovery-chain:local`
- [x] `pnpm perf:agent-filter`
- [x] `pnpm verify:deployment-manifests`
- [x] `pnpm install --frozen-lockfile --offline`
- [x] `docker compose -f examples/agent-runtime-lab/compose.yaml config --quiet`
- [x] `npm ci --ignore-scripts --dry-run`（agent-runtime-lab）
- [x] `docker build -f streaming/flink/Dockerfile streaming/flink`（容器内 Maven package/test）
- [x] `git diff --check`
- [x] `docker build -f Dockerfile .`
- [x] 历史 GitHub Actions CI #137：`build` 与 `docker` 均通过
- [ ] 当前 Draft PR GitHub Actions：创建 PR 后由 GitHub 生成最终检查记录

CI 地址：<https://github.com/A3S-Lab/AnySentry/actions/runs/30802065349>

### 分阶段功能验证脚本

本分支新增并在开发阶段用于验证：

```bash
pnpm verify:agent-templates
pnpm verify:docker-discovery
pnpm verify:behavior-discovery
pnpm verify:filter-pipeline
pnpm verify:priority-queue
pnpm verify:kube-identity
pnpm verify:forwarder-attribution
pnpm verify:agent-review
pnpm verify:agent-asset-model
pnpm verify:agent-identity-ui
pnpm verify:event-visibility
pnpm verify:identity-judgment-routing
pnpm verify:identity-routing-runtime
pnpm verify:identity-review-agent
pnpm verify:identity-review-runtime
pnpm verify:l2-code-judge
pnpm verify:l2-runtime
pnpm verify:policy-connectivity
pnpm verify:runtime-model-pubsub
pnpm verify:real-agent-discovery-chain:local
pnpm perf:agent-filter
```

### 建议合并前复跑

由于 PR 跨越 Collector、API、ClickHouse、Kafka/Flink、模型 worker 和前端，建议在干净环境执行：

```bash
pnpm install --frozen-lockfile
pnpm verify:contracts:local
pnpm verify:identity-judgment-routing
pnpm verify:agent-asset-model
pnpm verify:real-agent-discovery-chain:local
pnpm verify:streaming-phase1:local
pnpm verify:streaming-phase2:local
pnpm perf:agent-filter
docker compose --profile streaming build
```

实时模型测试依赖外部供应商可用性和有效凭据，不作为无凭据 CI 的硬前置条件。无模型或模型不可用时，系统必须保留 L1 并将 L2/L3/AI 辅助审核明确显示为 unavailable/failed，不能伪造成功结果。

## 审阅指南

建议按以下顺序审阅：

1. **语义和边界**
   - `docs/agent-discovery-filter.md`
   - `docs/agent-identity-review-ui-design.md`
   - `docs/identity-aware-judgment-and-ai-review-design.md`

2. **Collector 热路径**
   - `scripts/observer-forward.js`
   - `scripts/observer-workload-filter.js`
   - `scripts/observer-agent-attribution.js`
   - `scripts/observer-behavior-discovery.js`
   - `scripts/observer-priority-queue.js`

3. **稳定身份和规范资产**
   - `apps/api/src/security-monitoring/agent-identity.ts`
   - `apps/api/src/security-monitoring/agent-metadata.service.ts`
   - `apps/api/src/security-monitoring/identity-evidence.service.ts`
   - `apps/api/src/security-monitoring/kube-identity.service.ts`

4. **保留、可见性和研判路由**
   - `apps/api/src/security-monitoring/event-visibility.ts`
   - `apps/api/src/security-monitoring/identity-judgment-routing.ts`
   - `apps/api/src/security-monitoring/worker-main.ts`
   - `apps/api/src/security-monitoring/sentry-judge.service.ts`

5. **模型与只读 AI 审核**
   - `apps/api/src/security-monitoring/runtime-model-config.ts`
   - `apps/api/src/security-monitoring/judgment-connectivity.ts`
   - `apps/api/src/security-monitoring/l2-code-judge.ts`
   - `apps/api/src/security-monitoring/identity-review-agent.service.ts`

6. **前端交互**
   - `apps/web/src/components/custom/agent-identity.tsx`
   - `apps/web/src/components/custom/identity-ai-review.tsx`
   - `apps/web/src/pages/AgentsPage.tsx`
   - `apps/web/src/pages/AgentEventsPage.tsx`
   - `apps/web/src/pages/SecurityMonitorPage.tsx`
   - `apps/web/src/pages/PolicyConfigPage.tsx`

7. **部署与回归**
   - `deploy/observer.yaml`
   - `deploy/anysentry.yaml`
   - `docker-compose.yml`
   - `package.json` 中新增 verifier

## 跨仓库依赖与合并顺序

### Sentry

发布版本：Rust/Linux `v0.8.0`，TypeScript SDK `@a3s-lab/sentry@0.3.0`

该分支提供 staged L1 judgment SDK，使 Unknown 和 Candidate-L1-only 能只执行 L1，并由调用计数证明不会触发 L2/L3。

合并前置已经完成：Sentry staged L1 SDK 已合并并发布，AnySentry 正式依赖及
`pnpm-lock.yaml` 已锁定 `@a3s-lab/sentry@0.3.0`。生产安装、Docker 构建和 CI 不依赖
本地源码覆盖。

本仓库提供 `scripts/prepare-local-sentry-sdk.sh` 和 `docker-compose.local-source.yml`，可在 publish 前使用相邻 Sentry 源码进行联调。

### Observer

关联交付：`A3S-Lab/Observer` PR #11 已审批

该分支提供稳定 process/cgroup/boot/start-time facts 和 Collector 侧性能改进。AnySentry 对旧 Observer 数据保持兼容并 fail-open，但要获得完整的 PID reuse 安全、直接 cgroup 绑定和真实链路性能，需要部署对应 Observer 版本。

## 向后兼容与迁移

- 无破坏性 ClickHouse 数据迁移；历史事件不重写。
- Agent metadata v1 仍可读，服务会幂等生成并列 v2 规范注册表。
- 旧 Agent ID 和深链接通过 alias 解析。
- 旧 Collector 缺少稳定身份字段时保持 Unknown，不错误继承身份。
- `FORWARD_SCOPE` 保留兼容映射，但新部署应使用独立 filter/retention/noise 参数。
- 不配置 Redis 或模型时，L1 仍工作；高阶研判明确降级为 unavailable。
- 不配置用户模板时，平台元数据和行为发现仍可工作。
- 关闭行为发现或内置 Agent hints 不影响用户模板和人工裁决。

## 风险与缓解措施

### 1. 大型 PR 审阅风险

缓解：按设计、Collector、资产、研判、模型、UI、部署七个模块拆分审阅；提交历史已经按阶段保留。

### 2. 误过滤 Unknown/Agent

缓解：Unknown 默认保留；快照错误和身份冲突 fail-open；先使用 `shadow` 检查 would-filter；Candidate/Confirmed 不因常规身份策略被丢弃。

### 3. 人工误判 Non-Agent 后停止采集

缓解：只绑定稳定身份；Candidate/Confirmed 不能一步进入 Non-Agent；保留审计和抑制计数；支持重新纳入观察。

### 4. Kubernetes RBAC 扩大

缓解：权限只包含 Pod metadata get/list/watch；可改为 namespaced Role；文档明确完整名称解析与最小权限之间的权衡。

### 5. 模型凭据泄露

缓解：UI key 只在测试和显式 apply 期间进入后端；内存和 Redis Pub/Sub 热分发；不持久化、不返回、不写日志；环境变量作为 Secret 管理。

### 6. 外部模型不可用

缓解：L1 独立可用；连接测试返回经过裁剪的认证/限流/超时/网络/响应错误；未配置或失败不会显示虚假 L2/L3 成功。

### 7. 同名 Agent 或改名导致证据断链

缓解：所有关联使用 `agentAssetId`、实例和物理工作负载键；名称仅在查询时解析；Flink keyed state 不随名称改变。

### 8. Collector 压力和积压

缓解：有界优先级队列、批量发送、persistent connection、预算、采样和结构化 drop counters；高价值安全信号优先。

## 发布建议

### 阶段 1：只观测

```text
FORWARD_FILTER_MODE=shadow
FORWARD_RETAIN_UNKNOWN=true
FORWARD_RETAIN_NON_AGENT=true
FORWARD_NOISE_POLICY=include
```

比较 observed、forwarded、would-filter、unknown、cache miss、snapshot age 和 drop 指标。

### 阶段 2：启用常规噪声策略

```text
FORWARD_FILTER_MODE=shadow
FORWARD_NOISE_POLICY=balanced
```

确认 `/proc`、`/sys`、`/run`、`/dev` 常规 FileAccess 降噪不会影响生命周期和高价值风险证据。

### 阶段 3：启用 Non-Agent 抑制

```text
FORWARD_FILTER_MODE=enforce
FORWARD_RETAIN_UNKNOWN=true
FORWARD_RETAIN_NON_AGENT=false
FORWARD_NOISE_POLICY=balanced
```

只对已经审核或权威配置的稳定 Non-Agent 身份停止后续常规事件。

### 阶段 4：启用模型

1. 先配置并测试快速研判模型；
2. 观察 Candidate full/L1-only 和 Unknown L1-only 路由；
3. 再独立配置深度研判模型；
4. 检查 fast-judge、L3 worker 的 runtime profile version 和 Redis Pub/Sub 同步状态；
5. 最后启用 AI 身份辅助审核。

## 回滚方案

不需要删除历史数据即可回滚：

1. Collector 切换为 `FORWARD_FILTER_MODE=shadow`，停止实际过滤。
2. 设置 `FORWARD_RETAIN_NON_AGENT=true`，恢复 Non-Agent 常规事件转发。
3. 设置 `FORWARD_NOISE_POLICY=include`，恢复完整噪声观测。
4. 设置 Candidate pipeline 为 `l1_only`，停止 Candidate 高阶模型调用。
5. 清除 fast/deep runtime model connection，保留 L1。
6. 关闭 `ANYSENTRY_BEHAVIOR_DISCOVERY` 或内置 Agent hints，保留模板和人工身份。
7. 回滚应用镜像；历史 ClickHouse 事件和原始 attribution 不需要回写。

## 已知限制与后续工作

- `session-*.scope` 内多个 Agent/终端的细粒度 HostProcessTreeKey 拆分尚未完整落地；当前只将 session 作为环境标签并避免把它当作可信主名称。
- 共享进程/cgroup 中的多个逻辑 Agent 仍需要 trace/run/OTel application context 才能做 invocation-level attribution。
- 独立 containerd/CRI 和专有平台 adapter 仍是后续工作；当前 Kubernetes 通过 Pod/container metadata 和 cgroup/Container ID 解析。
- 可选的 observation-only eBPF prefilter 未启用，必须在长期 shadow 和误过滤评估后单独设计。
- 生产功耗、长时间 soak、超大规模 Kubernetes watch 和模型供应商故障注入需要在目标环境继续验证。
- `pnpm audit --prod --audit-level high` 仍报告仓库 `origin/main` 已存在的 14 条依赖公告（1 critical、6 high、6 moderate、1 low），涉及 VisActor 间接依赖的 `minimist`、Nest/Express 链路的 `multer`/`path-to-regexp` 和 React Router。对应版本在 `origin/main` 锁文件中已经存在，本 PR 新增的 `@a3s-lab/sentry@0.3.0` 不引入这些路径；考虑到修复涉及 UI/Nest/Router 升级与兼容性验证，建议单独建立依赖安全升级 PR，不能通过高风险 override 混入本大型功能 PR。
- GitHub Actions 仍提示 `actions/checkout@v4`、`actions/setup-node@v4` 的 Node 20 action runtime 弃用警告；当前 job 已成功，该警告不属于本功能逻辑失败，建议在独立 CI 维护 PR 中升级 action major 版本。

## 当前合并状态

- 最新 `origin/main` 已合并到本分支，包含 PR #4 的 Flink/OSV 流式能力。
- `@a3s-lab/sentry` 已从 `0.2.0` 升级并锁定为已发布的 `0.3.0`。
- 本地与远端测试结果及最终提交 SHA 将以实际 Draft PR 检查记录为准。
- 本 PR 稿随功能分支保存，作为大型跨模块变更的人工审阅导航，不参与运行时。

## Checklist

### 功能

- [x] 用户模板覆盖 Kubernetes、Docker、host。
- [x] 无模板行为发现只能生成 Candidate，不自动 Confirm。
- [x] Unknown 默认保留并可检索。
- [x] Non-Agent 后续常规事件可在 Collector 侧抑制。
- [x] Confirmed/Candidate/Unknown 使用独立研判路由。
- [x] 唯一 Agent 资产和 alias 兼容。
- [x] 人工审核状态机和审计记录。
- [x] displayName 不修改历史证据和流式关联键。
- [x] L2/L3 独立模型连接和热更新。
- [x] 只读 AI 身份辅助审核。
- [x] 首页 Agent 资产视角和时间窗视角。
- [x] 事件与资产双向深链接。

### 安全

- [x] observation-only，不增加内核阻断。
- [x] 模型 key 不持久化到业务存储。
- [x] AI reviewer 默认拒绝写入、shell、进程/工作负载控制。
- [x] Unknown/身份冲突 fail-open。
- [x] Non-Agent 抑制绑定稳定身份。
- [x] Kubernetes RBAC 限定为 Pod metadata read-only。

### 质量

- [x] API typecheck。
- [x] Web typecheck。
- [x] API/Web build。
- [x] Docker build。
- [x] 完整 contracts 与分阶段身份/研判 verifier。
- [x] Deployment manifest verifier。
- [x] 干净 Docker 生产镜像构建。
- [x] 真实 Host/Docker/Kubernetes Observer 链路。
- [x] Streaming phase 1/2、Flink 容器构建及 L3 pool。
- [x] 隔离运行时模型 Pub/Sub 与异步 L2 worker 链路。
- [ ] 当前 Draft PR GitHub Actions build/docker（PR 创建后等待）。
- [x] Sentry staged SDK 已按顺序发布为 npm `0.3.0`。
- [x] Observer 对应 PR 已审批；部署时仍需保证 probe/collector 使用匹配版本。

## Reviewer 重点问题

请重点确认：

1. Unknown 默认保留、仅 L1 的成本和合规语义是否符合生产预期。
2. Candidate 默认 full、可切换 L1-only 的策略是否需要按环境覆盖。
3. Cluster-wide Pod metadata read-only 权限是否符合目标集群安全基线。
4. Non-Agent 人工状态机是否足以防止误停采集。
5. L2/L3 凭据的内存 + Redis Pub/Sub 生命周期是否符合部署和灾备要求。
6. Sentry、Observer 与 AnySentry 三个分支的合并和发布顺序是否已安排。
7. 首次上线是否强制经过 shadow 观测窗口，以及所需的误过滤率、Unknown 比例和队列丢弃阈值。
