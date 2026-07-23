# AnySentry 使用手册

## 文档导航

- [AnySentry 部署手册](./AnySentry部署手册.md)：环境校验、安装、升级和基础排错。
- [AnySentry 使用手册](./AnySentry使用手册.md)：页面访问、监控对象和状态说明。
- [AnySentry 脚本说明](./AnySentry脚本说明.md)：发布包内各 Shell 脚本的用途和参数。

## 1. 访问监控页面

默认页面地址：

```text
http://<服务器可达IP>:29653/
```

无法直达服务器网段时，可使用同网段浏览器。具备跳转连接时，也可将本地端口转发至服务器
`127.0.0.1:29653`，然后访问：

```text
http://127.0.0.1:29653/
```

## 2. 监控范围

AnySentry Observer 在内核侧采集进程执行、进程退出、文件访问、网络连接和安全操作事件。
Observer 根据进程关系识别 Agent 及其子进程，并将有效事件发送至 AnySentry API。
API 执行 L1、L2 和 L3 判定，将事件、风险及判定结果保存到 ClickHouse。

页面主要对象：

- `Source`：受保护的事件来源；
- `Collector`：Observer 采集实例；
- `Agent`：被识别并持续观测的 Agent 进程；
- `Session`：一个活动周期内的关联事件；
- `Event`：进程、文件、网络、工具调用及安全操作记录。

## 3. 正常状态

Source 应为 `Active`，`acceptedEvents` 应持续增加，`rejectedEvents` 不应增加。
Collector 应为 `健康`，并满足：

```text
attachedProbes=8
outputDropped=0
errorCount=0
```

查看 API 健康状态：

```bash
curl -fsS http://127.0.0.1:29653/security-center/healthz
```

查看 Observer：

```bash
systemctl status anysentry-observer.service --no-pager -l
journalctl -b -u anysentry-observer.service -n 200 --no-pager -o cat
```

执行端到端安全模拟：

```bash
/opt/anysentry/RUN_HEALTH_SMOKE.sh --safe
```

脚本生成以 `a3s-health-smoke-` 开头的模拟记录，可在事件页面按该标识检索。
只读检查使用 `--passive`，多类别模拟使用 `--extended`。

## 4. L2 和 L3

L1 默认启用。L2 和 L3 的接口、模型及密钥配置保存在：

```text
/etc/anysentry/anysentry.env
```

该文件由正式安装创建，权限为 `0600`。配置变更后需重启相关服务：

```bash
systemctl restart anysentry.service
systemctl restart anysentry-fast-judge.service
systemctl restart anysentry-l3-worker.service
/opt/anysentry/verify.sh
```

健康接口中的 `policy.l2=true` 和 `policy.l3=true` 表示对应级别已启用。

## 5. 数据与配置

- `/etc/anysentry`：正式安装创建，保存配置和 Source 凭据；
- `/var/lib/anysentry`：正式安装创建，保存持久状态；
- `/var/log/anysentry`：正式安装创建，保存运行与安装日志；
- `events.total=100000`：内存热窗口统计，不是 ClickHouse 历史数据上限。

配置目录、状态目录及 Source Token 不应直接删除。清理方式见
[AnySentry 脚本说明](./AnySentry脚本说明.md)中的 `uninstall.sh`。
