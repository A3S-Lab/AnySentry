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
contained a worker hop and sandbox execution. The first query window contained six records from the
 earlier B run under `f9f00e85-e394-49ba-a65b-efae58b0370b`, which was initially mistaken for the
 current invocation. A later bounded query found the expected six records for run
 `09b9cc79-f800-481b-860a-538ebcd4e3d1`: three parent interactions in
 `sess_e496ae12c1a26873307b9963`, and three worker interactions in
 `sess_e9a98ad109a439c94f15d231`. Both Session point queries returned `partial` without
 `semantic_projection_expired_or_missing`, proving delayed eventual ingestion and parent/worker
 Session separation for that invocation.

A subsequent fresh B run `5157aabe-94c2-4da5-b925-b760592f1a8c` returned `completed/remote_ok`,
but was absent from the bounded interaction result at check time; it remains a delivery-latency
observation and is not counted as a successful canonical run.

### 2026-09-15 B 延迟交付与 WAL 采样

又一次 B 调用 `5157aabe-94c2-4da5-b925-b760592f1a8c` 返回 `completed/remote_ok`，但 20 秒后
的 500 条交互查询仍未出现该 run；这次调用不计入成功证据。同期查询能够看到前一个
`09b9cc79-f800-481b-860a-538ebcd4e3d1` 的 6 条记录，说明查询路径不是完全失效，而是存在
事件交付延迟或容量丢失窗口。

五次、每次间隔 5 秒的运行采样中，当前 recovery WAL 从约 66.9 MB 增长到 71.0 MB；日志未
出现新的 WAL JSON 读取错误，但 API 日志出现 `request aborted`。Observer 仍报告大量连接重组
状态，其中部分 HTTP/2 和 WebSocket 状态未完成。当前只能确认持续积压，尚不能把原因归为
单一的 eBPF、Forwarder 或 ClickHouse 故障；需要补齐 Forwarder ACK/重试指标和 ingest 批次
响应记录后再调整并发或过滤策略。

The customer A/B containers, networks and dangling images were removed after verification; the
pre-existing local registry was retained. Observer logs showed bounded reassembly and dynamic PID
allowlist admission; static-signature warnings do not on their own identify the affected workload
or prove that the warning is caused by the protected classic SSL WIP.

### 2026-09-15 WAL 清理纠正与恢复边界

运行中截断 WAL 使 Forwarder 内存中的延迟读取偏移失效，产生 JSON 读取错误；随后日志中的
解析异常还可能携带事件正文。这是清理动作引入的问题，不能作为正常负载下吞吐不足的证明。
恢复改为通过 DaemonSet 正常滚动切换到新的 `spool-recovery-20260915.wal`，不再截断运行文件。
WAL 的磁盘大小包含 PUT/ACK 历史，只有结合存活记录数、ACK 和队列指标才能判断积压。

局部修复：启动恢复时移除未完成的最后一行，完整但缺少换行的末尾记录补齐换行，避免下一次
追加污染第二次重启；中间行损坏仍拒绝加载。JSON 解析错误只记录结构信息，不输出正文片段。
`node scripts/verify-forwarder-spool-replay.mjs` 通过，包括两次重启、UTF-8 新记录保留和错误脱敏。
该新增代码尚未重新构建到 Observer 镜像，不能据此声明已部署修复。
### 2026-09-15 batch pressure experiment

The live Observer DaemonSet was temporarily tested with `FORWARD_BATCH_MAX_BYTES=131072` and
`FORWARD_MAX_INFLIGHT=2`, then restored to its prior configuration. The recovery WAL grew from
approximately 109.3 MB to 112.9 MB in 20 seconds during the constrained run, so smaller batches
and lower concurrency did not reduce the source/backlog rate. No new WAL JSON read errors appeared.
This experiment is runtime-only and is not a product default change. The evidence points away from
simple batch size/concurrency tuning; the next diagnostic must expose Forwarder ACK/retry counters
and the API request-abort boundary.

### 2026-09-15 request-abort diagnostic deployment

Commit `50f763f` adds a post-route Express error handler for body-parser aborts. It records only
method, path, content length, source ID, batch ID and error type/code; request bodies, bearer tokens
and arbitrary headers are excluded. The API image was rebuilt and deployed as
`127.0.0.1:5000/anysentry:abort-diagnostics-50f763f` with digest
`sha256:7fc061861b0316082a858f73d74afb7fb070976c077202db905bf86f96100b4e`; the old ReplicaSet
terminated and the new Pod became ready. A fresh abort sample is still required before claiming
that the diagnostic closes the WAL loss boundary.

The first deployment placed the error middleware after `listen` and did not intercept the parser
exception. Commit `74e1bc5` moves it immediately after the JSON body-parser middleware and before
route handling. A controlled partial request then produced the expected redacted log on the new Pod:
`path=/security-center/ingest/batch`, `contentLength=16000000`, `sourceId=diagnostic-test`,
`batchId=abort-test-74e1bc5`, `errorType=request.aborted`, `errorCode=ECONNABORTED`. No request body
or authorization value was logged. The diagnostic seam is now verified; it does not by itself prove
that ordinary Forwarder batches are accepted or that WAL growth has stopped.

### 2026-09-15 customer LangGraph restart and clean A/B verification

After the host restart, the customer simulation was rebuilt from `/home/chensicheng/a3s/security/customer-langgraph-sim-lab/README.md`. Design A was verified through the existing Kubernetes service (`design=A`, `node_agent_mode=ephemeral_subgraph`): `POST /runs` completed with sandbox exit code 0, stdout `2`, and a run/session correlation tuple (`trace_id=e8276db6fd6ab597be4a87450923baad`, `run_id=session_id=556de716-ea49-42fa-9f7b-022382a028f3`).

Design B was rebuilt with `docker compose -f docker-compose.design-b.yml up -d --build` and verified through both orchestrator and worker health endpoints (`node_agent_mode=remote_http`). Its POST run completed with sandbox exit code 0, stdout `2`, four spans in the local correlation payload, and explicit `parent_session_id` plus `delegation_id` (`trace_id=5dbb405197833520d310f11c02a9c9b0`, `run_id=session_id=cf9bddac-2be4-4ab5-9819-260185d296d4`). The response reported `telemetry_export.enabled=false` because the local simulation has no OTLP/source credential wiring; this is a coverage limitation, not a failed workflow run.

The Docker Design B stack was stopped with `docker compose ... down --remove-orphans`, and the old Kubernetes simulation deployments were scaled to zero after the checks. No simulation container was left running. The customer run artifacts were kept only in temporary `/tmp` files and are not part of the repository.

### 2026-09-15 fresh WAL baseline and delivery capacity

