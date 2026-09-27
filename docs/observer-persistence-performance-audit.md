# Observer / AnySentry 持久化链路性能问题清单与优化方案

调研日期：2026-09-18 至 2026-09-20。对象：单机 k3s（`pjnl261070032`，32 GB 内存、单块 NVMe、8 GB 交换文件）上的 `anysentry` 命名空间：Observer DaemonSet、AnySentry API、Postgres 17、ClickHouse、Redis 7.4。分支 `fix/langgraph-cross-agent-hop`。

本文只记录已经测到的现象和由此推出的方案。标注「明确」的问题可以直接执行；标注「需核查」的问题给出方向，执行前要先看对应业务代码或查询计划。

---

## 1. 现象总览

| 指标 | Observer 停止 | Observer 运行 5 分钟后 | 来源 |
|---|---|---|---|
| PSI `io full avg10` | 0.2–2 | 50–62 | `/proc/pressure/io` |
| NVMe 利用率（1 s） | ~1 % | 90–100 % | `/proc/diskstats` |
| 根分区 dm-0 利用率 | ~1 % | 100 % | 同上 |
| 交换区剩余 | 2.9 GiB | 352 KiB | `/proc/meminfo` |
| Observer 采集器 | — | CPU ~6 %，RSS 125 MiB，块写入 0.4 MB/s | `/proc/<pid>`、cgroup `io.stat` |
| ClickHouse | CPU 23m，RSS 503 MiB | CPU 231m，RSS 865 MiB，块写入 ~18 MB/s | `kubectl top`、cgroup `io.stat` |
| Postgres | CPU 63m | 进程写入 ~22 MB/s | `/proc/<pid>/io` |
| 事件量 | — | ~1660 逻辑事件/分钟（file 399、egress 378、file_access 356、exit 224、exec 205、llm 54、file_delete 44、ssl 0） | collector 每分钟窗口日志 |

累计量（Postgres 运行 5 天 19 小时）：

| 项 | 数值 |
|---|---|
| Postgres 数据库大小 | 55 GB |
| 预写日志累计写出 `pg_current_wal_lsn` | 659 GB（≈113 GB/天，≈49 KB/事件） |
| `anysentry_raw_observations_v1` | 1338 万行，25 GB（索引 4.4 GB） |
| `anysentry_kernel_facts_v1` | 1514 万行，16 GB（索引 5.7 GB） |
| `anysentry_coverage_gaps_v1` | 1076 万行，9.1 GB |
| ClickHouse `events` | 1619 万行，11.3 GB；同一事件另落 5 张表 |
| Redis（清理前） | 1.80 GB，49.5 万键，其中 48.2 万在 `bull:anysentry-stream-publish` |

桌面副作用：`systemd-oomd` 在 9/14、9/16、9/18 三次因用户会话内存压力 > 50 % 持续 20 s 杀掉 Cursor 与 Firefox。内核日志无 GPU hang、无段错误。

结论：采集进程本身不是压力来源。压力来自「每条事件被写成十几份，且每份都在等磁盘确认」，再叠加同一块盘上的交换区换出。

---

## 2. 问题清单

每一项给出：现象、证据、根因、方案、预期、代价、验收。

### P1. 基础设施进程被当成 probable_agent 全量采集　　**明确**（原「文件事件全量转发」，已重写）

- 现象：Observer 运行窗口（09-18 20:02–20:08）Postgres 原始观察 6368 行，按 `record.process.executable` 归类：k3s-server 1411 行（Connect 726、FileRead 308、Llm 189、Tls 188）、verge-mihomo 534 行（Connect 357、FileRead 177）、containerd-shim 225 行（FileDelete 135、FileAccess 90）、runc 251 行（Exec 179、FileAccess 72）。合计 2421 行，占 38 %。
- 证据：ClickHouse `events` 里这些进程的 Egress 全部带 `filterReasonCode=probable_agent`、`filterF2RuleId=fr_builtin_f2_agent_keep`、`filterRuleAuthority=candidate`。也就是说它们被候选算法晋升成了 Agent，并按 Agent profile 全量保留。
- 原方案的错误：之前把问题归到「文件事件重复没有合并」。实测 FileAccess 658 行按 `(agentId, subject, 秒)` 去重后 650 行，1 s 重复率 1 %，5 s 窗口 17 %。`FORWARD_FILE_AGGREGATION` 开了也省不了多少，不计入预期。
- 根因：设计 §6.3 要求「基础设施信号先于 Agent 行为晋升，避免数据库、消息队列和 AnySentry 自身服务制造候选」，§5.3 把「单一基础设施进程、服务状态写入、无 Agent 循环」列为负向信号。当前 F0 WorkloadContext 没有把集群控制面、容器运行时、纯网络代理标成 infrastructure，它们的 TLS/网络活动被当成正向信号。
- 方案：
  1. F0 `IdentityClassification` 增加 infrastructure 判定，依据物理上下文而非产品名：cgroup 属于 `system.slice/k3s.service`、`kubepods` 下 `anysentry` 命名空间的 Pod、作为容器父进程的运行时（containerd-shim/runc 这一层由「是 Pod 容器的 cgroup 祖先」判定）。
  2. 纯网络中继形状（只有 Connect/Tls，无 LLM/Tool 交替、无工作区文件变化）在 §5.3 评分中走负向，不晋升。
  3. 被标 infrastructure 的进程套 unknown/infra 策略：Exec/Exit/Security 保留，文件 drop，Connect/Tls 按 `ANYSENTRY_CAPTURE_SAMPLE_*` 有界采样。
  4. **不**把文件探针限制到 Agent cgroup；**不**把 `exit` 从原始观察里去掉。理由见第 5 节。
- 需核查：k3s-server 有 189 行被标成 `Ring(Llm)`，它不调用大模型。要看 LLM 协议形状识别是否把普通 HTTP/2 TLS JSON 误判；这既是 k3s 被晋升的可能原因，也影响 §5.3「可确认的模型操作 +4」的精度。cursor 与 feishu 的归属由算法决定，不按名字调整；feishu 命中了哪些信号也要看。
- 预期：原始行 −33 %；后续 kernel_facts、ClickHouse 六张表、索引维护同比例下降。
- 代价：k3s、容器运行时、代理进程只剩生命周期证据与采样网络证据。它们本来就不该是 Agent。
- 验收：collector 窗口里 k3s/containerd/runc 只剩 Exec/Exit；ClickHouse `events` 中 `agentId IN ('k3s-server','verge-mihomo')` 的 Egress 行 < 10/分钟；候选列表里没有这些进程。

### P1b. capture_aggregate 每秒一条，占原始观察 10 %　　**明确**

- 现象：同一窗口 `capture_aggregate` 661 行；ClickHouse `events` 里 `CaptureAggregate` 1758 行，是最多的一类。每条是一个 `(cgroupId, probe)` 在 1 s 窗口内的采样汇总。
- 证据：`ANYSENTRY_CAPTURE_SAMPLE_WINDOW_MS=1000`；attributes 里 `captureWindowStartUnixNs/EndUnixNs` 相差约 1 s。
- 方案：窗口改 10 s（`ANYSENTRY_CAPTURE_SAMPLE_WINDOW_MS=10000`）。汇总仍带计数、hash、原因、首末时间，只是粒度从 1 s 变 10 s。
- 预期：原始行 −9 %。
- 代价：采样汇总时间分辩率变粗；被采样的本来就是压缩记录。
- 验收：`capture_aggregate` 行数 < 80/6 分钟。

