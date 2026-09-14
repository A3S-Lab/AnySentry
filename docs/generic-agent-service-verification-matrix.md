# 通用 Agent 服务观测验证矩阵

本文记录 `fix/langgraph-cross-agent-hop` 阶段性实现的可重复验证证据。矩阵只记录已经执行的本地结果、受控环境闸门和仍待取得的真实证据；真实运行中的凭据、事件正文和中间产物不进入仓库。

## 2026-09-12 本地受控运行补充

在清理旧 AnySentry 镜像、ReplicaSet 和临时数据后，使用当前镜像 digest
`sha256:6be4202534c53916e3c5430e15f846da57e9fd703b5215a4917c8b244d423a05`，并通过本地管理鉴权运行了
`customer-langgraph-sim-lab/scripts/verify-observer.sh`。Design B 编排器、独立 worker、sandbox 和 tool-mock
保持为既有受控实验服务，未停止或删除。

结果：健康检查通过；一次 `/runs` 返回 `completed`；AnySentry 在 5 秒轮询窗口内收到 5 条 interaction，路径包含
`/runs`、`/v1/chat/completions` 和 `/execute`，来源为 `tcp_plaintext`，产品归因为 `langgraph`；conversation-directory
返回父编排器和 worker 两个 LangGraph 线程；两个 timeline 均返回完整 turn 和语义事件，父侧包含
`delegation_send`/`delegation_reply`，worker 侧包含 `tool_call`/`tool_result`。

本次还修正了受控验证脚本对 `timeline-v3` canonical 响应的兼容性：事件位于 `turn.events`，旧 fixture 才使用
`turn.items`；脚本现在兼容两种响应形状，避免把已经持久化的事件误判为空。该修复只影响测试脚本，不改变产品
事件模型。仍未据此宣称 KernelFact 与 Tool evidence 已完成唯一双向 canonical 关联。

## 2026-09-14 Design B 延迟投影复核

重启开发机后重新构建并启动 customer lab 的 Design B，实际 `/runs` 返回 `completed`，orchestrator、worker 和
sandbox 的健康检查均通过。Observer 日志确认已附加到三个 customer PID，并出现完整 HTTP interaction reassembly；
Collector 窗口的 `output_dropped`、三个优先级队列 dropped、sequence gap 和 body-limit drop 均为 0。

严格验收脚本在前 120 秒内点查到 `coverage.partial=false` 但当前 run 为 0 条 interaction，因此正确拒绝使用历史
thread。服务清理后继续对同一 run 做只读点查，最终得到 8 条当前 run interaction，包含 `/runs`、`/execute` 和 6 条
`/v1/chat/completions`；全部 `captureSource=tcp_plaintext`、`transportCompleteness=complete`、
`wireCompleteness=complete`，其中部分语义项为合法的 `tool_pending`。该证据表明本次主要偏差是 F3 canonical
投影/查询可见性延迟，不能把 120 秒内的 0 条直接解释成 Collector 丢失。

同时将 `customer-langgraph-sim-lab/scripts/verify-observer.sh` 的 canonical 等待窗口改为默认 600 秒，并加入失败
时自动清理两个 compose 项目的容器、volume 和网络；仍可用 `KEEP_LAB_SERVICES=1` 显式保留服务。该脚本改动位于
customer lab 外部目录，不作为 AnySentry 产品代码提交。

第二次复跑验证了另一个边界：应用健康检查通过不代表 Observer 已完成新进程的 probe attach。一次无启动等待的
调用发生在 attach 窗口之前，未形成该 run 的完整 interaction；脚本已增加默认 20 秒的
`OBSERVER_STARTUP_SETTLE_SECONDS`，用于受控实验等待冷启动发现。该等待是测试闸门，不是把缺失证据标记为成功。

