# AnySentry 统一过滤规则系统实施验收报告

状态：通过

验收日期：2026-08-25

对应 PRD：[AnySentry 统一过滤规则系统与可视化平台 PRD](./anysentry-unified-filter-rule-system-prd.md)

## 一、验收结论

PRD Phase 0—5 已全部实现，并通过模块、单元、本地 API、仓库合同、真实 Kubernetes、真实 Rust Collector 和浏览器验收。

最终运行态结果：

| 项目 | 验收结果 |
|---|---:|
| 统一 Catalog | 99 条 |
| 迁移保留的 Infrastructure Rule | 60 条 |
| Agent Runtime Signature | 6 条 |
| Agent Template | 0 条，类别明确可见 |
| Catalog 分类 | 8 类 |
| F0 / F1 / F2 / F3 | 全部 ready |
| 真实历史 Simulation 样本 | 200 条 ClickHouse 事件 |
| 部署 Catalog P95 | 65.43 ms |
| 部署 Explain P95 | 109.56 ms |
| 2,000 规则本地 Catalog P95 | 7.51 ms |
| 2,000 规则本地 Explain P95 | 8.03 ms |
| 2,000 规则热路径候选数 | 1 条 |
| 浏览器运行异常 / 网络失败 | 0 / 0 |
| 390px 文档级横向溢出 | 0 |

最终不可变镜像：

| 工作负载 | Digest |
|---|---|
| API + Web | `127.0.0.1:5000/anysentry@sha256:ae04dc4e453b8fa2fdbd1acce1f71b07b51feb484ce75566568fb9e0a8e26cfb` |
| Observer + Forwarder + Rust Collector | `127.0.0.1:5000/anysentry-observer@sha256:4d6274da2d3005117d11a95b0eb4487456f82aacf324c496fb5936ce6e904911` |

API 最终镜像是完整构建镜像的增量 OCI 后继：依赖层来自同次通过测试的完整构建，后继层仅覆盖随后重新验证的 API/Web 编译产物。Observer 后继层保留同一 Rust Collector，仅覆盖经过测试的 Forwarder 脚本。

## 二、最终 High-level 运行链路

```text
规则定义与事实来源
  ├─ 内置 Agent Signature / Deployment Binding / Guardrail
  ├─ PostgreSQL Infrastructure Rule（保留原 ruleId/revision）
  ├─ 人工身份审核事实
  ├─ Unknown Learning recommendation-only candidate
  └─ Operator typed draft
                  │
                  ▼
        Unified Filter Rule Catalog
        ruleId / revision / lifecycle / audit
                  │
          validate / preview / compile
                  │
       ┌──────────┼───────────┬───────────┐
       ▼          ▼           ▼           ▼
   F0 View     F1 View      F2 View      F3 View
 identity     capture       semantic     persistence
 / role       profile       retention    retention
       │          │           │           │
       │      node materialize │           │
       │      preview → ACK     │           │
       │      → grant           │           │
       ▼          ▼           ▼           ▼
 可信身份/角色  Ring reserve 前  HTTP 前语义过滤  入库/研判路由
       │          │           │           │
       └──────────┴──── decision lineage ─┘
                              │
                              ▼
           Explain / Simulation / Audit / Metrics / UI
```

一次事件的实际处理顺序：

1. F0 从进程键、Runtime Signature、Template、Kubernetes/Docker Inventory、人工事实和认证 Adapter 解析身份与角色；F0 不授权 DROP。
2. F1 只接收编译后的 node-local Capture Profile。Collector 在 payload 构造与 Ring reserve 前执行 FULL/AGGREGATE/SAMPLE/DROP。
3. F2 使用完整事件语义、进程树、F0 分类和 F1 lineage 执行 KEEP/AGGREGATE/SAMPLE/SUPPRESS/PRIORITY。
4. F3 在可信 Source 校验和服务端身份覆盖之后执行 RETAIN_FULL/RETAIN_L1_ONLY/STRUCTURAL_CONSUME/DISCARD。
5. 页面 Explain 使用与运行时相同的 typed matcher、优先级和编译语义，展示 F0→F1→F2→F3 候选、获胜者和 fail-open 原因。

## 三、关键架构结果

### 3.1 一个逻辑控制面，不使用万能 JSON

统一的内容是：