The active Observer heartbeat was accepted after restart (`collectorId=pjnl261070032`), proving the source credential and heartbeat route. Before cleanup, delivery was degraded by `spool_backlog_over_slo` with about 57,550 records and 45,489 parked records. Because this is the development host and historical loss is explicitly allowed, the stale recovery/stable WAL files were truncated while the Observer was stopped, then the DaemonSet was restarted.

The clean baseline eliminated old parked records and restored zero collector drops, but the host still produced more events than the API could drain: after a short window the new WAL had about 2,169 active records and the health channel again reported `spool_backlog_over_slo`. With `FORWARD_BATCH_MAX_BYTES=131072` and `FORWARD_MAX_INFLIGHT=2`, transport errors disappeared in the sample, but delivery remained capacity-bound (141 events accepted in the sampled window while the queue grew). This is evidence for a remaining API/ingest throughput or host-noise capacity problem; it is not evidence to enable global full capture. The runtime tuning was left explicit in the DaemonSet for the controlled baseline and must be revisited before a high-rate endurance claim.

Commit `20483c2` improves forwarder diagnostics by preserving redacted HTTP/status or socket failure reasons for control requests and logging heartbeat delivery failures with only the collector ID.

### 2026-09-15 ingest capacity experiment: API replicas and forwarder concurrency

The clean Observer baseline was measured with `FORWARD_BATCH_MAX_BYTES=131072` and
`FORWARD_MAX_INFLIGHT=2`. The capture channel remained healthy with zero Ring/output drops, but
bounded delivery accumulated records and reached `queueDropped=1555` while the API acknowledged only
about 420 events in the sampled window. Scaling AnySentry API from one to two replicas did not remove
backlog growth; the API batch path still performs per-event source resolution, canonical observation
commit, ClickHouse persistence and projection preparation.

A second controlled window raised only `FORWARD_MAX_INFLIGHT` to 4 while keeping the 131 KB batch cap.
During the first sample, `queueDropped` fell to zero and active spool records fell from roughly 12,979
to 3,770 while 950 events were acknowledged. A later sample showed the queue rising again to about
10,571 active records and a `control_runtime_snapshot_failed` warning, so this is an improved but not
stable capacity setting. The extra API replica was removed after the experiment to avoid idle resource
consumption. The runtime DaemonSet remains at the bounded 131 KB / concurrency 4 canary values for the
next controlled test; no claim of lossless endurance is made.

### 2026-09-15 ingest phase timing and bounded async persistence experiment

Commit `0b5b9a5` adds an opt-in `ANYSENTRY_INGEST_DIAGNOSTICS=1` timing record for Observer
batches. The record contains only event counts and phase durations: preparation, durable fence,
projection, source resolution, canonical observation, Judge preparation and total time.

A deployed sample with synchronous canonical persistence showed the actual bottleneck: a 29-event
batch took about 7.5 seconds, of which `canonicalObservationMs` was about 7.4 seconds; source
resolution was about 2 ms, Judge preparation about 17 ms, the ClickHouse durable fence about 50 ms,
and projection about 10 ms. This rules out source matching, Judge classification and ClickHouse
batch commit as the primary cause of the earlier prepare latency.

The existing bounded async canonical side lane was enabled temporarily with
`ANYSENTRY_CANONICAL_ASYNC_PERSIST_MAX_INFLIGHT=64`. Batch latency fell to roughly 0.15–0.45 seconds
and canonical observation time to roughly 9–17 ms. However, the health contract reported
`asyncPersistenceDropped=36820` and `persistenceDropped=54917` while the active in-flight limit was
reached. The experiment therefore proves the latency benefit but fails the no-unexpected-loss gate;
async persistence was reverted to `off` after the sample. A follow-up implementation must coalesce
raw observations into bounded batches before enabling this path as a product default.

### 2026-09-15 bounded raw-observation batch coalescing

Commit `bc372d4` introduces a bounded raw canonical side-lane batcher. It coalesces up to
`ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_ROWS` observations over
`ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_WINDOW_MS`, uses the existing `saveRawObservations([...])`
transaction/idempotency fence, and records a CoverageGap for every batch member when the sink fails.
Queue capacity is bounded by the configured in-flight batch limit and batch row limit; shutdown drains
pending entries into explicit dropped/gap accounting instead of acknowledging them silently.

A clean-WAL runtime canary (`async persistence on`, 64 in-flight batches, 512 rows, 50 ms window)
reduced Observer batch latency to roughly 30–320 ms and kept the Collector delivery channel healthy
with queue/spool at zero and no Observer drops. The same 90-second window still reported raw-side
persistence pressure: 9,428 async observations scheduled, 8,939 completed, 96 failed, and 5,240
async admissions dropped; the separate CoverageGap persistence lane also reported 15,496 dropped
writes. The canary therefore improves F2 delivery but does not satisfy the canonical no-gap gate.
The async canary was reverted to synchronous persistence after measurement. Further work must reduce
PostgreSQL transaction/advisory-lock cost or introduce a durable, lossless raw sink queue before
making async batch persistence a default.

### 2026-09-15 bounded raw-observation batch coalescing

Commit `bc372d4` introduces a bounded raw canonical side-lane batcher. It coalesces up to
`ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_ROWS` observations over
`ANYSENTRY_CANONICAL_ASYNC_RAW_BATCH_WINDOW_MS`, uses the existing `saveRawObservations([...])`
transaction/idempotency fence, and records a CoverageGap for every batch member when the sink fails.
Queue capacity is bounded by the configured in-flight batch limit and batch row limit; shutdown drains
pending entries into explicit dropped/gap accounting instead of acknowledging them silently.

A clean-WAL runtime canary (`async persistence on`, 64 in-flight batches, 512 rows, 50 ms window)
reduced Observer batch latency to roughly 30–320 ms and kept the Collector delivery channel healthy
with queue/spool at zero and no Observer drops. The same 90-second window still reported raw-side
persistence pressure: 9,428 async observations scheduled, 8,939 completed, 96 failed, and 5,240
async admissions dropped; the separate CoverageGap persistence lane also reported 15,496 dropped
writes. The canary therefore improves F2 delivery but does not satisfy the canonical no-gap gate.
The async canary was reverted to synchronous persistence after measurement. Further work must reduce
PostgreSQL transaction/advisory-lock cost or introduce a durable, lossless raw sink queue before
making async batch persistence a default.

### 2026-09-15 raw batch queue byte bound

Commit `11eff9e` adds an explicit byte bound to the asynchronous raw batch queue in addition to
row count, in-flight batch count, and time window. Queue diagnostics now expose rows, bytes, and
configured limits through `canonicalObservability.gaps`; the shutdown path clears the byte accounting
while recording every pending item as a coverage/drop outcome. The deterministic raw batching test
continues to pass after this change.

