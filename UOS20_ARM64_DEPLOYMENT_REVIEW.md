# AnySentry UOS 20 ARM64 部署复盘

## 正确打包流程

正式发布以 `AnySentry`、`Observer`、`Sentry` 三个仓库经过审核的 integration branch HEAD 为输入。AnySentry 和 Observer 通过 direct merge 引入上游 main，再提交 UOS 兼容修改；Sentry 使用锁定的 main 提交。构建程序确认三个工作区 clean、提交号与 `versions.env` 一致后，将源码导出到临时目录，分别构建业务服务、原生 Sentry、Node、ClickHouse、Redis、Linux 4.19 Observer、L3 和诊断程序。构建完成后执行 ELF/ABI、BPF 版本、包结构和 SHA-256 校验，生成 `PROVENANCE` 后打包。稳定 UOS 分支仅在目标环境验收通过后推进。

## 设备基线

- 操作系统：UnionTech OS Server 20 Enterprise；
- 处理器：Kunpeng 920，aarch64，16 核；
- 内存：约 64 GiB；
- glibc：glibc 2.28；
- 内核页大小：65536 字节；
- 显示内核：`4.19.0-arm64-server`；
- 内核构建时间：2021-04-15；
- BPF 有效版本：4.19.90，版本码 `0x0004135a`；
- BTF：不可用；
- BPF、KPROBE、KPROBE_EVENTS、PERF_EVENTS：已启用；
- 权限：root，具有 `CAP_SYS_ADMIN`、`CAP_SYS_RESOURCE`，Seccomp 未启用；
- 安全模块：capability、uosmanager、AppArmor；
- systemd 和命名空间检测表现为宿主环境。平台访问路径具有容器化或托管特征，因此是否为容器不能仅依据 `/.dockerenv` 判断，部署门禁以实际 syscall 能力为准。

## 主要故障与修正

### 内核配置文件读取失败

初版安装程序将 `/boot/config-4.19.0-arm64-server` 可读性作为硬门禁，导致预检提前退出。修正后按 `/boot/config-*`、`/proc/config.gz` 顺序读取；均不可读时给出警告，以无持久副作用的 BPF syscall 探测结果为最终依据。

### ClickHouse 非法指令

通用 ARM64 ClickHouse 在目标 Kunpeng CPU 上执行后触发 `SIGILL`，服务持续重启，API 因等待 8123 超时而失败。根因是二进制使用了目标 CPU 不支持的指令。修正为 ClickHouse 24.8.14.39 `armv8.0-compat` 配置，并在安装预检直接执行 `clickhouse --version`，使不兼容包在停服前失败。

### Observer BPF 程序全部加载失败

初始 legacy Observer 使用 uname 推导的 4.19.0 BPF 版本，八个程序均收到 `BPF_PROG_LOAD EINVAL`。目标内核无 BTF，因此不能使用 CO-RE 路径。专用 syscall 探测证明映射、socket filter 和权限正常，但 kprobe 仅接受 4.19.90。hotfix3 将 legacy BPF `kern_version` 固定为 `0x0004135a`，最终八个探针全部附加成功。

该问题说明发行版显示版本不等于内核 BPF ABI。以后不得仅按 `uname -r` 选择 Observer，必须执行随包探测程序。

### Redis 7.4.2 在 ARM64 内核主动退出

Redis 的实际 `MADV_FREE + fork()` 脏页自检证明该 UOS 4.19 ARM64 内核存在 Copy-on-Write 数据损坏风险，Redis 因 `ARM64-COW-BUG` 保护而拒绝启动。该 Redis 仅承担可重建的 BullMQ 临时队列，安全事件和判定结果由 ClickHouse 持久化。因此发布配置关闭 RDB 和 AOF 后台持久化，再显式忽略该启动警告；不得仅忽略警告并继续启用 fork 型持久化。

### Observer Source 配置脚本错误

服务创建 Source 返回 HTTP 201，但旧脚本仅接受特定状态或未解析 API 的 `data` 信封，错误报告为创建失败。人工编辑时又曾产生 `payload?.data??payload:` 语法错误；执行命令缺少路径开头 `/` 时出现 `MODULE_NOT_FOUND`。当前脚本使用 `payload?.data ?? payload`，接受所有 `response.ok` 状态，并使用绝对安装路径。

### 事件验证与采集噪声

旧验证仅在事件列表查找单个 ToolExec 标记。在高吞吐下，内存热窗口已达到 100000，目标事件可能在查询前被挤出，因而出现服务正常但验证失败。新验证改为检查 Source 的 `acceptedEvents` 增长、`rejectedEvents` 不增长、collector 健康以及八个探针日志。

采集统计中 FileAccess 约占 99.7%，主要来自 Observer 对 ClickHouse 数据和日志目录的自观测。systemd 现默认过滤 `/var/lib/anysentry/clickhouse/` 与 `/var/log/anysentry/`，同时保留 `/home`、`/etc` 和工作区安全事件。

## compat7 至 compat16 现场要点

目标机是 systemd 宿主，不是 k3s。机器上已有 Docker，`docker-proxy` 占用了 `9000`、`8000`、`8001`、`7998`、`7999`、`17862`、`8080`。AnySentry 不得再监听 `9000` 和 `8000`。发布包标识是 `0.4.0-compatN`；TypeScript 侧 `@a3s-lab/sentry` 保持 `0.3.0`，`@a3s-lab/code` 保持 `8.6.0`。改 compat 号时不要改这两个 npm 版本。

### 服务进程写不了 `/opt`

`./install.sh` 由 root 执行，程序落在 `/opt/anysentry`。在宿主机上用 root 查看，这个目录是可写的。API、快速研判和 L3 单元的 `User` 是 `anysentry`，并且 `ProtectSystem=strict`。服务自己的挂载命名空间里 `/opt` 只读，`ReadWritePaths` 只有 `/var/lib/anysentry`，工作目录是 `/opt/anysentry/app`。对 `/opt` 做 `chmod` 或 `chown` 改变不了这个挂载。

a3s-code 未收到记忆目录时，默认写 `<工作目录>/.a3s/memory`，于是 LLM 配置页报 `failed to initialize memory store: /opt/anysentry/app/.a3s/memory` 和 `read-only file system`。compat13 起 L2 工作目录是 `/var/lib/anysentry/a3s-l2-workspace`，记忆目录是 `/var/lib/anysentry/a3s-memory`，安装时由 `anysentry` 用户拥有。以后新增会写文件的运行时状态，都放在 `/var/lib/anysentry` 下，并在 `install.sh` 里建好目录。

