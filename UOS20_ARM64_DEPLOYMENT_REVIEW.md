# 双杨客户 AnySentry UOS 20 ARM64 部署复盘

## 正确打包流程

正式发布以 `AnySentry`、`Observer`、`Sentry` 三个仓库经过审核的 integration branch HEAD 为输入。AnySentry 和 Observer 通过 direct merge 引入上游 main，再提交客户兼容修改；Sentry 使用锁定的 main 提交。构建程序确认三个工作区 clean、提交号与 `versions.env` 一致后，将源码导出到临时目录，分别构建业务服务、原生 Sentry、Node、ClickHouse、Redis、Linux 4.19 Observer、L3 和诊断程序。构建完成后执行 ELF/ABI、BPF 版本、包结构和 SHA-256 校验，生成 `PROVENANCE` 后打包。稳定 UOS 分支仅在目标机验收通过后推进。

## 客户设备基线

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
- systemd 和命名空间检测表现为宿主环境。客户说明该服务器由电信平台提供，运维访问路径具有容器化或平台托管特征，因此是否为容器不能仅依据 `/.dockerenv` 判断，部署门禁以实际 syscall 能力为准。

## 主要故障与修正

### 内核配置文件读取失败

初版安装程序将 `/boot/config-4.19.0-arm64-server` 可读性作为硬门禁，导致预检提前退出。修正后按 `/boot/config-*`、`/proc/config.gz` 顺序读取；均不可读时给出警告，以无持久副作用的 BPF syscall 探测结果为最终依据。

### ClickHouse 非法指令

通用 ARM64 ClickHouse 在目标 Kunpeng CPU 上执行后触发 `SIGILL`，服务持续重启，API 因等待 8123 超时而失败。根因是二进制使用了目标 CPU 不支持的指令。修正为 ClickHouse 24.8.14.39 `armv8.0-compat` 配置，并在安装预检直接执行 `clickhouse --version`，使不兼容包在停服前失败。

### Observer BPF 程序全部加载失败

初始 legacy Observer 使用 uname 推导的 4.19.0 BPF 版本，八个程序均收到 `BPF_PROG_LOAD EINVAL`。目标内核无 BTF，因此不能使用 CO-RE 路径。专用 syscall 探测证明映射、socket filter 和权限正常，但 kprobe 仅接受 4.19.90。hotfix3 将 legacy BPF `kern_version` 固定为 `0x0004135a`，最终八个探针全部附加成功。

该问题说明发行版显示版本不等于内核 BPF ABI。以后不得仅按 `uname -r` 选择 Observer，必须执行随包探测程序。

### Redis 7.4.2 在 ARM64 内核主动退出

Redis 的实际 `MADV_FREE + fork()` 脏页自检证明客户 UOS 4.19 ARM64 内核存在 Copy-on-Write 数据损坏风险，Redis 因 `ARM64-COW-BUG` 保护而拒绝启动。该 Redis 仅承担可重建的 BullMQ 临时队列，安全事件和判定结果由 ClickHouse 持久化。因此客户配置关闭 RDB 和 AOF 后台持久化，再显式忽略该启动警告；不得仅忽略警告并继续启用 fork 型持久化。

### Observer Source 配置脚本错误

服务创建 Source 返回 HTTP 201，但旧脚本仅接受特定状态或未解析 API 的 `data` 信封，错误报告为创建失败。人工编辑时又曾产生 `payload?.data??payload:` 语法错误；执行命令缺少路径开头 `/` 时出现 `MODULE_NOT_FOUND`。当前脚本使用 `payload?.data ?? payload`，接受所有 `response.ok` 状态，并使用绝对安装路径。

### 事件验证与采集噪声

旧验证仅在事件列表查找单个 ToolExec 标记。在高吞吐下，内存热窗口已达到 100000，目标事件可能在查询前被挤出，因而出现服务正常但验证失败。新验证改为检查 Source 的 `acceptedEvents` 增长、`rejectedEvents` 不增长、collector 健康以及八个探针日志。

采集统计中 FileAccess 约占 99.7%，主要来自 Observer 对 ClickHouse 数据和日志目录的自观测。systemd 现默认过滤 `/var/lib/anysentry/clickhouse/` 与 `/var/log/anysentry/`，同时保留 `/home`、`/etc` 和工作区安全事件。

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