### 2026-09-15 PostgreSQL raw-write advisory-lock removal

Commit `966ff06` removes the global `pg_advisory_xact_lock('anysentry.raw_observations.v1')`
from `saveRawObservations`. The unique `(observation_id, revision)` and idempotency keys still
serialize conflicting inserts; conflict detection now runs after the insert inside the same
transaction and rolls back the current batch when an existing payload differs. This keeps identical
retries idempotent without serializing every unrelated raw batch.

Runtime evidence before the change showed one PostgreSQL session waiting on
`wait_event=advisory` while another held the same raw-observation lock. After deploying the change,
`advisory_waiters=0`; remaining database waits were `WALWrite`/`WalSync`. Synchronous canonical
writes still showed per-batch `canonicalObservationMs` in the sub-second-to-several-second range,
confirming the next bottleneck is per-observation transaction/WAL work rather than the global lock.
The async batch canary after this change drained its raw queue (`asyncRawBatchQueueRows=0`) but still
accumulated admission and CoverageGap pressure under the full host event rate, so async mode remains
reverted for the stable runtime.

### 2026-09-15 raw unique-key conflict handling and redeploy

Commit `973483a` changes the raw-observation insert to `ON CONFLICT DO NOTHING`. The table has two
 independent unique keys, `(observation_id, revision)` and `(idempotency_key, revision)`; targeting
 only the first key caused the old image to emit duplicate-key warnings when a retry collided on
 the second key. The existing post-insert payload comparison remains the rejection path for a
 conflicting record, so this change handles either retry key without accepting a different payload.

The API image `127.0.0.1:5000/anysentry:raw-unique-973483a` was built from `973483a`, pushed to the
local registry with digest
`sha256:398e22b0c14333e89cbc6f00fcb778c2c678d15bfabf062574aa3235ed4e0bd2`, and rolled out as the
only ready API replica. The previous `raw-no-advisory-966ff06` pod was allowed to terminate; the
PostgreSQL, ClickHouse, Redis and Observer infrastructure remained running. During the first two
minutes after readiness, the new API log contained no duplicate-key or raw-save warnings. This is
an initial runtime regression check, not yet a sustained load or canonical point-read acceptance.

### 2026-09-15 A/B 冷启动 settle 闸门复核

本轮在不改变 AnySentry/Observer 产品代码的前提下重新执行 customer-langgraph-sim-lab。Design A 真实调用返回 `completed/pass`；应用侧同一 `run_id=session_id` 下包含 `plan`、`work`、`verify`、模型交互和 sandbox 工具调用，模型网关与 sandbox 均返回 200。

Design B 首次在 12 秒固定启动等待后执行时，canonical 查询已经返回 `coverage.completeness=exact_as_observed`、`partial=false`，但当前 run 只有 `/v1/chat/completions`，工具部分仍为 `tool_pending`。Collector 重组日志确认请求和响应均完成，critical/semantic/bulk 队列和 output drop 均为 0，因此该结果不能归因于 Ring 或 Forwarder 丢失。

### 2026-09-15 clean spool stability follow-up

重启并切换到开发机专用的空 spool 后，当前 Observer Pod 为 `a3s-observer-79mjs`，旧 customer LangGraph 容器、网络、volume 和本轮临时证据目录均已清理。Collector health 仍报告 `filterMetricsReported=true`、`identitySnapshotReady=true`、规则版本非零，且新增 `droppedEvents=0`、`queueDropped=0`、`outputDropped=0`；不过事件输入速率仍高于当前 F2/F3 发送速率，队列从约 1,900 增至约 4,630，delivery 状态保持 `degraded/spool_backlog_over_slo`。因此这次复核证明了清理后没有新的无界丢失，但尚不能作为持续稳定性通过。`FORWARD_MAX_INFLIGHT=4` 与 `FORWARD_BATCH_MAX_BYTES=131072` 保持有界配置，未为追求排空积压而全局放开采集或无界提高并发；后续验收必须先证明队列收敛，再进行重复真实服务测试。

同一开发机上做了一个短时 F3 对照：将 AnySentry 的 `ANYSENTRY_CANONICAL_PERSIST` 临时设为 `off` 后，Collector 队列从约 9,300 降到约 4,370，新增 `droppedEvents/outputDropped/queueDropped` 仍为 0；恢复部署时已重新设置 `ANYSENTRY_CANONICAL_PERSIST=on`、`ANYSENTRY_CANONICAL_ASYNC_PERSIST=on`、`ANYSENTRY_CANONICAL_ASYNC_PERSIST_MAX_INFLIGHT=4`，并清理旧 Pod。该对照把容量瓶颈定位到 canonical durable persistence/F3 处理路径，而不是 eBPF Ring 或前置过滤；它不构成关闭持久化的产品方案，也不构成稳定性通过证据。

更正此前的部署结论：曾把 `f7d9207` 的 API `dist` 复制到旧 Pod，随后删除了该 Pod。副本重建会从 Deployment 镜像恢复，复制内容不会保留。当前 Pod 文件 SHA-256 为 `4760a017932bc59be9e95f26f5a70b867794202001eccbb8b519c7704247f756`，且没有 `enqueueKernelFact`；因此原先声称“批量代码已在真实进程启动”的结论撤回。队列与 A/B 观测仍是旧镜像配合运行参数的证据，不能归因于 `f7d9207`。后续必须在 digest 部署后比较容器内代码哈希，再做持久化验收。

随后将开发机 Observer Forwarder 的有界单批配置从 `FORWARD_BATCH_SIZE=128`、`FORWARD_BATCH_MAX_BYTES=131072` 调整为 `512` 和 `524288`，保持 `FORWARD_MAX_INFLIGHT=4` 不变。滚动替换旧 Pod 后，Collector 连续两个 45 秒窗口分别报告 `healthy/queueDepth=184` 和 `healthy/queueDepth=0`，`droppedEvents=0`、`outputDropped=0`、`queueDropped=0`。这些短窗口与扩大有限批次后吞吐改善一致，但同时发生 Pod 重启，尚不能独立证明瓶颈或长期稳定；仍需在该基线下重新执行真实 A/B LangGraph 和 canonical 完整点查。

在该稳定基线下重新执行 customer LangGraph：