### 版本

| 包 | 现场现象 | 处理 |
| --- | --- | --- |
| compat8 | 上游 `@a3s-lab/code` 8.6.0 的 linux-arm64 二进制需要 glibc 2.38 | 用 glibc 2.28 工具链在本机重编 `.node` 和 `libzvec_c_api.so`。`.node` 的 RUNPATH 为 `$ORIGIN/zvec`，页对齐 65536 |
| compat10 | 前面的服务失败后，后面的服务没有启动日志；或者服务没起来却留下半套新版本 | 每个单元都启动并写入 `startup-*.log`。仍有单元不是 active，或 API 因 a3s-code 起不来，本次更新失败并回滚。a3s-code 探测结果写入 `a3s-code-startup.txt`，探测本身不单独阻断 |
| compat11 | 旧 ClickHouse `events` 表缺少 `decisionRevision`，物化视图先创建，API 报 Code 47，`storage.mode` 停在 `memory` | `CREATE TABLE IF NOT EXISTS` 不改旧表。先 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，再创建读取这些列的视图。不 `DROP COLUMN`，旧行保留，视图不回填历史 |
| compat12 | Collector 一直 `degraded`：过滤规则和基础设施策略返回 401；首个心跳把进程生命周期内的 `droppedEvents` 算进窗口。60 秒等不到恢复 | Observer 使用环境文件里已有的 `ANYSENTRY_ADMIN_TOKEN` 作为管理令牌。Collector 健康等待改为 180 秒。安装程序会生成并保留令牌，目标机上不要先手工导出 |
| compat13 | 见上一节的记忆目录只读 | 记忆目录改到 `/var/lib/anysentry` |
| compat14 | 业务容器 `ai-agent` 镜像 `agent:office`，没有 `anysentry.io/*` 标签 | 增加与 `*langchain*`、`*langgraph*` 同级的镜像模板 |
| compat15 | hybrid 修复补全容器运行时身份后，模板命中的容器以 `hostId='local'`（`docker:local:<id>`）进入 runtime 快照，与租约的 machine-id 不一致，API foreignRoot 校验 21 次全拒（`identity_conflict`），verify-activation 超时回滚。compat14 没踩到纯属旧 hybrid bug 让容器条目缺 `rootStartTimeTicks` 被跳过；k3s 注入 NODE_NAME 也不触发 | 上游 `c2f18da`：DockerDiscovery 构造改为 `hostId: attributor.hostId`，Docker 身份与采集器租约同源。预期变化：`physicalWorkloadId` 变为 `docker:<machine-id>:<id>`，产生新资产记录；confirmed 身份经 `container:<容器id>` 审核键自动续绑，不需要现场重新确认。回归脚本 `verify-docker-hostid-consistency.mjs` |
| compat16 | compat15 的包内 `install.sh` 把 `COMPAT_RELEASE_ID` 硬编码为 compat14 未随包名 bump，安装日志写进上一版目录并覆盖，summary 错标版本 | `install.sh`、`RUN_HEALTH_SMOKE.sh` 和随包文档统一改用 `@RELEASE_VERSION@` 占位符，`assemble-release.sh` 在生成 manifest 前注入 `build.sh --version` 的值并断言无残留。版本命名从此单一来源，不存在"忘了 bump" |
| compat17 | compat16 给 install.sh 加的运行时占位符守卫，被 assemble 的全局注入连守卫自身的比较串一起改写，变成"等于本版就拒绝"，安装器自我拒绝（现场报错 `unresolved 0.4.0-compat16 placeholder`）。教训：打包侧不做运行时自校验这类过度防御 | 撤掉守卫，install.sh 只剩 `COMPAT_RELEASE_ID=@RELEASE_VERSION@`；正确性由构建期断言（注入后无残留）和合同测试（注入后的副本必须能跑 `--help`）保证。compat16 交付物作废 |
| compat18 | compat17 现场：人工审核后投影出现 confirmed，但白名单 `tls-agent-cgroups.json` 仍 `entries=[]`——`*agent:office*` 模板重分类把 `manual_review` 的 confirmed_agent 踩回 probable_agent，审核开通明文的路径从未走通过 | 上游 `5e53b7b`：replace() 对 manual_review 条目跳过模板重分类、runtime 快照把审核决定 join 到活体容器条目、投影新增 `reviewVersion`/`reviewedEntries` 字段 |
| compat19 | compat18 现场：白名单出现 ai-agent cgroup（24429）但探针仍无明文，且 skill 容器 cgroup（24440）未进白名单。打包核验后定案：**随包 collector 是 legacy-kernel-4-19 构建，`main()` 被 `legacy::run()` 整体替换，明文准入/解析/挂接代码全部不在二进制内**——tcp_plaintext/tls_uprobe 在 UOS 4.19 是功能缺口，与开关、审核、白名单均无关。核对中另发现 ABI 漂移：exit/connect/file/sec 事件尺寸与 common 结构体不匹配被静默丢弃，现场只有 exec 事件在流 | 上游 Observer `63473b7` 在 legacy 后端实现 HTTP 明文（kprobe/kretprobe syscall 载荷 + pid 准入 map + 复用白名单扫描与 interaction 重组）并逐字节修复 ABI 漂移；`4a454fa` 开关拆分与 AnySentry `360afde` 多实例白名单同批并入。打包侧单元加 `Environment=A3S_OBSERVER_PLAINTEXT_HTTP=1`，门禁脚本同步新清单。升级后五类非 exec 事件开始出现属预期 |
| compat20 | compat19 现场：6 个明文探针只有 2 个暂存类挂上，4 个带载荷拷贝的全部 `BPF_PROG_LOAD` 失败，明文仍为零。验证器日志给出指令级根因：`call bpf_probe_read#4` 处 `R2 unbounded memory access`——钳制（`if len>512 len=512`）的范围收窄落在 count 寄存器上，而 helper 长度参数用的是 len 拷贝寄存器，4.19 验证器不在寄存器拷贝间传播等值关系，拷贝寄存器保持无界 | 打包侧直接在 integration 分支修复（Observer `b667c6a`）：`emit_plaintext` 改定长读取——固定 512B 主读，EFAULT（页边界）回退 64B，再失败 len=0 丢载荷；`len` 字段仍是用户态权威有效长度，尾部不解析。长度参数从此只有常量，验证器无界问题根除。另：现场 env 文件残留 `A3S_OBSERVER_SSL` 已删（legacy WARN 抓获）；并集重审脚本修行匹配后缀（"ai-agent · agent:/sh"），审核体身份键必须并集覆盖两个容器 |
| compat21 | 打包侧工作流改进（无产品代码变化）：① 验收脚本此前单独传输，易与包版本脱节；② env 文件残留的 `A3S_OBSERVER_SSL` 是落盘持久键，升级保留机制让它一直存活，需手工删 | 随包新增 `ACCEPTANCE_CHECK.sh`（安装后在 `/opt/anysentry/ACCEPTANCE_CHECK.sh`，版本号由 assemble 注入）；安装器新增 `drop_inert_observer_keys`，安装/升级时自动删除惰性 `A3S_OBSERVER_SSL` 键并记日志（合同测试覆盖权限保持与无关键不动）；`build-observer.sh` 支持 `A3S_BPF_LOCAL_CLANG=zig` 本地编译 BPF 对象（docker 守护进程故障时的备选路径，默认 docker 不变） |
| compat22 | 明文零产出的现场闭环排查后，把最后一段不可见链路点亮：探针挂载✓、准入 map 实测含测试 pid✓、程序内 map 引用正确✓、read 进入暂存与 kretprobe 删除都在 tarpit 慢动作实验中实测发生✓，但 `tcp_plaintext` 事件全历史为 0——chunk 从内核 ring 到用户态 collector 这一段完全不可见 | **诊断版**（产品逻辑无变化）：Observer `3c70466` 给 legacy plaintext 加 chunk 级日志（前 50 条+每 500 条：pid/fd/方向/长度/前 32 字节预览）与 interaction 完成日志。现场重跑 tarpit 实验后按 journal 有无 `legacy plaintext chunk received` 四象限定根因。同时随包新增 `UOS现场诊断规则.md` 与 `FIELD_DIAGNOSTIC.sh`（S0-S8 分阶段一次跑完，默认纯只读，`--with-http` 加跑合成实验），打包合同三处（assemble/verify/合同测试）同步登记 |
| compat23 | compat22 现场结果：chunk 全通（seen>22 万、双向、准入 pid）但**每条都是 `len=0`、`orig_len` 正常**——emit_plaintext 的载荷 `bpf_probe_read` 在该内核 100% 失败（主读 512B 与 64B 回退都败），而同内核上 connect/exec 探针读用户态内存正常 | **诊断版 v2**：Observer `d9fe542` 把两次 probe_read 的返回值（-errno）打包进 `plaintext_event._pad`（低 16 位=主读、高 16 位=回退读），collector chunk 日志新增 `read_rc1`/`read_rc2` 字段。现场跑一次即可从错误码（EFAULT=-14 / EINVAL=-22 等）锁定内核侧根因。另：`ACCEPTANCE_CHECK.sh` 修正——S2 改按功能指标判定（degraded 仅提示，它是历史环丢失计数），S5 弃用入向 curl 改用出向 tarpit 合成法（入向按设计不出事件） |
| compat24 | compat23 现场铁证：`read_rc1=read_rc2=14`（EFAULT）——**该内核启用 CONFIG_ARM64_PAN（Kunpeng 920），4.19 老式 probe_read/probe_read_str 读用户态内存全部失败**；同病还有 exec argv 空、FileAccess path 空、observer 从不产 Egress。helper 实测（bpf-inspect helpers）：该内核 BPF 回移植带齐 112/113/114/115 | **修复版**：Observer `7e5548e`——全部用户态读取换成 `probe_read_user`/`probe_read_user_str`（明文载荷、sockaddr、argv、文件路径），内核态读取保持 helper 4；`_pad` 错误码上报保留为验证通道。规则文档与 FIELD_DIAGNOSTIC.sh 自本版起正式随包。**现场验收（10-13）**：12/13 通过——observer 源 Egress 首次出现、LlmInteraction 15 分钟 66 条（明文修复生效）、非 exec 五类事件恢复；唯一 FAIL 是验收脚本自身谓词错误：`events.source` 列只有 observer/api，`source IN ('tcp_plaintext','tls_uprobe')` 恒 0。明文真实落点是 `eventKind='LlmInteraction'` 与 `agent_interactions_v1`（transport='http'，payload 含 captureSource=tcp_plaintext）。ACCEPTANCE_CHECK.sh S5 与 FIELD_DIAGNOSTIC.sh S7 谓词已据此修正，合成探针改 POST 带标记路径/体 + OpenAI 形状应答 |
| compat25 | compat24 现场验收 13/13 全过后的收尾版：明文/argv/Egress 全部实证（chat/completions 真实对话、用户提问原文可见、前端同源接口三层证据闭环）；磁盘侧发现发行版默认配置把 ClickHouse 全部系统日志开着且无 TTL（两周 7.9G，asynchronous_metric_log 28.5 亿行），叠加高 churn 投影表 3.4G 死 part 稳态积压；合成探针实测仍 0 入库而真实流量 100% 在采（发射侧只把 LLM 形状的交换变成记录，列为已知限制）。**首版安装失败教训**：给系统日志配 TTL 时踩中 `opentelemetry_span_log`——它是基础配置中唯一带自定义 `<engine>` 的日志表，engine 与平级 `<ttl>` 冲突，CH 启动即 BAD_ARGUMENTS 崩溃循环（安装事务回滚保护兜住，现场无损退回 compat24）。修复：删掉该行（otel 本部署无数据），合同测试加负向样例防复发（`efdcf57`） | **打包侧收尾版**（应用/Observer 二进制与 compat24 相同，复用不重编）：① `clickhouse-config.xml` 给 8 张系统日志表加 TTL（7d/3d）、`remove` 掉 trace_log/processors_profile_log 两个纯采样日志、`merge_tree old_parts_lifetime=120`；② 随包新增 `anysentry-data-cleanup.sh`（磁盘占用查询 + events 按天清理，合同三处登记）；③ ACCEPTANCE_CHECK S5 探针改 LLM 形状（POST /v1/chat/completions + OpenAI 应答）+ 谓词改 agent_interactions_v1/LlmInteraction；④ FIELD_DIAGNOSTIC S7 同款谓词修正。现场已先行执行的等价操作（TRUNCATE 系统日志+TTL ALTER）与本版配置效果一致，升级不冲突 |
| compat26 | compat25 现场完整度复盘发现三层缺口：① unparsed 证据不进语义轮次（前端对话追踪页出不了结构化对话）；② chat/completions 主对话记录近半空壳——高流量 SSE 端点 `172.22.17.200:20002` 0/30 全灭，而普通端点 89-100% 有内容、大正文可到 124KB；③ `fragment_sequence_gap` 306/441 的元凶是序号 bug——chunk 序号用了启动纳秒时间戳（相邻必不连续），每个交互都被误判丢块。另查明合成探针其实一直能入库，只是安静连接靠 idle 边界（~60-90s）才完成，验收 30s 等待窗外 | **Observer 修复版**：Observer `30b671b`（开发 feat/legacy-plaintext-completeness，ff 合入）——截断 JSON 残骸打捞（截断的 OpenAI 交换也能出部分 messages，语义轮次）、per-(pid,fd,方向) 连续序号替代时间戳（假丢块根除）、空壳交互降级为 60s 计数日志不再占位、chunk 载荷 512B→1KB（双侧静态断言钉 ABI）、`A3S_OBSERVER_PERF_RING_PAGES` 可配（1..=1024，默认 8）。打包侧配合：observer 单元设 `A3S_OBSERVER_PERF_RING_PAGES=64`（4MiB/CPU/map，6 map 上限约 384MiB）；验收脚本 S5 标记未中时补等 45s（适配 idle 边界时滞）。本机验证：legacy 特性测试 231/231、zig 编 BPF 对象过门禁。现场验收加两条硬指标：timeline-v3 轮次>0 且有真实 user 内容；fragment_sequence_gap 占比≈0 |
| compat27 | compat26 现场二轮验证（业务活跃窗口）：序号修复实证（fragment_sequence_gap 306→**0**）、空壳治理生效（降级日志 suppressed=78/min）、**请求体 6/6 完整**（最大 5.1KB，system prompt 全文可见）；但**响应体 5/6 为空**且 parseState 仍全 unparsed、语义轮次未出。打包侧本地复现定位：该现场 LLM 网关是"请求→模型长时间思考（分钟级连接静默）→单个 chunked 大 JSON 响应"形态（预览见 `4a73\r\n{...}` 块长头），**90s idle 超时在思考期内把交互提前退休**（请求单方入库、响应空），迟到的响应字节成为孤儿被静默丢弃——本地回归测试对照组精确复现 | **打包侧直修**（Observer `1a8925f`，integration 分支）：重组器 idle 超时 env 化——`A3S_OBSERVER_REASSEMBLY_IDLE_TIMEOUT_SECONDS`（有界 5..=86400，默认 90 不变，不动现代路径）；observer 单元设 900s。回归测试：90s 对照组复现响应空壳、900s 组迟到响应归队成完整记录；233/233 全过，fmt/clippy 干净。遗留交开发：①语义轮次仍未出现（wire_template_unparsed 的 Salvage 没接入语义投影，A 项未达成）；②>900s 的极端思考仍会孤儿化（根治需响应孤儿保留策略或 close 事件收尾） |
| compat28 | compat27 的全局 900s 是止血但不够动态：Redis/日志管道等噪音连接也会跟着滞留 15 分钟，违背工业界"按连接状态分层"的做法（Zeek/Suricata 的 per-protocol 超时、Wireshark 按连接收尾） | **双车道 idle 退休**（Observer `01501fb`，打包侧直修）：**慢车道**——持有完整请求、在等响应的连接（LLM 思考期）用 `A3S_OBSERVER_INFLIGHT_IDLE_TIMEOUT_SECONDS`（缺省跟随快车道）；**快车道**——其余连接（噪音/健康检查/不完整流）用 `A3S_OBSERVER_REASSEMBLY_IDLE_TIMEOUT_SECONDS`（默认 90s 不变）。打包侧只设慢车道 900s，快车道保持默认：LLM 响应归队与噪音快速退休兼得。回归测试三态钉死（90s 复现空壳/慢车道响应归队/噪音 90s 退休），234/234 全过 |
| compat29 | compat28 现场高峰期验证：`fragment_sequence_gap` 与流量强相关——业务高峰（1000+ 记录/h）85-96% 记录丢块，低峰 2-6%；退休日志显示响应缓冲仅 1-3KB（字节到了但 ring 跟不上），非解析问题。另本轮新发现：约半数 LLM 响应为 gzip 压缩（采到但读不了，交开发流式解压）；语义轮次仍 0（salvage 在跑但没翻转 parseState/没进投影，A 项欠账） | **ring 扩容版**（Observer 代码不变，仍 `01501fb`）：`A3S_OBSERVER_PERF_RING_PAGES` 64→128（8MiB/CPU/map，6 map 上限约 768MiB）。gzip 流式解压方案已定（DEFLATE 可增量解压，截断流也能出部分内容，flate2 纯 Rust glibc 中性）写入三轮反馈文档交开发 |
| compat30 | 三轮反馈的两项开发交付：① gzip 压缩响应读不了（约半数 LLM 响应乱码）；② 语义轮次为零（A 项欠账）——排查后真断点不是 salvage 不工作，而是投影层把 `interactionType=unparsed` 整体过滤 | **Observer 修复版**（`0592615`，开发 feat/legacy-gzip-semantic-turns，ff 合入）：① gzip 流式解压截断容错——产出多少保留多少，截断流返回已解压前缀并标 `truncated_compressed_stream`；退休路径先容错 de-chunk 再解压，不完整声明块（现场 0x4a73=19KB 大声明）保留已到达前缀；flate2 为既有依赖（纯 Rust、无新原生依赖）。② 截断但 LLM 形状的交换升级为 `generic-llm-json`/`partial`/`Model` 放行投影（parse_state 保持 partial 不伪装 parsed）——timeline 应出现 salvaged 的 user/model 轮次。③ 双车道 idle helper 共享化，现代 main.rs 同步接入（默认行为两边不变）。本地 235/235 全过，fmt/clippy 干净。验收新标准：timeline 轮次>0、parseState 以 partial 为主、content_decode_error 基本消失、gzip 响应可检索 |
| compat31 | 全量取证后暴露的最后一批问题：wire 模板容错不足（LLM 对话 69 条仅 2 条进轮次，F7 keepalive 串联/F8 中流起始为主因）、会话穿线缺失（235 条记录 235 个一次性 sessionId）、轮次不持久（无 PG 热环几分钟淘汰）、前端无搜索/unparsed 不展示/base64 不解码、健康卡片被历史累计计数永久误报 | **产品化收口版**（双仓交付）：Observer `3ad0e8d`（keepalive 串联切分 keepalive_request_splice、中流头重扫 midstream_head_resync、orphan 响应配对 midstream_response_only、LLM 形状响应自动升级进轮次）+ `a7c67a0`（心跳 cumulative 标记）；AnySentry `acf446b`（contentQuery 全文检索全链路 + 无锚交互按进程/endpoint/连接归并采集会话 + 健康评估改窗口增量）+ `295ba8b`（session_memberships_v1 落 CH，30 天 TTL，仅无 PG 时写，启动恢复 7 天）+ `e220bed`（前端搜索框接线、base64 解码、未解析证据车道、截断徽标）。打包侧复验：Observer 238/238、健康通道/查询边界/membership 回退脚本全过（health 验证修复 dist 陈旧假象——验证脚本跑的是编译产物）。**台账更正**：outputDropped 是导出器写入失败计数不是策略丢弃（开发指正） |

