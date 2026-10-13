# AnySentry 脚本说明

## 文档导航

- [AnySentry 部署手册](./AnySentry部署手册.md)：环境校验、安装、升级和基础排错。
- [AnySentry 使用手册](./AnySentry使用手册.md)：页面访问、监控对象和状态说明。
- [AnySentry 脚本说明](./AnySentry脚本说明.md)：发布包内各 Shell 脚本的用途和参数。
- [现场问题采集](./现场问题采集.md)：现场日志、模型配置状态和资源占用的采集方法。

## 1. 路径规则

解压后进入发布包目录，使用 `./脚本名`。正式安装成功后，发布包整体安装到
`/opt/anysentry`，可使用 `/opt/anysentry/脚本名`。

`diagnostics` 子目录随发布包安装到 `/opt/anysentry/diagnostics`。报告路径由各脚本创建；
未执行对应脚本时，报告文件或目录不存在属于正常状态。

## 2. 可直接执行的脚本

### `install.sh`

用途：完成预检、首次安装、原地升级、运行验证和失败回滚。

```bash
./install.sh --check
./install.sh
./install.sh --help
```

`--check` 不修改服务、程序、数据或 sysctl，但会写入版本化诊断日志。正式安装需要 root
权限。

### `anysentry-services.sh`

用途：按依赖顺序启动、按相反顺序停止全部 AnySentry systemd 单元，或查看状态。
不停止 Docker 或其他系统服务，不删除 `/var/lib/anysentry`。

```bash
sudo /opt/anysentry/anysentry-services.sh stop
sudo /opt/anysentry/anysentry-services.sh start
/opt/anysentry/anysentry-services.sh status
```

### `verify.sh`

用途：验证主机 ABI、文件校验和、全部服务、ClickHouse、Redis、Kafka、Flink、API、
原生 Sentry、Source 事件增长及 Collector 健康状态。

```bash
/opt/anysentry/verify.sh
```

验证过程中会提交本地测试判定并确认 Observer 事件接收，不用于纯只读检查。

### `RUN_HEALTH_SMOKE.sh`

用途：生成统一健康报告。默认报告目录为
`/tmp/anysentry-health-smoke-@RELEASE_VERSION@`，该目录在脚本运行时创建并覆盖。

```bash
/opt/anysentry/RUN_HEALTH_SMOKE.sh --passive
/opt/anysentry/RUN_HEALTH_SMOKE.sh --safe
/opt/anysentry/RUN_HEALTH_SMOKE.sh --extended
/opt/anysentry/RUN_HEALTH_SMOKE.sh --help
```

- `--passive`：只读检查服务、接口、Source、Collector 和日志；
- `--safe`：默认模式，增加本地安全操作及带唯一标识的模拟事件；
- `--extended`：增加多类别 Sentry 摄取模拟。

### `ACCEPTANCE_CHECK.sh`

用途：现场验收。只读检查安装结果、Collector 健康、审核投影、明文白名单、Observer
开关与探针挂接，并向 `127.0.0.1:8000`/`8001` 各发 3 个带唯一标记的 GET（业务返回
401/404 属预期），30 秒后核对 ClickHouse 中的明文事件与五类非 exec 事件。

```bash
/opt/anysentry/ACCEPTANCE_CHECK.sh 2>&1 | tee acceptance-result.txt
```

全部通过时输出 `验收全部通过`；存在未通过项时把输出文件交给打包工程师。该脚本
不修改服务、配置或数据。

### `FIELD_DIAGNOSTIC.sh`

用途：分阶段现场诊断（S0-S8）。任何会话或任何人接手现场时先跑本脚本，按阶段输出
PASS/FAIL/WARN 和下一步指引，覆盖机器基线、服务存活、探针挂载、审核投影、白名单、
准入同步、明文采集和归因。

```bash
/opt/anysentry/FIELD_DIAGNOSTIC.sh 2>&1 | tee field-diagnostic-result.txt
/opt/anysentry/FIELD_DIAGNOSTIC.sh --with-http   # 追加一次合成 HTTP 明文实验
```

默认纯只读；`--with-http` 会从容器内发一个带标记的 HTTP 请求（性质同健康检查）。

### `anysentry-data-cleanup.sh`

