# AnySentry UOS 20 ARM64 部署与维护

## 文档导航

- [AnySentry 部署手册](./AnySentry部署手册.md)
- [AnySentry 使用手册](./AnySentry使用手册.md)
- [AnySentry 脚本说明](./AnySentry脚本说明.md)

## 1. 适用范围

本发布包适用于指定的 UOS Server 20 Enterprise ARM64 环境：glibc 2.28、64 KiB
内存页、显示内核 `4.19.0-arm64-server`，实际 BPF 版本码 `0x0004135a`。
安装程序同时支持首次安装和后续升级。

## 2. 上传与校验

将 tar 包和同名 `.sha256` 文件上传至目标服务器后执行：

```bash
cd /opt/shannon/anysentry
sha256sum --check anysentry-security-suite-0.2.0-compat8-uos20-arm64.tar.gz.sha256
tar -zxf anysentry-security-suite-0.2.0-compat8-uos20-arm64.tar.gz
cd anysentry-security-suite-0.2.0-compat8-uos20-arm64
sha256sum --check manifest.sha256
```

## 3. 首次安装或升级

预检不产生持久系统变更：

```bash
./install.sh --check
```

执行安装或升级：

```bash
./install.sh
```

安装程序保留 `/etc/anysentry/anysentry.env`、`/var/lib/anysentry` 和 `/var/log/anysentry`，自动合并新增配置项，按 ClickHouse、Redis、API、判定 Worker、Observer 的顺序启动服务，配置 Observer Source 并执行完整验证。激活失败时自动 rollback 至上一程序和 systemd 单元；失败版本保留为 `/opt/anysentry.failed.<时间>`。

上述 `/opt`、`/etc`、`/var/lib` 和 `/var/log` 路径由正式安装创建或管理。
`/opt/anysentry.failed.<时间>` 仅在激活失败并执行回滚时创建；
`/opt/.anysentry.rollback.<时间>` 仅在已有版本的升级过程中创建。

每次执行安装程序都会覆盖写入本 compat 版本的完整诊断目录：

```text
/var/log/anysentry/install/0.2.0-compat8
```

`/tmp/anysentry-install-0.2.0-compat8` 指向同一目录。安装失败时，安装器先保存新版本服务状态、
健康响应和 journal，再执行 rollback，并将失败阶段和回滚结果写入 `summary.txt`。

正式安装还会写入 `/etc/sysctl.d/90-anysentry.conf`，持久设置
`vm.overcommit_memory=1`。各 systemd 服务使用发布包内规定的 Node 堆和 MemoryHigh/MemoryMax；
后续升级会重新应用这些资源配置。

安装成功后执行：

```bash
/opt/anysentry/verify.sh
cat /opt/anysentry/VERSION
cat /opt/anysentry/PROVENANCE
```

## 4. 页面访问

管理页面默认地址：

```text
http://<目标服务器可达IP>:29653/
```

无法直接访问服务器网段时，可使用同网段浏览器。具备跳转连接时，可建立本地端口转发：
本地 `29653` 转发至服务器 `127.0.0.1:29653`，然后访问
`http://127.0.0.1:29653/`。ClickHouse `8123` 仅允许本机访问，不得对外发布。

## 5. L2 和 L3 配置

编辑受保护配置：

```bash
vi /etc/anysentry/anysentry.env
```

L2 使用 OpenAI 兼容接口：

```ini
ANYSENTRY_LLM_BASE_URL=https://<LLM服务地址>/v1
ANYSENTRY_LLM_MODEL=<模型名>
ANYSENTRY_LLM_API_KEY=<API密钥>
ANYSENTRY_LLM_TIMEOUT=30
ANYSENTRY_ASYNC_JUDGE=on
```

启用 L3：

```ini
ANYSENTRY_L3_ENABLED=true
ANYSENTRY_L3_TIMEOUT=180
ANYSENTRY_L3_TIMEOUT_MS=180000
ANYSENTRY_L3_WORKSPACE=/var/lib/anysentry/l3
A3S_SENTRY_L3_URL=https://<LLM服务地址>/v1
A3S_SENTRY_L3_MODEL=<模型名>
A3S_SENTRY_L3_KEY=<API密钥>
```

配置文件变更不会自动重启服务。配置完成后执行：

```bash
chown root:root /etc/anysentry/anysentry.env
chmod 0600 /etc/anysentry/anysentry.env
systemctl restart anysentry.service
systemctl restart anysentry-fast-judge.service
systemctl restart anysentry-l3-worker.service
curl -fsS http://127.0.0.1:29653/security-center/healthz
```

健康响应中的 `policy.l2=true`、`policy.l3=true` 表示相应级别已启用。手工修改配置不会触发自动重启；执行新版本 `install.sh` 升级时会自动重启全部服务。

## 6. 常用检查

```bash
systemctl status anysentry-clickhouse.service --no-pager -l
systemctl status anysentry-redis.service --no-pager -l
systemctl status anysentry.service --no-pager -l
systemctl status anysentry-fast-judge.service --no-pager -l
systemctl status anysentry-l3-worker.service --no-pager -l
systemctl status anysentry-observer.service --no-pager -l
curl -fsS http://127.0.0.1:8123/ping
/opt/anysentry/redis/bin/redis-cli -h 127.0.0.1 -p 6379 ping
curl -fsS http://127.0.0.1:29653/security-center/healthz
journalctl -b -u anysentry-clickhouse.service -n 200 --no-pager
journalctl -b -u anysentry-redis.service -n 200 --no-pager
journalctl -b -u anysentry.service -n 200 --no-pager
journalctl -b -u anysentry-fast-judge.service -n 200 --no-pager
journalctl -b -u anysentry-l3-worker.service -n 200 --no-pager
journalctl -b -u anysentry-observer.service -n 300 --no-pager -o cat
/opt/anysentry/inspect-host.sh
/opt/anysentry/diagnostics/RUN_DIAGNOSTICS.sh
```