控制面页面的密钥是 `ANYSENTRY_ADMIN_TOKEN`，从 `/etc/anysentry/anysentry.env` 读取后粘贴到页面钥匙图标。`ANYSENTRY_INGEST_TOKEN` 和模型厂商的 API Key 不是这个字段。

### 路径和端口

| 用途 | 路径或地址 |
| --- | --- |
| 程序 | `/opt/anysentry`，服务内只读 |
| 配置 | `/etc/anysentry/anysentry.env`，`0600`，属主 root。升级保留已有键 |
| 可写状态 | `/var/lib/anysentry` |
| 日志与本次安装诊断 | `/var/log/anysentry`，`/var/log/anysentry/install/<compat 号>/` |
| API 页面 | `0.0.0.0:29653`，路径前缀 `/anysentry/` |
| ClickHouse | 只监听 `127.0.0.1:8123`。原生端口 `9000` 已从本包去掉 |
| Redis / Kafka / Flink REST | `127.0.0.1:6379`、`127.0.0.1:9092` 与 `9093`、`127.0.0.1:8081` |
| 目标机已有业务容器 | `ai-agent` 发布 `7998` 和 `8000`。不得停止该容器，不得把 GLM 实验或 AnySentry 绑到 `8000` |

`@a3s-lab/code` 的 `.node` 和 `zvec/libzvec_c_api.so` 必须同时在 pnpm 真实目录和 L3 拷贝里。只更新 `app/dist` 的组装不会重新编译这份原生库；全量 `app` 构建会删掉旁边的 `*.node`，之后要再跑 L3 安装步骤，从 glibc 2.28 缓存放回去。`--component assemble` 使用已经放好的 stage。上一版 stage 里手工打进 `dist` 的补丁，要先把 stage 复制到新 compat 目录，否则会丢。

