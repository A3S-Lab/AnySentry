# 五个从证据出发的安全时刻

AnySentry 不是从“有多少告警”开始，而是从一次真实行为开始，逐步回答身份、风险、上下文与动作。以下场景对应首页的局部产品重绘，演示值均为合成数据，交互结构来自当前实际 Dashboard。

## 1. 识别正在运行的 Agent

Observer 将进程树、容器或 Pod、Workspace 与行为序列连接到 Agent Asset。操作员可以区分 `confirmed_agent`、`probable_agent`、`unknown` 与 `non_agent`，查看归因来源并做人工裁决。

**当前边界：** 自动行为发现只能产生候选身份；只有明确标签、平台事实或人工确认才能形成稳定的已确认身份。

## 2. 在高风险工具调用前给出判断

Agent 或工具网关可在执行前调用 `assessRuntimeAction`。L1 对明确模式做确定性判断，并返回 `policyAction`、`severity`、`riskCategory`、`reason` 与 `eventId`。L2/L3 只在配置后按策略升级。

**当前边界：** AnySentry 评估并记录动作，不执行提交的命令。调用方必须遵守 `require_approval` 或 `block` 才能形成硬控制。

## 3. 把离散行为放回时间和拓扑

事件页保留原子事实；拓扑连接 Agent、Tool、Network、File、LLM 与 Risk；Episode 和流式 finding 提供时间窗口中的组合信号。调查者可以从聚合关系下钻到具体事件。

**研究方向：** 对更长行为前缀做危险轨迹预测仍属于 Advanced / Experimental，需要以提前量、误报率和证据完整度持续验证。

## 4. 只在必要时增加研判成本

L1 处理确定性热路径，L2 为单事件补充语义，L3 在未解决升级时用受限只读工具补充上下文。每层都有独立配置、预算和来源标记。

**当前边界：** L2/L3 不是开箱即用的默认能力；没有有效模型连接与显式策略时保持关闭。

## 5. 让每个治理动作回到证据

Incident、Alert、Evidence Bundle、通知、处置任务、目标与审计记录使用同一控制面关系。Agent 还可以通过 Progressive API 生成脱敏证据包或获取按证据排序的后续行动。

**当前边界：** Evidence Bundle 是调查与交接材料，不等同于合规认证；处置任务和通知状态也不代表外部系统已经成功执行，除非相应适配器返回可验证结果。

## 推荐验证顺序

1. 用[快速开始](/guide/)验证一条 L1 guard 决策；
2. 接入一个真实 Source，并确认身份、事件与 Workspace 关联；
3. 从拓扑或 Agent 资产下钻到原始事件；
4. 围绕同一 `eventId` 创建 Evidence Bundle；
5. 最后再启用 L2/L3 或接入执行网关，测量延迟、误判和失败模式。
