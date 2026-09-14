# 候选归因纠偏与验收边界

## 已确认偏差

`d3789cb` 至 `388ffa3` 新增的 API 评分路径不满足已审核设计第 5 节：

- 重复 FileAccess、Egress 可以单独达到阈值，没有行为序列门槛。
- `agentInstanceId = __behavior_candidate__` 覆盖实际实例 ID，使不同候选可能共享同一个实体键。
- 评分发生在重放去重/提交之前，重试可以重复计分；状态没有事件去重。
- 该路径没有调用 Forwarder 的规则发布器，API Explain 的 F1 计算结果不能证明 eBPF map 已应用。

因此移除新建的 API scorer/registry 及 Judge 注入，恢复既有 API 身份路由。保留本地历史提交，以便追溯；不部署这套状态的持久化实现。

## 保留的实现链路

`scripts/observer-forward.js` 在平台/进程身份及基础设施规则之后调用
`BehavioralAgentDetector`，随后调用 `unifiedFilterPolicy.captureDecision()` 与
`filterRulePublisher.observe()`。检测器位于 `scripts/observer-behavior-discovery.js`，已有行为形状、代次隔离、有界集合、TTL/滞回与注册表版本。

API 保留上游经现有归因逻辑处理后的 `probable_agent`，使用原有完整候选路由。
候选身份分类与实例 ID 分离；不得用规则匹配哨兵值替代实体标识。

## 本轮验证计划

1. 直接执行 Judge 接缝测试：重复未知文件/网络事件不能自行晋升；两个候选经过 API 后仍保留两个实例；Session、Run、进程代次不被改写。
2. 重跑既有 Forwarder 行为发现、统一投影与 API 身份路由测试。
3. 开发机运行版本暂回到 `f50ff73` 对应的既有镜像，待后续实现满足上述约束再更新。

## 证据边界修正

- `/events/list` 返回 `partial=false` 证明该事件查询覆盖；不等同于 `/v1/session-memberships/:id` 或 Canonical Session 完整点查。
- Explain 中 F0/F1/F2/F3 均有 winner 证明给定上下文的规则计算；Ring 前执行还需 epoch、map ACK、根进程代次和计数器的运行证据。
- A/B HTTP 返回成功证明实验工作流成功；没有完成 UI、独立子 Session 与内核证据检查时，不声明父子观测验收通过。
- Collector 内部队列压力测试不等同于实际 eBPF→Forwarder→API→数据库全链路压力测试。

上述缺口仍属于原目标，需继续实现与验收。
