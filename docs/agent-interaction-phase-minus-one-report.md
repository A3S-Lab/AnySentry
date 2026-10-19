# Agent Interaction Phase -1 / Phase 1 验证报告

> 日期：2026-08-27，2026-08-28 更新  
> 结论：生产 `metadata-only` 基础链路已实现并通过隔离验证；Python/OpenSSL
> HTTP/1.1 用户消息 Fixture 和真实 Codex `exec -` stdin 输入边界 Fixture
> 已形成两个互补的正确性闭环。受控 Codex stdin Fixture 现已进入独立加密
> ContentStore，并可在 `/conversations` 经双凭据和调查原因按需查看。该能力
> 仍是 `isolated_fixture`，不代表生产正文采集，也不代表已经完成全链路 Turn
> 追踪。当前开发实例另按本机调试需求显式开启 `UNSAFE_LOCAL` 无密钥直显；
> 该便利模式不属于生产安全 Gate。

## 1. 本轮范围

本轮只实现已获准的安全子集：

1. Observer 在生产模式下从采集源头禁止读取 TLS Payload Buffer；
2. 隔离测试环境提供受 PID 白名单保护的 OpenSSL 与 native-stdin 明文 Fixture；
3. AnySentry 接收 LLM 传输元数据，以 Kafka durable ack 返回 Receipt；
4. PostgreSQL 和 ClickHouse 作为可重放投影；
5. Observer Forwarder 使用独立 WAL、重试、DLQ 和 Loss Ledger；
6. `/conversations` 的普通列表与详情只展示进程、连接、Provider、字节数、
   内容引用和连接级时间证据，不随页面加载正文；
7. clean deployment 的 Raw View 固定拒绝；本机受控 Fixture 可通过显式配置
   启用独立加密 ContentStore 和按需 Raw View。

以下能力仍不在生产授权内，也没有被伪装成生产能力：

- 用户消息正文采集；
- HTTP/2、WebSocket 请求重组；
- 生产 Provider Body Parser；
- 生产 Runtime 进入 AnySentry Interaction Plane 的 `UserInstructionObserved`；
- 多活跃 Turn 关联；
- Query → Tool / File / Process / Egress 的因果追踪；
- 生产正文 ContentStore、正文 HMAC 和面向普通用户的 Raw View；
- Node、Bun、Claude Code 的正文 Runtime 支持声明；
- Codex 交互式 TUI、PTY、app-server、Agent→LLM 请求正文或多 Turn 支持声明。

2026-08-28 仅在 `fixture_payload + isolated_test + 精确 PID + 明确确认` 的隔离
Gate 下新增：

- 有界 HTTP/1.1 `Content-Length`、chunked 和 gzip 重组；
- OpenAI Chat Completions、Responses、Anthropic Messages 风格的最新
  `role=user` 文本提取；
- 专用 `0600` Fixture Artifact 中的 `LlmRequestObserved` 与嵌套
  `UserInstructionObserved`；
- 独立的 exact-PID、fd0 native-stdin Fixture，以及专用 Artifact 中的
  `AgentInputObserved` 与嵌套 `UserInstructionObserved`；
- 普通 Observer NDJSON/日志不再具有承载 TLS 明文的事件类型。

同日新增受控的端到端正文子集：

- 仅接受 `ebpf_stdin + isolated_fixture + encrypted_full` 的严格 Schema；
- AES-256-GCM 加密正文，租户和密钥版本进入认证附加数据；
- 接收边界为 `ContentStore finalize + Kafka acks=-1`；
- PostgreSQL / ClickHouse 投影只保存 `contentRef`、字节数和 SHA-256，不保存
  正文；
- Raw View 必须同时提供管理凭据、独立正文凭据和 12–500 字符调查原因；
- 查看和删除写入审计，删除后只保留元数据与不可恢复 tombstone；
- 真实 `codex-cli 0.147.0` 的 87 字节受控 stdin 已完成
  `eBPF → 加密上传 → 投影 → 授权读取`，读取结果与 Ground Truth 完全一致；