用途：查看 AnySentry 各项磁盘占用（文件系统、`/var/lib/anysentry` 各子目录、日志、
回滚残留、ClickHouse 各表和按月分区大小、events 按天分布），并可按天清理
ClickHouse 事件数据。

```bash
/opt/anysentry/anysentry-data-cleanup.sh                          # 只读报告（默认）
/opt/anysentry/anysentry-data-cleanup.sh --keep-days 30           # 只保留最近 30 天事件
/opt/anysentry/anysentry-data-cleanup.sh --drop-oldest-days 7     # 删除最早 7 天的事件
```

不带参数时不修改任何数据。删除只作用于事件族四张表（`events`、`event_locators_v1`、
`kernel_fact_locators_v1`、`agent_interactions_v1`），审核记录等配置数据不受影响；
执行前会显示将删除的行数并要求输入 `YES` 确认（可用 `--yes` 跳过）。删除通过
ClickHouse mutation 完成，磁盘空间在分区分配合并后归还，脚本会等待 mutation 结束。

### `collect-support-bundle.sh`

用途：在出现安装失败、页面报错、模型未连通、采集中断或服务占用过高之后，把主机、服务、日志和模型配置状态打成一个压缩包。密钥和令牌只记录是否已设置、长度和指纹，不写入原文。

```bash
sudo /opt/anysentry/collect-support-bundle.sh
sudo ./collect-support-bundle.sh /tmp/anysentry-support.tar.gz
```

未安装完成时，在解压目录执行 `./collect-support-bundle.sh`。默认输出 `/tmp/anysentry-support-主机名-时间.tar.gz`。把这一个文件拷回，不要编辑或截断。

### `inspect-host.sh`

用途：采集操作系统、ABI、内存、磁盘、服务、端口、Observer 日志和 BPF 能力。

```bash
cd /tmp
/opt/anysentry/inspect-host.sh
/opt/anysentry/inspect-host.sh /tmp/anysentry-host-inspection.txt
```

未指定参数时，报告写入当前工作目录，文件名包含执行时间。指定参数时写入给定路径。

### `diagnostics/RUN_DIAGNOSTICS.sh`

用途：执行被动检查和瞬时 BPF syscall 探测，判断实际 BPF kprobe 版本兼容性。

```bash
cd /tmp
/opt/anysentry/diagnostics/RUN_DIAGNOSTICS.sh
/opt/anysentry/diagnostics/RUN_DIAGNOSTICS.sh \
  /opt/anysentry/observer/bin/a3s-observer-collector
```

报告默认写入当前工作目录。该脚本不附加 KProbe，不 pin BPF 对象。

### `diagnostics/RUN_PASSIVE_CHECK.sh`

用途：只读采集内核配置、capability、命名空间、挂载点、LSM、资源限制和 Collector ABI。

```bash
cd /tmp
/opt/anysentry/diagnostics/RUN_PASSIVE_CHECK.sh
```

该脚本不调用 `bpf(2)`。报告默认写入当前工作目录。

### `uninstall.sh`

用途：停止并移除程序和 systemd 单元。

```bash
/opt/anysentry/uninstall.sh
/opt/anysentry/uninstall.sh --purge-data
/opt/anysentry/uninstall.sh --help
```

默认保留 `/etc/anysentry`、`/var/lib/anysentry` 和 `/var/log/anysentry`。
`--purge-data` 同时删除上述配置、状态和日志，执行后不可恢复。

## 3. 服务内部脚本

以下脚本由 systemd 或安装程序调用，通常不直接执行：

| 脚本 | 作用 |
| --- | --- |
| `wait-clickhouse.sh` | API 启动前等待 ClickHouse 回环接口就绪 |
| `run-l3-worker.sh` | 根据 `ANYSENTRY_L3_ENABLED` 启动 L3 Worker；未启用时保持待机 |
| `run-kafka.sh` | 初始化 Kafka KRaft 存储并启动本机 Broker |
| `init-kafka-topics.sh` | 幂等创建 AnySentry 流处理主题 |
| `run-flink.sh` | 启动 Flink JobManager、TaskManager 或提交流处理作业 |

脚本参数和默认值以对应版本发布包内的 `--help` 输出及本说明为准。
