# AnySentry Security Suite UOS 20 ARM64 离线部署手册

本包用于客户主机 UOS Server 20 Enterprise、`aarch64`、glibc 2.28、Linux 4.19，兼容
64 KiB 内核页。目标机配置为 16 核 Kunpeng 920、64 GiB 内存、约 34 GiB 可用磁盘；
ClickHouse 内存上限已设为 8 GiB，数据写入 `/var/lib/anysentry/clickhouse`。

包内包含 AnySentry API、Web 监控中台、Node.js 20.19.4、ClickHouse 24.8.14.39
`armv8.0-compat`、
ARM64 `a3s-sentry`、L1/L2/L3、`@a3s-lab/code` 5.1.0 和 Linux 4.19 legacy
`a3s-observer`。目标机不需要 Docker、Node、npm、pnpm、Rust，也不需要联网。

## 1. 构建与网络边界

构建机需要联网，用于下载固定版本并校验摘要的 Zig、Rust crate、Node ARM64 包、
ClickHouse 24.8 固定源码及构建镜像、ClickHouse 配置镜像和 a3s-code ARM64 addon。
目标机安装和运行完全离线，安装脚本
不会调用软件源、容器仓库或包管理器。

构建机执行：

```bash
pnpm install --frozen-lockfile
ANYSENTRY_RELEASE_VERSION=0.1.0-compat1 \
OBSERVER_SOURCE_DIR=/path/to/Observer-worktree \
pnpm build:uos20-arm64-package
```

输出：

```text
release/anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz
release/anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz.sha256
```

只有配置了内网 LLM 或告警 Webhook 后，运行时才会主动访问对应的内网地址。包本身不
访问互联网。

## 2. WinSCP 上传、校验与解压

通过 WinSCP 将 `.tar.gz` 和 `.sha256` 上传到客户机 `/mnt`，然后以 root 执行：

```bash
cd /mnt
sha256sum -c anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz.sha256
tar -xzf anysentry-security-suite-0.1.0-compat1-uos20-arm64.tar.gz
cd anysentry-security-suite-0.1.0-compat1-uos20-arm64
./install.sh --check
```

`--check` 不修改系统。它会检查 AArch64、glibc、Linux 4.19、4/64 KiB 页、BPF、
perf、kprobe、`__arm64_sys_execve`、systemd、端口、5 GiB 可用空间、包内 SHA-256，
并实际执行随包 Node 与 ClickHouse 的 `--version`。若 CPU 不兼容，预检会在创建用户、
写入配置或启动服务前失败。
预检失败时不要强行安装，应先处理错误中指出的内核能力、端口或磁盘问题。

### 从首版 ClickHouse `SIGILL` 恢复

若 `0.1.0` 首版在目标机出现 `非法指令`、`signal=ILL` 或 `status=4/ILL`，先停止旧包
留下的重启服务：

```bash
systemctl disable --now anysentry-observer.service 2>/dev/null || true
systemctl disable --now anysentry.service 2>/dev/null || true
systemctl disable --now anysentry-clickhouse.service 2>/dev/null || true
systemctl reset-failed anysentry-observer.service anysentry.service anysentry-clickhouse.service
```

随后上传并安装本 `0.1.0-compat1` 包。重复安装会保留
`/etc/anysentry/anysentry.env` 和 `/var/lib/anysentry`；不要删除已生成的密钥或状态目录。
本包的 ClickHouse 使用官方 `clang-18-aarch64-v80compat` profile 构建，不再包含首版
使用的现代 `armv8.2-a+dotprod+ssbs+rcpc` 指令集基线。

## 3. 安装前配置 LLM

客户尚未提供内网模型时可保持 URL 为空：L1 规则始终启用，L2 和 L3 自动关闭。拿到
接口后，在首次安装前复制模板并填写：

```bash
cp config/anysentry.env.example config/anysentry.env
vi config/anysentry.env
```

至少确认以下字段：

```text
ANYSENTRY_LLM_BASE_URL=http://内网模型地址:端口/v1
ANYSENTRY_LLM_MODEL=客户提供的模型ID
ANYSENTRY_LLM_API_KEY=客户提供的Key或留空
ANYSENTRY_LLM_TIMEOUT=30
ANYSENTRY_L3_ENABLED=true
ANYSENTRY_L3_TIMEOUT=180
```

`ANYSENTRY_L3_ENABLED=false` 表示只使用 L1/L2。L3 使用同一 URL、模型和 Key，无需再
填写一套。Key 只从 `/etc/anysentry/anysentry.env` 注入内存 ACL，不写入 ClickHouse，
也不会通过配置查询接口返回。

OpenAI 兼容要求：AnySentry L2 请求 `POST <ANYSENTRY_LLM_BASE_URL>/chat/completions`，
可选发送 `Authorization: Bearer <Key>`。返回需包含 `choices[0].message.content`，其中
content 是 JSON 对象或含有该对象的文本，例如：

```json
{
  "choices": [
    {
      "message": {
        "content": "{\"verdict\":\"block\",\"severity\":\"high\",\"reason\":\"detected credential theft\"}"
      }
    }
  ]
}
```

`verdict` 为 `allow`、`block` 或 `escalate`；`severity` 为 `low`、`medium`、`high` 或
`critical`；`reason` 为一句原因。L3 还要求该接口能处理普通 OpenAI chat completion。

以下值保留 `__GENERATED__`，安装器会自动处理：

- `CLICKHOUSE_PASSWORD`：数据库密码。
- `ANYSENTRY_ADMIN_TOKEN`：控制面写操作令牌。
- `ANYSENTRY_SOURCE_ID` / `ANYSENTRY_INGEST_TOKEN`：API 启动后创建的 Observer Source
  身份和上报令牌，令牌哈希持久化在 ClickHouse。