发布包输出目录是 `ANYSENTRY_RELEASE_DIR`。未设置时写到工作区的 `release/`。现场交付文件放在 `/home/chensicheng/a3s/security/release/`。

### 模型配置页和正式研判

本包 `ANYSENTRY_L3_MODE=completion`。配置页的快速研判测试、深度研判测试，以及正式的快速研判和深度研判，都走同一个 L2 会话。测试通过说明地址、模型名和 API Key 能完成一次结构化调用。测试之后还要点应用，凭据才会推到研判进程。凭据在 API 进程内存中，API 重启后要在页面上重新测试并应用。

正式调用还要求对应研判进程处于 active，并且有事件进入该层。样例事件通过，不保证一条真实大事件不会因超时或输出格式失败。记忆目录只读问题在 compat13 之后，测试和正式调用是同一条路径。

### Docker 镜像模板

内置模板只认部署位置 `docker` 和镜像通配 `*agent:office*`，身份是候选 Agent `office-agent`。容器名、容器 ID、镜像摘要和 compose 项目名不写进规则，容器重建后仍能命中。`*agent*` 会和镜像名里同时出现 `langchain` 或 `langgraph` 的模板打成平手，工作负载退回未识别，所以不用。进程名 `python` 不能作为容器身份。

`agent:office` 与现有 `*langchain*`、`*langgraph*` 不重叠，进程 `/usr/local/bin/python /opt/agent/start.pyc` 也碰不到那两条命令前缀。镜像名同时包含 `langchain` 和 `agent:office` 时才会歧义。候选身份不打开明文；明文仍要在页面上审核为已确认 Agent。