- 普通 Observer 输出、日志、Kafka 事件和 PG/CH 元数据投影不承载正文；
- 生产 Observer 继续保持 `metadata + SSL=0`。

受保护 Raw View 是正式安全语义。当前开发实例额外启用了
`ANYSENTRY_INTERACTION_UNSAFE_LOCAL_DIRECT_VIEW=on`，仅在
`isolated_fixture` 下旁路状态、会话列表、详情和正文 GET，使页面选择会话后
自动展示正文。Source 管理、其他管理 API 和正文 DELETE 仍要求原凭据；生产与
手工部署 Manifest 均禁止设置该开关。

## 2. Gate 状态

| Gate | 当前状态 | 证据与限制 |
|---|---|---|
| A：Runtime ABI | **部分通过，性能未通过** | Python 3.12 + 动态 OpenSSL 3 的出站-only schema-4 ABI 与 HTTP/1.1 Parser 正确性闭环通过，真实边界测试已完整重组 1,012,036 字节指令；Codex CLI 0.147.0 的 native `exec -` fd0 输入边界正确性闭环通过；共享工作站 OpenSSL A/B/A 未达到 2% P95/TTFT 预算，Codex stdin 也尚未完成 declared-load；Node 22 公开 `SSL_*` ABI 未捕获到片段 |
| B：并发 Turn | **未通过** | 有界多活跃 Turn Map 只完成架构约束，生产尚未实现正文 ModelCall / Turn Correlator |
| C：持久化 | **metadata-only 通过；受控正文通过** | Metadata 以 Kafka ack 为 Receipt 边界；受控正文以 ContentStore finalize + Kafka ack 为边界；PG/CH 可重放投影、稳定重试、冲突拒绝和故障降级已验证 |
| D：安全 | **metadata-only 通过；受控 Fixture 通过；生产正文未通过** | 默认源头不读 Payload；受控 Fixture 具备独立 AES-GCM、双凭据、原因、审计和删除闭环；真实用户认证、服务端 RBAC、KMS 和生产租户治理尚未完成 |

正式冻结仍要求四项 Gate 全部通过。当前只允许灰度运行生产
`metadata-only` 链路。

## 3. Runtime 指纹

运行时清单由以下命令生成：

```bash
pnpm inventory:agent-interaction-runtimes
```

本轮主机指纹：

| 组件 | 版本 / Build ID | 结果 |
|---|---|---|
| Kernel | Linux 6.17.0-23-generic x86_64 | Spike 主机 |
| Node | v22.23.1 / `fc483f3be9455c8b2af025e7f4f61c6bc616cdea` | 未通过正文 ABI Gate |
| Python | 3.12.3 / `04657a7aa3577f9234b186f9a5918f06030389b6` | 与系统 OpenSSL 组合通过小请求、276 KiB 和近 1 MiB 精确 Fixture；性能 Gate 未通过 |
| OpenSSL | 3.0.13 / `12056657bc94e197a62896a1676f8400f80ed765` | Phase -1 只声明出站 `SSL_write*` 请求路径；响应正文不在批准范围 |
| Codex CLI | 0.147.0；静态 PIE native Rust，`reqwest` / `hyper-rustls` / `rustls` | `codex exec -` exact-PID fd0 输入边界正确性通过；交互式 TUI、app-server、Agent→LLM 请求正文、性能 Gate 均未通过 |
| Claude Code | 2.1.207 / `2ba9a4dca997a53147167d7f967fdc840325054c` | 未支持 |
| Bun | 当前主机不存在 | 未测试 |

### 3.1 Python / OpenSSL 结果

隔离 `fixture_payload` 模式同时满足：

- `A3S_OBSERVER_ENVIRONMENT=isolated_test`；
- 明确确认字符串；
- 非空、非零、最多 256 个 PID 的 allowlist；
- BPF 中的全局使能位和 PID Map 双重检查。

