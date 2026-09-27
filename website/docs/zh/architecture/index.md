# 一条连接系统层与 Agent 层的证据平面

系统层知道机器上实际执行了什么；Agent 层知道任务、工具与会话意图。AnySentry 通过稳定身份、运行上下文和规范事件把两类事实连接起来，使安全运营与运行时决策引用同一份证据。

## 数据链路

```text
Linux / Kubernetes / Agent Runtime / Existing Telemetry
                         │
                         ▼
Capture → Normalize + Redact → Canonical Event Stream
                                      │
                      ┌───────────────┴───────────────┐
                      ▼                               ▼
               L1 / L2 / L3                     Evidence store
                      │                     hot ring + ClickHouse
                      └───────────────┬───────────────┘
                                      ▼
               Dashboard / Incident / Evidence Bundle / Guard API
```

## 主要层级

### L01 · 信号与执行点

`a3s-observer`、Kubernetes 元数据、Agent Runtime、Tool Gateway 与 OpenTelemetry 是事件来源。Observer 采集与调用方执行解耦：同一证据可以用于纯观测，也可以由显式接入的工具网关执行 guard 结果。

### L02 · 接入与规范化

接入层接受 Observer NDJSON、JSON、CloudEvents 和 OTLP/HTTP JSON。规范化层补充稳定字段、执行分类与 key-aware 脱敏，支持真实来源和显式标记的合成演示来源共存。

### L03 · 身份与上下文

Agent Asset 是稳定调查对象；Runtime Instance 记录 Pod、容器、进程树、Session、Run 与 Workspace。显示名可以变更，但不会成为历史关联键。行为发现可以生成候选身份，不能自行确认 Agent。

### L04 · 研判与时间关联

L1/L2/L3 对安全相关事件做分层判断。流式链路按稳定身份与事件时间组织 Episode、关系边和 finding；支撑遥测仍可查询，但不伪装成已判断风险。

### L05 · 安全运营与治理

Dashboard 从 Agent、事件、拓扑、Incident、Alert、Evidence Bundle、目标、通知、维护窗口、处置任务和审计记录观察同一控制面。Progressive API 为 Agent 提供 `list → describe → dry-run → execute` 的可发现接口。

## 核心数据关系

```text
Agent Asset (stable agent_id)
  ├── Runtime Instance (pod / container / process tree / session)
  │     └── Atomic Event (source-linked evidence)
  ├── Episode / Topology edge / Stream finding
  ├── Human identity decision
  ├── Incident / Alert / Evidence Bundle
  └── Policy decision / Remediation / Audit record
```

## 两种研判部署模式

| 模式 | 行为                                                            | 示例                |
| ---- | --------------------------------------------------------------- | ------------------- |
| 同步 | 没有队列时由 API 内联判断安全事件                               | Kubernetes 基础清单 |
| 异步 | API 将任务放入 Redis，由 fast-judge 与 L3 worker 处理已配置层级 | Docker Compose      |

L1 默认启用。L2 和 L3 必须分别配置模型连接与策略；两者不会因为 worker 存在就自动开启。

## 存储、性能与退化

- 当前读使用内存 hot ring；ClickHouse 提供持久分析与控制面存储。
- 未配置 ClickHouse 时服务仍可以内存模式运行，但重启后不保留状态。
- 采集与流式处理使用批量、背压、有界队列和显式 dropped 计数，避免无界状态。
- `/security-center/healthz` 报告 API 与存储状态，但不等价于 Redis 和每个 worker 的完整依赖就绪检查。

## 信任边界

零代码观察路径目前要求受支持的 Linux/amd64 节点、特权 eBPF 与主机可见性。管理认证默认关闭；暴露服务前必须配置 token、TLS 与网络控制。模型调查工具保持只读和有界；高影响动作仍由部署组织掌握审批与执行权限。