本轮 AnySentry health/collector point-read 还观察到 Forwarder 处于真实容量压力：`spoolRecords=158665`、
`spoolActiveRecords=11471`、`spoolParkedRecords=147194`、`spoolAtCapacity=true`、`queueDropped=525`，delivery
状态为 degraded；同时 Collector Ring `ringDropped=0`。这一区分证明 Ring 无丢失不能推出 F2/F3 投递无丢失，后续
真实 E2E 必须先清理开发机可丢弃的旧 spool 并恢复 delivery health，再进行稳定性验收。

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
| Candidate behavior provenance | `verify-behavior-discovery.mjs`、`verify-filter-rule-snapshot.mjs` | passed | `behavior-window-v1`、score/threshold/window、bounded evidence、`fr_builtin_behavior_candidate` lineage |
| Behavior signal registry reload | `verify-behavior-discovery.mjs` | passed | bounded JSON registry normalization、runtime `updateSignalRegistry()`、next-observation `algorithmVersion` change；不清空既有代次窗口 |
| Model-only service candidate | `verify-behavior-discovery.mjs` | passed | 同一代次窗口内两次 provider-neutral kernel `Egress` 模型路由即可进入 bounded `probable_agent`，不要求 `ToolExec` 或厂商 host，仍不创建稳定 LogicalAgent |
| Candidate capacity and continuity | `verify-behavior-discovery.mjs` | passed | 满容量继续观测已有候选不淘汰；新 scope 按最近访问顺序淘汰一项；周期清理保留活跃记录；旧实现已复现失败 |
| Filter-rule compiler performance | `verify-unified-filter-rule-performance.mjs` | passed | 2,000 rules，index build 2.573 ms，evaluator P95 0.034 ms，catalog P95 7.492 ms，explain P95 4.547 ms |
| Candidate discovery hot-path performance | `perf-agent-filter.mjs` | passed | 60,000 synthetic events，246,743 events/s，latency P99 14.83 μs，RSS 增量 1.3 MB；bounded identity/process/candidate caches，无 stale-generation miss |
| S5 capture-profile hot reload | `verify-s5-capture-profile-control.mjs` | passed | preview/ACK/grant epoch、intent hash、candidate safe downgrade、generation fence |
| Forwarder full retention pipeline | `verify-filter-pipeline.mjs`（180 秒有界运行） | passed | Unknown、candidate、retry、413、spool、capacity、SIGTERM final snapshot/heartbeat |
| Observer lifecycle generation | `cargo test -p a3s-observer-collector process_lifecycle` | 11 passed | PID reuse、re-exec、start ticks、cgroup mismatch、bounded generation store |
| Observer Ring reader | `cargo test -p a3s-observer-collector 'ring_reader::tests::'` | 9 passed | malformed/TLS gap envelope、POD bound、capacity、delta conservation |
| Observer TLS attach | `cargo test -p a3s-observer-collector 'tls_attach::tests::'` | 20 passed | product-neutral runtime selection、ABI fail-closed、bounded retry and scope membership |
| Generic agent RPC route admission | Observer `8d17523` | passed | no implicit `/runs`; RPC route is an explicit deployment capability, while candidate/confirmed profiles provide bounded full capture |
| Generic HTTP route shape persistence/query | `pnpm --filter @anysentry/api build`、`verify-canonical-observability.mjs`、`verify-clickhouse-query-bounds.mjs`；`e68cf45`、`e45ea8e`、`e98efa1`、`1eb82b8`、`5bbcce5` | passed locally; runtime durable point-read pending | raw path remains evidence; dynamic IDs normalize to `:param`; ClickHouse schema/write/API query and hot-delta filtering share the same route shape contract |

## 真实验收闸门

最近一次只读 health 观察：API `healthz/livez` 返回 200，ClickHouse ready，PostgreSQL 未就绪；
hot ring 为 `4991/5000`，protected 为 `4528`，post-commit projection 为 0 in-flight、0
pending、0 failed、0 dropped，canonical raw/kernel/semantic/evidence lane 的 dropped 均为 0。
由于 hot ring 已处于约 99.8% 高水位，当前只保留只读和低事件量验证，暂缓会扩大事件量的真实
Agent E2E；健康检查通过不等价于容量闸门通过。

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

当前运行环境已确认本地 Kubernetes port-forward 的 AnySentry API 在 `127.0.0.1:32653`
可达（`/healthz` 返回 200），但 canonical/interaction verifier 的管理写入在
`POST /sources` 返回 401 `management token required`，因此真实 API 证据属于“服务可达、
管理授权未提供”，不能记为网络故障或 canonical 验收通过。