### P2. Postgres 每条事件维护 9 个索引，其中 6 个从未被读　　**明确**

- 现象：预写日志 49 KB/事件，而一行原始观察平均 1.6 KB，放大约 30 倍。
- 证据（`pg_stat_user_indexes`，自启动累计）：

  | 表 | 索引 | 大小 | 扫描次数 |
  |---|---|---|---|
  | kernel_facts | `process_idx (process_generation_key, observed_at DESC)` | 1286 MB | 0 |
  | kernel_facts | `connection_idx (connection_id, observed_at DESC)` | 1039 MB | 0 |
  | kernel_facts | `event_idx (event_id)` | 943 MB | 0 |
  | kernel_facts | `observed_idx (observed_at DESC, fact_id)` | 1456 MB | 2 |
  | kernel_facts | `pkey (fact_id)` | 934 MB | 2996 万 |
  | raw_observations | `source_idx (source_id, collector_id, event_at DESC)` | 1346 MB | 0 |
  | raw_observations | `event_idx (event_at DESC)` | 655 MB | 0 |
  | raw_observations | `idempotency_revision_idx` | 1440 MB | 2450 万 |
  | raw_observations | `pkey (observation_id, revision)` | 979 MB | 2630 万 |
  | session_memberships | `session_key_idx` | 275 MB | 0 |

  两张表 `seq_scan=0`，全部读取都是写入时的幂等去重查找。
- 根因：`full_page_writes=on`（默认）+ `checkpoint_timeout=15min`：每个检查点后每个索引页第一次被改都整页（8 KB）写进预写日志；一条插入随机命中 5–6 个索引页。
- 方案（修订，见第 5 节核对）：
  1. 停用 5 个没有任何代码路径引用的索引（`DROP INDEX CONCURRENTLY`）：`kernel_facts.process_idx`、`kernel_facts.connection_idx`、`raw_observations.source_idx`、`raw_observations.event_idx`、`session_memberships.session_key_idx`，共约 4.6 GB。`loadKernelFacts` 只接受 `factIds / eventIds / sourceRefs / derivedFrom`，从不按 `connection_id` 或 `process_generation_key` 查；`loadRawObservations` 没有 source 过滤。
  2. **保留** `kernel_facts.event_idx (event_id)`：`getDurableKernelFact` 的别名回退路径按 `eventIds` 查，这是 canonical 点查的一部分。它 0 次扫描只说明回退没触发过，不代表无用。
  3. 时间列索引换 BRIN：`raw_observations(event_at)`、`kernel_facts(observed_at)` 相关系数 0.99998 / 0.99992，BRIN 体积 < 1 MB，插入近零成本。前提是 P11 先给「最新 n 条」查询加时间下界。
  4. 保留主键与幂等索引。
  5. `sourceRefs / derivedFrom` 的 JSONB `?|` 查询目前没有索引；点查回退真的上线时应加 GIN，而不是把 B-tree 加回来。
- 预期：每条插入少写 5 个随机页；预写日志量降 40 % 以上。
- 代价：将来若按 `connection_id` / `process_generation_key` 查 Postgres，需先按 `EXPLAIN` 加回窄时间窗的部分索引。目标里进程代次与连接的归因发生在 Observer/Collector 与 hot-ring 内，不查这两列。
- 验收：`pg_current_wal_lsn` 每分钟增量对比；`pg_stat_user_indexes` 剩余索引均有扫描。

### P3. `coverage_gaps` 逐条、多版本、永不清理　　**明确**

- 现象：1076 万行、9.1 GB、两个索引 2 GB。表内容是「持久化失败 / 丢弃」的诊断记录。
- 证据：`saveCoverageGaps` 每次都 `INSERT ... ON CONFLICT (gap_id, revision) DO NOTHING`，`n_tup_upd=0`、`n_tup_del=0`；`loadCoverageGaps` 只读 `ORDER BY last_seen_at DESC LIMIT 1000`。采样原因分布：`process_generation_unavailable` 55 %、`identity_unknown` 25 %、`dropped` 14 %、`storage_unavailable` 5 %。
- 根因：`recordGap` 的 `scope` 参数被传成 `observationId`（`identity_unknown`、`runtime/dropped`、`raw_commit/storage_unavailable` 三处）或 `pid:<pid>`（`process_generation_unavailable`），于是 gap 变成「每个事件一条」而不是「每个原因一条」。抽样 1 % 里 10.7 万行对应 7.07 万个不同 `gap_id`。每个 gap 的每个 revision 又是新行，旧 revision 从不删除。设计 §9.2 要求的是每类丢失一个独立计数，不是每条事件一行。
- 方案（修订，见第 5 节核对）：
  1. `scope` 改为稳定维度：进程用 `ProcessGenerationKey` 或 cgroup，观察用 `sourceId/collectorId`，不再用 `observationId` 和裸 `pid`。同原因同 scope 的重复只递增 `droppedCount` 与 `lastSeenAt`，一个 gap 一行多 revision。
  2. 保留 revision 历史，但只保留每个 `gap_id` 最近 32 个 revision，与 `onModuleInit` 装回内存时的 `gapHistory.slice(-32)` 一致；更早的 `DELETE`。
  3. 加 7 天 TTL。
- 预期：该表从每条事件一行变成每类原因一行；停止随事件量线性增长。
- 代价：不再能从 gap 表反查「哪一条事件」丢了；事件级证据仍在 `raw_observations`、ClickHouse `event_commit_facts_v2` 与 `source_commit_progress`，验收矩阵用它们做点查即可。
- 验收：表大小 7 天后稳定；`n_tup_ins` 增速 < 1000/天。

### P4. Postgres 提交与检查点参数　　**明确**

- 现象：`synchronous_commit=on`（默认）、`commit_delay=0`、`wal_sync_method=fdatasync`、`checkpoint_timeout=15min`、`max_wal_size=4GB`、`shared_buffers=128MB`。
- 证据：`pg_settings` 与 `postgresql.auto.conf`（由 `ALTER SYSTEM` 写入，非镜像默认）。
- 根因：每次提交单独等一次 `fdatasync`；检查点频繁导致整页写反复发生；缓冲区太小使脏页更早刷盘。
- 方案（用户已接受断电丢失最后几百毫秒）：
  ```sql
  ALTER SYSTEM SET checkpoint_timeout = '60min';
  ALTER SYSTEM SET max_wal_size = '16GB';
  ALTER SYSTEM SET shared_buffers = '2GB';        -- 需重启
  ALTER SYSTEM SET wal_writer_delay = '200ms';    -- 默认即可
  ```
  `synchronous_commit=off` 只对 canonical 写入会话设置（`SET synchronous_commit = off` 于连接池初始化，或 `ALTER ROLE anysentry_canonical SET ...`），代码注释已把该车道定义为「rebuildable side lane」；主研判路径保持 `on`。
- 预期：`fdatasync` 从每次提交变为每 200 ms 一次；整页写次数降 3–4 倍。
- 代价：崩溃恢复时间变长（最多回放 16 GB 预写日志）；canonical 行断电丢最后 ~200 ms。
- 与目标的约束（见第 5 节）：设计 §9.2 要求每类丢失有独立指标，§11.4 要求 canonical 点查 `coverage=complete`。异步提交的丢失只发生在崩溃瞬间，而且事后无法逐条感知，所以必须补一个启动时对账：用 ClickHouse `event_commit_facts_v2` / `source_commit_progress`（已存在，就是为提交对账建的）与 Postgres `raw_observations` 比对最后一个提交批次，差额记为 `canonical_persistence_dropped{reason=async_commit_lost}` 并对受影响窗口报 `coverage=partial`。没有这个对账，不要开 `synchronous_commit=off`。
- 验收：Observer 运行 5 分钟 PSI `io full avg10` < 20；NVMe 利用率 < 50 %；人为 `kill -9` Postgres 后重启，对账计数与实际差额一致。