对真实 Python HTTPS 请求的 `SSL_write_ex` 观测结果：

- eBPF 实验 ABI `schema_version=4`；
- `io_direction=local_write`；
- 每条动态 Ring Record 最多 31 KiB，调用级最多 1 MiB；
- 完整调用经有界多 Fragment 重组后满足 `captured_length == original_length`；
- `truncated=false`；
- HTTP Body 与 Ground Truth 逐字节一致；
- `capture_profile=isolated_fixture`。

2026-08-28 在一次性 `python:3.12-slim` 特权容器中，对 OpenSSL 3.5.6 完成
多轮真实闭环。最终 schema-4 边界轮同时满足：

- 小请求、276,034 字节指令和 1,012,036 字节指令均各生成且仅生成一个
  `UserInstructionObserved`；
- Fixture Artifact 权限为 `0600`；
- Authorization 与全部受控 Marker 在普通 NDJSON/日志中的泄漏为 0；
- `SIGUSR2` Kill Switch 在最新多轮成功测试中约 0.62–20.81 ms 生效；
- Kill Switch 后发送的受控请求产生 Payload Observation 为 0；
- 同一验证先执行生产 `metadata-only` 请求，Heartbeat 明确
  `payload_capture_enabled=false`，普通输出正文为 0。

Fixture 现在直接按批准 PID 附着 uprobe，并继续在 eBPF PID Map 内二次校验，不再
使用全机 uprobe 后仅靠用户态过滤。

当前内核 ABI 使用 31 KiB per-CPU Scratch 和动态 Ring Record。P95 范围内最多
四片走静态直达路径，更大请求通过 `bpf_loop`，单次成功 `SSL_write*` 上限为
1 MiB。Phase -1 不挂载 `SSL_read*` 正文探针。
超过上限只发出 `truncated=true` 的无正文 Loss Record，不得生成
`captureCompleteness=complete`。初始 512 KiB Ring 在近 1 MiB 边界测试中出现
不完整重组，扩大为有界 4 MiB 后同一 Ground Truth 通过；这一失败与修复保留为
容量证据。68 KiB、80 KiB 和 128 KiB per-CPU Scratch 会被当前内核以 `E2BIG`
拒绝，因此不能作为可运行方案。Observer build script 现已显式追踪共享
`a3s-observer-common` ABI 源码，避免仅修改共享常量时静默复用旧 eBPF 字节码。

ABI 已通过真实内核 verifier 与边界 Fixture，但 declared-load 性能 Gate 未通过，
因此 Gate A 仍只能判定“部分通过”。详见 4.1。

### 3.2 Node 22 结果

Observer 已尝试挂载：

- `SSL_write` / `SSL_read`；
- `SSL_write_ex` / `SSL_read_ex`；
- `SSL_write_ex2`；
- 每个函数的 entry 与 return。

10 个 uprobe 可以挂载，但真实 Node 22 HTTPS 请求没有产生 `SslContent`。
该二进制静态链接 OpenSSL，内部调用不保证经过公开包装符号；因此不能仅凭符号存在
宣布支持。Node 必须继续做精确二进制指纹适配或选择其他 Runtime 证据点。

### 3.3 Codex native stdin 结果

当前 `codex` 命令是 Node 启动器，实际执行：

```text
@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
```

该文件是约 247 MiB 的 stripped static PIE。二进制指纹字符串表明其使用
`reqwest 0.12.28`、`hyper-rustls 0.27.7`、`rustls 0.23.36` 与
`aws-lc-rs 1.16.2`；因此 OpenSSL `SSL_write*` 不是当前 Codex 的正确挂载点。

隔离 Spike 新增两个只在 `fixture_payload` 下可附着的 tracepoint：

```text
sys_enter_read
sys_exit_read
```