当前 Docker 中的 `customer-langgraph-sim-lab` 由
`/home/chensicheng/a3s/security/customer-langgraph-sim-lab` compose 项目管理，包含
orchestrator、worker-agent、python-sandbox 和 tool-mocks；端口 18088、18090、18091、
18092 均返回健康状态 200。该项目是本目标的受控 LangGraph 跨 Agent 实验链路，已核实为
在用资源，本轮不停止或删除。

当前 classic SSL WIP 的局部 interaction 测试仍为 `63 passed, 5 failed`。失败项是
quiescent WebSocket idle、reassembly sequence-gap/eviction、Rustls moved-pointer 唯一绑定、
competing pointer ambiguity 以及 WebSocket control-frame 竞争归属；这些失败保持在 WIP
边界内，未通过调整断言隐藏，也不降低 generic HTTP、Ring reader 或 TLS attach 已通过的证据等级。

目标级 `verify-canonical-goal.mjs --run-tests` 当前为 `58 pass, 2 partial, 5 blocked,
9 unexecuted, 1 fail`；唯一 fail 是上述 Observer Cargo WIP，真实 host/Docker/Kubernetes
代表对象和 credential hygiene 仍由环境门禁阻断。

## 解释边界

- 本地 fixture 证明算法和模块接缝，不证明共享部署已经完成真实验收。
- Unknown、CandidateAgent、KernelFact 和 coverage gap 必须保留；缺少明文解析不能被解释成没有内核证据。
- classic SSL WIP 的已知失败不通过修改测试断言隐藏，也不作为 generic HTTP 已完成的证据。
- 任何真实运行报告必须同时附带镜像 digest、规则 epoch、进程代次、队列/WAL 指标和 canonical 点查结果。

### 2026-09-15 customer-langgraph-sim-lab 重启后 A/B 复测

为验证重启后的干净开发环境，先停止并删除旧的 customer compose 容器/卷，清理
`/var/lib/anysentry-forwarder/spool-stable-20260907.wal`（约 809 MB，开发机临时 WAL），再恢复
`a3s-observer` DaemonSet；Observer 新 Pod 为 Ready，Ring/LLM 计数持续增长，Ring dropped 为 0。
该清理未触碰 PostgreSQL、ClickHouse、镜像仓库或 classic SSL WIP。

- Design A：`docker compose.yml` 真实启动成功，`GET /healthz` 返回 `design=A`；`POST /runs`
  返回 completed/verify pass，`run_id=session_id=be775a3c-3596-4a27-9ae2-36e15bec5056`，
  `trace_id=278e58013a037d7a63c9fc9f876aa231`，业务侧包含 plan/work/verify、sandbox 输入输出和
  11 条 dialogue。以该 run/trace 做 canonical durable point-read 时返回
  `coverage.completeness=exact_as_observed, partial=false`，但 0 条 interaction。
- Design B：`docker compose.design-b.yml` 真实启动成功，编排器和 worker 均返回健康；
  `POST /runs` 返回 completed/verify pass，`run_id=38274771-1308-425f-9e86-460f43d605bd`，
  `trace_id=22fa9f2ad7f396f14d56c2e2f68b9ecd`，业务侧返回 16 条 dialogue。以该 run/trace
  做 canonical durable point-read，轮询后仍为 0 条 interaction，coverage 同样为
  `exact_as_observed/partial=false`。
- 这两次结果不是“继续等待即可”：API 已报告 exact snapshot；Observer health 在同一窗口内
  报告 LLM/Ring 有事件且 ringDropped=0，但 interaction reassembly 日志对应的是其他进程流，
  未形成本次 customer run 的闭合 semantic projection。当前结论是：A/B 应用生命周期和业务
  canonical run 产生正常，跨进程 kernel/plaintext→run 归属与 projection 仍未通过真实验收。