执行安装：

```bash
./install.sh --check
sudo ./install.sh
```

重复安装会保留 `/etc/anysentry/anysentry.env` 和已有 Observer Source，不轮换现有密钥。

## 4. 目录、服务与端口

| 内容 | 路径 |
| --- | --- |
| 程序、私有 Node、L3 和 Observer | `/opt/anysentry` |
| 配置与密钥，权限 0600 | `/etc/anysentry/anysentry.env` |
| ClickHouse 持久数据 | `/var/lib/anysentry/clickhouse` |
| ClickHouse 日志 | `/var/log/anysentry` |

| 服务 | 身份 | 用途 |
| --- | --- | --- |
| `anysentry-clickhouse.service` | `anysentry` | 本机持久层 |
| `anysentry.service` | `anysentry` | API、L1/L2/L3、Web 中台 |
| `anysentry-observer.service` | root，受限 capabilities | Linux 4.19 eBPF 采集和本机转发 |

| 端口 | 监听地址 | 用途 |
| --- | --- | --- |
| `29653/tcp` | `0.0.0.0` | 浏览器、API 和其他内网调用方 |
| `8123/tcp` | `127.0.0.1` | 仅 AnySentry 本机访问 ClickHouse |

只向需要访问中台/API 的客户网段放行 29653，禁止对外开放 8123。

## 5. 安装验收与 LLM 测试

安装器末尾会自动运行完整验收。也可手动执行：

```bash
sudo /opt/anysentry/verify.sh
systemctl status anysentry-clickhouse anysentry anysentry-observer --no-pager
curl -fsS http://127.0.0.1:29653/security-center/healthz
ss -lntp | grep -E ':(29653|8123)\b'
```

验收要求：ClickHouse storage mode 为 `clickhouse`；ARM64 Sentry L1 阻断测试通过；
Observer 执行唯一命令后，API 的 `/security-center/events/list` 中能查询到对应
`ToolExec`。这是客户 Linux 4.19 内核上的最终 eBPF 接受条件。

LLM 配好并重启后，从网页策略配置页或管理接口执行模拟。修改配置的重启命令：

```bash
sudo systemctl restart anysentry anysentry-observer
```

若修改 ClickHouse 密码，则按顺序重启全部服务：

```bash
sudo systemctl restart anysentry-clickhouse anysentry anysentry-observer
```

## 6. 网页与接口调用

监控中台：`http://客户机器IP:29653/`

健康接口：

```bash
curl -fsS http://客户机器IP:29653/security-center/healthz
```

通用 JSON 上报：

```bash
curl -fsS -X POST http://客户机器IP:29653/security-center/ingest/events \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceType":"custom",
    "sourceName":"customer-agent",
    "workspacePath":"repo://customer/project",
    "agentId":"agent-01",
    "sessionId":"session-001",
    "events":[{"kind":"egress","peer":"169.254.169.254","port":80}]
  }'
```

查询事件：

```bash
curl -fsS -X POST http://客户机器IP:29653/security-center/events/list \
  -H 'Content-Type: application/json' \
  -d '{"timeType":"last_24h","limit":20}'
```

其他接入接口：

- Observer NDJSON：`POST /security-center/ingest`
- OTLP Logs：`POST /security-center/ingest/otlp/v1/logs`
- OTLP Traces：`POST /security-center/ingest/otlp/v1/traces`
- Collector heartbeat：`POST /security-center/collectors/heartbeat`
- Source 管理：`POST /security-center/sources`，需要 `X-AnySentry-Admin-Token`
- 策略读取/更新：`GET/PUT /security-center/config`，写操作需要管理令牌

管理令牌从 root 可读的环境文件获取，不要写入网页、日志或事件：

```bash
ANYSENTRY_ADMIN_TOKEN=$(sed -n 's/^ANYSENTRY_ADMIN_TOKEN=//p' /etc/anysentry/anysentry.env)
curl -fsS -X POST http://127.0.0.1:29653/security-center/config/simulate \
  -H "X-AnySentry-Admin-Token: $ANYSENTRY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"timeType":"last_24h","limit":20}'
unset ANYSENTRY_ADMIN_TOKEN
```

## 7. Observer 兼容范围与诊断

本包不是主线 RingBuf Observer，而是为客户 Linux 4.19 构建的 legacy backend：
`PerfEventArray + ARM64 syscall kprobe`，不依赖 `/sys/kernel/btf/vmlinux` 和 syscall
tracepoint。默认仅观测，不启用 kernel enforcement。采集 exec、exit、connect、文件写入/
删除、setuid、ptrace 和 bind；文件伪文件系统噪声由 forwarder 过滤。

若 Observer service active 但验收找不到 `ToolExec`，检查目标内核实际符号与日志：

```bash
grep -E ' (__arm64_sys_execve|__arm64_sys_connect|__arm64_sys_openat)$' /proc/kallsyms
journalctl -u anysentry-observer -n 300 --no-pager
```

## 8. 日志、升级与卸载

```bash
journalctl -u anysentry -n 300 --no-pager
journalctl -u anysentry-observer -n 300 --no-pager
journalctl -u anysentry-clickhouse -n 300 --no-pager
tail -n 200 /var/log/anysentry/clickhouse-server.err.log
```

升级使用新包重复执行 `sudo ./install.sh`，历史数据与现有配置默认保留。默认卸载同样
保留配置、密钥和历史数据：

```bash
sudo /opt/anysentry/uninstall.sh
```

确认不再需要数据时才执行：

```bash
sudo /opt/anysentry/uninstall.sh --purge-data
```
