# 通用 Agent 服务观测验证矩阵

本文记录 `fix/langgraph-cross-agent-hop` 阶段性实现的可重复验证证据。矩阵只记录已经执行的本地结果、受控环境闸门和仍待取得的真实证据；真实运行中的凭据、事件正文和中间产物不进入仓库。

## 已通过的本地验证

| 能力 | 验证入口 | 结果 | 证据范围 |
| --- | --- | --- | --- |
| 进程代次和 PID reuse | `cargo test -p a3s-observer-collector process_lifecycle` | 11 passed | `start_time_ticks`、cgroup、Exec/Exit generation fencing |
| Collector capture profile | `cargo test -p a3s-observer-collector capture_profile` | 13 passed | candidate/confirmed profile、签名 ACK、文件事件保护 |
| Ring/Collector pipeline | `cargo test -p a3s-observer-collector pipeline` | 20 passed | 有界队列、加权调度、drop ledger、压力下内存边界 |
| 通用 HTTP tool shape | Collector interaction test | passed | 不依赖固定 endpoint 名称，关联请求和响应 |
| 远程 Agent delegation | `remote_agent_run_shape_emits_delegation_interaction_with_hop_headers` | passed | `/runs`、hop、parent session、delegation id |
| F0/F1/F2 规则投影 | `verify-unified-filter-forwarder.mjs` | passed | rule lineage、capture profile、Forwarder projection |
| Unknown/噪声/重试/413 | `verify-filter-pipeline.mjs` | passed | shadow/enforce、Unknown discovery、ACK、WAL 反压 |
| 行为候选发现 | `verify-behavior-discovery.mjs` | passed | generic route/semantic signal、process generation fence |
| Canonical identity/session | `verify-canonical-observability.mjs`、`verify-canonical-contract.mjs` | passed | LogicalAgent、AgentInstance、Session/Run、fork 边界 |
| Tool 与 Kernel evidence | `verify-s6-tool-evidence-linker.mjs` | passed | ToolCall/ToolExecution 与 KernelFact 双向链接 |
| Reader-first persistence contract | `verify-s2-persistence-canonical.mjs` | passed | reader-first、canonical coverage contract |

## 真实验收闸门

`verify-real-agent-discovery-chain.mjs` 在创建任何 source、Pod、Docker workload 或 Collector 前执行连续容量检查：

- AnySentry API 默认不超过 `600 MiB`；
- ClickHouse 默认不超过 `1800 MiB`；
- 默认连续通过 3 个、间隔 1 秒的样本；
- `kubectl top` 缺失、超限或控制面 namespace 不可读时 fail closed；
- source token 只通过临时进程环境传递，测试结束禁用临时 source；
- Docker argv 不包含 source token 或管理 token；
- 所有测试资源使用唯一名称并在 `finally` 中清理。

容量闸门是资源保护条件，不等价于真实验收通过。它阻止在 API/ClickHouse 高水位时重复触发此前的 OOM 风险。

## 尚未取得的真实证据

以下项目仍需在容量闸门连续通过后执行一次受控真实运行：

1. source 鉴权后的 Collector batch ingest 和 heartbeat；
2. F0/F1/F2/F3 规则 epoch、热加载和原因解释在真实事件上的一致性；
3. HTTP Agent、LangChain/LangGraph 服务的启动、空闲、重启、Session/Run 生命周期；
4. 父工作流调用子 Agent 时父视图和子视图的独立证据边界；
5. canonical Session/Run/AgentInvocation/KernelFact/EvidenceLink point-read 返回 `coverage=complete`；
6. ClickHouse/PostgreSQL 压力下的队列、WAL、丢失计数和观测延迟；
7. classic SSL WIP 完成后的 WebSocket/TLS 明文重组全链路。

## 解释边界

- 本地 fixture 证明算法和模块接缝，不证明共享部署已经完成真实验收。
- Unknown、CandidateAgent、KernelFact 和 coverage gap 必须保留；缺少明文解析不能被解释成没有内核证据。
- classic SSL WIP 的已知失败不通过修改测试断言隐藏，也不作为 generic HTTP 已完成的证据。
- 任何真实运行报告必须同时附带镜像 digest、规则 epoch、进程代次、队列/WAL 指标和 canonical 点查结果。
