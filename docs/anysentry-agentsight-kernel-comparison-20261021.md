# AnySentry 与 AgentSight 观测对照评测报告

日期：2026-10-21

## 一、评测结论

**两系统在不同场景下各有优势。** 短任务和同题并发中，AgentSight 的进程退出记录更丰富；长程并发中，AnySentry 的程序执行与退出记录明显更多。指定行为测试的目标事件采集持平，AnySentry 仍存在部分事件已采集、未完整归入 Session 的问题。

本轮结果反映指定范围内的**事件记录数量与目标证据命中情况**，不等同于全量内核覆盖率或归因准确率。

## 二、实验设置

统一使用 Harbor 调度 Kimi Code CLI，在 Docker 中执行任务，AnySentry 与 AgentSight 1.0.34 同时观测同一次运行。Kimi 模型配置为 `kimi-code/k3-256k`；AgentSight 按目标 PID 定向录制，AnySentry 自动发现会话。

| 场景 | 测试任务及内容 | 并发设置 | 任务结果 |
| --- | --- | --- | --- |
| **S1：异任务并发** | `fix-git`：找回并合并 Git 修改；`db-wal-recovery`：恢复 SQLite WAL 数据；`polyglot-c-py`：编写 C/Python 双语言程序 | 3 个容器同时运行不同任务 | 3/3 评分通过 |
| **S2：同题并发** | `fix-git` × 2，同题、同工作区路径、不同容器 | 2 个实例同时运行 | 2/2 评分通过 |
| **S3：长程并发** | `music-harmony`：乐谱和声；`shadow-relay`：网络外传取证；`legacy-utility-triage`：通过 GUI 处理计费异常 | 3 个任务运行重叠，单任务约 48–82 分钟 | 未全部通过，作为压力测试样本 |
| **T2P：工具到进程** | Kimi 执行自定义 Python 脚本，产生子孙进程、标记文件访问及 curl 连接 | 单实例、指定行为 | 核对 10 个目标事件 |

**任务来源：** S1/S2 使用本地 Terminal-Bench 2.1 的 `terminal-bench-2-1/tasks`；S3 使用本地另一任务树 `terminal-bench/tasks`，其正式数据集版本未在本轮确认；T2P 为自定义用例。S1/S2/S3 执行于 10 月 19 日，T2P 执行于 10 月 21 日。

## 三、核心结果

### 1. 程序执行与退出记录

`exec` 指内核成功加载程序执行，**不是 Agent 工具调用次数**；`exit` 指进程结束。一次工具调用可以产生多条 exec，同一进程也可以通过 exec 更换程序而保持 PID 不变。

| 场景 | 任务/实例 | 成功 exec：AnySentry / AgentSight | exit：AnySentry / AgentSight |
| --- | --- | ---: | ---: |
| S1 | fix-git | 29 / **36** | 14 / **30** |
| S1 | db-wal-recovery | 21 / **30** | 7 / **22** |
| S1 | polyglot-c-py | **397** / 240 | 112 / **218** |
| S2 | fix-git A | 32 / 32 | 16 / **25** |
| S2 | fix-git B | 38 / **40** | 15 / **27** |
| S3 | music-harmony | **85** / 27 | **61** / 18 |
| S3 | shadow-relay | **117** / 24 | **75** / 12 |
| S3 | legacy-utility-triage | **1302** / 418 | **556** / 228 |

- **S1：各有优势。** AgentSight 在 fix-git、db-wal 的记录更多；AnySentry 在 polyglot 的 exec 更多。
- **S2：exec 接近，退出记录 AgentSight 更多。** 合计 exec 为 **70 / 72**，exit 为 **31 / 52**。
- **S3：AnySentry 的进程记录更多。** 合计 exec 为 **1504 / 469**，exit 为 **692 / 258**，分别约为 AgentSight 的 **3.21 倍、2.68 倍**。该倍数是记录数量比，不是覆盖率或准确率倍数。

### 2. T2P 指定行为核验

| 指标 | AnySentry | AgentSight |
| --- | ---: | ---: |
| 目标 exec | 6/6 | 6/6 |
| 三个核心标记文件访问 | 3/3 | 3/3 |
| curl 目标连接 | 1/1 | 1/1 |
| **原始库目标事件命中** | **10/10** | **10/10** |
| 目标事件进入原生 Kimi Session | **8/10** | 本轮未提供对应原生 Session 归属 |

AnySentry 的孙进程文件访问和 curl 连接已落库，但因进程身份字段不完整，未进入对应 Session。工具关联仍为候选级，本轮为 **9 条 candidate、0 条 confirmed**；AgentSight 的工具记录关联 Kimi 本体 PID，也未证明与具体执行子进程的确定绑定。

### 3. 长程模型请求采集修复

针对 legacy 同题回归，AnySentry 请求记录与原生请求数的对账结果由 **15/188 → 43/232 → 4/144 → 162/162**，完成超限截断、分片停采问题的修复验证。

最后一轮 AnySentry 保存 **162 条请求、153 条响应**；AgentSight 保存 **159 条带响应体的记录，其中 6 条带请求体**。请求、响应和 Token 数量须分别比较，不能合并为一个采集率。该轮因 Kimi 配额 429 退出，任务评分未通过。

## 四、统计口径与可信边界

- **统计范围：** 各任务 Harbor 执行前 5 秒至结束后 10 秒，限定目标 Kimi 及其子孙进程，包含安装、Hook 和后台行为。
- **数据来源：** AnySentry ClickHouse 原始事件、AgentSight SQLite 原始事件；按各自事件标识统计。AnySentry exec 仅计 `exec_confirmed=true`。
- **参照依据：** 官方评分用于判断任务完成；Kimi 原生 wire 用于工具调用和模型记录对账。两者均不是完整内核 ground truth。
- **现有限制：** 未完成跨系统逐事件匹配、全量进程代际校验和逐事件时钟校准；文件、网络采集及聚合口径不同，不按条数排名。多轮间存在版本修复与宿主负载变化。
- **未完成项：** 44 条任务关键事件命题尚未通过独立探针核验，因此暂不发布内核漏采率、错归率或整体胜负评分。

## 五、下一步

1. 完成 44 条关键事件的独立核验，形成可计算覆盖率、错归率的参照集。
2. 对双方差异 exec/exit 逐条定位，区分采集遗漏、过滤、聚合及统计范围差异。
3. 修复短命进程身份缺失，补齐 Session 归属；增加同进程并发工具、后台任务和子代理验收。

## 附件

- [逐轮统计数据](experiments/20261021-kernel-comparison/counts.json)
- [本机只读复核脚本](experiments/20261021-kernel-comparison/recompute.py)
- [T2P 用例脚本](experiments/20261021-kernel-comparison/t2p_probe.py)

原始工件位于 `../terminal-bench/.harbor-jobs/kimi-s1-*、kimi-s2-*、kimi-s3-*` 及 `../agentsight/.local/harbor-recordings/` 对应目录。统计附件中的 `ToolExec` 包含未确认记录，正文成功 exec 使用单独的 `AnySentry_exec_confirmed["1"]` 计数。
