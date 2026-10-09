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

## compat7 至 compat14 现场要点

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

2026-10-09 深入排查（确认身份后明文仍不通）判定为 **cgroup v1/混合布局的功能缺口**，非部署配置问题。目标机是 hybrid cgroup：v1 各控制器挂在 `/sys/fs/cgroup/<控制器>`，v2 unified 挂在 `/sys/fs/cgroup/unified`，容器 `/proc/<pid>/cgroup` 同时有 v1 行和 `0::` 行。两处代码缺陷叠加：

1. `scripts/observer-docker-discovery.js` 按纯 v2 布局用 `/sys/fs/cgroup` 拼 `0::` 路径后 stat；hybrid 上正确路径是 `/sys/fs/cgroup/unified/...`，stat 失败导致所有容器拿不到 `cgroupId`（日志持续 `cold_start_runtime_ready=0`），明文白名单没有 cgroup 可写。cgroup 解析缺失还使进程归因退化，出现身份键污染（gdss 容器 ID 混入 `office-agent` 审核键、office 身份键挂在无关容器进程事件上）。
2. `observer-forward.js` 的 `TLS_AGENT_CGROUPS_FILE` 由 `ANYSENTRY_FILTER_RULES_FILE` 推导，打包的 systemd unit 未设置该变量，白名单发布 `publish()` 对空路径直接 return 0，文件通道在打包部署里是空操作；同时 legacy collector 事件 `cgroupId` 全为 0（4.19 legacy 后端不上报 BPF cgroup id），白名单匹配对 legacy 路径还需降级策略佐证。

部署侧全部干净：docker socket 可读、`/proc` 可读、`/sys/fs/bpf` 已挂载、统一过滤投影正常加载（identity=1/templates=3）、确认评审在 API 侧已生效、collector healthy（8 探针、outputDropped=0）。unknown/候选工作负载只留生命周期事件是策略设计（`droppedEvents` 即丢弃量），不是积压。

修复方向（integration 分支，随 compat15）：discovery 先探测 unified 挂载点再回退 v1 `memory`/`name=systemd` 层级 inode；打包侧显式设置 `ANYSENTRY_FILTER_RULES_FILE`（如 `/run/anysentry-filter/filter-rules.json`，配 RuntimeDirectory）让白名单落地；legacy 后端补 cgroup id=0 的明文准入降级（pid/路径匹配）。验收标准：`cold_start_runtime_ready>0`、白名单文件出现且含 cgroup 条目、向 8000/8001 发请求后事件表出现 `tcp_plaintext` 明文事件。

### 现场插曲

- 手动测试启停脚本时 `anysentry-kafka-init.service` 报 `/opt/anysentry/init-kafka-topics.sh: No such file or directory`：WorkingDirectory 的 `/opt/anysentry/kafka` 缺失导致 CHDIR 失败。从安装器解压目录 `cp -a` 补回 kafka 程序目录和脚本，`systemctl reset-failed` 后按序启动恢复。
- 单元名必须写全，少打字母（如 `anysentry-kafka.servic`）报 Unit not found。
- 停掉 Observer 后页面事件仍短暂增长是正常的：Kafka、Flink 和研判 Worker 在排空已有队列。

### 待并入的上游修正

开发分支在 `f4d0fd6` 之后有两个提交待下一版并入：`95d33a8`（策略页只改超时时同步运行时模型快照）和 `ced2110`（LLM 超时上限 600s 提高到 1800s，sanitize、策略边界和页面输入三处对齐）。后者直接缓解慢内网模型上"样例事件通过、真实大事件超时"的风险。

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