Observer 正常日志应包含 8 条 `legacy probe attached` 和汇总 `effective_probes=3`。Source 应为 `active`，`acceptedEvents` 持续增加，`rejectedEvents` 不增加；collector 应为 `healthy`，`outputDropped=0`、`errorCount=0`。

安装验证以 Source 事件增长及 collector 运行时健康为准，要求
`attachedProbes>=8`、`outputDropped=0`、`errorCount=0`。journal 日志仅用于排错，
不得作为独立的激活或回滚条件。

Collector 健康记录在 API 启动后可能延迟可见。安装验证最长等待 60 秒；若仍未就绪，
错误输出包含最后一次 `/collectors/health` 原始 JSON、`state` 和 `attachedProbes`。

若日志出现 `Cannot find module './observer-agent-attribution'` 或
`Cannot find module './observer-event-dedup'`，表示发布包不完整。停止部署并更换完整发布包，
不得单独复制 `observer-forward.js`。

## 7. 故障定位与修复

### 预检提示 kernel configuration 不可读

当前安装程序不再仅依赖 `/boot/config-$(uname -r)`；该文件不可读时以运行时 BPF syscall 探测为准。执行：

```bash
./inspect-host.sh
```

该命令在当前工作目录生成 `anysentry-host-inspection-*.txt`，用于兼容性分析。

### ClickHouse 出现 `signal=ILL` 或“非法指令”

安装包不是 `armv8.0-compat` 构建，禁止继续安装。更换为匹配此 ABI 的发布包并执行
`./install.sh --check`。不得复制通用 ARM64 ClickHouse 覆盖兼容版本。

### Observer 出现 `BPF_PROG_LOAD`、`EINVAL` 或无有效探针

检查诊断结果是否包含：

```text
scan.kprobe_candidate.version=4.19.90
scan.kprobe_candidate.version_code=0x0004135a
```

若不一致，目标内核 ABI 已变化，停止部署并重新构建 Observer；不得修改版本字符串绕过预检。

### API 启动超时

先确认 ClickHouse 和 Redis：

```bash
systemctl status anysentry-clickhouse.service --no-pager -l
tail -n 200 /var/log/anysentry/clickhouse-server.err.log
curl -fsS http://127.0.0.1:8123/ping
/opt/anysentry/redis/bin/redis-cli -h 127.0.0.1 -p 6379 ping
```

### 判定 Worker 启动失败

确认 Redis 为 `PONG`，再查看相应日志：

```bash
systemctl status anysentry-fast-judge.service anysentry-l3-worker.service --no-pager -l
journalctl -b -u anysentry-fast-judge.service -u anysentry-l3-worker.service -n 300 --no-pager
```

未启用 L3 时，`anysentry-l3-worker.service` 保持 active 并由休眠进程占位，属于正常状态。

### Redis 报告 `ARM64-COW-BUG`

指定的 UOS 4.19 ARM64 内核未通过 Redis 的 `MADV_FREE + fork()` 脏页自检，
使用 RDB 或 AOF 后台重写可能造成数据损坏。本发布包将 Redis 配置为无 RDB、无 AOF
的临时队列，并在禁用 fork 型持久化后设置 `ignore-warnings ARM64-COW-BUG`。
安全事件与判定结果仍由 ClickHouse 持久化。

不得在该内核上将 Redis 配置改回 `appendonly yes` 或启用 `save`。Redis 或服务器重启时，
尚未处理的临时队列任务可能丢失；服务恢复后新事件正常入队。

### Observer Source 配置失败

确认 API 健康后重新执行幂等配置：

```bash
/opt/anysentry/runtime/node/bin/node \
  /opt/anysentry/provision-observer.mjs \
  /etc/anysentry/anysentry.env \
  http://127.0.0.1:29653/security-center
systemctl restart anysentry-observer.service
```

HTTP 201 为创建成功状态；随包脚本已支持标准响应信封。脚本路径必须以 `/opt/anysentry/` 开头。

### 验证失败但服务为 active

执行 `/opt/anysentry/verify.sh` 并检查 Source/collector 指标。页面健康接口中的 `events.total=100000` 是内存热窗口上限，不是 ClickHouse 总存储上限；历史数据由 ClickHouse 保存并按 90 天 TTL 清理。

### 手工恢复上一程序

仅在自动 rollback 本身失败时执行。先找到最近目录：

```bash
ls -ld /opt/.anysentry.rollback.*
systemctl stop anysentry-observer.service anysentry-l3-worker.service anysentry-fast-judge.service
systemctl stop anysentry.service anysentry-redis.service anysentry-clickhouse.service
mv /opt/anysentry /opt/anysentry.failed.manual
mv /opt/.anysentry.rollback.<时间> /opt/anysentry
systemctl daemon-reload
systemctl start anysentry-clickhouse.service
systemctl start anysentry-redis.service 2>/dev/null || true
systemctl start anysentry.service
systemctl start anysentry-fast-judge.service anysentry-l3-worker.service 2>/dev/null || true
systemctl start anysentry-observer.service
/opt/anysentry/verify.sh
```

## 8. 卸载

保留配置和数据：

```bash
/opt/anysentry/uninstall.sh
```

同时删除配置和持久数据：

```bash
/opt/anysentry/uninstall.sh --purge-data
```