内核侧同时要求全局正文 Gate、exact-PID allowlist 和 `fd=0`，成功返回后才从
用户 Buffer 复制有界片段；EOF 才将同一 PID/fd 的内容提交给专用 Fixture
Pipeline。生产 `metadata-only` 不加载这两个 program，也不会读取 stdin Buffer。
OpenSSL Fixture 可通过 `A3S_OBSERVER_PAYLOAD_FIXTURE_OPENSSL=off` 独立关闭。

真实内核验证分两层：

1. disposable Python fd0 Fixture 将 83 字节 Ground Truth 分成 5 次 `read()`，
   最终逐字节重组为 1 条 `AgentInputObserved`；Artifact 为 `0600`，普通输出
   泄漏为 0，Kill Switch 约 20.73 ms，停采后记录为 0；
2. `codex-cli 0.147.0` 的 native 二进制先停在 `SIGSTOP`，eBPF exact-PID
   tracepoint 附着完成后再恢复执行。`codex exec -` 读取的 87 字节合成指令与
   Ground Truth 完全一致，Codex 正常返回 `OK`，普通 Observer 输出泄漏为 0，
   且未挂载 OpenSSL Fixture。

首轮使用 Node 启动器 PID 时没有采集到任何内容；这是正确的 fail-closed 结果，
因为读取 stdin 的是其 native 子进程。验证器随后直接启动 native binary，保证
exec 前后 PID 不变。该失败记录也证明 PID allowlist 没有向子树或整机静默扩散。

该结果只证明：

> 对当前指纹的非交互式 `codex exec -`，Observer 可以在不修改 Codex 代码的
> 情况下观测“输入给 Agent 的原始 stdin 指令”。

它不证明“模型最终收到的请求正文”。Codex 可能在发送给 LLM 前追加 system
上下文、工具结果和历史消息。交互式 TUI/PTY 还可能包含终端控制序列、多次输入且
长期不出现 EOF；因此不能复用当前“一条 stdin 流直到 EOF 等于一条指令”的边界。
当前 Fixture 已进入 AnySentry 独立 ContentStore 和 `/conversations` 受控展示，
但尚未进入 Turn Correlator，也没有成为生产采集模式。

## 4. metadata-only 安全验证

生产默认：

```text
A3S_OBSERVER_INTERACTION_CAPTURE_MODE=metadata
A3S_OBSERVER_SSL=0
```

已验证：

- metadata 模式不挂载 TLS Payload uprobe；
- metadata 模式不挂载 native-stdin `read(2)` Payload tracepoint；
- eBPF 不执行 Payload Buffer 的 `bpf_probe_read_user` 路径；
- BPF 使能位为 0；
- Ring Buffer 不出现正文分片；
- Collector Heartbeat 明确报告 `payload_capture_enabled=false`；
- 真实 Python TLS 请求中的唯一 marker 未出现在 Observer 输出；
- API Schema 拒绝 `prompt`、`query`、`messages`、`requestBody`、
  `payload`、`contentHmac` 等字段；
- Kafka 投影重新构造 allowlist Record，未知字段不会进入 PG/CH；
- clean deployment 的 `/security-center/interactions/:id/content` 固定返回 403；
- metadata-only 不计算 HMAC、不访问 ContentStore。

`SIGUSR2` 一键 Kill Switch 在最新多轮实测中约 **0.62–20.81 ms** 完成：

1. 先将 BPF 使能位设为 0；
2. 再丢弃用户态已排队 Fragment；
3. 只能通过进程重启和完整 Fixture Gate 重新启用。

单次空闲采样中 Observer 为约 **0.98% CPU / 38.92 MiB RSS**。该数据低于合同
上限，但不是正式 declared-load 性能结论；2% P95/TTFT 性能 Gate 仍是 Gate A 的
阻塞项。

### 4.1 真实 metadata-only 灰度部署

2026-08-28 使用当前本地 Collector 与正式 `observer-supervisor` 在现有开发栈
完成灰度启动，未重建 API、ClickHouse、PostgreSQL 或 Kafka：

- 旧的手工 Forwarder 容器绑定已经消失的宿主 PID，处于重启循环；已停止但保留
  容器本体供审计；
