# AnySentry UOS 0.2.0 compat8 设计

## 目标

生成可直接部署到 UOS Server 20 ARM64 环境的
`anysentry-security-suite-0.2.0-compat8-uos20-arm64.tar.gz`。安装器同时支持首次安装和原地升级，
失败时保留新版本现场并自动恢复上一版本。

## 配置修复

安装器在写入或复用 `/etc/anysentry/anysentry.env` 时执行规范化：

- 同一配置键只保留最后一个有效值；
- 拒绝 `KEY=KEY=value` 形式的嵌套赋值；
- 自动修复已知的 `A3S_OBSERVER_COLLECTOR_ID=A3S_OBSERVER_COLLECTOR_ID=...`；
- 校验 Collector ID 不含 `=`、空白或控制字符；
- 保留已有密钥和环境配置，新增模板键使用默认值。

运行验证不再通过动态 JavaScript 表达式解析 Collector JSON，而是将 Collector ID 作为独立参数传给
固定解析器。验证条件保持为 `state=healthy`、`attachedProbes>=8`、
`outputDropped=0`、`errorCount=0`。

## 安装日志

每次执行 `install.sh` 或 `install.sh --check` 均使用固定 compat 目录：

- 持久目录：`/var/log/anysentry/install/0.2.0-compat8`
- 临时入口：`/tmp/anysentry-install-0.2.0-compat8`

新的执行覆盖该 compat 目录中的旧记录，不附加时间。安装器记录安装输出、阶段、主机上下文、预检、
配置检查、服务状态、HTTP 健康响应和所有 AnySentry systemd journal。激活失败时先采集失败版本现场，
再回滚，最后记录回滚状态。终端始终输出日志目录和摘要文件路径。

## 资源配置

目标主机约有 64 GiB 内存。systemd 单元持久采用以下配置：

- API：Node 堆 4 GiB，`MemoryHigh=6G`、`MemoryMax=8G`；
- Fast Judge：Node 堆 2 GiB，`MemoryHigh=3G`、`MemoryMax=4G`；
- L3 Worker：Node 堆 4 GiB，`MemoryHigh=6G`、`MemoryMax=8G`；
- Observer forwarder：Node 堆 1 GiB，`MemoryHigh=2G`、`MemoryMax=3G`；
- ClickHouse：`MemoryHigh=32G`、`MemoryMax=40G`；
- Redis：4 GiB数据上限，`MemoryHigh=5G`、`MemoryMax=6G`；
- Observer 保留 `LimitMEMLOCK=infinity`，高并发服务设置明确的 `LimitNOFILE`。

正式安装写入 `/etc/sysctl.d/90-anysentry.conf`，持久设置 `vm.overcommit_memory=1` 并立即应用。
`--check` 只验证，不修改 sysctl。Redis 在该 UOS 内核上继续禁用 RDB 和 AOF，避免已确认的
ARM64 COW 内核缺陷。

## 发布文档

发布包根目录包含：

- `AnySentry部署手册.md`：上传、校验、预检、首次安装、升级、验证、日志和故障定位；
- `AnySentry使用手册.md`：监控页面地址、网络访问方式、Agent 监控原理和日常状态检查。

文档使用简洁、正式的中文表述，不包含内部开发流程。

## 验证与交付

发布前执行 UOS 通道全部合同测试、Shell 语法检查、发布目录校验、ELF/ABI 校验和完整归档校验。
最终交付 tar.gz、同名 SHA-256 文件以及可追溯的 `VERSION` 和 `PROVENANCE`。
