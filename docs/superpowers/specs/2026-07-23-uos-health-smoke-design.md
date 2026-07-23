# UOS 健康与模拟检测脚本设计

## 目标

提供单文件 `RUN_HEALTH_SMOKE.sh`，用于已经安装的 AnySentry UOS
服务器上执行全面健康检查，并通过安全、可追踪的模拟事件验证采集、接入、判定和存储链路。

## 执行模式

- `--passive`：只读取版本、服务、端口、API、Source、Collector 和近期日志状态。
- `--safe`：默认模式；在被动检查基础上执行 `/tmp` 文件操作、进程执行、本地回环网络
  操作和一条带唯一标识的 Sentry 模拟事件。
- `--extended`：在安全模式基础上增加多种 Sentry 事件和较长的事件增长观察；不执行
  `setuid`、`ptrace`、外网访问或破坏性操作。

## 安全边界

脚本只写入 `/tmp/anysentry-health-smoke-compat8` 及其临时子目录。网络模拟仅访问
`127.0.0.1`。API 模拟使用自定义测试 Source，不读取或输出 Observer Token。每个模拟
事件包含唯一 `agentId`、`sessionId` 和标记，便于在页面中识别。

## 检查结果

检查项输出 `PASS`、`WARN` 或 `FAIL`。关键服务、数据库、API、Source、Collector、
Sentry 判定或模拟事件落库失败时返回非零退出码；L2/L3 未启用、近期存在历史错误日志等
非阻断情况返回 `WARN`。完整报告覆盖保存到
`/tmp/anysentry-health-smoke-compat8/report.txt`。

## 发布方式

脚本加入 `uos20-arm64/package/` 和后续发布包组装流程。为已部署 compat8 单独复制一份
到 `security/release/RUN_HEALTH_SMOKE-compat8.sh`，不修改原 compat8 压缩包及其校验值。