### P5. ClickHouse 同一事件落 6 张表，旧物化视图仍在写　　**明确**

- 现象：`events`、`event_revision_identities`、`event_locators_v1`、`event_commit_facts_v2`、`event_commit_facts`、`kernel_fact_locators_v1` 各 1500 万行以上；每天各被插入 82 068 次（≈每秒一批）。
- 证据：`system.query_log`：`event_commit_facts`（旧）近 3 天被读 0 次，`event_commit_facts_v2` 被读 6 次。代码只定义 `EVENT_COMMIT_FACT_TABLE = "event_commit_facts_v2"`；旧表由残留的物化视图 `event_commit_facts_mv` 从 `events` 自动写入，代码中已无引用。`async_insert=0`。
- 方案：
  1. `DROP VIEW anysentry.event_commit_facts_mv; DROP TABLE anysentry.event_commit_facts;`
  2. 用户级 `async_insert=1, wait_for_async_insert=0`（或 profile），让服务端合并微批。
  3. 需核查：`event_locators_v1` 与 `event_revision_identities` 是否可以合并为一张按 `eventId` 排序的定位表（两者行数一致、都是 `ReplacingMergeTree`）。
- 预期：每批少 1/6 插入；插入等待次数下降。
- 代价：`async_insert` 在进程崩溃时丢内存中未成块的记录；原始行仍在 Postgres。
- 验收：`system.part_log` 每日 `NewPart` 数下降；`system.query_log` 插入耗时 p95 下降。

### P6. Postgres 侧没有保留期　　**明确**

- 现象：55 GB 持续增长；ClickHouse 侧已有 7–365 天 TTL，Postgres 原始观察 / 内核事实 / 会话归属没有。
- 根因：索引越深，每次插入越贵；表越大，`VACUUM` 越慢。
- 方案：按 `event_at` / `observed_at` 月分区（`PARTITION BY RANGE`），过期分区直接 `DROP`；或应用侧每日删除 14 天前数据。分区后 BRIN 与分区裁剪叠加。
- 需核查：目标阶段的「canonical 完整点查」需要多久的回溯窗口，由此定 TTL（建议 14 天起）。
- 预期：数据库大小在 TTL 之后稳定；插入成本不再随时间上升。

### P7. Redis 流式出站队列没有消费者　　**明确**

- 现象：`bull:anysentry-stream-publish` 48.2 万键、1.8 GB，Redis 顶着 2 GiB 限额被 cgroup OOM 反复杀掉（内核日志 9/14–9/18 每 5–7 小时一次）。
- 证据：`ANYSENTRY_STREAMING=on`、`ANYSENTRY_STREAM_BOOTSTRAP_SERVERS=kafka:9092`，但命名空间内没有 Kafka Pod，也没有 `stream-worker`；`enqueueCanonicalShadow` 在每条接受事件后入队，任务 `attempts: 100`、`removeOnFail` 30 天。
- 根因：影子链路开着，下游不存在。
- 方案：`ANYSENTRY_STREAMING=off`，直到 Kafka 与 `stream-worker` 真的部署且拥有独立磁盘。Kafka 的消费者只做两件事：把流式研判发现写回 ClickHouse、把风险分析批次送大模型做组合研判；它不是存档，也不是清空 Redis 的必经之路。在当前单盘机器上再起 Kafka 只会再加一层每条落盘、等副本确认的写入。
- 预期：Redis 常驻 < 50 MB；不再 OOM。
- 验收：`redis-cli DBSIZE` 稳定在个位数；无 `Memory cgroup out of memory: Killed process ... redis-server`。

### P8. 快研判队列没有 worker　　**明确**

- 现象：`bull:anysentry-fast-judge` 1.26 万键；命名空间内没有 `fast-judge` / `l3-worker` Pod。
- 根因：接受事件时无条件 `enqueuePreparedFastJobs`，队列只进不出。
- 方案：要么部署 worker，要么在 worker 不在时不入队（探测队列消费者数 `Queue.getWorkers()`，为 0 则记 gap 计数而非入队）。
- 需核查：当前验证阶段是否需要 L1/L2 结论；若不需要，`ANYSENTRY_FAST_JUDGE` 类开关关闭。

### P9. 内存与交换区在同一块盘上争抢　　**明确**

- 现象：Observer 拉起 5 分钟交换区从剩 2.9 GiB 到剩 352 KiB；`systemd-oomd` 杀桌面进程。
- 证据：Redis 限额 2 GiB（清理前占满）、AnySentry 953 MiB、ClickHouse 865 MiB、k3s 513 MiB、VS Code Server 两进程 4.1 GiB、rust-analyzer 1.2 GiB。
- 方案：
  1. P7 之后 Redis 限额降到 512 MiB。
  2. ClickHouse `max_server_memory_usage` 设为 1.5 GiB（现有 `clickhouse-memory-config` ConfigMap）。
  3. `vm.swappiness=10`，减少换出频率；若允许，交换区改用 zram 或移到另一块盘。
  4. `systemd-oomd` 的 `DefaultMemoryPressureLimit` 从 50 % 提到 70 %，避免过早杀桌面（仅缓解症状）。
- 预期：Observer 运行时交换区剩余 > 1 GiB；桌面不再被杀。

### P10. Observer spool WAL 持续增长　　**需核查**（属目标 Phase E）

- 现象：`/var/lib/anysentry-forwarder/spool-clean-20260915.wal` 5 分钟从 3.2 MiB 涨到 31 MiB；从未截断。
- 证据：`FORWARD_SPOOL_FSYNC=periodic / 250ms`、`FORWARD_SPOOL_COMPACT_MAX_LIVE_RECORDS=16384`。
- 方向：确认 compaction 是否在 ack 后触发；若 AnySentry 返回慢导致 ack 迟滞，WAL 会持续膨胀。P4/P5 落地后重新观察增长速率；只有在证明 WAL 无活跃记录时才截断。

### P11. 「最新 n 条」查询没有时间下界　　**需核查**

- 现象：`relational-business-store.service.ts` 中 `loadKernelFacts` / `loadRawObservations` 无过滤条件时执行 `ORDER BY observed_at DESC, fact_id LIMIT n`。
- 影响：P2 把时间索引换成 BRIN 后，这条查询会全表排序。
- 方向：给两条查询加默认时间下界（如最近 24 h），与页面时间窗口（`last_1h/3h/24h/7d`，走 ClickHouse `events ORDER BY at`）口径一致。

### P12. 会话归属表的 JSON 表达式索引　　**需核查**

- 现象：`session_memberships_v1_interaction_idx` 建在 `(record->>'interactionId')` 上，208 MB，91 次扫描；`session_key_idx` 0 次。
- 方向：把 `interactionId` 提升为普通列再索引，避免每次插入解析 JSONB；`session_key_idx` 与 `session_idx` 是否重复，看 `session_key` 与 `session_id` 的关系。

### P13. 事件在 Postgres 与 ClickHouse 双写　　**暂不建议**