查看一台未打 `anysentry.io/*` 标签的容器时，只读执行 `docker inspect` 的 `Config.Image`、`Config.Labels`、`Config.Entrypoint` 和 `docker top` 的命令行。`Config.Env` 可能含密钥，不收进规则，也不写入本手册。

### Prometheus 平台监控

离线包未包含 Prometheus 和 node-exporter（开发 Compose 里才有）。只影响平台监控页图表，不影响 Agent 识别和明文采集。API 读 `ANYSENTRY_PROMETHEUS_URL`；为空时监控页降级为 API 进程本地指标。目标机已有 Prometheus 时，把地址写入 `/etc/anysentry/anysentry.env` 后 `systemctl restart anysentry.service`；没有可留空。以后若打进离线包：aarch64、glibc 2.28、64 KiB 对齐，只监听 `127.0.0.1:9090` 和 `127.0.0.1:9100`，不得占用 `8000`、`7998`、`9000`。

### ai-agent 明文采集

候选身份不打开明文。先在审核页把 `office-agent` 确认为已确认 Agent（或助手 `review_agent_candidate`），约 15 秒后对新流量生效；身份在 F0–F3 共用，与 L1–L3 研判深度是两套编号。HTTP 明文确认后走 `tcp_plaintext`，不依赖 SSL 符号。HTTPS 需要在 Observer 环境追加 `A3S_OBSERVER_SSL=1` 和 `A3S_OBSERVER_TLS_PROCESS_PATTERNS=start.pyc`（不要用宽泛的 `python`），改完 `systemctl restart anysentry-observer.service`。采集器从容器进程 `/proc/<宿主机pid>/maps` 找动态 libssl，成对挂接 `SSL_read`/`SSL_write`（含 `_ex`）；静态链接、去符号、Go、Rustls、GnuTLS、NSS 不在当前挂接矩阵。

