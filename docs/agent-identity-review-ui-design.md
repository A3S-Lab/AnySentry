# Agent 身份审核、资产聚合与 UI 展示设计

状态：实现基线  
适用分支：`feat/agent-discovery-filter`  
上位设计：`../AnySentry-Agent-Discovery-High-Performance-Design.md`、`docs/agent-discovery-filter.md`

## 1. 目的

本文把 Agent 自动发现、四分类、人工身份审核、可变显示名、运行链路和智能体资产页面统一成一套可实现、可审计、可高性能运行的产品语义。

系统必须同时满足：

1. 保留现有模板、平台身份、进程图和行为分析算法，不用人工结论覆盖原始检测证据。
2. 运行链路保留单条 Agent 事件，便于从一次具体操作回查完整证据。
3. 智能体资产将同一 Agent 的事件、实例、时间和风险聚合展示。
4. 用户可以修改显示名，但不得改写历史事件中的原始 Agent 名称、进程、工作负载或归因证据。
5. 明确的非 Agent 身份在 Collector 热路径丢弃后续常规事件，避免无价值数据进入 ClickHouse。
6. 所有人工结论可审计；误判可恢复；稳定身份冲突时 fail-open。
7. UI 用审核人员能直接理解的措辞表达状态和动作，不暴露不必要的内部术语。

## 2. 不变量

以下约束优先于任何页面便利性：

- `displayName` 只影响查询时展示和搜索，不参与事件关联、Flink keyed state、身份缓存键或历史证据哈希。
- 采集时名称、原始 `agentId`、进程信息、工作负载信息和归因 evidence 不可由改名操作覆盖。
- 人工裁决与算法分类分开保存。
- `non_agent` 抑制必须绑定稳定身份，不得只按名称、线程名、短 PID 或共享 `session-*.scope` 执行。
- 已进入 ClickHouse 的事件永不因后续人工裁决删除。
- `non_agent` 的原始常规事件可以不进入 ClickHouse，但裁决记录、身份绑定、审计日志和轻量抑制统计必须保留。
- 同一稳定身份被多条相互冲突的人工记录认领时不得任意选取，必须 fail-open 回到自动分类。
- 行为负向证据可以让候选提前回到 Unknown，但不能自动生成等同人工排除的永久 `non_agent`。
- Agent 资产只有一个唯一 `agentAssetId`。人工审核只向这个底层观测资产追加分类、显示名、负责人和说明，不得创建第二条“人工 Agent”。
- `workspacePath`、原始 `agentId` 和容器名称是观测及展示字段，不得与 `agentAssetId` 组合成第二个资产主键。

### 2.1 唯一资产与兼容迁移

- 内部元数据以 `agentAssetId` 为主键；`workspacePath + agentId` 只保留为旧数据查找索引。
- 对缺少 `agentAssetId` 的旧记录，优先从 `physicalWorkloadId`、`agentInstanceId`、Pod UID 和稳定身份键推导规范资产 ID。
- 同一规范资产的事件与人工元数据只生成一个资产项，人工审核状态在查询时覆盖分类，但不生成 metadata-only 重复资产。
- 旧算法生成的资产 ID 保存在 `agentAssetAliases` 中，旧深链接解析后跳转到规范资产。
- ClickHouse 配置以 `anysentry.agent_metadata.v2` 包装格式写入，同时保留并兼容读取旧 `agent_metadata`；历史事件不迁移、不改写。
- 服务加载 v1 元数据后会幂等写入并列的 v2 规范注册表；没有 `agentAssetId` 或稳定观测身份的新审核请求会被拒绝，避免审核接口凭空创建资产。

## 3. 分类、裁决和最终状态

### 3.1 四分类

后端保留明确的四分类：

| 内部值 | UI 名称 | 语义 |
|---|---|---|
| `confirmed_agent` | 已确认 Agent | 可信平台声明、强身份锚点或人工确认 |
| `probable_agent` | 候选 Agent | 多条非权威证据达到行为或模板阈值 |
| `unknown` | 尚未识别 | 证据不足、身份暂不可用或人工要求重新观察 |
| `non_agent` | 已排除 | 权威基础设施规则或人工明确判定不是 Agent |

页面不得把 `unknown` 描述成“候选 Agent”，也不得把 Candidate 的“降为未知”描述成“判定非 Agent”。

### 3.2 三层状态

每个身份分别保留：

```text
detectedClassification  自动算法/规则的原始分类
reviewDecision          人工覆盖结论
effectiveClassification 页面、资产聚合和 Collector 路由使用的最终分类
```

