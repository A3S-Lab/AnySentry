# 一条事件如何成为可追问的系统事实

AnySentry 使用稳定的 `eventId` 把原始信号、规范事件、研判结果、拓扑关系、Evidence Bundle、候选规则和审计记录连接起来。用户看到的风险不是脱离来源的红点，而是一条可以继续下钻的系统事实。

## Capture · 接收原始信号

Observer、Agent API、JSON、CloudEvents 或 OTLP 接收进程、工具、文件、网络、DNS、LLM 与安全动作。系统保留 Source、接收时间、原始事件标识和可用的进程上下文。

## Normalize · 建立身份与上下文

信号被归一为 `anysentry.agent_event.v1`，并绑定 Source、Agent、Workspace、Session、Run、Trace 与事件分类。敏感字段在存储或返回前执行 key-aware 脱敏。

## Decide · 保留分层判断

每一层研判记录自己的策略版本、判断、理由、延迟和是否需要继续升级。L2、L3 的结构化结论与原始事实并存，不覆盖 L1 或原始事件。

## Operate · 连接治理动作

判断沿 `eventId` 进入事件详情、拓扑、Incident、Alert、Evidence Bundle、候选规则、Runtime Guard 和审计记录。人工批准、处置状态和执行结果继续写回同一上下文。

## Evidence Bundle 包含什么

- 案件范围和稳定身份；
- 按时间排序的原子事件；
- Agent、Tool、File、Network 与 Risk 拓扑；
- L1、L2、L3 判断及其来源；
- 脱敏状态和完整性标识；
- 规则、审批、处置与审计记录。

Evidence Bundle 是调查、复核与交接材料，不替代原始事件，也不等同于合规认证。

继续阅读：[架构](/architecture/) · [典型场景](/scenarios/) · [快速开始](/guide/)