联调前只读收集（不要反编译客户容器，不要贴 `Config.Env`）：`openssl s_client` 测容器映射端口；`docker top` 加 `/proc/<pid>/maps` 是否出现 `libssl`/`_ssl`；Observer 环境是否已有 `A3S_OBSERVER_SSL`。

2026-10-09 现场实测：目标机现有 `ai-agent`（7998/8000）和 `ai-agent-skill`（7999/8001）两个 `agent:office` 容器，均被镜像模板命中为候选。`8000` 和 `8001` 的 `openssl s_client` 报 `wrong version number`，即入向服务是纯 HTTP，确认身份后经 `tcp_plaintext` 即可看到明文，**入向不需要开 `A3S_OBSERVER_SSL`**。两个容器的 python 工作进程都加载了 `/usr/lib/aarch64-linux-gnu/libssl.so.3`，若之后要采出向 HTTPS（例如容器调用外部 LLM API），TLS uprobe 挂接条件具备，按需再开 SSL 开关。

2026-10-12 更正与方向语义（compat21 现场实证 + 代码确认）：明文管线的方向标签按"Agent 是 HTTP 客户端"设计——`write/sendto` 出请求、`read/recvfrom` 出响应，重组器按标签配对，无内容嗅探纠正。**采的是 Agent 主动调 LLM 的出向腿；向 8000/8001 curl 打入的入向探针方向相反**（服务端 read 到请求被标成响应车道、write 出响应被标成请求车道），永远凑不成一对，不出事件——这是设计行为，不是故障。legacy 后端暂不支持 TLS uprobe（设了 `A3S_OBSERVER_SSL` 只会收 WARN；compat21 起安装器自动清除该残留键），出向若走 HTTPS 当前版本采不到。验收探针因此改为：触发 Agent 真实调 LLM（业务侧正常使用一次），而非 curl 入向。若以后需要入向（用户→Agent）明文，属于上游新功能（按内容嗅探方向或服务端角色标记），提需求给开发。

2026-10-09 深入排查（确认身份后明文仍不通）判定为 **cgroup v1/混合布局的功能缺口**，非部署配置问题。目标机是 hybrid cgroup：v1 各控制器挂在 `/sys/fs/cgroup/<控制器>`，v2 unified 挂在 `/sys/fs/cgroup/unified`，容器 `/proc/<pid>/cgroup` 同时有 v1 行和 `0::` 行。两处代码缺陷叠加：

1. `scripts/observer-docker-discovery.js` 按纯 v2 布局用 `/sys/fs/cgroup` 拼 `0::` 路径后 stat；hybrid 上正确路径是 `/sys/fs/cgroup/unified/...`，stat 失败导致所有容器拿不到 `cgroupId`（日志持续 `cold_start_runtime_ready=0`），明文白名单没有 cgroup 可写。cgroup 解析缺失还使进程归因退化，出现身份键污染（gdss 容器 ID 混入 `office-agent` 审核键、office 身份键挂在无关容器进程事件上）。
2. `observer-forward.js` 的 `TLS_AGENT_CGROUPS_FILE` 由 `ANYSENTRY_FILTER_RULES_FILE` 推导，打包的 systemd unit 未设置该变量，白名单发布 `publish()` 对空路径直接 return 0，文件通道在打包部署里是空操作；同时 legacy collector 事件 `cgroupId` 全为 0（4.19 legacy 后端不上报 BPF cgroup id），白名单匹配对 legacy 路径还需降级策略佐证。

部署侧全部干净：docker socket 可读、`/proc` 可读、`/sys/fs/bpf` 已挂载、统一过滤投影正常加载（identity=1/templates=3）、确认评审在 API 侧已生效、collector healthy（8 探针、outputDropped=0）。unknown/候选工作负载只留生命周期事件是策略设计（`droppedEvents` 即丢弃量），不是积压。

修复已于 2026-10-09 完成并合入 compat15（上游修复，打包侧配合）：

- **① discovery 路径**：上游 `71ee8a3` 新增共享 helper `scripts/observer-cgroup-mounts.js`，从 `/proc/mounts` 解析真实 cgroup2 挂载点（hybrid 上 `/sys/fs/cgroup/unified`），修了全部 4 处硬编码点。**刻意不采纳**"回退 v1 inode"：v1 层级 inode 与内核 `bpf_get_current_cgroup_id`（v2 默认层级）不相等，发布 v1 inode 反而准入失配。新文件必须随包分发（打包侧已把 `observer-cgroup-mounts.js` 补入 `build-observer.sh`、`verify-release.sh`、`install.sh` 三处清单——与上游 DaemonSet 逐文件挂载踩的是同一类坑）。
- **② 白名单文件通道**：打包侧在 `anysentry-observer.service` 增加 `RuntimeDirectory=anysentry-filter` 和 `Environment=ANYSENTRY_FILTER_RULES_FILE=/run/anysentry-filter/filter-rules.json`，`tls-agent-cgroups.json` 随其同目录落地。
- **③ legacy 明文准入**：上游 Observer `2d86db9` 修复。实际准入链不是按事件 cgroupId 匹配：collector 把白名单 cgroup 经 /proc 扫描解析成 pid 集合，再按 `(bpf_get_current_cgroup_id, pid)` 组装 eBPF 键，事件里的 cgroupId=0 不参与准入。真正断点是 Rust 侧同一个 hybrid 挂载点 bug（`tls_agent_scopes.rs`、`main.rs` 两处）。`bpf_get_current_cgroup_id` 在 4.19 可用且 hybrid 下返回 unified 层级 id，无需额外 pid 降级。含回归测试 `hybrid_unified_mount_resolves_process_cgroup_ids`。
- **④ 归因污染**：结论为**独立 bug**（非 cgroup 缺失并发症）：`observer-workload-filter.js` 把 `cgroupId='0'` 当可缓存鉴别键，全机 legacy 事件共享 '0' 键先到先绑。同 `71ee8a3` 修复：'0' 视为缺失、candidateCache 键纳入 pid、快照 replace 清空缓存；回归脚本 `verify-workload-filter-legacy-cgroup.mjs`（修复前可精确复现误绑）。