- 一个 Rule Catalog 入口；
- 一个 ruleId/revision lineage；
- 一个 typed validator；
- 一个生命周期、审批与审计模型；
- 一个优先级和冲突模型；
- 一个 Explain/Simulation 模型；
- F0/F1/F2/F3 四种受限编译投影。

保留的 Infrastructure Service、人工审核和 Unknown Learning 是兼容事实/状态 adapter，不再形成第二个用户规则页面。旧文件、ConfigMap 和环境变量只作为 bootstrap/LKG，不是新规则的权威写入口。

### 3.2 逻辑版本与物理版本分离

系统分别维护 Catalog、identity、capture、forwarder、retention 和 node epoch。新增 `intentHash` 后：

- `contentHash` 校验包含 generatedAt/expiresAt 的完整传输内容；
- `intentHash` 只描述 F0/F1/F2 有效语义；
- TTL 续期改变 contentHash，但不触发规则重编译；
- F3-only 变化不触发 Forwarder 语义重载；
- Infrastructure materialization `stateVersion` 增长不推进 Catalog/domain version；
- 实测物化 stateVersion 增长 1 时，Catalog cursor 和四个 domain version 保持不变。

### 3.3 F0/F2 热路径索引

Typed exact/one-of matcher 在加载时编译为字段索引；无法安全索引的 present/prefix 规则进入有界 fallback bucket。2,000 条精确规则测试中：

- index bucket：2,000；
- 最大 bucket：1；
- 一次匹配候选：1；
- evaluator P95：0.038 ms。

Explain 保留全候选失败条件，用于按需解释；事件热路径使用索引候选，不扫描全部规则。

### 3.4 Rust Collector generation fence

真实 Kubernetes Observer rollout 记录了以下顺序：

```text
新 Collector 启动，无当前世代快照
  → discovery-safe capture
  → preview snapshot destructive=false
  → Collector ACK
  → central materialization acceptance
  → generation-bound grant
  → enforce snapshot destructive=true
```

真实进程加载 27/27 个探针。每次物理成员变化均重新经历 destructive=false → ACK/grant → destructive=true，没有沿用旧 Collector instance 的 destructive 权限。

## 四、功能需求逐条验收

### 4.1 P0：统一可视化与理解

| FR | 状态 | 实现/证据 |
|---|---|---|
| FR-001 | 通过 | 导航、标题和 canonical route 统一为“过滤规则” |
| FR-002 | 通过 | `/capture-rules` 保留 query/hash 并重定向 `/filter-rules` |
| FR-003 | 通过 | cursor Catalog API 聚合内置、Infrastructure、人工审核和学习候选 |
| FR-004 | 通过 | 每条规则展示 source、management、editable、authority、lifecycle |
| FR-005 | 通过 | 按类别、按阶段、按资产/信号三种 URL 可保持视角 |
| FR-006 | 通过 | 页面顶部展示 F0→F1→F2→F3 流程 |
| FR-007 | 通过 | 各阶段展示 mode、domain version、规则数、节点、漂移原因和损失 |
| FR-008 | 通过 | Runtime Signature、Template 0、K8s/Docker Label、认证 Adapter、人工绑定、Behavior Candidate 均在目录 |
| FR-009 | 通过 | Infrastructure、8 个 Capture Profile、F2、F3、5 个 Guardrail 均可见 |
| FR-010 | 通过 | 详情五个 Tab 与四阶段影响矩阵 |
| FR-011 | 通过 | eventId/assetId 服务端 Explain；资产页提供深链 |
| FR-012 | 通过 | 部署实测 60 条 Infrastructure rule 全部保留且 cursor 可枚举 |

### 4.2 P1：统一治理与编译

| FR | 状态 | 实现/证据 |
|---|---|---|
| FR-101 | 通过 | typed envelope、immutable revision、管理鉴权、独立批准、审计 |
| FR-102 | 通过 | 6 个 Signature 和 Template 进入 Catalog；Forwarder 从中央投影生成兼容文档 |
| FR-103 | 通过 | 8 个 Capture Profile 作为只读、版本化矩阵规则展示 |
| FR-104 | 通过 | F2 keep/aggregate/sample/suppress 迁入 typed semantic-retention；环境变量仅 bootstrap |
| FR-105 | 通过 | F3 full/L1/structural/discard 迁入 persistence-retention；Policy 页面标记兼容只读 |
| FR-106 | 通过 | 独立 identity/capture/forwarder/retention domain version 与 F0/F1/F2/F3 投影 |
| FR-107 | 通过 | F0/F1/F2 返回统一 Decision Receipt；F3 持久化低成本可信 lineage |
| FR-108 | 通过 | Draft、Preview、Simulation、shadow、promote、revoke 完整 API/UI |
| FR-109 | 通过 | 冲突、能力边界、Catalog/domain/fact/policy/epoch drift 检测 |
| FR-110 | 通过 | enforced 内容不可原地编辑；UI 创建带 predecessorRuleId 的 typed 后继草稿 |

