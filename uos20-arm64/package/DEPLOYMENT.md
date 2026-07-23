# AnySentry UOS 20 ARM64 部署与维护

## 1. 适用范围

本发布包适用于双杨客户 UOS Server 20 Enterprise ARM64 环境：glibc 2.28、64 KiB 页、显示内核 `4.19.0-arm64-server`，实际 BPF 版本码 `0x0004135a`。安装程序同时支持首次安装和后续升级。

## 2. 上传与校验

将 tar 包和同名 `.sha256` 文件上传至目标服务器后执行：

```bash
cd /opt/shannon/anysentry/v0.1.0
sha256sum --check anysentry-security-suite-0.1.0-compat2-uos20-arm64.tar.gz.sha256
tar -zxf anysentry-security-suite-0.1.0-compat2-uos20-arm64.tar.gz
cd anysentry-security-suite-0.1.0-compat2-uos20-arm64
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

安装程序保留 `/etc/anysentry/anysentry.env`、`/var/lib/anysentry` 和 `/var/log/anysentry`，自动合并新增配置项、依次启动服务、配置 Observer Source 并执行完整验证。激活失败时自动 rollback 至上一程序和 systemd 单元；失败版本保留为 `/opt/anysentry.failed.<时间>`。

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

若本地不能直接 SSH 或访问目标网段，应使用客户内置浏览器打开该地址。Xshell 可连接跳板入口时，可建立本地转发：本地 `29653` 转发至目标 `127.0.0.1:29653`，然后访问 `http://127.0.0.1:29653/`。ClickHouse `8123` 仅允许本机访问，不得对外发布。

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
```

启用 L3：

```ini
ANYSENTRY_L3_ENABLED=true
ANYSENTRY_L3_TIMEOUT=180
ANYSENTRY_L3_WORKSPACE=/var/lib/anysentry/l3
```

配置文件变更不会自动重启服务。配置完成后执行：

```bash
chown root:root /etc/anysentry/anysentry.env
chmod 0600 /etc/anysentry/anysentry.env
systemctl restart anysentry.service anysentry-observer.service
curl -fsS http://127.0.0.1:29653/security-center/healthz
```

健康响应中的 `policy.l2=true`、`policy.l3=true` 表示相应级别已启用。

## 6. 常用检查

```bash
systemctl status anysentry-clickhouse.service --no-pager -l
systemctl status anysentry.service --no-pager -l
systemctl status anysentry-observer.service --no-pager -l
curl -fsS http://127.0.0.1:8123/ping
curl -fsS http://127.0.0.1:29653/security-center/healthz
journalctl -b -u anysentry-clickhouse.service -n 200 --no-pager
journalctl -b -u anysentry.service -n 200 --no-pager
journalctl -b -u anysentry-observer.service -n 300 --no-pager -o cat
/opt/anysentry/inspect-host.sh
```

Observer 正常日志应包含 8 条 `legacy probe attached` 和汇总 `effective_probes=3`。Source 应为 `active`，`acceptedEvents` 持续增加，`rejectedEvents` 不增加；collector 应为 `healthy`，`outputDropped=0`、`errorCount=0`。

## 7. 故障定位与修复

### 预检提示 kernel configuration 不可读

当前安装程序不再仅依赖 `/boot/config-$(uname -r)`；该文件不可读时以运行时 BPF syscall 探测为准。执行：

```bash
./inspect-host.sh
```

将生成的 `anysentry-host-inspection-*.txt` 返回开发人员。

### ClickHouse 出现 `signal=ILL` 或“非法指令”

安装包不是 `armv8.0-compat` 构建，禁止继续安装。恢复使用本客户专用包并执行 `./install.sh --check`。不得复制通用 ARM64 ClickHouse 覆盖专用版本。

### Observer 出现 `BPF_PROG_LOAD`、`EINVAL` 或无有效探针

检查诊断结果是否包含：

```text
scan.kprobe_candidate.version=4.19.90
scan.kprobe_candidate.version_code=0x0004135a
```

若不一致，目标内核 ABI 已变化，停止部署并重新构建 Observer；不得修改版本字符串绕过预检。

### API 启动超时

先确认 ClickHouse：

```bash
systemctl status anysentry-clickhouse.service --no-pager -l
tail -n 200 /var/log/anysentry/clickhouse-server.err.log
curl -fsS http://127.0.0.1:8123/ping
```

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
systemctl stop anysentry-observer.service anysentry.service anysentry-clickhouse.service
mv /opt/anysentry /opt/anysentry.failed.manual
mv /opt/.anysentry.rollback.<时间> /opt/anysentry
systemctl daemon-reload
systemctl start anysentry-clickhouse.service anysentry.service anysentry-observer.service
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
