# Kimi Code 内核证据链修复与验收（2026-10-12）

本轮目标：为后续评测补齐 Kimi Code 的进程、文件行为与 Session 归属。没有运行正式 Terminal-Bench 任务、评分器或 AgentSight 对照。

## Harbor 与探针的关系

本地 Harbor 调度 Docker 容器时，Agent 行为仍发生在宿主机内核，宿主机 Observer 可以观测，无需为 Harbor 重写内核探针。
需要对接的是容器 PID/命名空间、任务身份和 Session 文件路径。若 Agent 在远程机器或独立 VM 内执行，探针必须部署在实际执行机器/内核。
本轮容器验证直接运行真实 Kimi CLI，共享其 Session 目录；证明容器观测和关联可行，但不等于 Harbor 临时记录/归档合并已验收。

## 修复内容

1. API 内置签名与 Forwarder 默认签名增加新版 `kimi-code` 的 comm、exe basename、argv0；Python 启动器兼容同名入口。普通 Node 参数中提到 Kimi 不构成身份依据。
2. 本机启用 `A3S_OBSERVER_FILE_ACCESS=1`、`A3S_OBSERVER_FILE_DELETE=1`。当前 Collector 仍为 `process-birth-v2-0909`，未修改 Rust/eBPF 程序。
3. 修复 Kimi 目录的配置配对：容器根目录与宿主根目录按位置对应。多个容器路径指向同一宿主目录时，不得对宿主路径单独去重。此前第 4 个容器根没有对应宿主根，导致文件已落库但 Session 查询不到。
4. Session 证据投影用 FileDelete 原始 `attributes.path` 展示删除路径，兼容历史 subject 为 `FileDelete` 的事实；不改写历史事件、归属或 ID。
5. Kimi Bash 的 `cd '工作目录' && 原命令` 包装纳入候选匹配。必须核对完整内核脚本哈希；允许展示文本独立截短，不允许用不完整 argv 生成的哈希匹配。不提升为可信调用绑定。
6. Forwarder 在处理 ProcessExit、清除进程缓存前，保留已观测到的代际/命名空间；检查缓存代际和 cgroup，不从通用 startTime 猜测时钟单位。修复已测试 PID 复用、不同 cgroup 的拒绝边界。
7. 已证明 Session 根代际的 DIRECT ProcessExit 可使详情显示 exited，不再要求此前一定抓到活跃 FD。

Observer 白名单为 `kimi-cli,kimi code,kimi code cli,opencode,claude code`；Codex 继续不转发。Collector 仍可能附着 Codex 探针，转发范围与底层附着范围不同。

## 最终真实验收

使用实际 Kimi Code CLI 2.1.0、配置模型 `kimi-code/k3-256k`，两次均真实执行 Bash，创建测试文件并删除另一个测试文件。独立检查文件内容和删除后的状态，未注入模拟事件。

| 样本 | recordId | 原生工具调用 | 返回系统证据 | 归属 | 调用候选 / 可信确认 |
| --- | --- | --- | --- | --- | --- |
| 宿主机 | `60f7acef9c09991c7aa5ed56` | 1 | 133 | DIRECT 117 / LINEAGE 16；歧义 0、冲突 0、未归属 0 | 6 / 0 |
| Docker 容器 | `714b02ca577c1ff9f890aed9` | 1 | 135 | DIRECT 125 / LINEAGE 10；歧义 0、冲突 0，另有未归属计数 1 | 10 / 0 |

两条会话详情均显示 `exited / observed_exit`。宿主机绑定为 `ebpf_session_file`，容器最终绑定为 `proc_fd`。
两边均能核对 ToolExec、ProcessExit、Egress、FileAccess、FileDelete；目标文件写打开和删除路径可见，样本间未出现对方的目标文件证据。
这些事件数量包含 Kimi 自己的会话落盘等行为，**不是任务关键行为数量，也不是覆盖率**。`complete_as_observed` 只表示已观测事实的当前查询完整，不证明捕获全部真实行为。
容器未归属计数 1 保留，不将其强制绑定或写成全场景零误差。

最终明细与报告：`/tmp/anysentry-kimi-p2-20261012/acceptance-report.json`、`host-acceptance-detail.json`、`container-acceptance-detail.json`。
真实测试脚本为同目录 `live-probe.py`、`container-probe.py`；测试 workspace 在 `../anysentry-e2e-work/kimi-p2-20261012/`，原生 Session 在用户 Kimi 目录。

调试中曾发生 Forwarder 对 const 行变量赋值而退出，已改为可更新变量并增加真实 Forwarder 子进程回归。中断期间的记录 `43f31d03b87f86ea966ca251` 不作为成功验收，未补造缺失事件。早期缺失身份的历史 ProcessExit 不自动变为可信事实。

## 验证与部署

- API 构建、进程签名、Forwarder 归因、统一规则核心、工具证据、tail/resume、Kimi 解析、归属合并、持久队列回归通过。
- 新增 `scripts/verify-forwarder-exit-context.mjs`：启动真实 Forwarder 子进程，验证退出记录可到达 API 通道且保留缓存代际，不发生运行时崩溃。
- `verify-session-event-attribution.mjs` 功能断言执行通过，包括新增历史删除路径断言；完整脚本仍失败于既有前端文案断言 `/不代表已归因到具体 Turn、Tool Call 或用户指令/`。没有删除该断言或改前端掩盖失败，不能称全套测试通过。
- 当前 API：`anysentry-api:kimi-observer-evidence-v3-20261012`，基于实际运行的 `wire15-semantics-v7-20261010`，仅替换 filter-rule-builtins、session-event-attribution.service、local-record-tracking.service、local-tool-evidence 四个编译模块及 map。部署前逐模块 diff 核对，保留 P1a/P1b/P3。
- 立即回滚容器：`anysentry-anysentry-1-before-kimi-observer-signatures-1791786661693`。它恢复上一 API 镜像/配置，不自动回滚共享挂载的 Forwarder 脚本。
- 窄镜像构建和配置保持脚本：`/tmp/anysentry-kimi-p2-20261012/Dockerfile`、`deploy-api.mjs`。保留所有原有环境、挂载、网络与密钥；运行环境另修正 Kimi 宿主路径数组。
- Observer 已恢复运行，日志为 `file_access=true / file_delete=true / probes attached; streaming`；API/ClickHouse 健康。本轮未启动 AgentSight、Langfuse、Flink，也未提交或清理原脏工作区。

## 仍未完成

- **Kimi 模型 TLS 请求/响应明文**：新版原生程序静态链接 TLS，不能沿用早期 Python 动态 libssl 假设。已核查到 SSL_write/read 符号，但尚未实现并验收其独立运行时明文通道；不能用本地 Wire 内容代替网络观测。
- **只读文件访问**：当前部署仍为 legacy 捕获模式，FileAccess 主要覆盖写打开；启用写打开/删除不代表捕获了全部读取或每次实际 read/write 系统调用。
- **本地模型步骤 Trace 投影**：`llm.request` 尚未作为原生 MODEL 行完整展示。
- **调用级可信绑定**：6/10 条为候选，确认均为 0。
- **正式 Harbor / Terminal-Bench 验收**：需要选定实际 Kimi 启动方式，检查容器 Session 可读、任务归属和归档连续性，再运行评分。此次 Docker 测试没有 verifier、Reward 或全量评测结果。