有效分类按以下优先级解析：

1. 无冲突且未过期的人工裁决；
2. 用户模板或可信平台身份；
3. 现有进程图、签名和行为分析结果；
4. `unknown`。

清除人工裁决后，`effectiveClassification` 立即回到当前自动检测结果，而不是固定回到之前某个状态。

### 3.3 人工状态机

```text
probable_agent
  ├─ 确认是 Agent ────────> confirmed_agent
  └─ 证据不足，降为未知 ──> unknown

unknown
  ├─ 确认是 Agent ────────> confirmed_agent
  └─ 标记为非 Agent ──────> non_agent

confirmed_agent
  └─ 撤销确认，重新观察 ──> unknown

non_agent
  └─ 重新纳入观察 ────────> unknown
```

不支持 Candidate 一次点击直接进入 `non_agent`，也不支持 Confirmed 一次点击直接进入 `non_agent`。这两个约束用两步审核降低误停采集风险。

### 3.4 UI 动作措辞

| 当前状态 | 主操作 | 次操作 | 说明 |
|---|---|---|---|
| 候选 Agent | 确认是 Agent | 证据不足，降为未知 | 次操作继续采集，允许行为算法再次发现 |
| 尚未识别 | 确认是 Agent | 标记为非 Agent | 次操作在稳定身份命中后停止常规事件入库 |
| 已确认 Agent | 撤销确认，重新观察 | 无 | 不直接提供“非 Agent” |
| 已排除 | 重新纳入观察 | 无 | 仅在已排除身份管理入口展示 |

二次确认使用页面内嵌确认条，不能使用浏览器原生弹窗。

## 4. 数据保留和采集路由

### 4.1 页面与存储矩阵

| 有效分类 | 首页 Agent 运行链路 | 智能体资产 | 高级事件检索 | 新常规事件进 ClickHouse |
|---|---:|---:|---:|---:|
| 已确认 Agent | 是 | 是 | 是 | 是 |
| 候选 Agent | 是 | 是 | 是 | 是，受现有预算和去重控制 |
| 尚未识别 | 否 | 否 | 是 | 是，受 discovery budget 控制 |
| 已排除 | 否 | 否 | 可查历史 | 否 |

生命周期和高价值安全信号继续遵循上位 Filter 设计中的 fail-open 规则。手工 `non_agent` 对稳定身份的常规事件执行热路径抑制；Collector 仍报告聚合计数，不发送原始负载。

### 4.2 轻量抑制统计

每个 Collector 至少保留以下累计计数：

```text
filteredNonAgent
wouldFilterNonAgent
lastSuppressedAt
identitySnapshotVersion
identitySnapshotAgeSeconds
```

可选按有界 top-N 身份维护：

```text
identityKeyHash
suppressedEventCount
lastSuppressedAt
eventKindCounts
reviewVersion
```

不得在抑制统计中复制命令、文件路径或网络负载。热路径使用计数器和有界 Map，不能产生无界高基数字段。

## 5. 稳定身份

### 5.1 本地进程

```text
hostId + bootId + rootPid + rootStartTime + rootExecutable
```

在根进程事实不完整时保持 Unknown 或使用短 TTL 的弱绑定；不得只用 PID。

`session-*.scope` 是运行环境标签，不是 Agent 主名称或唯一资产键。共享 SSH session 内的不同根进程应在身份足够时拆分。

### 5.2 Docker

```text
hostId + fullContainerId
```

容器名和镜像用于展示及证据，不作为唯一抑制键。

### 5.3 Kubernetes

```text
cluster/environment + podUid + containerName/fullContainerId
```

Pod 名称用于展示；Pod UID 和完整 Container ID 用于实例身份。新 Pod 或新 Container 默认重新进入自动分类，除非用户明确配置逻辑资产级持续策略。

### 5.4 冲突

稳定身份键同时命中多个不同人工结论时：

- 不应用任何一个人工结论；
- 保留自动分类；
- 在审核页提示“身份绑定冲突”；
- Collector 不执行 non-Agent 抑制；
- 审计记录必须能定位冲突的两条元数据记录。

## 6. 名称模型

### 6.1 字段

```text
displayName       用户可修改的当前展示名
detectedName      采集或检测时名称，不可由改名覆盖
rawAgentId        Observer/事件原始执行者，不可修改
agentAssetId      稳定资产键，不随改名变化
agentInstanceId   一次具体运行实例
```

在完整 `agentAssetId` 落地前，现有 `workspacePath + agentId` 继续作为兼容键；新增解析逻辑不得改变历史事件结构。

