# Harbor 实时 Session 与短命进程 argv 修复（2026-09-13）

## 本轮结论

源码修复与多轮隔离回归通过；不是生产部署或真实 Terminal-Bench 端到端验收。
正式 `anysentry-observer-1` 仍停止，仍使用旧包装镜像；本轮没有替换 API 容器、重算历史、清库或调用模型。
不得把这里的合成测试成功率描述为历史 Shell 精确匹配率已经从 22.2% 恢复到 100%。

## 修改

### Observer

基于第一阶段 host TGID / real_parent / birth 修复，补充成功 exec 时的 argv 恢复：

- syscall-entry 参数读取不完整/截断时，从 `sched_process_exec` 阶段读取新地址空间的
  `mm.arg_start..arg_end`，使用有界分块采集；正常完整 syscall-entry 快照不重复读取。
- 所需 task/mm 偏移来自运行中内核 BTF，支持 mm_struct 匿名成员；字段缺失/越界显式失败。
- 新增 `EXEC_RECORD_RECOVER`，仅在同一 exec 身份下替换失败的参数快照。
- 恢复片段与 COMMIT 使用相同采集时间，避免管线按时间排序后 COMMIT 先于恢复片段，
  造成一次 exec 被拆成两条不完整事件。
- 保留采集决策/cgroup/birth 冲突标志；恢复 END 丢失、数据不完整仍报告 incomplete，不能掩盖丢失。
- Kernel 与 Collector 须成套部署；虽结构 ABI 未变，旧 Collector 不理解新增记录类型。

涉及 `../Observer-main-runtime-payload/a3s-observer-{ebpf,common,collector}/src`，
以及 `scripts/verify-process-ancestry.py`。

### Harbor

- 新增 `../terminal-bench/scripts/harbor_live_codex.py`，使用已验证的 Harbor 0.22.0 自定义 Codex adapter。
- 将临时 CODEX_HOME 下的 **sessions 子目录**链接到已有每 Trial `/logs/agent/sessions` 挂载。
  因而宿主机 `.harbor-jobs/job/trial/agent/sessions` 在任务运行期间就是同一份文件，不再只等结束复制。
- auth/config 仍位于原来的临时目录，不共享整个 CODEX_HOME，不修改模型、认证和工具调用参数。
- 接管上游结束时 `rm + cp` 的 Session 归档命令，避免删除正在共享的文件；失败准备阶段也禁止执行该删除。
- 保留上游恢复/清理流程，验证恢复记录迁移、重复初始化、错误软链接拒绝和退出后文件保留。
- `scripts/run-codex-chatgpt.sh` 改用 `scripts.harbor_live_codex:LiveCodex` 并设置模块搜索路径。
  直接使用 `harbor run --agent codex` 不会启用此适配器。Harbor 升级需重新验证命令契约。

### AnySentry

- Harbor 记录发现时保存设备号/inode；`local-record-tracking.service.ts` 用它识别不同 mount 路径下的同一个 Session。
- 只有目标进程的可写 FD 才可提供所有权证据；保留 FD 重读、文件身份复核、进程启动时间及 exec 变化检查。
- 不同 Trial 同名文件不能匹配；inode 别名有歧义、文件被替换、只读 FD 均拒绝。
- 已知 Harbor inode 匹配失败时禁止降级为路径匹配。
- 复用现有列表触发的后台精确绑定/证据持久化调度，没有另建全局扫描器或改 UI/ToolExec 语义。

## 测试结果

- Rust：28 库测试 + 7 workload 测试 + 129 Collector 测试 + 7 common 测试 = **171 项通过**。
- 真实内核三轮（两轮本地 release、一轮新镜像）：每轮 host + 两个独立 PID namespace 并行。
  每轮 **108/108** 直接短命 exec 的 host 父进程/出生/退出匹配，**36/36** 嵌套 root→shell→printf 链正确，
  **3/3** CLONE_PARENT 使用实际父进程且 argv 完整、COMMIT 已确认，无重复恢复事件。