- 为 `modules-observer` 创建受 Token 保护的精确 Source，凭据保存在 gitignored
  `0600` env 文件；
- Compose 固定 `A3S_OBSERVER_INTERACTION_CAPTURE_MODE=metadata`、
  `A3S_OBSERVER_SSL=0`、`ANYSENTRY_INTERACTIONS=on`；
- Supervisor、Collector、Forwarder 三个进程同时存活；
- 普通 Forwarder WAL 与 Interaction WAL 均以 `0600` 写入
  `observer-forward-spool` 持久卷；
- 3 次来自已识别 Agent 进程树的 OpenAI HTTPS 探测全部形成
  `LlmTransportObserved`，随后重启 Observer 再探测 1 次仍成功；
- 本轮 4 条新增记录均完成 Kafka durable ack 与 PG/CH 投影，拒绝、重复与投影
  失败均为 0；
- Collector 统计为 `llm=3`、`ssl=0`、`dropped=0`、`ssl_dropped=0`、
  `output_dropped=0`；
- 查询详情只有进程、Provider、SNI、连接级时序与字节数，
  `rawRetentionState=not_retained`，不存在 `content`、`query` 或 `contentRef`；
- Raw View 继续返回 403。

后续只重建 `anysentry` 服务时，原先仅通过调用 shell 临时传入的
`ANYSENTRY_INTERACTIONS=on` 丢失，API 正确降级为
`enabled=false / durability=unavailable`，Observer 端累计 37 次发送拒绝而没有
删除 Interaction WAL。现已将该开关持久写入 gitignored 本地 `.env` 并只重建
API 服务；复核结果为：

- `enabled=true`、`ready=true`、`durability=ready`；
- PostgreSQL / ClickHouse 投影均为 `ready`；
- 初始重放后本进程计数为 `accepted=3`、`projected=3`；最终 Codex 复验后为
  `accepted=4`、`projected=4`，拒绝、重复和投影失败均为 0；
- 最终查询返回 16 条已投影 metadata-only Conversation；
- Interaction WAL 最终审计为 `puts=8`、`acks=8`、`live=0`、`bad=0`。

这次恢复证明服务端功能开关必须持久化，且 API 停机窗口内 Forwarder 不会因 503
删除 WAL。37 是重试次数，不能解释为 37 条唯一交互。

这证明生产 metadata-only 链路已经可以真实运行，但不改变 Gate A 正文性能未通过、
Gate B Turn 关联未实现、Gate D 正文安全未通过的结论。

### 4.2 受控加密正文闭环

本机使用 gitignored、权限 `0600` 的 `.local/interaction-content.env` 显式开启：

```text
isolated_fixture content ingest
→ tenant-versioned AES-256-GCM ContentStore finalize
→ Kafka durable ack
→ PG / CH metadata projection
→ /conversations 按需授权读取
```

已通过：

- ContentStore 单元测试：加密、精确解密、幂等 finalize、GCM 篡改拒绝、删除；
- Service 故障测试：Kafka 失败不返回虚假 Receipt、孤儿重试复用、响应丢失稳定
  重放、冲突在 Kafka 前拒绝；
- 生产端口受控 Runtime Gate：普通列表/详情无正文，缺管理凭据返回 401，缺独立
  Raw View 凭据返回 403，缺原因返回 400；
- 授权读取正文与 SHA-256 完全一致，审计记录不包含正文；
- 删除后密文被清除，详情显示 `deleted` tombstone，Raw View 不再可读；
- 两轮真实 `codex exec -` eBPF stdin 测试完成加密上传；最终一轮还通过同一
  Raw View API 回读并与 Ground Truth 比较；
- 生产 Observer 环境仍为
  `A3S_OBSERVER_INTERACTION_CAPTURE_MODE=metadata`、`A3S_OBSERVER_SSL=0`。

后续本机直显回归还验证：

