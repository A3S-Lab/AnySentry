# AnySentry 部署手册

## 1. 适用环境

本安装包适用于指定的 UOS Server 20 ARM64 服务器。服务器应使用 `aarch64` 架构、
glibc 2.28、64 KiB 内存页及客户专用 Linux 4.19 内核。安装过程不需要访问互联网。

## 2. 上传和校验

将压缩包及同名 `.sha256` 文件上传至服务器同一目录，然后执行：

```bash
sha256sum --check anysentry-security-suite-0.2.0-compat8-uos20-arm64.tar.gz.sha256
tar -zxf anysentry-security-suite-0.2.0-compat8-uos20-arm64.tar.gz
cd anysentry-security-suite-0.2.0-compat8-uos20-arm64
sha256sum --check manifest.sha256
```

校验必须全部通过。校验失败时不得继续安装。

## 3. 预检和安装

以 root 用户执行预检：

```bash
./install.sh --check
```

预检通过后执行首次安装或升级：

```bash
./install.sh
```

安装程序自动保留配置和业务数据，启动全部服务并执行运行验证。新版本验证失败时自动恢复上一版本。

## 4. 安装验证

```bash
/opt/anysentry/verify.sh
curl -fsS http://127.0.0.1:29653/security-center/healthz
systemctl is-active anysentry-clickhouse.service
systemctl is-active anysentry-redis.service
systemctl is-active anysentry.service
systemctl is-active anysentry-fast-judge.service
systemctl is-active anysentry-l3-worker.service
systemctl is-active anysentry-observer.service
```

验证程序应全部显示 `PASS`，所有服务应显示 `active`。

执行只读健康检查：

```bash
/opt/anysentry/RUN_HEALTH_SMOKE.sh --passive
```

执行安全模拟检查：

```bash
/opt/anysentry/RUN_HEALTH_SMOKE.sh --safe
```

安全模拟只使用 `/tmp`、本地回环网络和带唯一标识的自定义测试事件，不修改服务配置。
详细报告保存在 `/tmp/anysentry-health-smoke-compat8/report.txt`。

## 5. 安装日志

每次执行安装程序后，详细记录保存在：

```text
/var/log/anysentry/install/0.2.0-compat8
```

同时可以通过以下路径访问：

```text
/tmp/anysentry-install-0.2.0-compat8
```

查看安装结果：

```bash
cat /var/log/anysentry/install/0.2.0-compat8/summary.txt
less /var/log/anysentry/install/0.2.0-compat8/install.log
```

如安装失败，应将该目录完整提供给维护人员。安装器会先保存失败现场，再执行自动回滚。

## 6. 页面地址

管理页面默认地址：

```text
http://<服务器IP>:29653/
```

服务器IP必须能够从访问终端到达。禁止对外开放 ClickHouse 的 8123 端口。
