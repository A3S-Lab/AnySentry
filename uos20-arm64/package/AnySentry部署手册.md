# AnySentry 部署手册

## 文档导航

- [AnySentry 部署手册](./AnySentry部署手册.md)：环境校验、安装、升级和基础排错。
- [AnySentry 使用手册](./AnySentry使用手册.md)：页面访问、监控对象和状态说明。
- [AnySentry 脚本说明](./AnySentry脚本说明.md)：发布包内各 Shell 脚本的用途和参数。

详细兼容性说明见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 1. 适用环境

本安装包适用于以下环境：

- UnionTech OS Server 20 Enterprise；
- `aarch64` 架构；
- glibc 2.28 或更高版本；
- 65536 字节内存页；
- 显示内核 `4.19.0-arm64-server`；
- BPF 有效版本 4.19.90，版本码 `0x0004135a`。

安装过程不访问互联网。环境不一致时，应停止安装并重新完成兼容性构建。

## 2. 路径约定

解压目录由上传位置决定，安装前命令均使用 `./脚本名`。执行正式安装后，安装程序创建或管理：

| 路径 | 创建条件 | 内容 |
| --- | --- | --- |
| `/opt/anysentry` | 正式安装 | 程序、运行时和随包脚本 |
| `/etc/anysentry` | 正式安装 | 受保护配置 |
| `/var/lib/anysentry` | 正式安装 | ClickHouse、Redis 和 L3 状态 |
| `/var/log/anysentry` | 正式安装 | 服务日志和安装诊断 |
| `/etc/sysctl.d/90-anysentry.conf` | 正式安装 | 运行时内存参数 |
| `/tmp/anysentry-install-0.2.0-compat8` | 每次执行安装程序 | 安装诊断入口；通常指向持久日志目录 |
| `/tmp/anysentry-health-smoke-compat8` | 执行健康检查脚本 | 健康检查报告 |
| `/opt/.anysentry.rollback.*` | 成功升级且已有旧版本 | 上一版本程序备份 |
| `/opt/anysentry.failed.*` | 激活失败并回滚 | 失败版本现场 |

未执行对应操作时，条件路径不存在属于正常状态。

## 3. 上传和校验

将压缩包及同名 `.sha256` 文件放在同一目录：

```bash
sha256sum --check anysentry-security-suite-0.2.0-compat8-uos20-arm64.tar.gz.sha256
tar -zxf anysentry-security-suite-0.2.0-compat8-uos20-arm64.tar.gz
cd anysentry-security-suite-0.2.0-compat8-uos20-arm64
sha256sum --check manifest.sha256
```

校验必须全部通过。

## 4. 预检、安装和升级

使用 root 权限执行预检：

```bash
./install.sh --check
```

预检通过后执行首次安装或原地升级：

```bash
./install.sh
```

安装程序保留现有配置和持久数据，依次启动 ClickHouse、Redis、API、判定 Worker 和
Observer。新版本验证失败时自动恢复上一版本。

## 5. 安装验证

```bash
/opt/anysentry/verify.sh
/opt/anysentry/RUN_HEALTH_SMOKE.sh --passive
curl -fsS http://127.0.0.1:29653/security-center/healthz
systemctl is-active anysentry-clickhouse.service
systemctl is-active anysentry-redis.service
systemctl is-active anysentry.service
systemctl is-active anysentry-fast-judge.service
systemctl is-active anysentry-l3-worker.service
systemctl is-active anysentry-observer.service
```

`verify.sh` 应全部显示 `PASS`，服务状态应全部为 `active`。执行安全模拟：

```bash
/opt/anysentry/RUN_HEALTH_SMOKE.sh --safe
```

该命令仅使用 `/tmp`、回环网络和带唯一标识的模拟事件。报告目录由脚本创建：

```text
/tmp/anysentry-health-smoke-compat8
```

## 6. 安装日志

每次执行安装程序都会覆盖本版本诊断目录：

```text
/var/log/anysentry/install/0.2.0-compat8
```

快速入口：

```text
/tmp/anysentry-install-0.2.0-compat8
```

查看结果：

```bash
cat /var/log/anysentry/install/0.2.0-compat8/summary.txt
less /var/log/anysentry/install/0.2.0-compat8/install.log
cat /var/log/anysentry/install/0.2.0-compat8/current-stage.txt
```

安装失败时，诊断目录会在自动回滚前记录服务状态、接口响应、验证输出和 journal。

## 7. 页面地址

默认地址：

```text
http://<服务器可达IP>:29653/
```

无法直达服务器网段时，可使用同网段浏览器，或将本地端口转发至服务器
`127.0.0.1:29653` 后访问 `http://127.0.0.1:29653/`。ClickHouse 8123 端口仅供本机使用。