- 该结果保留了 Unknown/Candidate/coverage 缺口，没有通过全量放开采集掩盖问题。下一步应在
  Observer 事件中核对传播头（`x-anysentry-run-id`、`traceparent`）是否被重组并写入
  `LlmInteraction`，同时核对 Docker workload 的进程代次与候选规则是否在首次调用前完成反馈。

本轮实验结束后应执行 Design B compose down（`--remove-orphans --volumes`），避免测试服务和
临时网络继续占用开发机资源；保留日志目录作为未入库现场证据，不提交 `.runtime` 或凭据。

### 2026-09-15 冷启动关联候选修复

Forwarder `1cba15b` 增加了通用的协议级候选信号：当 `LlmInteraction` 同时携带非空
`run_id` 与 `trace_id/session_id` 时，即使进程分类尚未完成，也进入 `probable_agent` 候选
路径，原因写为 `correlation_header` / `correlated_llm_interaction_candidate`。该规则不读取
工具名、厂商域名、固定端口或框架版本，不直接创建 LogicalAgent；明确的基础设施和
non-agent 结论仍优先。`verify-behavior-discovery.mjs` 与 `verify-filter-pipeline.mjs` 均通过。

重启正式 Observer 后再次执行一次低负载 Design B：业务请求 completed/verify pass，
但 canonical run 点查仍为 0 条且 `exact_as_observed/partial=false`。因此修复已进入部署脚本，
但真实闭环仍未验收；下一步需要取得该 workload 的实际 Forwarder classification 和
`LlmInteraction` 原始字段，确认是传播头未进入重组事件，还是更高优先级的 workload/infrastructure
规则覆盖了候选信号。

### 2026-09-15 API 镜像更新与诊断字段复测

AnySentry API 以提交 `e1adf79` 构建并部署到开发 Kubernetes，运行镜像 digest：
`127.0.0.1:5000/anysentry@sha256:c278900fa475825cbc080660f16c49b4cfe19fffe5822a166dc312f8b11d72a5`。
旧 API Pod 已由 Deployment rollout 替换，新 Pod imageID 与该 digest 一致。

一次低负载 Design B 调用返回 completed/verify pass，`run_id=3e3c6fc5-e54f-4fd3-9139-8018e7404e12`，
`trace_id=8d3a7e36d560b9543e5202cf8d72741e`。新 API health 已能保留 Forwarder 诊断字段：
`correlatedLlmCandidates=6`、`correlatedLlmRejectedInfrastructure=0`、
`llmWithoutCorrelationTuple=10`。这证明本次事件中确有 6 个带传播 tuple 的 LLM 候选进入 Forwarder，
且未被 infrastructure 规则拒绝；但按该 run/trace 查询 `events/list` 和 `agents/interactions` 仍均为 0，
coverage 为 `exact_as_observed/partial=false`。故当前故障点已从 Forwarder 候选判定进一步收敛到
F2/F3 canonical ingest 或 interaction projection，而不是冷启动识别或 API 字段隐藏。

### 2026-09-15 raw commit 边界修复

coverage-gaps 对本轮 source `src_c6afd3f7e7c4e847` 连续报告
`stage=raw_commit, reason=parser_failed, validation=raw_observation_has_missing_or_invalid_required_fields`。
根因是 Observer 事件在冷启动重组窗口可能没有 `eventAtUnixNs`，而 canonical raw validator 将
`eventAtUnixNs/receivedAtUnixNs` 视为必填，导致事件在 semantic parser 之前无法进入 RawObservation。

提交 `eeb91b3` 对已认证 Observer raw lane 增加有界时间回退：缺少采集事件时间时使用 API receive
clock，标记 `eventTimeQuality=api_received` 和 `anysentry.event_time_fallback=api_received`，不伪造
provider/application 时间。AnySentry API 以 digest
`127.0.0.1:5000/anysentry@sha256:fe1276a595ccac15c889f44851d769ca636906cb6b3ab5ccb21488cfee443978`
部署，旧 Pod 已停止并删除。部署后未再启动 customer 测试容器；Forwarder WAL 已清理为 0 bytes，
Observer DaemonSet 已恢复 Ready rollout。

尚待一次新镜像下的 customer A/B 受控请求验证 raw commit gap 是否消失，以及 interaction point-read
是否恢复；在该验证前不宣称 canonical Session/Run 已通过。

