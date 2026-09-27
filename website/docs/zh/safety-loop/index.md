# 从真实运行证据到可审计治理动作

AnySentry 的核心不是单独的探针、规则引擎或大模型，而是一条连续、可回溯的控制链。每个结论都应能回答三个问题：系统实际发生了什么、为什么被判为风险、谁依据哪一版策略采取了什么动作。

## 01 · Capture：获取系统事实

在支持的 Linux 节点上，`a3s-observer` 可以在不修改 Agent 代码的情况下获取进程、工具、文件、网络与 DNS 等行为。已有系统也可以通过 Observer NDJSON、普通 JSON、CloudEvents、OTLP/HTTP JSON 或 Agent 原生 API 发送事件。

采集只说明“看到了什么”，不会把每一条遥测都伪装成安全告警。

## 02 · Normalize：形成规范证据

进入 AnySentry 的信号被统一为 `anysentry.agent_event.v1`，并补充可用的 Source、Agent、Workspace、Session、Run、Trace 与事件分类字段。敏感字段在存储或返回前执行 key-aware 脱敏。

身份置信度和原始事件事实彼此独立：未知工作负载仍可查询并进入 L1，不会因为缺少友好名称就消失。

## 03 · Decide：按风险分层研判

| 层级     | 当前状态 | 职责                                         |
| -------- | -------- | -------------------------------------------- |
| L1 Rules | 默认启用 | 低延迟、确定性地识别明确风险并返回可执行结果 |
| L2 LLM   | 可选配置 | 对单次事件补充语义判断、理由和不确定性       |
| L3 Agent | 可选配置 | 在 L2 未解决时使用受限只读工具进行更深调查   |

L3 不会仅因严重等级而自动触发；模型后端、策略和预算都必须显式配置。模型输出是带来源的研判结果，不会覆盖原始事实。

## 04 · Operate：把结论变成有据可查的动作

同一证据可以驱动 Dashboard、Incident、Alert、拓扑、Evidence Bundle、通知、处置任务和 Progressive API。运行时评估返回 `allow`、`warn`、`require_approval` 或 `block`，同时附带 `eventId`、严重度、风险分类、理由和研判层级。

调用方是否执行审批或阻断仍是明确的信任边界。AnySentry 不会把“给出阻断建议”描述成“已经强制阻断”。

## 一次完整链路

```text
ToolExec: curl 169.254.169.254/latest/meta-data
  → capture: observer / agent API
  → normalize: agent + workspace + session + redaction
  → decide: L1 / critical / systemic_risk
  → action: require_approval
  → evidence: eventId → timeline → Evidence Bundle → audit
```

这条链路是首页动画的事实来源，也可以用[快速开始](/guide/)中的请求在本地复现。

## 从审查到执行前控制

运行时审查和执行前控制不是彼此割裂的产品功能。它们共享身份、事件、作用域、策略版本和审批记录：

1. 真实行为进入规范证据；
2. L1、L2、L3 完成分层研判；
3. 系统生成带来源、条件和作用域的候选规则；
4. 人工确认风险、规则与生效范围；
5. 规则进入 Runtime Guard；
6. 相似动作再次出现时，在执行前返回允许、警告、审批或阻断；
7. 判断和执行结果继续写回审计，成为下一轮治理依据。

这条闭环既可以从已发生行为中形成控制，也可以由组织直接配置明确策略。任何自动生成内容都保留来源、版本和回滚依据。