- Design B：完成一次真实 `/runs`，canonical 查询返回 7 条 interaction，`completeness=exact_as_observed`、`partial=false`，路径包含 `/runs`、`/v1/chat/completions`、`/execute`，来源为 `tcp_plaintext`，`transport_incomplete=0`；conversation-directory 找到父 orchestrator 与 worker 两个 LangGraph thread，timeline 均包含工具调用和工具结果。
- Design A：同进程子图完成一次真实 `/runs`，canonical 查询返回 8 条 interaction，`completeness=exact_as_observed`、`partial=false`，每条 interaction 的 `transportCompleteness=complete`，并保留同一 run/trace 的 Session 归属与 KernelFact 进程代次。

两种方案测试结束后已停止并清理 customer compose 容器、volume 和 network；AnySentry/Observer 基础设施保持运行。

A/B 完成后的受控观察窗口中，Collector 有一次 API health 请求超时，随后两个连续采样恢复为 `healthy`，队列分别为 `0` 和 `8`，输入约 3,270 events/min，`droppedEvents=0`、`outputDropped=0`。这属于查询面瞬时繁忙，不能直接等价为事件丢失；后续长稳报告仍需把 API 查询延迟和 F3 delivery 状态分开记录。

最终本地接缝复核还通过了 canonical identity/session、canonical contract、raw side-lane batching、Session membership durable read、behavior discovery、Candidate attribution、2,000-rule performance 和 S5 capture profile。2026-09-15 10:28 的 Collector health 为 `healthy`，`queueDepth=0`、`droppedEvents=0`、`outputDropped=0`，规则模式为 `enforce`，`identitySnapshotReady=true`，`unifiedProjectionState=ready`。

Observer 分支随后执行了完整 `cargo test --workspace`：`a3s-observer` 35 tests、workload contract 7 tests、collector 200 tests、common 9 tests 全部通过；其中 collector 包含 TLS attach、classic SSL、TLS scope、Ring admission、process generation、bounded pipeline、interaction reassembly 和 capture profile 测试。该结果是代码级覆盖证据，不替代真实容器中的 TLS/OCI 镜像验收。

`f3f8aae` 已通过依赖相同的 runtime overlay 构建并推送到开发机 loopback registry：`127.0.0.1:5000/anysentry@sha256:033d38d5b381245ed3e6518813f58a0e5d8a566cb3acc95c783aa44ff6c13d5a`。Deployment 已滚动到该 digest，旧 Replica 已清理；容器内 `canonical-observability.service.js` SHA-256 与本地 `apps/api/dist` 均为 `e904cd5ed124dca44c1032ffec6f36e486305ffb0a5394fabd05dd981fa61d05`。新代码的 health snapshot 暴露 KernelFact batch rows/bytes/maxBytes，Collector 随后报告 `healthy/queueDepth=0/droppedEvents=0/outputDropped=0`。

正式 digest 运行后，`ANYSENTRY_CANONICAL_ASYNC_PERSIST_MAX_INFLIGHT=4` 的初始窗口出现 `asyncPersistenceDropped` 增长，虽然 KernelFact 队列有界、Collector `droppedEvents/outputDropped/queueDropped` 保持 0。将该并发提高到 16/32 的短时对照仍有增长并使 API health 出现超时，因此已恢复 4，不把提高并发当作修复。该结果定位了剩余缺口：semantic/raw 相关 canonical durable side lane 仍可能因共享异步槽位饱和形成显式 CoverageGap；需继续做按 lane 的批量持久化和独立容量控制后，才能通过 canonical 无缺口验收。

将受控实验的 Observer startup settle 闸门扩大到 30 秒后重跑，得到当前 run 的 5 条 interaction，路径同时包含 `/v1/chat/completions` 和 `/execute`，来源为 `tcp_plaintext`，无 transport incomplete；conversation-directory 找到编排器和 worker 两个 LangGraph 线程，timeline 均包含 `tool_call` 与 `tool_result`。A/B compose 容器、网络、volume 和本轮 `.runtime` 证据目录已清理。

该复核确认：应用健康不代表新容器的 F1 规则、进程 admission 和工具后端捕获资格已经稳定。startup settle 只能作为测试闸门，不能把缺失证据标记为成功；后续应把规则 epoch、工作负载 identity readiness 和 tool-backend capture readiness 暴露为可轮询条件，减少对固定睡眠时间的依赖。

### 2026-09-15 bounded persistence-wait deployment

Commit `4513bc6` adds a bounded wait (default 250 ms, maximum 2 s) before rejecting an asynchronous canonical side-lane admission when all persistence slots are occupied. The implementation was built into `127.0.0.1:5000/anysentry:backpressure-4513bc6` and deployed as digest `sha256:7369a720ad5a1f760a650e326fda108cfa3983903204d8e480be5d9de74576b`; the new Pod became Ready and the previous Pod was removed. The startup path took about 58 seconds while PostgreSQL and ClickHouse connections initialized, then reported `Nest application successfully started`.

After deployment, the Collector remained active with `droppedEvents=0`, `outputDropped=0`, and `queueDropped=0`; the current Collector queue was bounded but degraded while it caught up. The canonical health samples showed bounded KernelFact queues (0--98 rows, 0--42,684 bytes) and no unbounded memory growth, but `asyncPersistenceDropped` continued to rise (1,285 -> 1,403 in a 30-second sample) and `asyncPersistenceFailed` remained at 321. The bounded wait therefore prevents an unbounded queue but does not yet provide canonical durable no-gap behavior. This is the current remaining F3 bottleneck; it must be addressed with independent lane capacity or a durable lossless handoff before claiming canonical Session/semantic projection stability.

The health query also exposed historical Collector identities as `down`; the live Observer logs showed the current process forwarding events and reporting zero pipeline drops. These are separate stale health records and should not be used as evidence that the current Ring/Forwarder dropped events. A follow-up must reconcile Collector heartbeat identity and run a fresh A/B request against the new digest before the final canonical point-read gate.

### 2026-09-15 derived persistence lane isolation

Commit `bb9b58b` separates asynchronous derived canonical writes (SemanticRecord, EvidenceLink and
SessionMembership) from the bounded Raw/KernelFact persistence pool. Commit `6827955` adds lane
specific admission counters and a deterministic isolation test. The API image containing both
changes was deployed as digest
`sha256:b216492184025bd3cfc8603732a76a2eff8e7494a1ef6660108be5e042420c61`.

On the first deployment with `ANYSENTRY_CANONICAL_ASYNC_DERIVED_MAX_INFLIGHT=4`, the health
snapshot showed `asyncRawPersistenceDropped=0` and `asyncDerivedPersistenceDropped=4,352`; this
proved the remaining drops were in the derived lane rather than Raw/Kernel admission. A bounded
runtime comparison at derived concurrency 16 reduced the short-window increase but did not make it
zero: `asyncPersistenceDropped` increased from 1,156 to 1,190 in 15 seconds, while both raw and
kernel queues drained to zero and `asyncPersistenceFailed=0`. PostgreSQL showed WALWrite/WalSync
waits, and the API remained within its configured memory limit. The concurrency change is retained
as a bounded development-machine setting, not treated as a durable-loss fix. Canonical no-gap
acceptance and A/B point-read verification remain open.