- 现象：同一条事件既是 Postgres `raw_observations` 一行，又是 ClickHouse `events` 一行。
- 为什么不动：设计 §6.1 把 RawObservation 定为 F0 的起点、§6.4 要求 KernelFact 与 PlaintextChunk 独立留存、§11.4 要求 canonical 点查 `coverage=complete`。`listDurableRawObservations` / `getDurableRawObservation` 走 durable-first 规则，从 Postgres 读完整 `record` 并与 hot-ring 比对指纹。把正文移到 ClickHouse 会让点查依赖分析库的最终一致性，与「durable point-read」冲突。
- 若将来要做：先让 ClickHouse 侧有等价的 exact point-read（按 `observationId+revision` 的 `ReplacingMergeTree` + `FINAL`），并证明 coverage 语义不变，再迁移正文。

### P14. `alerts` / `incidents` 每行被重写数百次　　**明确**

- 现象：`pg_stat_user_tables`：`anysentry_alerts` 16 296 行、`n_tup_upd` 1362 万、HOT 更新 8.2 万（0.6 %）；`anysentry_incidents` 16 817 行、198 万次更新；`anysentry_remediations` 15 105 行、32 万次更新。Observer 停止时预写日志仍以 16 MB / 3 分钟增长，`pg_waldump --stats` 该段 72 139 条记录里 52 378 条指向 `anysentry_alerts`（relfilenode 16425）及其三个索引。
- 根因：`alerting.service.ts` 的 `persist()` 在每次脏标记后立刻 `drainPersistence()`，完成后若期间又有脏标记就再跑一轮，没有时间合并；`upsertAlertRecords` 的 `ON CONFLICT DO UPDATE` 无条件重写 `record` 与 `updated_at`；索引 `(status, updated_at DESC)` 含 `updated_at`，于是每次更新都不能走 HOT，要写新堆元组 + 改 3 个索引。
- 方案：
  1. `persist()` 加 ≥ 1 s 的合并窗口（脏集合本来就存在，只是现在立刻刷）。
  2. `record` 内容未变化时不更新（比较 `payloadFingerprint` 或 JSONB 相等）。
  3. 索引改为 `(status)` 并对三张表设 `fillfactor=70`，让更新走 HOT。列表排序用 `updated_at` 在 16k 行上顺序扫描即可。
- 与目标的关系：alerts 是研判结果的投影，不是 KernelFact / RawObservation / EvidenceLink，不在设计 §6.4 的证据链上。
- 预期：三张表更新 −90 %；Observer 停止时预写日志接近零增长。
- 验收：`n_tup_upd` 每分钟增量 < 200；`n_tup_hot_upd / n_tup_upd` > 80 %。

---

## 3. 实施顺序与验收口径

每一步之后用同一方法量 5 分钟：Observer 拉起，采样 PSI `io full avg10`、NVMe 利用率、Postgres 与 ClickHouse cgroup `io.stat`、`pg_current_wal_lsn` 增量、collector 窗口日志。

| 步骤 | 内容 | 是否改代码 | 预期 |
|---|---|---|---|
| 1 | P7 关 streaming；P4 检查点 / WAL 上限 / `shared_buffers`；P5 `async_insert` + 删旧物化视图与旧表；P1b 采样窗口 1 s → 10 s；P9 内存限额与 swappiness | 否 | PSI `io full avg10` 50–60 → < 30；NVMe 100 % → < 70 %；Redis DBSIZE 个位数；交换区剩余 > 1 GiB |
| 2 | P11 加时间下界（前置）→ P2 停 5 个无引用索引、时间索引换 BRIN；P14 索引改 `(status)` + `fillfactor=70` | P11 是，其余 DDL | PSI < 20；Postgres 块写入 < 8 MB/s；`pg_stat_user_indexes` 剩余索引均有扫描 |
| 3 | P1 基础设施分类；P14 `persist()` 合并 + 未变化不写；P3 `coverage_gaps` scope 改稳定维度；P8 worker 不在不入队 | 是 | 原始行 −40 %；PSI < 10；`coverage_gaps` `n_tup_ins` < 1000/天；`alerts` `n_tup_upd` < 200/分钟；三个 fixture 点查 `coverage=complete` |
| 4 | P4 async-commit 对账 → canonical 会话 `synchronous_commit=off`；P6 分区与 TTL；P12 结构调整 | 是 | `kill -9` Postgres 后对账差额与实际一致；7 天后数据库大小稳定 |

预期总量（步骤 1–3 全部落地、步骤 4 未开）：

| 指标 | 现在 | 预期 | 来源 |
|---|---|---|---|
| 原始观察行 / 分钟 | ~1061 | ~615 | P1 −33 %、P1b −9 % |
| `coverage_gaps` 插入 / 分钟 | ~850 | < 5 | P3 |
| `alerts`/`incidents` 更新 / 分钟 | ~1620（5.8 天均值） | < 150 | P14 |
| 每次插入改动的索引页 | ~9 | ~4 | P2 |
| 预写日志写出 | 113 GB/天（49 KB/事件） | ≈ 15 GB/天 | 行数 −42 % × 每行 −70 %（P2 + P4 整页写） |
| Postgres + ClickHouse 写盘 | ~20 MB/s | 3–5 MB/s | 综合 |
| NVMe 利用率（Observer 运行 5 分钟） | 90–100 % | < 40 % | 综合 |
| PSI `io full avg10` | 50–62 | < 10 | 综合 |

数字为估算，验收以实测为准。所有步骤都不缩小「哪些进程、哪些事件被看见」：全部进程的 Exec/Exit/Security 保留；未知与基础设施进程的 TLS/网络按有界窗口保留发现信号；Agent 归属进程的文件、网络、明文全量；canonical 点查用到的 pkey、幂等索引、`event_idx` 全部保留。每一步完成后要重跑设计 §11.3 三个 fixture 的 canonical 点查，确认 `coverage=complete`。

### 步骤 1 实施记录（2026-09-20）

已生效，未改采集代码：

| 项 | 结果 |
|---|---|
| P7 streaming | `anysentry-runtime` 的 `ANYSENTRY_STREAMING=off`，新 Pod 已读到。仓库 `deploy/anysentry.yaml` 本来就是 off；集群上的 on 来自 manual-test 覆盖。`deploy/manual-test/runtime-on.yaml` 仍写 on，下次套用会把开关打回去。 |
| P4 | `checkpoint_timeout=60min`、`max_wal_size=16GB` 已 reload；`shared_buffers=2GB` 已随 Postgres 重启生效（`pending_restart=false`）。未开 `synchronous_commit=off`。 |
| P5 | 已 `DROP VIEW event_commit_facts_mv`，旧表改名为 `event_commit_facts_legacy_20260920`（未删除）。`event_commit_facts_v2` 与其物化视图仍在。`async_insert=1`、`wait_for_async_insert=0`。`max_server_memory_usage=1.5 GiB`。 |
| P1b | DaemonSet `ANYSENTRY_CAPTURE_SAMPLE_WINDOW_MS=10000`。 |
| P9 | `vm.swappiness=10`（`/etc/sysctl.d/99-anysentry-io.conf`）。Redis 限额 512 MiB、`maxmemory 384mb`、`allkeys-lru`，且 `--dbfilename unused.rdb`，避免启动时装载磁盘上 1.28 GB 的旧快照（该文件及残留 temp rdb 已删）。 |

镜像 `anysentry-observer:log-backpressure-20260915`（`sha256:19c19f1c…`）仍在本机 Docker 中，已重新推入 `127.0.0.1:5000`。2026-09-20 14:49–14:55 拉起 Observer 采样 5 分钟后再次暂停。