验收标准：`cold_start_runtime_ready>0`、`/run/anysentry-filter/tls-agent-cgroups.json` 出现且含 cgroup 条目、向 8000/8001 发请求后事件表出现明文事件、`office-agent` 审核键只含 `agent:office` 两容器。

### 现场插曲

- 手动测试启停脚本时 `anysentry-kafka-init.service` 报 `/opt/anysentry/init-kafka-topics.sh: No such file or directory`：WorkingDirectory 的 `/opt/anysentry/kafka` 缺失导致 CHDIR 失败。从安装器解压目录 `cp -a` 补回 kafka 程序目录和脚本，`systemctl reset-failed` 后按序启动恢复。
- 单元名必须写全，少打字母（如 `anysentry-kafka.servic`）报 Unit not found。
- 停掉 Observer 后页面事件仍短暂增长是正常的：Kafka、Flink 和研判 Worker 在排空已有队列。

### compat15 并入的上游修正

`95d33a8`（策略页只改超时时同步运行时模型快照）、`ced2110`（LLM 超时上限 600s 提高到 1800s）、`71ee8a3`+`f329b37`（cgroup hybrid 修复与归因污染防护，含 DaemonSet 挂载同步）、Observer `2d86db9`（legacy 明文准入的 cgroup2 挂载点解析）。详见上一节。

### compat16 并入的上游修正

`c2f18da`（Docker 工作负载身份与采集器租约同源，修 compat15 现场安装回滚）、`72409eb`+`ee99ab9`（文档与清单卫生，无功能变化）。注意上游分支在 compat15 锁定后做过变基：`71ee8a3`→`cd94d1e`、`f329b37`→`f890e69`，内容等价，仅回归脚本里的真实容器名改为泛化名；integration 合并时对该回归脚本按上游新版解决 add/add 冲突，其余运行时文件与上游树逐字节一致（`git diff HEAD c2f18da -- scripts/ apps/` 只剩打包侧既有适配）。

compat16 现场验收在上一节 4 条基础上增加：collector 健康 JSON 中 `runtimeSnapshotPosts>0` 且 `runtimeSnapshotErrors=0`、`runtimeSnapshotRejected=0`，control 车道无 `control_runtime_snapshot_failed`（即 verify-activation 不再因此回滚）；office-agent 的 confirmed 身份应经审核键自动续绑。

### compat18 并入的上游修正

`5e53b7b`（人工审核身份优先级）：① `WorkloadIdentityCache.replace()` 对 `manual_review` 条目跳过模板重分类——此前 `*agent:office*` 模板把人工确认的 `confirmed_agent` 降级回 `probable_agent`，`confirmedPhysicalWorkloadIds()` 为空，明文白名单永远 `entries=[]`，审核开通明文的路径从 compat14 起就没通过；② runtime 快照把审核决定 join 到活体容器条目（审核条目自身不带 containerState 等活体事实），人工 `non_agent` 会把容器从 runtime 清单排除（设计意图）；③ `/security-center/identity/snapshot` 新增 `reviewVersion`/`reviewedEntries` 显式字段，现场可直接断言 `reviewVersion>=1`，不用再拆 version 求和。回归脚本 `verify-workload-filter-review-precedence.mjs`（修复前必败）。

次生问题自查结论（开发反问"安装器是否重置数据卷"）：**不重置**。`install.sh` 对 `/var/lib/anysentry` 只有 `mkdir -p`；无 DROP/TRUNCATE；回滚只恢复 `/opt` 程序和 env，不动数据目录；ClickHouse `config` 表是 `CREATE TABLE IF NOT EXISTS` + ReplacingMergeTree；`agentMetadata.reviewVersion` 初始化时从持久化记录重算（agent-metadata.service.ts:245），不是易失计数器。所以 10-09 审核记录在 compat15 失败+回滚+compat17 重装期间并未被安装器清除，记录丢失的原因仍在两套审核存储无桥接（AgentMetadataService vs ObservedAssetReviewService），留上游继续查；现场 workaround 是升级后重新审核一次（compat17 现场已重做）。

compat18 现场验收：compat17 的 5 条基础上，第 5 条改为直接断言投影 `reviewVersion>=1`（新字段）；另加：白名单 `tls-agent-cgroups.json` 出现 cgroupId 条目（客户现场实测为 24429/24440 两个 inode），探针流量 30s 内 ClickHouse 出现 `tcp_plaintext` 事件。

### compat19 并入的上游修正与明文定案（重要）

Observer `4a454fa`（HTTP 明文准入与 HTTPS 采集拆开关）：`A3S_OBSERVER_SSL` 此前同时管 libssl uprobe 挂接和白名单→`VERIFIED_AGENT_PROCESSES`→`tcp_plaintext` 准入链；拆分后新增 `A3S_OBSERVER_PLAINTEXT_HTTP` 管准入链，SSL 只管挂接，SSL 开启时隐含准入（存量行为不变）。AnySentry `360afde`（多实例白名单）：`confirmedPhysicalWorkloadIds()` 按活体发现条目的身份键建索引，一次人工审核覆盖 office-agent 的全部容器实例（ai-agent/skill），人工 `non_agent` 反向移出。同批并入 `624fcef`（rustfmt，无语义）、`9dcd9c6`（CI 门禁与 sticky-poison fixture，Rust 测试首次全量通过）。

**但打包核验时发现定案级事实：以上 Rust 侧修正对 UOS 包二进制无运行时影响。** 随包 collector 以 `--features legacy-kernel-4-19` 构建，该 feature 整体替换 `main()` 为 `legacy::run()`（`legacy.rs`，465 行）——只有 exec/exit/connect 元数据/文件/安全六类事件；白名单读取器、准入同步、`tcp_plaintext` 解析、TLS 挂接、两个开关的读取点全部在非 legacy `main()` 里被 cfg 编译排除。`probes-legacy.o` 符号表实测：8 个 kprobe + 6 个事件 map，无 `VERIFIED_AGENT_PROCESSES`、无载荷采集程序。二进制字节级搜索 `A3S_OBSERVER_SSL`/`tls-agent-cgroups.json`/`libssl` 均为 0 命中。**因此 tcp_plaintext/tls_uprobe 在 UOS 4.19 legacy 后端是功能缺口，不是开关、审核或白名单配置问题**；compat18 现场"白名单有条目但无明文"的真正原因是读取方不存在。完整证据链见 `docs/uos-legacy-backend-plaintext-gap-handover-2026-10-10.md`（开发检出 docs/ 下）。