### 6.2 名称优先级

列表主名称：

```text
displayName
  -> detectedName / attribution.agentDisplayName
  -> Pod 名
  -> Container 名
  -> systemd unit / process / executable basename
  -> rawAgentId
  -> 候选 Agent
```

详情页同时展示：

```text
当前显示名
采集时名称
原始执行者
```

改名只更新 `displayName` 和名称变更审计。历史事件、Flink 关联键和身份绑定不更新。

## 7. 统一两行 Agent 身份组件

页面保留现有视觉结构，统一复用 Agent Identity 组件。

### 7.1 Compact：运行链路

```text
安全研发 Codex                         [本地服务]
security/AnySentry · PID 4058085
```

- 主名称颜色表示有效分类：已确认使用绿色，候选使用琥珀色。
- 运行环境使用小标签：`K8s`、`Docker`、`本地服务`。
- 第二行是定位信息，不把 workspace 拼进名称。
- Candidate 在需要明确状态的区域显示“候选 Agent”，不能显示 `probable_agent`。

### 7.2 Card：智能体资产

```text
安全研发 Codex                         [本地服务]
security/AnySentry · 4 个运行实例
```

卡片摘要至少包含：

- 首次发现、最近活动和活跃跨度；
- 总事件、风险事件、会话和运行实例数；
- 当前最高风险；
- 自动分类来源或人工结论。

### 7.3 Detail：事件/资产详情

```text
安全研发 Codex                    [已确认 Agent] [本地服务]
security/AnySentry · PID 4058085
采集时名称 codex · 原始执行者 tokio-rt-worker
```

完整路径、Pod UID、Container ID、cgroup、session scope 和证据仅在详情或悬浮提示中展示。

### 7.4 定位信息优先级

Kubernetes：

```text
namespace/pod/container
```

Docker：

```text
containerName · workspace短名或containerId短值
```

本地：

```text
workspace短名 · Root PID
```

无 workspace 时：

```text
executable basename · Root PID
```

列表路径使用末尾一至两段；完整路径保留在 `title` 和详情。

## 8. 页面信息架构

### 8.1 首页运行链路

- “Agent 事件”只展示有效分类为已确认或候选的单条记录。
- “全部事件”继续保留原始检索能力，允许查看 Unknown。
- 每条事件继续展示事件类型、命令/主题、时间、风险和 L1/L2/L3 状态。
- 点击“详情”进入事件检索页并保留现有过滤上下文。
- 身份块增加资产跳转，但不能用可变名称作为路由键。

### 8.2 智能体资产

只聚合：

```text
confirmed_agent
probable_agent
```

默认排序：

```text
classificationPriority ASC
riskPriority DESC
lastSeen DESC
riskyEventCount DESC
displayName ASC
```

其中已确认优先级高于候选。页面使用“已确认 Agent”和“候选 Agent”轻量分区，保留现有列表与详情布局。

Unknown 和 Non-agent 不得作为 metadata-only 伪资产重新混入主列表。已排除身份通过独立、低频管理入口恢复。

### 8.3 事件详情

保留现有左侧历史运行记录和证据详情，增加：

- 统一 Detail 身份头；
- 当前显示名、采集时名称、原始执行者；
- 查看 Agent 资产；
- 来源事件和资产之间的双向跳转；
- 人工分类与自动分类的并列展示。

### 8.4 人工审核

审核卡只显示当前状态允许的动作。显示名配置继续位于默认折叠的“身份信息配置”，不和高频审核按钮混在一起。

状态改变后的行为：

- Candidate 确认：移动到已确认分区；
- Candidate 降为未知：从资产页和 Agent 事件默认视图移除，但继续采集；
- Unknown 确认：进入已确认分区；
- Unknown 标记非 Agent：停止稳定身份的后续常规事件入库；
- Confirmed 撤销：进入 Unknown 并重新执行自动发现；
- Non-agent 恢复：进入 Unknown 并重新采集。

## 9. 查询时显示名解析

历史事件不更新。所有业务 DTO 在返回前通过统一 resolver 补充当前显示身份：

```text
agentDisplayName
agentDetectedName
rawAgentId
locationLabel
runtime
```

解析先按稳定身份键匹配元数据，兼容期再按 `workspacePath + agentId` 回退。resolver 必须是纯函数或 O(1) Map 查询，不能在事件列表循环中逐条访问 ClickHouse。

应用范围：

- 首页运行链路；
- 事件列表和详情；
- 智能体资产；
- 告警、Incident、处置和证据包；
- Flink risk profile/composite judgment 的查询展示；
- 搜索索引。