| 指标 | 步骤 1 之前（09-18） | 这次 5 分钟 | 步骤 1 验收线 |
|---|---|---|---|
| PSI `io full avg10` | 50–62 | 9–61，峰值 60.6，结束 36 | < 30，未达到 |
| NVMe 利用率 | 90–100 % | 78–92 %，结束 90 % | < 70 %，未达到 |
| 预写日志 | 约 113 GB/天 | 241 MiB / 5 分钟，0.80 MiB/s | — |
| 交换区剩余 | 2.9 GiB → 352 KiB | 2186 → 1682 MiB | > 1 GiB，达到 |

结论：检查点、`async_insert`、关 streaming 和采样窗口没有把磁盘等待降下来。预写日志速率已经不高，盘仍被小块同步写占满。交换区不再在 5 分钟内被吃光。

### 步骤 2 实施记录（2026-09-20 15:02–15:07）

采样说明的是：0.80 MiB/s 的预写日志仍能把 NVMe 打到 90%，所以下一步要减少每次插入改写的随机页，而不是再放大 WAL。

已在运行中的 Postgres 执行，Observer 暂停期间：

- `DROP INDEX CONCURRENTLY`：`kernel_facts.process_idx`、`kernel_facts.connection_idx`、`raw_observations.source_idx`、`session_memberships.session_key_idx`。这四个在代码里没有查询路径，重启前的扫描次数是 0。
- `alerts` / `incidents` / `remediations` 去掉含 `updated_at` 的索引，改为只索引 `status`，`fillfactor=70`，并 `VACUUM FULL` 腾出 HOT 更新空间。四个旧索引扫描次数都是 0。
- 时间列 B-tree（`raw_observations.event_idx`、`kernel_facts.observed_idx`）和 `kernel_facts.event_idx` 保留。前者是当前进程里「最新 n 条」的排序路径；后者是点查别名。源码已给无 id 的读取加上 24 小时下界，并在下次 API 启动时建 BRIN、再删这两棵时间 B-tree。当前 Pod 仍是旧镜像，所以这一步还没生效。旧镜像若重启，会用 `CREATE INDEX IF NOT EXISTS` 把刚删的四个索引建回来。

| 指标 | 步骤 1 后 | 去掉四个索引并改 HOT 后 | 步骤 2 验收线 |
|---|---|---|---|
| PSI `io full avg10` | 峰值 60.6，结束 36 | 峰值 24.7，结束 14.5 | < 20。结束值达到，峰值未达到 |
| NVMe 利用率 | 78–92%，结束 90% | 31–72%，结束 55% | 步骤 1 的线是 < 70%。结束值达到，中段有 72% |
| 预写日志 | 0.80 MiB/s | 0.65 MiB/s（196 MiB / 5 分钟） | 块写入 < 8 MB/s，达到 |
| 交换区剩余 | 2186 → 1682 MiB | 1849 → 611 MiB | > 1 GiB，未达到 |

磁盘等待大约降了一半，预写日志本来就已经不高。交换区比步骤 1 掉得更快，是因为采样开始时剩余更少，Observer 仍在灌入被误标成 Agent 的基础设施事件。

### 步骤 3 进展（2026-09-20 15:23）

09-18 窗口里标成 `LlmCall` 的事件全部来自 k3s-server、cursor、verge-mihomo 和飞书，没有一条来自真实模型服务。`isLlmEvent` 以前看到种类名 `LlmCall` 就记成模型操作（+4），所以控制面和代理被晋升成 `probable_agent` 并全量保留。

已改为：`LlmCall` / `LlmInteraction` 必须带协议路径或语义操作才算模型事件。没有路径的探测标签不再晋升。`scripts/verify-behavior-discovery.mjs` 通过。Observer 从宿主机目录挂载脚本，已补上 `observer-behavior-discovery.js` 的 subPath；之前改了文件但没有挂进容器，所以 15:17 那次采样仍是旧逻辑。

15:23 拉起约 40 秒后暂停（交换区只剩约 16 MiB，不再跑满 5 分钟）。这 40 秒写入 ClickHouse 的是 `CaptureAggregate`、`SecurityAction` 和 `ProcessExit`，没有 k3s-server / verge-mihomo 的 `probable_agent` Egress 或 LlmCall。按之前约 2.6 条/秒的 k3s 出向，40 秒里若仍全量保留应有上百条。生命周期和安全事件仍在。

### 步骤 3 五分钟复测（2026-09-20 16:30:54–16:36:05）

交换区空位已回升（开始 2643 MiB），行为发现脚本已挂上（容器与宿主机均为 27038 字节），`ANYSENTRY_BEHAVIOR_DISCOVERY=on`，采样窗口 10 s。Pod `a3s-observer-lhbdm` Ready 后采满 310 s，随后用 nodeSelector 再暂停。未构建、未滚动 API，旧 digest `sha256:16e25b86…` 未重启。

| 指标 | 步骤 2 后 | 这次 5 分钟 | 交接 §5.1 目标 |
|---|---|---|---|
| PSI `io full avg10` | 峰值 24.7，结束 14.5 | 峰值 19.05，结束 11.36（末 10 s 为 7.12） | 结束 < 20。达到；峰值也低于 20 |
| NVMe 利用率 | 31–72%，结束 55% | 窗口均 26.6%，10 s 峰值 64.4%，结束 29.2% | 结束 < 70%。达到 |
| 预写日志 | 0.65 MiB/s | 65.8 MiB / 311 s，0.21 MiB/s | — |
| 交换区剩余 | 1849 → 611 MiB | 2643 → 2632 MiB | > 1 GiB。达到 |

ClickHouse 窗口内：`CaptureAggregate` 2953、`ProcessExit` 140、`SecurityAction` 64、`ToolExec` 36。**没有** `Egress` / `LlmCall` / `Connect` / `Tls`。k3s / verge-mihomo 无 `probable_agent` 出向。

Postgres 原始观察 891 行：`capture_aggregate` 531、`Ring(Exec)` 151、`Ring(Exit)` 140、`Ring(Security)` 64、`ssl-classic LlmInteraction` 5。k3s / runc 只出现在 `Ring(Exec)`（各 1 / 13 行，`action=sample`）；飞书只出现在 `Ring(Security)`（4 行）。5 条 `LlmInteraction` 全部来自 `/home/chensicheng/.nvm/versions/node/v24.16.0/bin/node`，不是控制面或代理。

结论：裸 `LlmCall` 不再把 k3s / mihomo 晋升成全量 Agent 采集；Exec / Exit / Security 仍在。PSI / NVMe / 交换区空位达到交接 §5.1 的结束线。步骤 3 其余代码（cgroup 基础设施分类、`persist()` 合并、`coverage_gaps` scope、worker 不在不入队）和步骤 2 的 API 镜像仍未做。`capture_aggregate` 531 行 / 5 分钟仍高于 P1b「< 80 / 6 分钟」——窗口已是 10 s，行数来自多 scope，不是 1 s 粒度没改。

下一步：交换区已稳定，可以构建并滚动 API 镜像（24 小时下界 + BRIN）。滚动前不要无故重启旧 API。

### 步骤 2 镜像滚动（2026-09-20 16:44–16:58）

源码确认：`loadRawObservations` / `loadKernelFacts` 在无 id 时带 24 小时下界；启动时建 BRIN、删时间 B-tree 与四个无查询路径索引，保留 `kernel_facts.event_idx`。把 `RECENT_READ_WINDOW_MS` 挪到全部 `import` 之后，否则 `nest build` 不合法。