### 4.3 P2：反馈闭环

| FR | 状态 | 实现/证据 |
|---|---|---|
| FR-201 | 通过 | Unknown Learning policy 映射到“学习候选”分类，内部目录上限 2,000 |
| FR-202 | 通过 | learning candidate 为 recommendation-only；禁止直接 authoritative DROP |
| FR-203 | 通过 | 资产审核页可进入全局 Explain、复用获胜规则或创建预选资产的安全草稿 |
| FR-204 | 通过 | 页面回流 stage/category/action 等低基数决策、抑制、聚合和丢失指标 |
| FR-205 | 通过 | Simulation 支持当前 Inventory、30m、3h、24h；历史最多 500 条并明确 partial/fallback |

## 五、安全不变量验收

| 不变量 | 结果 |
|---|---|
| Signature 最高只产生 probable_agent | 通过，validator/API adversarial test |
| Unknown authoritative DROP | 0，validator 与运行时 fail-open |
| Agent/Infrastructure 冲突 destructive DROP | 0，`fr_guardrail_agent_conflict_keep` 在 F1/F2/F3 获胜 |
| SecurityAction 被身份过滤 | 0，immutable FULL/PRIORITY/RETAIN_FULL |
| non-Agent Exec/Exit 直接丢弃 | 0，先 STRUCTURAL_CONSUME 更新 generation/tombstone |
| Regex/Glob/任意脚本进入 F1 | 拒绝 |
| destructive 未 ACK/grant 生效 | 0，真实 Collector rollout 验证 |
| 旧 Collector instance 继承 grant | 0，generation fence |
| 浏览器暴露 raw cgroup/grant/contentHash | 0，raw API 受管理鉴权且标准详情仅 human projection |
| enforced 原地覆盖 | 0，生命周期只新增 revision/后继规则 |

## 六、测试与证据

### 6.1 核心命令

```text
pnpm verify:unified-filter-rules
pnpm verify:unified-filter-rules:local
pnpm verify:governance-phase-a
pnpm verify:governance-phase-bc
pnpm verify:s5-capture-profile
pnpm verify:s8-unknown-learning
pnpm verify:observer-ingest:local
pnpm verify:forwarders:local
pnpm verify:contracts:local（分段复验后全部合同通过）
pnpm verify:unified-filter-rules:deployed
pnpm verify:unified-filter-rules:browser
```

### 6.2 Golden 与跨运行时

- TypeScript compiler → Node Forwarder golden fixture：通过；
- Node Forwarder → F1 v1 snapshot/ACK：通过；
- 真实 Rust Collector preview/ACK/grant/CaptureAggregate：通过；
- Kubernetes Collector restart generation fence：通过。

Golden fixture：`test/fixtures/unified-filter-rule-golden-v1.json`。

### 6.3 浏览器验收

浏览器自动化覆盖：

- 1440×1000 分类树 + 目录 + 详情；
- 1024×900 阶段视角；
- 390×844 目录与详情路由化；
- 五个 Tab 的 ArrowLeft/ArrowRight/Home/End 键盘模型；
- 中文和英文；
- `prefers-reduced-motion: reduce`；
- 页面和 body 横向溢出检查；
- JS runtime exception 与网络失败监测。

最终截图目录：`/tmp/anysentry-filter-rules-browser-1856193`。

## 七、最终运行态检查

最终 Kubernetes 工作负载：

- `deployment/anysentry`：1/1 ready；
- `daemonset/a3s-observer`：1/1 ready；
- ClickHouse：ready；
- PostgreSQL：ready；
- F0/F1/F2/F3：全部 ready；
- Forwarder 中央投影：6 signatures、0 templates、5 semantic rules；
- F1 当前 enforce、38 个有效物化规则、0 冲突；
- Ring、Forwarder queue 的物理丢失分别可见，最终 stage status `lost=0`。

至此，页面所表达的 High-level 流程与实际采集、投影、物化、过滤、入库和归因链一致。