## 2026-09-14/15 B 方案重启后 canonical raw 复测

- customer-langgraph-sim-lab Design B 在重启后的本机重新启动，orchestrator `:18090`、worker `:18091`、sandbox `:18088` 均健康；受控 POST `用 Python 计算 3+3 并打印结果` 返回 `status=completed`、`verify_status=pass`，产生独立 `run_id`/`trace_id`。
- AnySentry 当前部署 digest：`sha256:8ca3eb119fba6ebbff04a4da308b0f30ca4dc8399d822a2197ba87f11da6edb0`，对应本地提交 `e09a794`。旧 Pod 已进入 terminating，新 Pod `1/1 Running`，滚动更新完成。
- raw commit 字段诊断从 `payload` 收敛到 `sourceRefs`，随后在 envelope repair 后不再出现在最新 coverage-gap 前十项；这证明服务端接收时间、来源类型、payload hash、sourceRefs、derivedFrom 和幂等键已具备兼容补齐路径。
- 当前查询结果：该 B run 的 `agents/interactions` 返回 `items=0`、`completeness=exact_as_observed`、`partial=false`；因此 semantic interaction projection 与 canonical Session 尚未验收通过。Observer 日志同时显示 HTTP 交互重组 `completed_interactions=1`，说明剩余缺口位于 Forwarder/semantic 投影或其关联键，而非客户服务未运行。
- 资源清理：Design B compose、network、containers 已停止并删除；本地 AnySentry 旧测试镜像 tag 已清理，仅保留当前部署镜像。Observer WAL 仍约 252 MiB，未在 Collector 运行期间强制截断，避免把活动链路误判为已清空。

## 2026-09-15 interaction query backpressure fix

- 从 Observer WAL 中解析到 Design B 的真实事件：`/v1/chat/completions` 和 `worker-agent:18091/runs` 均为 `parseState=parsed`，共享同一 `traceId/runId/sessionId`；Design A 的 `/runs` 外层 HTTP 仍有 `wire_template_unparsed`，但内层模型调用具备完整关联三元组。
- API coverage gap 明确记录了 `agent_interaction` 与 `semantic_record` 的 `ANYSENTRY_OBSERVER_PROJECTION_TIMEOUT`。原因是 ClickHouse/关系投影慢时，读取接口先等待 durable interaction 查询，未及时合并已进入进程 hot ring 的记录。
- AnySentry `b11f3ea` 为 durable interaction 查询增加 2 秒有界等待；超时后返回 hot ring 内容并把 coverage 标为 `partial/hot_ring_only`，不再把数据库慢误报为 `items=0/exact`。构建部署 digest：`sha256:139a8762a994efb3e19552849d2d952e62f91310c2314fcb4489aa2b682c8d81`。
- 本轮低负载 A 调用业务返回 `completed/pass`，但调用后立即查询仍为 `items=0/exact_as_observed`；最新 coverage gap 尚未出现对应 projection timeout，说明该请求的 Observer/WAL 到 API 投递仍可能受历史 WAL backlog 延迟影响，semantic projection 尚不能验收为完成。

## 2026-09-15 clean-WAL replay boundary

- 为隔离历史积压，开发机暂停 Observer forwarder PID 后将 `/var/lib/anysentry-forwarder/spool-stable-20260907.wal` 清为 0，再恢复进程；B 受控调用 `run_id=a92360c1-5760-47e5-b1cc-c2ee87dd83df`、`trace_id=4890edb1f07eb3d1e20fcaa5fa030d99` 返回 `completed/pass`。
- 调用后 WAL 很快重新增长到约 65 MiB，说明宿主上的持续内核活动速率高于当前 Forwarder/API 投递速度；coverage-gaps 未出现该 run 的新 projection 错误，但 interaction 查询仍为 0。这个结果不能证明 semantic projection 成功，也不能继续通过扩大采集来掩盖 backlog。
- 运行时还发现 Deployment 的 hostPath overlay `scripts/.local-bin/aggregation.service.js` 比当前源码旧，已在开发机仅同步必要的 `runId/traceId` 过滤和 2 秒 durable read 超时；该中间 overlay 未纳入 Git。源码修复 `b11f3ea` 仍是正式可审查变更。
- A/B 容器已全部停止并删除；当前仅保留 AnySentry、Observer 和本地 registry。Observer classic SSL WIP 未改动。