- AnySentry API 构建通过；`verify-session-event-attribution`、`verify-harbor-parent-tgid`、
  `verify-harbor-process-key`、`verify-harbor-record-discovery`、`verify-local-record-tracking` 全部通过。
- `verify-session-fd-ownership` 16 项通过；新 `verify-harbor-live-fd` 三轮通过，包含只读、同名不同 inode、
  歧义别名、文件替换及禁止路径回退。
- `verify-harbor-live-docker` 三轮最终回归通过：两个真实独立容器同时写入，各自文件实时发现、可写 FD 精确绑定、
  列表显示运行中、触发两次各自绑定调用，容器退出后归档仍存在。
  此测试的归因存储服务为 mock，**验证调用持久化路径，不证明生产数据库已写入关系**。
- `verify-harbor-live-codex.py`：三轮文件系统回归通过；执行实际已安装 Harbor 的 Codex.run 方法并 mock I/O，
  验证首次/恢复命令生成、原始调用参数保留、结束删除被抑制、准备失败保护；不加载账号或调用模型。
- Shell 语法、三个工作树的 `git diff --check` 通过。

测试开发时曾遇到 Node Debian 镜像 glibc 低于本地原生库要求；真实 Docker 测试改用 Ubuntu 24.04 + 本机 Node 只读挂载。
测试产生的临时容器和合成 Session 目录已清理，不涉及用户任务或数据。构建仍有既有 LLVM/unsafe 警告，退出码为 0。

## 产物与复测命令

新 Collector 镜像：`a3s-observer:host-tgid-argv-20260913`。
配置摘要：`sha256:228e36f49171766204be0e408b4126790e06e49df260b0944a82dd69f07aa98f`。
没有替换旧镜像标签；尚未生成新的生产包装镜像/API 镜像。

```bash
cd /home/zhongyule/code/Observer-main-runtime-payload
cargo test -p a3s-observer-common -p a3s-observer-collector -p a3s-observer --quiet
OBSERVER_TEST_COLLECTOR_IMAGE=a3s-observer:host-tgid-argv-20260913 python3 -u scripts/verify-process-ancestry.py

cd /home/zhongyule/code/terminal-bench
.venv-harbor/bin/python scripts/verify-harbor-live-codex.py

cd /home/zhongyule/code/AnySentry
pnpm build:api
node scripts/verify-harbor-live-fd.mjs
node scripts/verify-harbor-live-docker.mjs
node scripts/verify-session-event-attribution.mjs
```

## 仍需验收

1. 构建/灰度部署包含新 Collector 的包装镜像，以及包含 inode 修复的 API；旧容器 `docker start` 不会载入新代码。
2. 新 Harbor 启动脚本已接入 adapter，但 API 必须具有对应 `.harbor-jobs` 只读挂载和宿主机 `/proc` 读取权限。
3. 当前后台绑定调度由记录列表请求触发；需要任务运行期持续刷新/轮询列表。尚未新增不依赖页面请求的独立调度，
   极短任务、FD 尚未打开/已关闭、错过扫描的任务仍有漏绑定风险。
4. 用真实短 Harbor 任务检验 Session 写入→生命周期入库→关系持久化→容器退出后恢复，再做两个并行任务。
   mock 和合成核验不能替代真实模型/数据库/页面全链路。
5. 新任务须分别统计 Native Shell 调用数、内核 exec 数、Session DIRECT/LINEAGE 数、精确 Tool Call 匹配数和 loss；
   不得把这四种计数等同。历史损失不能靠推测补齐。
6. runtime TLS 截断、采集背压和所有平台/内核适配仍需独立验证。本轮只验证本机 Linux/x86_64。

## 工作树

AnySentry `feat/flink-osv-risk-streaming` / `e9eea63`，Observer 目标工作树
`integration/observer-main-runtime-payload` / `c1d7eff`，terminal-bench `main`。
均保留原有未提交修改；本轮未提交。AnySentry 新旧混合改动共 152 条 status 条目（写报告前），
其中本轮新增脚本及 LocalRecord 文件为未跟踪状态；不要把其他既有修改算成本轮改动。