- 无凭据可读取状态、会话列表、详情和正文 GET；
- 列表与详情响应仍不携带正文，只有独立正文 GET 返回明文；
- 页面选中会话后自动请求正文，并提供加载、错误、隐藏和重新显示状态；
- 无凭据 Source 创建和正文 DELETE 均返回 401；
- 受保护删除仍可使用管理与独立正文凭据完成；
- 部署校验拒绝在 canonical、manual 或 production Manifest 中出现直显开关。

该闭环只证明“输入给当前受支持 Codex Runtime 的受控 stdin 指令可以被安全落地
和展示”。它不证明 Agent 最终发送给 LLM 的请求正文，也不授权常态化采集真实
用户输入。

### 4.3 Declared-load 性能与正确性

负载分布固定为 100 RPS、并发 32，指令大小为 128 B / 4 KiB / 64 KiB /
1,040,000 B；验证器执行：

```text
metadata baseline before
→ isolated fixture payload（只保留长度与 SHA-256）
→ SIGUSR2 后继续发请求
→ metadata baseline after
```

比较时使用前后两段 metadata 中更快的 P95，不能挑选有利基线。当前证据为：

- 一轮 900 秒 Fixture 完成 90,000 / 90,000 条，Ground Truth 完整率 100%，
  Ring Drop、容量丢弃、重复、正文留存、普通输出泄漏和 Kill Switch 后正文记录均
  为 0；CPU 增量约 3.43%，RSS 未增长；
- 该轮 P95 与 TTFT 相对保守基线分别回归约 57.9% 和 52.9%，未通过合同；
- 该 900 秒轮次发生在共享 ABI 构建依赖修复前，且 metadata 基线只有 60 秒，
  因此不能作为最终 ABI 的通过证据，只能保留为失败与正确性历史证据；
- 最终 31 KiB、出站-only、静态四片快路径的 120 秒 A/B/A 完成
  12,000 / 12,000 条，所有正确性、安全和 Drop 项通过，CPU 增量 4.848%，RSS
  增量 77,824 B，Kill Switch 20.31 ms；
- 同一最终轮次的 metadata-before / metadata-after P95 分别为
  5.382 ms / 2.680 ms，TTFT 分别为 4.780 ms / 2.496 ms；Fixture 为
  5.226 ms / 4.771 ms。两段基线相差接近一倍，说明共享工作站不是平稳性能环境；
- 按冻结的保守算法，该轮 P95 / TTFT 回归为 95.0% / 91.1%，因此结果仍是
  `FAIL`，不能因为环境抖动而改判通过。

正式复验必须在专用安静节点执行 900 秒 metadata + 900 秒 Fixture + 900 秒
metadata，保持阈值不变。通过前 Runtime 状态固定为：
`bounded_1mib_correctness_passed_performance_gate_failed`。

## 5. Durable Interaction Lane

metadata-only 接收边界：

```text
Source Token 鉴权
  → 严格 metadata Schema
  → PG 不可变 Receipt 预留
  → Kafka idempotent producer, acks=-1
  → 202 Durable Receipt
  → PG / ClickHouse 可重放投影
  → 成功后提交 Kafka offset
```

稳定键：

```text
interactionId = hash(sourceId, sourceEventId)
payloadFingerprint = hash(所有不可变元数据)
```

语义：

- 相同 `sourceEventId` + 相同指纹：返回稳定 Receipt；
- 相同 `sourceEventId` + 不同指纹：409 conflict；
- Kafka 不可用：503，不返回虚假 durable ack；
- Receipt Registry 不可用：503；
- PG 或 CH 投影失败：不提交 offset，允许重放；
- PG/CH 投影按 Kafka Batch 批量写入，避免把 Interaction 链路重新做成高频
  小 Insert；
- Observer Interaction WAL 默认每条写入同步落盘；Loss Ledger 使用有界轮转；
- 并发 pending 重试仍可能产生物理 Kafka 重复，但 PG/CH 读取按稳定逻辑键折叠；
- Receipt 只表示 Kafka 已持久确认，不谎称 PG/CH 投影已经完成。

