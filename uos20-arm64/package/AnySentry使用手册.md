# AnySentry 使用手册

## 1. 访问监控页面

AnySentry 默认监控页面为：

```text
http://<服务器IP>:29653/
```

如果办公终端不能直接访问服务器网段，应在客户提供的内置浏览器中打开该地址。通过跳板机或
Xshell 访问时，也可以将本地端口转发到目标服务器的 `127.0.0.1:29653`，然后打开：

```text
http://127.0.0.1:29653/
```

## 2. Agent 监控方式

AnySentry Observer 在服务器内核侧采集进程执行、进程退出、文件访问、网络连接和安全操作事件。
Observer 根据进程关系识别 Agent 及其子进程，将有效事件发送至 AnySentry API。API 对事件执行
L1、L2 和 L3 判定，并将事件、风险和判定结果保存到 ClickHouse。

页面中的主要对象如下：

- `Source`：目标服务器上的受保护事件来源；
- `Collector`：运行中的 Observer 采集器；
- `Agent`：被识别和持续观测的 Agent 进程；
- `Session`：Agent 在一个活动周期内产生的关联事件；
- `Event`：进程、文件、网络、工具调用及安全操作记录。

## 3. 正常状态

Source 状态应为 `Active`，`acceptedEvents` 应持续增加，`rejectedEvents` 不应增加。
Collector 状态应为 `健康`，并满足：

```text
attachedProbes=8
outputDropped=0
errorCount=0
```

查看 API 健康状态：

```bash
curl -fsS http://127.0.0.1:29653/security-center/healthz
```

查看 Observer 运行状态：

```bash
systemctl status anysentry-observer.service --no-pager -l
journalctl -b -u anysentry-observer.service -n 200 --no-pager -o cat
```

## 4. 注意事项

- 页面显示的事件总数可能是内存热窗口统计，不代表 ClickHouse 中的全部历史数据；
- Observer、API 或数据库服务异常时，应先查看部署手册中的安装日志目录；
- 不得手工删除 `/etc/anysentry/anysentry.env`、`/var/lib/anysentry` 或 Source Token；
- 配置 L2 或 L3 后，应按维护要求重启对应服务并重新执行 `/opt/anysentry/verify.sh`。