未做全量 Dockerfile 构建（交换区刚够，且只要换这一份 schema 代码）。从当前运行 digest `sha256:16e25b86…` overlay 一份 22 KiB 层，发布为：

`127.0.0.1:5000/anysentry@sha256:9d08df37a7edab3b4aa211967654ec724dc247ce5931a3eeb608257a4546a012`（tag `brin-24h-20260920`）。

滚动前在 Postgres 上预建 BRIN。第一次 `CREATE INDEX CONCURRENTLY` 把 Postgres OOMKill 了：`shared_buffers=2GB`，Pod limit 当时是 2Gi，没有余量。旧 API Pod **没有**重启（仍是 16e25b86，start 05:53 UTC），四个已删索引没有被建回。随后把 Postgres 内存调到 request 2Gi / limit 4Gi（`manual-support.yaml` 已改），BRIN 建成并有效：`event_brin` 944 kB，`observed_brin` 520 kB。两棵时间 B-tree 已 `DROP INDEX CONCURRENTLY`。

Deployment 按 digest 滚动，`maxUnavailable=0`。新 Pod `anysentry-859665485f-nxkt7` Ready；`image` 与 `imageID` 均为 `sha256:9d08df37…`；容器内 store js SHA-256 与宿主机 dist 同为 `d42246f1…`。启动日志：`PostgreSQL business-state store is ready`，`Nest application successfully started`。

滚动重叠期旧 API 曾把 `raw_observations.event_idx` 建回来一次（旧镜像 `CREATE INDEX IF NOT EXISTS`）。旧 Pod 结束后已再次 DROP。当前索引：

| 必须在 | 状态 |
|---|---|
| `kernel_facts.event_idx` B-tree | 在，945 MB |
| `raw_observations.event_brin` / `kernel_facts.observed_brin` | 在，且 `indisvalid` |
| 四个无查询路径索引 + 两棵时间 B-tree | 不在 |

滚动后立刻采了 5 分钟（16:52:38–16:57:58，Pod `a3s-observer-rzl2v`）。**这一次不能当步骤 2 性能验收**：开始时 PSI 已是 32.7（索引手术 + Postgres 重启 + 旧 Pod 终止的盘债），前 40 s NVMe 97%。

| 指标 | 16:30 干净窗口 | 这次（滚动后立刻） |
|---|---|---|
| PSI `io full avg10` | 峰值 19.05，结束 11.36 | 峰值 65.33，结束 21.72 |
| NVMe | 窗口 26.6%，结束 29% | 窗口 46.9%，结束 55%，峰值 97% |
| 预写日志 | 0.21 MiB/s | 0.70 MiB/s |
| 交换区剩余 | 2643 → 2632 MiB | 2498 → 2393 MiB |

采集口径仍对：ClickHouse 无 Egress / LlmCall；无 k3s / mihomo `probable_agent` 出向。Postgres：Exec 87、Exit 96、Security 8；runc 只在 Exec（12）；飞书只在 Security（8）。

下一步：等 PSI 回到空闲后再采一次 5 分钟，才拿来比步骤 2 的盘数字。之后做设计 §11.3 fixture 点查。

### 盘债观察与一次被污染的复测（2026-09-20 17:06–17:19）

17:06 起盯盘。当时不是新异常，是旧脏页在还：`Dirty` 2801→17 MiB（约 15–20 MiB/s），Postgres `pg_stat_activity` 空闲，交换区空位稳住约 1900 MiB。17:10 后 PSI `avg10` 0.3、NVMe 2%、写 0.1 MiB/s，旧债还完。

17:12 在空闲上再采 5 分钟（Pod `a3s-observer-87szt`，API 已是 `sha256:9d08df37…`）。**这一次异常，不能当步骤 2 验收。**

| 指标 | 17:12 开始 | 17:19 结束 |
|---|---|---|
| PSI `io full avg10` | 0.18 | 59，峰值 69 |
| NVMe | 6% | 窗口 76%，峰值 97% |
| 预写日志 | — | 65 MiB / 0.17 MiB/s（比 16:30 的 0.21 还低） |
| `Dirty` | 3 MiB | 涨到 2.5 GiB |
| 交换区空位 | 1900 MiB | 762 MiB |

WAL 低、盘却满，说明忙的不是 Postgres 插入量。取证：

- 17:12 拉起 Observer 时 `k3s.service` 写到 21–27 MiB/s（拉镜像 143 MiB + 建 Pod）。
- 窗口内本机另有 `host-integration-smoke.sh --soak`（2 小时）在跑 `cargo test -p a3s-box-cri` / `crictl pull busybox`；`src/target` 约 15 GiB，会持续造脏页。
- ClickHouse（pod `b4816c1a`）窗口内 2–9 MiB/s，对应 3315 条 `CaptureAggregate`。
- 17:17 起 `Dirty` 从 0.7 GiB 跳到 1.8 GiB，交换区同步被挤；`user.slice` 交换区约 6.7 GiB。有 `kworker/flush`、`jbd2/dm-0`、一个 Postgres 后端长时间 D 态。

采集口径仍对：无 k3s / mihomo `probable_agent` 出向；Exec 103、Exit 122、Security 23。

不要在 soak / 脏页回落 / 交换区空位回到 1 GiB 之前再采。不要杀那条 a3s-box soak（不是本仓库的任务）。Observer 已再暂停。

### 步骤 3 代码落地与 API 滚动（2026-09-20 18:27–18:47）

步骤 3 其余代码已进源码，并 overlay 到运行中的 API。未做全量 Dockerfile，未开 `synchronous_commit=off`，未拉起 Observer，未杀 soak。

| 项 | 落地 |
|---|---|
| P1 F0 基础设施 | cgroup：`system.slice/{k3s,containerd,docker,crio,kubelet}.service` → host control plane；kubepods + `anysentry` → `self_plane`；kubepods 无 pod/container 叶子 → `runtime_ancestor`。纯网络中继形状走负向。`infrastructure_aggregate`：Exec/Exit/Security 全量，文件 drop，Connect/Tls 采样。 |
| P14 | `persist()` 合并 ≥1 s；alerts/incidents/业务 upsert 在去掉 `updatedAt` 后 JSONB 未变则跳过写入。 |
| P3 | coverage gap `scope` 用 ProcessGenerationKey 或 sourceId/collectorId，不用 observationId；每个 gap 保留最近 32 个 revision；TTL 7 天（每 256 次保存抽一次）。 |
| P8 | `getWorkers()===0` 时不入 fast-judge 队，记 `judgment/dropped/fast_judge`；`getWorkers` 缺失或抛错则放行。 |
| P4 对账（门闩，未翻开关） | 启动时用 ClickHouse `event_commit_facts_v2` 最后一个 `commitBatchId` 按 source 取 max(eventAt)，与 Postgres `raw_observations` 24h 内同 source 的 MAX(event_at) 比较。ClickHouse 超前 >2 s 记 `raw_commit/async_commit_lost`，details 带 `coverage=partial`。`synchronous_commit` 仍是 `on`。 |

本地验证：`verify-canonical-observability.mjs`、`verify-unified-filter-rule-core.mjs`、`verify-observer-unified-filter-policy.mjs`、`verify-behavior-discovery.mjs`、`verify-observer-classification-semantics.mjs`、`verify-s5-capture-profile-{safety,control}.mjs` 通过。

Overlay：`brin-24h-20260920`（`sha256:9d08df37…`）上加 346 KiB 层，发布为