### 2026-09-15 derived lane bounded concurrency comparison

After the lane-specific metrics deployment, the development Deployment was rolled with
`ANYSENTRY_CANONICAL_ASYNC_DERIVED_MAX_INFLIGHT=16` while the Raw/Kernel lane remained at its
bounded default. In two 15-second health samples, `asyncRawPersistenceDropped` stayed at zero,
Raw/Kernel queue rows fell from 631/625 to zero, and `asyncPersistenceFailed` stayed at zero.
Derived admission drops nevertheless increased from 1,156 to 1,190. This is a controlled
capacity comparison, not a no-loss result: increasing bounded concurrency does not remove the
PostgreSQL/WAL throughput limit. Further work should reduce transaction/query count through
projection batching and preserve the current bounded limits rather than globally opening capture
or creating an unbounded retry queue.

### Semantic microbatch boundary verification

The next local implementation coalesces same-window `saveSemanticRecords` calls in the relational
store, preserving the existing SQL conflict checks. Its outstanding budget includes queued and
in-flight records (default 4,096 rows / 8 MiB), with a 10 ms window and 128-row coalescing target.
An individual caller remains atomic and may exceed the coalescing target within the outstanding
budget. Oversized admissions return false. Records are snapshotted on admission; conflicting
independent callers are split into separate batches. Shutdown rejects new semantic admissions and
waits for both the active write and trailing queue before ending the database pool.

`verify-relational-semantic-batching.mjs` verifies coalescing, immutable snapshots, conflicting
caller separation, byte/row capacity including active writes, failed sink propagation and shutdown
drain against a controlled sink. API compilation and existing canonical contract/raw/kernel/lane
tests pass. This is module-level evidence; database throughput and A/B canonical completeness have
not yet been verified with this implementation.

Correction to causal claims above: lane counters identify derived **admission** rejection, while
database activity snapshots show WAL waits. These observations do not isolate WAL as the sole root
cause, nor do zero raw-admission drops prove complete raw durability or end-to-end capture. Future
comparisons must include durable point reads, write failures, query latency and all pipeline drops.

### 2026-09-15 semantic durable microbatch deployment

Commit `7107a45` adds a bounded relational SemanticRecord microbatcher. It snapshots accepted
records, limits combined queued plus in-flight work to 4,096 rows/8 MiB by default, coalesces up
to 128 rows per SQL call over a 10 ms window, isolates conflicting callers, and drains admitted
work during shutdown. The deterministic module test passed together with the canonical contract,
raw batch, kernel batch and lane-isolation tests.

The resulting API image was deployed as digest
`sha256:39bf93b5d92ee7ea581ee24464bd0423539cbc13b9838742aa8b6fc8b98fe656`. Startup took about 86
seconds on this development host; the old Pod was removed after the new Pod became Ready. In the
first controlled post-deploy samples, `asyncRawPersistenceDropped=0`, `asyncPersistenceFailed=0`,
Raw/Kernel queues returned to zero between samples, and Derived drops increased 220 -> 225 -> 268
across the observed windows. This is an improvement over the previous Derived-only lane sample,
but it is not a no-gap result because EvidenceLink and SessionMembership are not yet microbatched
and canonical durable point reads have not yet been rerun.

### 2026-09-16 tip 8442bda digest deploy and Design B point-read

Deployed local tip `8442bda` (`perf(canonical): batch evidence and session projections`) as
`127.0.0.1:5000/anysentry@sha256:5e5b4e0bd267693c2fcf983413b207fde56c323e4b9f81f91df339e25ad9dd0a`.
Container `relational-business-store.service.js` SHA-256 matched the local dist
(`69b194d6e3d31fca7b8a83f809f86305f154345251a85e721c4beb3e7fad7056`), confirming EvidenceLink and
SessionMembership projection microbatch code is live. The previous Pod on digest `39bf93b5…`
was removed after the new Pod became Ready.

Controlled Design B lab (`COMPOSE_PROJECT_NAME=langgraph-goal-182615`) completed
`POST /runs` with `status=completed` and `verify_status=pass`,
`run_id=session_id=ffd2f4ce-1965-4934-919b-d279b9e28a5f`,
`trace_id=3ba0c6dc2c5be15b2b89dc0e33fc2633`. After Observer settle, canonical
`POST /agents/interactions` returned **8** items with
`coverage.completeness=exact_as_observed` and `partial=false`. Items included
`remote_agent` (`worker-agent:18091`), model calls, and tool calls to `tool-mocks:18092`,
all `captureSource=tcp_plaintext`.

Conversation list for the run included parent `cv_0be58fba7119961c80923482` (LangGraph) with
`relatedConversations` `delegates_to` → worker `cv_94342f06b1e96db450c3e182`
(`displayName=customer-langgraph-sim-worker`, strength `exact`) and a second same-run peer.
`timeline-v3` for the parent showed `delegation_send`/`delegation_reply` plus tool events;
the worker timeline showed `tool_call`/`tool_result` without parent-internal duplication.

Post-run health on the new digest: `semantic.dropped=0`, `evidence.dropped=0`,
`sessionMembership.dropped=0`. Hot ring occupancy remained high from ambient host traffic and is
recorded separately from durable derived admission. Module tests
`verify-relational-projection-batching.mjs`, `verify-relational-semantic-batching.mjs`, and
`verify-canonical-lane-isolation.mjs` passed before deploy.

Remaining open gates unchanged in scope: sustained no-gap under prolonged ambient load,
classic SSL WIP, and readiness polling instead of fixed settle sleeps. Lab compose project
`langgraph-goal-182615` is cleaned after this evidence record; infrastructure and classic SSL WIP
were not modified.

### 2026-09-16 Phase C pollable Observer readiness gate

Replaced the Design B fixed `OBSERVER_STARTUP_SETTLE_SECONDS` sleep with
`AnySentry/scripts/wait-observer-readiness.mjs`, wired from
`customer-langgraph-sim-lab/scripts/verify-observer.sh`.

**Plane gates (always):** `collectors/health` must report
`filterMetricsReported`, `identitySnapshotReady`, `unifiedProjectionState=ready`,
`captureProfileControlPlaneState=ready` (when present), and optional `dockerReady`.