受控正文接收边界：

```text
Source Token 鉴权
  → 严格 isolated_fixture Schema
  → PG 不可变 Receipt 预留
  → ContentStore AES-256-GCM finalize
  → Kafka idempotent producer, acks=-1
  → 202 Durable Receipt
  → PG / ClickHouse 可重放元数据投影
```

正文已 finalize 但 Kafka 失败时不返回 Receipt；调用方使用稳定
`sourceEventId` 重试并复用同一密文对象。PG/CH 投影不属于 Receipt 原子边界。

运行状态把两条语义分开：

- `ready` / `durability.state` 只表示是否能给出 Kafka durable ack；
- `projection.state` 单独表示查询投影为 `ready` 或 `degraded`；
- 投影失败时公开失败 Topic/Partition，但接收通道仍可继续持久化；
- 只有失败分区成功重放后才解除投影降级。

## 6. 故障与端到端测试

已通过的场景：

1. 首次写入得到 Kafka durable Receipt；
2. 完全相同重试返回同一 `interactionId`、`conversationId`、`acceptedAt`；
3. 不可变元数据冲突返回 409；
4. metadata-only 入口携带正文字段返回 400；
5. clean deployment Raw View 返回 403；
6. PG 与 CH 均完成投影；
7. Kafka 不可用时服务 `ready=false` 且写入返回 503；
8. Forwarder 收到 503 后保留 WAL；
9. Forwarder 重启后重放 WAL；
10. 收到匹配的 durable Receipt 后才删除 WAL；
11. 4xx 永久拒绝进入 DLQ；
12. Spool 达容量上限后写入 metadata-only Loss Ledger；
13. Producer 失败不创建虚假内存 Receipt；
14. in-flight Promise 数和字节数有硬上限；
15. 顺序重复写入在 Kafka、PG 和 CH 的逻辑结果均保持 1。
16. ClickHouse 表暂时不可用时，Kafka Receipt 仍成功且对应分区 `LAG=1`；
17. 投影故障时状态为 `durability=ready`、`projection=degraded`，不会混淆接收
    与查询可用性；
18. ClickHouse 恢复后自动补投、`LAG=0`，失败分区清空且逻辑结果仍为 1；
19. PG 已投影而 CH 未投影时重启消费者，仍可从未提交 Offset 完成跨进程恢复；
20. 三轮 1000 条、32 并发、各 100 次重放的隔离负载均无投影失败。
21. 受控正文 finalize 后 Kafka 失败不产生虚假 Receipt，重试复用稳定对象；
22. Raw View 三项授权缺一不可，读取和删除均审计且审计不包含正文；
23. AES-GCM 密文篡改被拒绝，删除后密文不可恢复；
24. 真实 Codex stdin 加密上传后的授权回读与 Ground Truth 完全一致。
25. 显式本机直显模式无需凭据即可读取正文，但不放开管理写入或正文删除。
26. 真实 `codex-cli 0.147.0` 一次性进程的 stdin 指令与 stdout 回复连续两轮
    逐字节通过 Ground Truth；普通 Observer 输出正文泄漏为 0。
27. 输入和回复分别形成 `AgentInputObserved` 与 `AgentOutputObserved`，使用
    相同显式 source Turn ID 后投影为同一稳定 `turnId`，详情统计
    `completeTurns=1`。
28. `/conversations` 在本机直显模式下自动读取两段加密正文，按时间线分别显示
    “用户指令”和“Agent 回复”；列表与普通详情投影仍不内嵌明文。

### 6.1 隔离负载结果

| 轮次 | Durable Receipt 吞吐 | P50 | P95 | 最大值 | 重放 P95 | PG/CH 投影批次 | 投影失败 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 批量投影初测 | 265.4 条/秒 | 112.51 ms | 182.46 ms | 344.96 ms | 44.53 ms | 80 | 0 |
| 状态分离回归 | 308.72 条/秒 | 99.61 ms | 136.00 ms | 205.21 ms | 54.52 ms | 79 | 0 |
| 最终镜像 + Source 记账 | 350.44 条/秒 | 87.32 ms | 119.32 ms | 221.43 ms | 46.65 ms | 77 | 0 |