`127.0.0.1:5000/anysentry@sha256:481da54b5bebd0ef97a4559b942c873761669e096cb8edef3cd3b15f040bd7ae`（tag `step3-p4-20260920`）。

Deployment `maxUnavailable=0`。新 Pod `anysentry-5bb7fb75ff-tft4n` Ready；`imageID` 为 `sha256:481da54b…`；容器内 store / canonical service js SHA-256 与宿主机 dist 一致。启动约 71 s 后 `Nest application successfully started`。`synchronous_commit=on`。索引仍是：`kernel_facts.event_idx`、两棵 BRIN、raw 幂等/pkey；四个无查询路径索引和时间 B-tree 未建回。启动后 `async_commit_lost` gap = 0（符合：开关未开、无崩溃丢失）。

历史 Design B / graph Session 点查（未重跑 fixture，只读已有 ID）仍是 `coverage=complete`：`sess_71c03932…`、`sess_b7c54d5c…`、`sess_505d6eda…`、`sess_6b7c64e3…`、`sess_b03844c4…` 均为 6/0；`sess_22b7e932…` 为 7/0。这不能代替设计 §11.3 三个 fixture 的新跑。

Observer 脚本是宿主机挂载。P1 已在 23:55 这次拉起里带流量跑过。soak 已停。

步骤 4（P6 / P12 / `synchronous_commit=off`）仍有门闩，且要等这次盘压的写放大查清。对账代码已在，崩溃验证之前不要改 `synchronous_commit`。

### 步骤 3 干净窗口复测（2026-09-20 23:55:00–00:00:16）

soak 已停。23:54 门槛：Dirty 2.7 MiB，PSI full `avg10=0.52`，交换区空位 2060 MiB，API `sha256:481da54b…`。只去掉 pause nodeSelector，未重套 `observer-manual-patch.yaml`（现场仍是 `BEHAVIOR_DISCOVERY=on`、窗口 10 s、脚本 hostPath）。Pod `a3s-observer-lfw55` Ready 后采 316 s，随后再暂停。desired=0。

| 指标 | 16:30 干净窗 | 这次 | 目标 |
|---|---|---|---|
| PSI `io full avg10` | 峰值 19.05，结束 11.36 | 前 160 s 峰值 6.27；全程峰值 45.25，结束 31.05 | 结束 < 20。未达到 |
| NVMe | 窗均 26.6%，结束 29% | 前 160 s 均 25.5%；全程均 47.5%，峰值 97.8%，结束 97.8% | 结束 < 70%。未达到 |
| 预写日志 | 0.21 MiB/s（66 MiB） | `pg_wal_lsn_diff` 1104 MiB / 316 s ≈ 3.5 MiB/s | — |
| 交换区空位 | 2643 → 2632 | 2061 → 2060 | > 1 GiB。达到 |
| Dirty | — | 窗内峰值 498 MiB；暂停后 00:01 已回到 4 MiB | — |

窗口切成两段：前 160 s 和 16:30 同级（PSI < 7，NVMe 均 26%）。240 s 之后盘被打满。交换区几乎没动，所以不是换出。

采集口径：

- ClickHouse **没有** k3s / verge-mihomo。`probable_agent` 是 `kimi-code`、`git`、`gh`、`ssh`、`libuv-worker`（LLM/工具，应保留）。
- Postgres probe：`Ring(Exec)` 119、`Ring(Exit)` 117、`capture_aggregate` 225、`ssl-classic` 13、`FileRead` 13、`Tls` 11、`Connect` 11、`Llm` 10、`FileAccess` 5、`FileDelete` 3。Exec/Exit 在。无 k3s/runc/containerd/mihomo 可执行文件行。
- `capture_aggregate` 225 / 5 分钟，低于 16:30 的 531，仍高于 P1b「< 80 / 6 分钟」。ClickHouse `CaptureAggregate` 3245，与 16:30 的 2953 同量级。
- infra 文件几乎没进原始观察（FileAccess 5），F0 文件 drop 看起来生效。

盘数字**不能当步骤 3 性能验收**。原始行只有约 528 条，却写出 1.1 GiB WAL，说明忙的不是 Observer 插入量。自 Postgres 08:45 UTC 重启累计：`alerts` 更新 62 万（HOT 61.8 万）、`coverage_gaps` 删除 422 万（现 6.2M 活行 + 4.6M 死元组）。`last_seen_at` 最小值已贴着 7 天 TTL，启动后那次无界 `DELETE WHERE last_seen_at < ttl` 会一次扫掉几百万行。

### coverage_gaps TTL 有界删除（2026-09-21 00:07–00:10）

语义不变：每个 gap 仍留 32 个 revision，7 天以外仍删。改动是每次 TTL 最多删 256 行，走 `(last_seen_at, gap_id, revision)`，避免在 Observer 窗口里写 1 GiB WAL。未改采集范围。

Overlay：`step3-p4-20260920` 上加 23 KiB 层，`127.0.0.1:5000/anysentry@sha256:0b94aa4996e0acfc6a9024c5f269e2cb81c3eed7c0b56e7595ff0aa4744bad7d`（tag `gap-ttl-batch-20260921`）。Pod `anysentry-76f7ff787-lzjjb` Ready，store js 与宿主机 dist 一致，`synchronous_commit=on`。

下一步：等 Dirty / PSI 回到空闲后再采 5 分钟，确认 WAL 不再是 GB 级。然后 §11.3 fixture。alerts 62 万次更新仍待查，不挡这次 TTL 修复。

### 步骤 3 有界 TTL 后复测（2026-09-21 00:14:07–00:19:20）

Pod `a3s-observer-xp8df`，API `sha256:0b94aa49…`。soak 不在。前 10 s 有拉起毛刺（Dirty 480 MiB，NVMe 48%），之后回落。

| 指标 | 23:55（无界 TTL） | 这次 | 目标 |
|---|---|---|---|
| PSI `io full avg10` | 峰值 45，结束 31 | 峰值 17.56，结束 1.88 | 结束 < 20。达到 |
| NVMe | 峰值 98%，窗均 48% | 峰值 47.6%，窗均 16.5%，结束 12% | 结束 < 70%。达到 |
| 预写日志 | 1104 MiB / 3.5 MiB/s | **56 MiB / 0.18 MiB/s** | 回到 16:30 的 0.21 一线 |
| 交换区空位 | 2061 → 2060 | 2138 → 2140 | > 1 GiB。达到 |

采集口径：ClickHouse 无 k3s/mihomo、无 `probable_agent` 出向。Postgres：Exec 94、Exit 116、Security 6、`capture_aggregate` 456。无 FileAccess/Connect/Tls 洪水。`coverage_gaps` 死元组从 460 万降到 2.4 万（autovacuum 已收）。

这次**可以作为步骤 3 磁盘 + 口径验收**。P1b `capture_aggregate` < 80/6 分钟仍未达到（456/5 分钟，多 scope）。alerts 仍在高频更新（累计 64 万），但不挡采集验收。下一步转设计 §11.3 fixture 新跑，再推进整体 goal。步骤 4（`synchronous_commit=off` / P6 / P12）仍有门闩，先不做。

---

## 4. 已排除的方向

