# AnySentry 脚本说明

## 文档导航

- [AnySentry 部署手册](./AnySentry部署手册.md)：环境校验、安装、升级和基础排错。
- [AnySentry 使用手册](./AnySentry使用手册.md)：页面访问、监控对象和状态说明。
- [AnySentry 脚本说明](./AnySentry脚本说明.md)：发布包内各 Shell 脚本的用途和参数。

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

### `verify.sh`

用途：验证主机 ABI、文件校验和、全部服务、ClickHouse、Redis、Kafka、Flink、API、
原生 Sentry、Source 事件增长及 Collector 健康状态。

```bash
/opt/anysentry/verify.sh
```

验证过程中会提交本地测试判定并确认 Observer 事件接收，不用于纯只读检查。

### `RUN_HEALTH_SMOKE.sh`

用途：生成统一健康报告。默认报告目录为
`/tmp/anysentry-health-smoke-0.3.0-compat1`，该目录在脚本运行时创建并覆盖。

```bash
/opt/anysentry/RUN_HEALTH_SMOKE.sh --passive
/opt/anysentry/RUN_HEALTH_SMOKE.sh --safe
/opt/anysentry/RUN_HEALTH_SMOKE.sh --extended
/opt/anysentry/RUN_HEALTH_SMOKE.sh --help
```

- `--passive`：只读检查服务、接口、Source、Collector 和日志；
- `--safe`：默认模式，增加本地安全操作及带唯一标识的模拟事件；
- `--extended`：增加多类别 Sentry 摄取模拟。

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