每轮均为 1000 个唯一事件、并发 32、随后重放 100 个已确认事件。相较于逐条
投影的 1000 次 PG/CH 写入，最终镜像只执行 77 个投影批次；所有 1000 条逻辑
记录最终可查询，重放没有增加逻辑计数。该结果是本机隔离数据，不是生产容量
承诺。

隔离测试使用独立端口和独立测试数据库；生产 `29653` 未被替换或重启。

## 7. HTTP/2 与时间语义

当前 Observer 的传输计时不等于请求级计时：

- HTTP/1.1 未完成 Body 重组前也不能自动宣称 request latency；
- HTTP/2 多 Stream 共用连接，Socket 时间只能标记为 connection-level；
- 长连接和 WebSocket 在缺少 Stream/Message 边界时，latency 和 TTFT 为
  `unavailable`；
- 当前 Schema 只允许 `timingScope=connection|unavailable`；
- UI 明确显示“连接级”或“不可用”，不会呈现为精确 Turn TTFT。

## 8. 允许与禁止的产品声明

当前允许：

> AnySentry 可以无侵入观测已识别 Agent 进程与 LLM 目标之间的传输元数据，
> 并以可恢复的专用链路展示连接证据。

仅限隔离 Fixture 证据还可以表述为：

> Observer 已证明可以从当前 `codex-cli 0.147.0` 的非交互式 `codex exec -`
> exact-PID stdin/stdout 边界还原输入给 Agent 的合成指令及 Agent 最终写入
> stdout 的回复，将二者投影为一个显式 Turn，并通过 AnySentry 受控加密正文
> 链路展示；该能力尚未进入生产采集。

当前禁止：

> AnySentry 已采集用户指令。  
> AnySentry 已还原模型实际收到的消息。  
> AnySentry 已把一条用户指令与该 Agent 的全部底层动作精确关联。  
> 所有 Agent / Runtime 均已支持。

## 9. 下一阶段

按以下顺序继续，不能跳过：

1. 在专用安静基准节点对最终 ABI 完成 900 秒 metadata + 900 秒 Fixture +
   900 秒 metadata，验证 Ring Drop、CPU、RSS、Agent P95 和 TTFT；
2. 为 Codex `exec -` stdin Adapter 冻结单独的 declared-load 合同，验证 CPU/RSS、
   Agent 延迟、Ring Drop、最大输入、无效 UTF-8、进程退出和 Kill Switch；在此
   之前保持 `fixture_only`；
3. 对 Codex TUI/PTY 和 app-server 先识别真实消息边界，禁止把整段终端流或一个
   长连接错误标记为一条 `UserInstructionObserved`；
   同样禁止把 stdout 日志、进度输出或终端控制序列直接标记为最终
   `AssistantResponseObserved`；
4. 为 Node 22、Claude/Bun 完成精确 Runtime Spike；失败则明确
   `unsupported`；
5. 仅在当前有界多 Fragment ABI 的 declared-load Gate 通过后，再扩展 HTTP/2
   Stream 和 WebSocket Message 边界；
6. 扩大已实现的隔离 Provider Parser Fixture，并保持生产正文入口关闭；
7. 对更多真实 Payload 分布继续用 ground truth 验证
   `LlmRequestObserved` 和 `UserInstructionObserved`；
8. 实现并验证有界多活跃 Turn Map、`ambiguous` / `unassigned` 和迟到修订；
9. 在现有受控审计/删除闭环之上完成真实用户认证、服务端 RBAC、KMS 托管、
   租户密钥轮换和保留策略；
10. Gate D 全部通过后，才可单租户、单 Runtime 灰度正文能力。

在以上工作完成前，生产配置必须继续保持 `metadata-only`。