Flink `agentCorrelationId` 和窗口状态保持不变。显示名在 API 查询阶段解析，不重放 Kafka，不重建 Flink state。

## 10. API 与兼容性

### 10.1 审核请求

请求保留稳定身份字段，并增加显式目标：

```text
decision:
  confirmed_agent
  unknown
  non_agent
  clear
```

服务端校验允许的状态转换，不能只依赖前端隐藏按钮。

`unknown` 表示人工要求重新观察，并保留一条人工审核记录；`clear` 表示清除人工覆盖、恢复自动分类。为兼容旧客户端，`clear` 继续接受。

### 10.2 资产与事件响应

兼容新增：

```text
detectedClassification
effectiveClassification
detectedName
displayName
locationLabel
runtime
instanceCount
```

旧字段在迁移期继续返回，前端优先使用新字段。

## 11. 高性能编码原则

实现遵循以下工程原则：

1. **单一事实源**：分类优先级、状态转换、名称解析和定位信息各有一个共享实现。
2. **不可变证据**：展示覆盖不回写事件；状态迁移追加审计而不是修改历史事实。
3. **显式状态机**：后端集中校验合法转换，拒绝非法状态跳转。
4. **O(1) 热路径**：Collector 使用版本化身份快照、预归一化键和 Map 查询；不在逐事件路径访问网络、磁盘或正则扫描全量配置。
5. **有界内存**：缓存、抑制统计、名称历史和审计都有上限、TTL 或 top-N 策略。
6. **批量解析**：API 构造一次元数据索引后批量装饰结果，避免 N+1 查询。
7. **Fail-open**：快照缺失、过期、冲突或身份不完整时继续观察，不误丢事件。
8. **向后兼容**：新增字段是 additive；旧 Collector、旧事件和旧元数据仍可读取。
9. **确定性排序**：分类、风险、时间和名称形成稳定排序，避免轮询刷新后列表跳动。
10. **可测试性**：状态机和 identity resolver 使用无副作用函数；运行时集成由现有验证脚本覆盖。
11. **可观测性**：过滤行为由结构化计数说明；不得只依赖日志字符串。
12. **最小权限与最小数据**：非 Agent 抑制统计不复制敏感事件负载。

## 12. 测试矩阵

### 12.1 状态机

- Candidate -> Confirmed；
- Candidate -> Unknown；
- Candidate 不能直接 -> Non-agent；
- Unknown -> Confirmed；
- Unknown -> Non-agent；
- Confirmed -> Unknown；
- Confirmed 不能直接 -> Non-agent；
- Non-agent -> Unknown；
- 冲突稳定身份 fail-open；
- displayName 更新不改变 classification。

### 12.2 UI

- 前端不显示内部值 `probable_agent`；
- Candidate 使用“候选 Agent”和“证据不足，降为未知”；
- Unknown 使用“尚未识别”和“标记为非 Agent”；
- Confirmed 只显示“撤销确认，重新观察”；
- 已排除入口显示“重新纳入观察”；
- 名称、运行标签和 location 两行显示；
- 同名 Agent 可由 workspace/Pod/Container/Root PID 区分；
- 资产页不包含 Unknown/Non-agent；
- 已确认始终排在候选之前；
- 运行链路 Agent scope 不包含 Unknown/Non-agent；
- 事件、资产双向跳转保留时间和来源事件。

### 12.3 Filter

- `all` 不过滤；
- `shadow` 只累计 would-filter；
- `agent` 丢弃稳定 `non_agent` 常规事件；
- Unknown 高价值事件 fail-open；
- 快照未就绪或冲突时 fail-open；
- Non-agent 恢复后事件重新转发；
- 抑制计数进入 Collector heartbeat；
- 性能验证不低于现有基线。

### 12.4 回归

- API 和 Web 构建；
- Agent review、identity UI、filter pipeline、forwarder attribution；
- Docker/Kubernetes discovery；
- behavior discovery；
- dashboard runtime；
- streaming phase 1/2；
- `perf:agent-filter`；
- Observer Rust 单元和集成测试。

## 13. 分阶段提交

1. 设计文档和状态/UI 词汇表；
2. 后端状态机、分类解析和资产聚合；
3. 前端统一身份组件、页面过滤排序和审核操作；
4. Collector non-Agent 抑制恢复与结构化统计；
5. 构建、全量回归、性能和真实链路修复。

每个阶段必须在本地功能分支提交；不得推送远程 `main`。