- 在本机启动 Kafka 以「消费掉」Redis 积压：Kafka 消费者不是存档路径，且会再加一层同盘落盘。
- 提高 Observer 队列容量（`RAW_QUEUE_BATCHES` 16→32）：只是把丢弃推后，不减少写入。
- 认为是 k3s 版本或 DaemonSet 机制问题：DaemonSet 无 `scale` 子资源属正常行为，暂停用 nodeSelector 即可。
- 认为是显卡或桌面程序崩溃：内核日志无 GPU hang、无段错误，桌面退出全部是 `systemd-oomd` 因内存压力所杀。
- 把文件探针限制到 Agent cgroup、把 `exit` 从原始观察中去掉、把正文从 Postgres 迁到 ClickHouse：违反设计 §6.1/§6.2/§9.1，见第 5 节。

---

## 5. 与《通用 Agent 服务观测设计》的兼容性核对

核对依据：`generic-agent-service-observability-design.md` §1 边界、§5 发现算法、§6 三阶段过滤、§9 性能与稳定性、§11.4 放行标准。目标要的是：内核事实与进程生命周期 → 工作负载上下文 → 有界行为窗口与候选评分 → 采集计划 → 明文与内核事实独立留存 → Session/Run → 父子视图与 EvidenceLink，每一层的丢失有独立计数，canonical 点查 `coverage=complete`。

| 方案 | 结论 | 依据 |
|---|---|---|
| P1 文件探针限 Agent cgroup（原方案） | **冲突，已撤回** | §5.3 「工具后工作区文件变化」是候选评分信号；§6.2 高频 FileAccess 只能按 file policy keep/sample，不能整类关掉；§1 「不能把 Unknown 等同于 Non-Agent」。且实测这 356 条/分钟本来就来自已归属 Agent 的进程，收窄 scope 不减少它们。 |
| P1 `exit` 不落原始观察（原方案） | **冲突，已撤回** | §6.2 「Unknown Exec/Exit/Security 保留」；§4.2 进程代次由 exit 关闭，缺 exit 会让 generation fence 无法收口。 |
| P1 文件聚合（第一次修订） | 兼容但无效，不计入 | 实测 1 s 重复率 1 %。开关可以开，预期为零。 |
| P1 基础设施分类（第二次修订） | 兼容，且是设计要求 | §6.3 「基础设施信号先于 Agent 行为晋升，避免数据库、消息队列和 AnySentry 自身服务制造候选」；§5.3 单一基础设施进程为负向信号。判定依据是 cgroup 与容器父子关系（F0 WorkloadContext），不是产品名，符合 §12 纪律。 |
| P1b 采样窗口 1 s → 10 s | 兼容 | §6.3 采样保留计数、窗口、hash、原因，粒度变化不改语义。 |
| P14 alerts/incidents 重写合并 | 兼容 | 研判结果投影，不在 §6.4 证据链；不影响 KernelFact / RawObservation / EvidenceLink。 |
| P2 停 `kernel_facts.event_idx`（原方案） | **冲突，已撤回** | `getDurableKernelFact` 别名回退按 `eventIds` 查，是 canonical 点查路径的一部分。 |
| P2 停另 5 个索引 + BRIN | 兼容，前提 P11 | 代码无任何按 `connection_id`、`process_generation_key`、`source_id` 查 Postgres 的路径；进程代次归因发生在 Observer 与 hot-ring。BRIN 需先给「最新 n 条」加时间下界，否则违反 §6.4 「读请求不得重新投影全量历史」。 |
| P3 `coverage_gaps` 聚合成每分钟一行（原方案） | **口径不符，已修订** | §9.2 要求 ring/collector/forwarder/WAL/canonical 各自独立计数，不能合并成一个 `dropped`；按 `(stage, reason, scope)` 聚合会保留这一点，但原方案的「每 60 s 一行汇总」会丢掉 revision 与 `firstSeenAt`，而 `onModuleInit` 要靠这些装回内存。修订为改 `scope` 维度 + 保留最近 32 个 revision。 |
| P4 检查点 / WAL 上限 / `shared_buffers` | 兼容 | 不改变已提交数据的持久性。 |
| P4 canonical 会话 `synchronous_commit=off` | **有条件兼容** | §11.4 「用页面数量代替 durable delivery」是禁止项；异步提交在崩溃时丢的行事后没人知道。必须补 async-commit 对账并把差额记成 `canonical_persistence_dropped`、对应窗口报 `partial`。用户已接受这几百毫秒的丢失，但目标要求丢失可见。 |
| P5 删旧物化视图与旧表、`async_insert` | 兼容 | 旧表代码无引用；ClickHouse 是分析投影，原始行在 Postgres。`async_insert` 丢失应记入 `projection/storage_unavailable` 类 gap（现有 `saveSemanticRecords` 失败路径已这么做）。 |
| P6 Postgres TTL / 分区 | 兼容，需定窗口 | §6.4 「有界分页、时间窗口」；TTL 之外的点查返回 `coverage=partial`+ `reason=retention_expired`，不能返回空。 |
| P7 关 streaming | 兼容 | 影子链路，代码明确失败不影响已接受事件。 |
| P8 worker 不在时不入队 | 兼容 | 应记 gap 计数而非静默丢弃（§9.2）。 |
| P9 内存限额 / swappiness | 兼容 | 不触及数据链路。 |
| P10 spool WAL | 属目标 Phase E | 只有证明无活跃记录才能截断，与 §9.1 「用全局 clear() 清空」禁止项一致。 |
| P11 「最新 n 条」加时间下界 | 兼容且是目标要求 | §6.4。 |
| P12 `interactionId` 提升为列 | 兼容 | 不改语义。 |
| P13 正文迁 ClickHouse | **暂不建议** | durable-first 点查依赖 Postgres 完整 `record`；见 P13。 |

一句话：优化只能砍「同一事实的多余副本」和「无人读的索引」，不能砍「哪些进程、哪些事件被看见」。修订后的方案满足这一条；原方案里 P1 的两项和 P2 的一项不满足，已撤回。

---

## 6. 附录：取证命令

```bash
# PSI / 磁盘 / D 态（Observer 运行时采 5 分钟）
cat /proc/pressure/io; awk '$3=="nvme0n1"||$3=="dm-0"{print $3,$13}' /proc/diskstats

# Postgres
psql -Atc "SELECT pg_size_pretty(pg_current_wal_lsn()-'0/0'::pg_lsn);"
psql -Atc "SELECT relname,indexrelname,idx_scan,pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_stat_user_indexes ORDER BY idx_scan;"
psql -Atc "SELECT tablename,attname,correlation FROM pg_stats WHERE attname IN ('event_at','observed_at');"
psql -Atc "SELECT name,setting,source FROM pg_settings WHERE name IN ('synchronous_commit','checkpoint_timeout','max_wal_size','full_page_writes','shared_buffers');"

# ClickHouse
clickhouse-client --query "SELECT table,sum(rows),formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active AND database='anysentry' GROUP BY table"
clickhouse-client --query "SELECT arrayJoin(tables),count() FROM system.query_log WHERE query_kind='Insert' AND event_time>now()-INTERVAL 1 DAY GROUP BY 1"
clickhouse-client --query "SELECT name,value FROM system.settings WHERE name IN ('async_insert','wait_for_async_insert')"

# Redis
redis-cli DBSIZE; redis-cli --scan --pattern 'bull:*' | awk -F: '{print $1":"$2}' | sort | uniq -c

# Observer 暂停 / 恢复（DaemonSet 无 scale）
kubectl -n anysentry patch ds a3s-observer --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/nodeSelector","value":{"manual.anysentry.io/observer-plane":"paused"}}]'
kubectl -n anysentry patch ds a3s-observer --type=json -p='[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'
```