**Cold-start docker signal:** host compose labs are gated on
`filterMetrics.dockerEntries >= OBSERVER_READY_MIN_DOCKER_ENTRIES` (Design B default 4).
Observer logs confirmed `docker snapshot ... containers=7; confirmed_agents=2;
cold_start_candidates=1` while the lab was up. Platform `GET /identity/snapshot` still
does **not** list labeled compose agents (`customer-langgraph-sim-orchestrator` /
`customer-langgraph-sim-worker`); requiring those agent ids there times out and is not
used as the default lab gate.

**Live evidence (`COMPOSE_PROJECT_NAME=langgraph-ready-1904`):** readiness became ready in
**89 ms** (`dockerEntries=7`, plane reasons empty). Controlled `POST /runs` completed with
`verify_status=pass`, `run_id=session_id=23140878-efb1-4e69-9cae-a8e8bf4a9bff`,
`trace_id=b8ecaf5ea5e621a65f74a5280b59c21e`. Canonical interactions: **6** items,
`coverage.completeness=exact_as_observed`, `partial=false`, paths
`/runs` `/v1/chat/completions` `/execute`, `captureSource=tcp_plaintext`,
`transport_incomplete=0` (2 interactions still `tool_pending`). Conversation directory
found parent `cv_2088da325cf7872bb551d8d5` with `relatedConversations` `delegates_to` →
worker `cv_6e829263405579fefb9910b1` at strength `exact`.

**Honest gap:** `timeline-v3` for both directory ids (and their
`redirectTarget`/`canonicalConversationId` `cv_a2338a87ff9b9462e73f51b7`) stayed
`turns=[]` / `coverage.partial=true` for >40s after interactions were exact. Verifier now
polls timelines with redirect follow-up, but this run did not fill. Not treated as a
readiness-gate failure.

Lab project `langgraph-ready-1904` cleaned after this record. Classic SSL WIP and
infrastructure were not modified. Goal remains open for sustained no-gap and SSL WIP.

### 2026-09-16 Design B hop-fence: empty timeline alias collapse fixed

**Root cause:** conversation projection already applied `hopConversationFence` so Design B
parent/worker kept independent directory Conversations, but resolver v2 merged them by
shared `runId`/`sessionId`/`providerConversationId` into one canonical Thread and then
route-aliased both ids onto an empty target (`turns=[]`, `coverage.partial=true`).

**Fix:** export shared `hopConversationFence` from `agent-conversation-resolution-v2`,
apply it in `anchorScopeKey` / canonical id minting, and refuse `canMerge` when hop
fences disagree. Module test `verify-agent-conversation-resolution-v2.mjs` covers the
shared-run Design B case.

**Digest deploy:** thin overlay on tip `5e5b4e0bd267…` as
`127.0.0.1:5000/anysentry@sha256:c13fc66acd14e21408bbe5cef976f798b104e83709da70ba563581568b02a3b8`
(`hop-fence-d36119f`). Container
`agent-conversation-resolution-v2.js` SHA-256 matched local dist
(`92dc565dd4176d272b5f84473ba96015cd5331ba01a6e896b212995b589c2499`).

**Design B re-verify** (`COMPOSE_PROJECT_NAME=langgraph-hop-194244`): readiness ready in
101 ms (`dockerEntries=4`). Run `3b9cc27d-088a-4724-8d20-aab5f7de4f8b` /
`trace_id=573a22107fa64db38c12ebb9130ea499` completed. Interactions **8**,
`exact_as_observed`, paths `/runs` `/v1/chat/completions` `/execute`,
`tcp_plaintext`. Directory: parent `cv_e0c0809deae5c39b54ba77f9` and worker
`cv_181c7c2d2a1f8a742f4382cf`. Timelines non-empty without cross-alias collapse:
parent kinds include `delegation_send`/`delegation_reply` plus tools; worker kinds
include `tool_call`/`tool_result` / `model_final`.

Lab cleaned after evidence. Classic SSL WIP untouched. Remaining open: sustained no-gap,
classic SSL WIP.

### 2026-09-16 derived coalescing: ambient derived drops closed on e3f82106

**Problem:** after evidence/session microbatch (`8442bda`), ambient host traffic still
incremented `asyncDerivedPersistenceDropped` (+127 over a prior 60s window) because each
derived Semantic/Evidence/Session write held an in-flight slot for the full SQL round trip
and expired the 250 ms admission wait.

**Fix:** coalesce derived Semantic / EvidenceLink / SessionMembership writes behind the same
bounded-queue pattern as Raw/Kernel (`ANYSENTRY_CANONICAL_ASYNC_DERIVED_BATCH_*`): one
derived slot per flush, queue later admissions instead of wait-timeout drops, expose
`asyncDerivedBatchQueueRows` in health gaps. Module test
`verify-canonical-derived-batching.mjs` passed.

**Digest deploy:** thin overlay tagged `derived-batch-753327b` as
`127.0.0.1:5000/anysentry@sha256:e3f8210665e556de89c0e62ce5d9ecb532851e2b09d2009749594251cf4b2399`.
Container `canonical-observability.service.js` SHA-256 matched local dist
(`e50d08b8ca62b6a54355ec70849b969a407fe175836cb6cc7b4bbd329d2085c1`). New Pod
`anysentry-5b75bc495c-crsj2` Ready; port-forward retargeted off the terminating prior Pod.

**Ambient 60s health delta** (no Design B lab, new digest uptime ~198→261s):
`asyncDerivedPersistenceDropped` 0→0, `asyncRawPersistenceDropped` 0→0,
`asyncPersistenceFailed` 0→0, `asyncDerivedBatchQueueRows` present and 0→0.

**Ambient 300s follow-up** (uptime ~1747→2047s): derived drops remained 0→0 and
`asyncPersistenceFailed` 0→0, but `asyncRawPersistenceDropped` had already reached
**178** before the window and stayed flat (178→178). Derived coalescing therefore stops
the prior ambient derived-slot regression; raw-lane loss during the intervening period
still blocks claiming full sustained no-gap.

**Design B spot-check blocked (host Docker):** after the ambient samples, `docker compose`
build/create hung; `dockerd` PID 2233 became zombie with sibling threads stuck in
uninterruptible `D` on `ovl_sync_fs` / `sync_inodes_sb` during overlay unmount. Docker
restart fails while that PID exists (`process with PID 2233 is still running`). K8s /
AnySentry API (containerd) stayed Ready on digest `e3f82106…` with derived drops still
zero. Lab compose was not left running; no infrastructure or classic SSL WIP changes.
Design B point-read under this digest remains pending until host Docker recovers.

Remaining open: Design B point-read on this digest, raw-lane no-gap investigation,
longer sustained no-gap, classic SSL WIP.

### 2026-09-16 maxInFlight=8 ambient: raw+derived drops flat 300s