JS 侧修复不受此影响，全部真实生效：`cd94d1e`（hybrid discovery）、`c2f18da`（hostId 同源）、`5e53b7b`（审核优先）、`360afde`（多实例白名单）修的都是 observer-forward.js / API 路径。

**功能已补齐（Observer `63473b7`，同日出 compat19）**：上游按任务书在 legacy 后端实现 HTTP 明文——`probes.c` 新增 `PLAINTEXT_ALLOWED`（pid 准入 hash，用户态写）、`PLAINTEXT_READ_ARGS`（enter/exit 关联）、`PLAINTEXT_EVENTS` perf 环与 6 个程序（kprobe write/sendto 出请求、kprobe 暂存 + kretprobe 出响应，取返回值长度），载荷定长 512B，准入仅按 pid，HTTP 语法判定在用户态重组器；`legacy.rs` 复用 `TlsAgentScopeReloader`（含 hybrid 修复）每 2s 同步准入 map，chunk 喂共享 `InteractionReassembler`，出事件 `source='tcp_plaintext'`、`adapter_id='plain-http-syscall'` 与现代路径一致。挂接点走候选 B（kprobe/kretprobe `__arm64_sys_*`，aya 0.13.1 裸 `kretprobe` 段原生支持，源码已核实）。`A3S_OBSERVER_SSL` 在 legacy 下打显式 WARN；开关开了但配对对象缺 `PLAINTEXT_ALLOWED` 时 collector 拒绝启动（响亮失败）。打包门禁 `verify-legacy-bpf-object.mjs` 已同步新清单（6 程序 4 map）。

**同批修复的第二个缺陷（ABI 漂移）**：`probes.c` 的 exit/connect/file/sec 事件尺寸停留在旧 ABI（28/44/280/32 字节），与 common 结构体（72/80/312/64）不匹配，用户态长度守卫把它们全部静默丢弃——客户机此前实际只有 exec 事件在流（现场 `lastEventSubject=exec` 即此证）。已按 common 布局逐字节对齐。**升级后 ProcessExit/Egress/FileAccess/FileDelete/SecurityAction 会开始出现，属预期**（设计本就如此），验收时把五类事件的出现列为检查项。

compat19 现场验收（`check-compat19-acceptance.sh`）：沿用 compat18 全部条目并强化——单元含 `A3S_OBSERVER_PLAINTEXT_HTTP=1` 且不设 SSL；白名单同时覆盖 ai-agent/skill 当前 cgroup（脚本动态解析 inode）；collector 日志出现 `legacy plaintext Agent cgroup scopes reconciled`；探针 8000 与 8001 后 30s 内 ClickHouse 出 `tcp_plaintext` 且标记可检索；近 15 分钟分布出现五类非 exec 事件。注意开发侧未做活体验证（其机器为 x86_64/6.17，跑不了 arm64/4.19 专用对象），现场验证是收口门禁。

### compat20：明文探针验证器修复（打包侧直修）

compat19 现场验收结果：安装成功、审核/白名单/collector 准入同步全通（354 次 reconcile 日志）、ABI 修复后五类事件恢复流动——但 6 个明文探针只有 2 个暂存参数的挂上，4 个带载荷拷贝的（write/sendto/read_exit/recvfrom_exit）全部 `BPF_PROG_LOAD` 失败。提取完整验证器日志后定位到指令级根因：

- 拒绝点：`call bpf_probe_read#4` 报 `R2 unbounded memory access, use 'var &= const' or 'if (var < const)'`
- 机制：C 代码 `len = (u32)count; if (len > 512) len = 512;` 经 clang 分配后，范围比较落在 count 所在寄存器，而 probe_read 的长度参数用 len 拷贝寄存器；4.19 验证器不在寄存器拷贝之间传播等值收窄，拷贝寄存器保持 umax=2^32-1，拒绝加载。两个暂存类小程序不带载荷拷贝所以通过——与现场"挂 2 掉 4"精确吻合
- 修复（打包侧直接在 Observer integration 分支，`b667c6a`）：`emit_plaintext` 消除变长 probe_read——固定 512B 主读，EFAULT（buf 跨未映射页）回退 64B 定长，再失败 `len=0` 丢弃本次载荷；`len`/`orig_len` 字段语义不变（用户态重组器只认 len，截断标记照常）

compat20 验收仍用 `check-compat19-acceptance.sh`：挂接日志应出现全部 14 个程序（8 基础 + 6 明文），其余条目不变。若仍有个别程序加载失败，验证器日志提取命令见第 4.5 节脚本输出说明。

## 最终部署状态

ClickHouse、AnySentry API/页面和 Observer 均为 active。API 使用 ClickHouse 存储，受保护 Observer Source 为 active，事件持续接收，拒绝数为 0；collector 状态 healthy，队列、outputDropped 和 errorCount 均为 0。新版本同时内置 Redis 及 L1/L2、L3 异步判定 Worker。L1 默认启用；L2、L3 需配置兼容 LLM 后显式重启 API 和判定 Worker。

## 组件维护注意事项

- Sentry：必须使用 aarch64、glibc 2.28 和 64 KiB ELF 对齐构建；
- ClickHouse：必须保留 `armv8.0-compat`，通用 ARM64 包可能触发 SIGILL；
- Redis：必须随离线包提供 aarch64、glibc 2.28、64 KiB 对齐二进制，并仅监听回环地址；
- Observer：必须使用 perf-kprobe-legacy 和 BPF 4.19.90；不得依赖 BTF；
- AnySentry：Source 创建应兼容 HTTP 201 和标准响应信封；
- Forwarder：必须保留 ClickHouse 自噪声过滤，并监控 acceptedEvents、outputDropped、errorCount；
- installer：升级前完成全部 ABI 检查，保留配置和数据，激活失败自动 rollback；
- 发布：每个包必须包含 VERSION、PROVENANCE、manifest.sha256、部署文档、主机检查脚本和原始 BPF syscall 探测程序。