## 2026-09-15 parent/worker Session scope verification

- 在修复 `2b19aec` 部署后重新运行 Design B，业务调用 `12+12` 返回 `completed/pass`，run=`0023cd94-3937-4528-b932-434f275d2ecd`，trace=`ebee29513ed9c67b7c82deace19ce76d`。
- interaction 查询最终返回父 orchestrator 与 worker 的 6 条记录。父侧运行实例为 `host-root:...:4077834:6976435`，canonical Session=`sess_f618de6ee7aa6e151a87c218`；worker 侧运行实例为 `host-root:...:4078576:6977190`，canonical Session=`sess_b33430d0e9ccf7d587971560`。两者共享 run/trace，但不再因为 `/app`、Source 或 provider run 相同而合并到同一个 Session。
- 父侧 interaction 包含模型调用、sandbox 调用和模型返回；worker 侧包含 delegation 入口及自身模型调用。worker delegation 保留父 run 关联，满足父视图保留子 Agent 入口、子视图保留内部细节的归属方向。
- `/v1/sessions/sess_f618de6ee7aa6e151a87c218` 与 `/v1/sessions/sess_b33430d0e9ccf7d587971560` 均可点查，但 coverage 为 `asset_only / semantic_projection_expired_or_missing`，`interactionIds` 已存在而 `completeInteractions=0`。因此 Session 边界修复通过，canonical semantic durable projection 仍未通过最终验收。
### 2026-09-15 durable semantic coverage reconciliation

The restarted customer B deployment produced distinct canonical Sessions for the parent
orchestrator (`sess_f618de6ee7aa6e151a87c218`) and worker (`sess_b33430d0e9ccf7d587971560`).
The durable semantic-record endpoint returned 12 records for the parent and 10 for the worker;
complete and `tool_result_pending` partial records were both present and carried the expected
canonical Session IDs and interaction references. The Session point endpoint nevertheless reported
`asset_only / semantic_projection_expired_or_missing`, because it only used the expired timeline
projection for coverage. Commit `9510935` adds a bounded durable-record reconciliation to the
Session projection. The source builds successfully with `pnpm --filter @anysentry/api build`; the
new behavior still needs an image rebuild and a fresh A/B runtime check.

### 2026-09-15 rebuilt image and A/B runtime check

Image `127.0.0.1:5000/anysentry:session-reconcile-9510935` was built from commit `9510935`,
pushed to the local registry with digest `sha256:6ffc25e670279eb025be9ca94fc9e551a81a47f5a7ae8a6ef8a9ad154509fcda`,
and rolled out as the only ready AnySentry replica. The previous ReplicaSet terminated normally.

Design A was rebuilt and run through `:18090/runs`; it returned `completed`, sandbox exit code 0,
and `1 + 1 = 2`. AnySentry recorded six interactions in canonical Session
`sess_a8ce5a98ce4c71a3544897d7` for run `1e3dc726-f8ad-419d-b309-204c999cc754`.

Design B was then rebuilt after Design A cleanup. The orchestrator, worker and sandbox health checks
passed; `/runs` returned `completed`, the worker returned `remote_ok`, and the correlation payload
contained a worker hop and sandbox execution. AnySentry recorded six interactions in canonical Session
`sess_982d3b0f4adcca5cf5819eb6`, including model, sandbox and gateway traffic. The Session point
query returned `coverage.status=partial`, with `completeInteractions=3` and
`partialInteractions=3`, and no `semantic_projection_expired_or_missing` reason. The partial state
is retained because the run contains pending/less-complete semantic records; it is not promoted to
complete by the durable reconciliation.

The customer A/B containers, networks and dangling images were removed after verification; the
pre-existing local registry was retained. Observer logs showed bounded reassembly and dynamic PID
allowlist admission; classic SSL static-signature warnings remain the separately protected WIP boundary.