After derived coalescing on digest `e3f82106…`, a later ambient window on the same
digest (maxInFlight still 4) showed `asyncRawPersistenceDropped` already at **178**
with flat growth afterward. Controlled env-only bump
`ANYSENTRY_CANONICAL_ASYNC_PERSIST_MAX_INFLIGHT=4→8` (same digest, image already on
node; no rebuild). New Pod `anysentry-8694b754d5-wnclr` Ready.

**120s + 300s ambient samples** on the new Pod: `asyncRawPersistenceDropped` 0→0,
`asyncDerivedPersistenceDropped` 0→0, `asyncPersistenceFailed` 0→0 throughout.
Raw queue oscillated (0–138 rows) while raw in-flight often saturated at 8 and still
drained between bursts; healthz remained responsive (no prior 16/32 timeout
regression). CoverageGap `persistenceDropped` continued to rise and is recorded as a
separate gap-store counter, not canonical raw/derived admission.

Host Docker briefly cleared its earlier zombie, then failed to finish starting
(`volumes/metadata.db` open timeout; restore stuck on overlay writeback while other
host processes including Postgres checkpointer were also in `D`). Design B point-read
on this digest remains blocked until host Docker is healthy again. Classic SSL WIP
untouched. Goal remains open.

### 2026-09-16 host Design B point-read while Docker down

System Docker remained `failed`; disposable lab dockerd also hung on buildkit. Ran
Design B on the host venv instead (sandbox `:18088`, tool-mocks `:18092`, worker
`:18091`, orchestrator `:18090`) with localhost URL overrides.

**Run:** `status=completed` `verify_status=pass`
`run_id=session_id=6aa2f931-3750-4dc2-98d9-3f4ad8b9e8c7`
`trace_id=54ba22b23e8593e05abc9373ed1abef7`.

**Interactions:** **6** items for the run, all `captureSource=tcp_plaintext`, paths
`/runs` `/v1/chat/completions` `/execute`, hops `orchestrator`/`worker`. Post-run
health: `asyncRawPersistenceDropped=0`, `asyncDerivedPersistenceDropped=0`,
`asyncPersistenceFailed=0` on digest `e3f82106…` / maxInFlight=8.

**Directory:** parent `cv_0e6d5220e59cf2b4d8078fae` `delegates_to` worker
`cv_a1625ba75236993e27d33b3e` at strength `exact` (hop-fence held; no alias collapse).

**Timelines:** parent events include `delegation_send`/`delegation_reply` plus plan
tools; worker events include `tool_call`/`tool_result`/`model_final`. Coverage reports
`partial=true` with `partialReason=scan_limit` (ambient ClickHouse window), not empty
turns.

**Honest coverage boundary:** without Docker labels, agent product resolved as host
`user@1001.service` / `environment=host` rather than
`customer-langgraph-sim-{orchestrator,worker}`. Docker-labeled cold-start attribution
and Observer `dockerEntries` readiness remain pending until host Docker recovers.
Host lab processes stopped after evidence. Classic SSL WIP untouched.

### 2026-09-16 host Design B Session/EvidenceLink/KernelFact point-read

Follow-up durable reads for run `6aa2f931-3750-4dc2-98d9-3f4ad8b9e8c7` /
canonical session `sess_b7c54d5cc5cf3595c255861a` on digest `e3f82106…`:

- `GET /v1/sessions/sess_b7c54…` **200**; coverage endpoint reports
  `status=partial` with `completeInteractions=3`, `partialInteractions=2`
  (not `coverage=complete`).
- `GET /v1/evidence-links` matched **4** links for the run's observation refs:
  two **strong** (`network_effect` / `executes_as`+`command`) targeting
  `kf_4b30382…` and `kf_ce66cb0…`, plus one unmatched `executes_as` (honest gap).
- `GET /v1/kernel-facts/{id}` for both strong targets **200** with
  `coverage.status=complete` and `authority=attested_observer`
  (`kind=network` and `kind=exec`).

Observer spool at check time: active≈258, parked=0, `spoolAtCapacity=false`,
collector `droppedEvents/outputDropped/queueDropped=0` — no disposable WAL
cleanup required. Docker-labeled Design B and session `coverage=complete` remain
open. Classic SSL WIP untouched.

### 2026-09-16 Session coverage respects P2 tool-closure

**Bug:** `GET /v1/sessions/:id/coverage` rebuilt coverage from durable
`SemanticRecord.completeness`, which still stored Observer single-row
`tool_result_pending` after a later interaction closed the tool call. Conversation
directory already reported `coverage=complete` via P2 closure for the same run.

**Fix:** export `conversationCoverage` and, on exact Session reads that already load
membership interactions, recompute Session coverage from that interaction set after
durable reconcile (hostPath overlay of `security-monitoring.controller.js` +
`agent-conversation.js` while Docker image rebuild remains blocked).

**Point-read:** session `sess_b7c54d5cc5cf3595c255861a` now returns
`coverage.status=complete`, `completeInteractions=6`, `partialInteractions=0`.
Raw/derived async drops remain 0 on digest `e3f82106…` / maxInFlight=8.

### 2026-09-16 host Design B re-verify after Session coverage fix

Module test `verify-session-coverage-tool-closure.mjs` passed. Fresh host Design B
run `6d903f4c-80d4-401a-964b-951e14621438` /
`trace_id=2e7003753cf2455c1c9c467b5fae4221` completed with `verify_status=pass`.
Canonical session `sess_22b7e932f8a1f132d6691de0` point-read:
`coverage.status=complete`, `completeInteractions=7`, `partialInteractions=0`.
Post-run `asyncRawPersistenceDropped=0`, `asyncDerivedPersistenceDropped=0`.
Host lab cleaned. System Docker still stuck at buildkit init; tip remains
hostPath-overlaid on digest `e3f82106…` until an image rebuild is possible.

### 2026-09-16 ambient 60s no-gap + Docker recover attempt

**Ambient 60s health delta** on digest `e3f82106…` / maxInFlight=8 / hostPath
Session-coverage overlay (uptime ~845→905s):

| counter | Δ |
| --- | ---: |
| `asyncRawPersistenceDropped` | 0 |
| `asyncDerivedPersistenceDropped` | 0 |
| `asyncPersistenceDropped` | 0 |
| `asyncPersistenceFailed` | 0 |
| `persistenceDropped` (legacy non-async) | +2165 |

Raw/derived queues grew under host I/O pressure (`asyncRawBatchQueueRows`
128→1041) but did not admit explicit async CoverageGaps in this window.

**Docker:** quarantined disposable buildkit DBs (`cache.db` / `history_c8d.db` /
`metadata_v2.db`); daemon returned to `active`. Tip thin-overlay rebuild then
stalled on saturated NVMe write latency (≈3s await, many D-state tasks including
system `containerd`/`dockerd`), so digest bake of tip `c18ec52` and
Docker-labeled Design B remain open. Classic SSL WIP untouched.

### 2026-09-16 tip Session-coverage digest deploy (no hostPath)

Bypassed hung `dockerd` create/build by exporting base digest `e3f82106…` from
k3s containerd, appending an OCI layer with tip `c18ec52`
`security-monitoring.controller.js` + `agent-conversation.js`, and importing a
slim OCI archive (`ctr images import --local --no-unpack`). Deployed:

- Image: `127.0.0.1:5000/anysentry@sha256:cdcf85f884503a2ddd2d516592e55c18c76298bc64aa53872e5d37bb6779cbe5`
- Pod: `anysentry-6d6f9975f6-wpblw` Ready; `imageID` matches the tip digest
- hostPath `local-session-coverage-fix` removed from Deployment/Pod
- In-container SHA-256 matches tip `apps/api/dist` for both JS files
  (`645edb1b…` / `24277708…`)

**Ambient 30s** on the new digest (uptime 230→260s): async raw/derived/
persistence dropped and failed deltas all **0**. Docker-labeled Design B still
open (compose/`docker run` still I/O-fragile). Classic SSL WIP untouched.

### 2026-09-16 tip digest host Design B point-read (no hostPath)

Host uvicorn Design B against digest `cdcf85f8…` / pod
`anysentry-6d6f9975f6-wpblw` (no `local-session-coverage-fix` mounts).

- Run `6769cb33-986f-439b-99bd-73a287caf809` /
  `trace_id=5da0a34e0b45f57cbfae6833e5e6e435` → `status=completed`,
  `verify_status=pass`, sandbox stdout `4`, `parent_session_id` +
  `delegation_id=cceb26df-…` present.
- Canonical `POST /agents/interactions`: **6** items,
  `coverage.completeness=exact_as_observed`, `partial=false`, paths
  `/v1/chat/completions` `/execute` `/runs`.
- Session `sess_b03844c48d6b62ac080a74df` coverage
  `status=complete`, `completeInteractions=6`, `partialInteractions=0`.
- Async raw/derived/persistence dropped remain **0** on the tip digest.

**Coverage boundary:** host attribution (no Docker labels /
`dockerEntries`); labeled Design B still blocked by host `docker create`
hangs under NVMe saturation. Classic SSL WIP untouched. Lab ports cleaned.

### 2026-09-17 labeled Design B still blocked; tip ambient 120s

`docker compose` / sequential `docker run` for labeled Design B timed out while
creating containers (NVMe write await multi-second; many `Created` ghosts pruned).
Docker daemon remains `active`, but container create is not reliable for lab bring-up.

**Ambient 120s** on tip digest `cdcf85f8…` / pod `anysentry-6d6f9975f6-wpblw`
(uptime ~39891→40011s):

| counter | absolute | Δ120s |
| --- | ---: | ---: |
| `asyncRawPersistenceDropped` | 2115 | 0 |
| `asyncDerivedPersistenceDropped` | 0 | 0 |
| `asyncPersistenceDropped` | 2115 | 0 |
| `asyncPersistenceFailed` | 0 | 0 |

Overnight ambient load accumulated **2115** raw-lane CoverageGaps; the sampled
window did not add more. Sustained no-gap remains open pending raw-lane capacity
work. Labeled Design B and classic SSL WIP still open.

### 2026-09-17 host capacity gate + KernelFact drop attribution

Added `scripts/check-host-capacity.sh` (load / MemAvailable / swap / disk /
PSI io / nvme util / D-state / docker Created). Lab host sample at 10:19+08:
load≈23/16, PSI io full avg10≈69%, nvme util≈95–99%, swap≈3.5Gi → **NO-GO**
for docker create/compose; memory headroom still OK (~20Gi available).

**Bugfix (code):** `enqueueKernelFact` overflow previously incremented
`asyncRawPersistenceDropped`. KernelFact CoverageGaps are now counted as
`asyncKernelPersistenceDropped` (and still in `asyncPersistenceDropped`).
`verify-canonical-kernel-batching.mjs` asserts raw counters stay flat on
kernel byte-bound/close drops. Tip digest image not yet rebuilt under NO-GO I/O;
live pod still reports historical rawDrop=2115 which may include misattributed
kernel overflows until tip redeploy.

### 2026-09-17 KernelFact lane capacity isolation

Kernel durable batches no longer share `asyncPersistenceInFlight` with raw.
New bounded pool `ANYSENTRY_CANONICAL_ASYNC_KERNEL_MAX_INFLIGHT` (default 4)
with `asyncKernelPersistenceInFlight` metrics. Verifier confirms kernel flush
proceeds while a raw side-lane slot is held.

### 2026-09-17 tip digest deploy (kernel-isol) — verified

Bypassed hung `docker create` via k3s slim OCI import (`--local --no-unpack`)
as `kernel-isol-5c9d25f`. Deployment image:
`127.0.0.1:5000/anysentry@sha256:dc90e4f31de5a0eed7d66e004b26f442a6293356e092f8cf93137bd7005b0885`
with `ANYSENTRY_CANONICAL_ASYNC_KERNEL_MAX_INFLIGHT=4`, no hostPath overlay.

Pod `anysentry-5867c447f8-ckj5t` Ready after ~5m (Nest start delayed under I/O;
startup probe connection-refused until listen). In-pod checks:
- dist symbol `asyncKernelPersistenceMaxInFlight` present
- healthz gaps: raw/kernel/derived drops **0**; `kernelMax=4`
- Δ60s ambient sample: raw/kernel/derived/total drops **0** (uptime≈365s)
- Δ120s ambient sample after sole replica: raw/kernel/derived/total drops **0**
  (uptime≈664s)

Old tip replica `…wpblw` (digest `cdcf85f8…`) hung Terminating under NVMe
saturation; force-deleted (`--grace-period=0`) once new tip was Ready.
Docker `Created` leftovers pruned (`docker_created=0`).

### 2026-09-17 capacity watch (concurrent with deploy)

`check-host-capacity.sh` remains **NO-GO** (post-rollout sample):
load1≈15 / 16 CPUs; MemAvailable≈20Gi; swap≈3.5Gi; disk≈81%;
PSI io full avg10≈52%; nvme util≈98%; D-state≈7
(postgres checkpointer/bgwriter/autovacuum, a3s-observer-collector, jbd2/flush).
CPU PSI near zero. Prefer docs/k8s-light; defer labeled Design B / compose
until gate GO.

