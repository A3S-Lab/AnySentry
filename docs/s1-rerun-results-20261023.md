# S1 异任务并发复测结果

日期：2026-10-23。结论：**三个任务全部评分通过；本轮 AgentSight 的 exec、exit 记录均更多，AnySentry 的部分真实任务 exec 未在统计范围内找到。** 记录数量仍不等于覆盖率。

## 实验设置

Harbor 同时启动三个独立容器，分别运行 Terminal-Bench 2.1 的 `fix-git`、`db-wal-recovery`、`polyglot-c-py`。Kimi Code 2.2.0，模型配置 `kimi-code/k3-256k`，AgentSight 1.0.34；两系统观测同一次执行。三个实例于 16:56:26 放行，执行时间重叠。

沿用现有采集配置，没有修改算法或重启 Observer。任务各分配 1 CPU / 2 GiB，AgentSight recorder 各 2 CPU / 2 GiB，Observer 为共享部署；资源并非等额控制。

## 核心结果

表内顺序均为 **AnySentry / AgentSight**。

| 任务 | 上轮 exec | 本轮 exec | 上轮 exit | 本轮 exit | 本轮评分 | Agent 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fix-git | 29 / 36 | 38 / 40 | 14 / 30 | 25 / 34 | 1.0 | 135.5 秒 |
| db-wal-recovery | 21 / 30 | 33 / 37 | 7 / 22 | 25 / 36 | 1.0 | 124.9 秒 |
| polyglot-c-py | 397 / 240 | 52 / 62 | 112 / 218 | 22 / 60 | 1.0 | 367.6 秒 |
| **合计** | **447 / 306** | **123 / 139** | **133 / 270** | **72 / 130** | **3/3 通过** | — |

**AgentSight 每题包含两条启动门控 `sleep 1` exec，共 6 条。** 单独排除这些已识别的准备行为后，本轮 exec 为 **123 / 133**。该调整仅针对 exec，不代表所有准备进程或辅助行为已清理。

## 关键行为复核

以下只统计实际程序 exec，Bash 参数中出现命令文本不算执行该程序。

| 任务及证据点 | AnySentry | AgentSight | 判断 |
| --- | ---: | ---: | --- |
| fix-git：`git reflog -30` | 1 | 1 | 双方均记录；上轮 AnySentry 未找到该实际 exec |
| db-wal：备份数据库和 WAL 的 `cp` | 2 | 2 | 双方均记录；本轮备份后缀为 `.bak` |
| polyglot：`gcc` 编译 | 2 | 3 | AgentSight 多记录第三次编译的 gcc |
| polyglot：带参数的 `cmain` 执行 | 13 | 17 | AgentSight 多记录部分测试执行 |

第三次编译的 gcc PID 为 `3715796`，cc1 为 `3715797`，as 为 `3715798`，collect2 为 `3715799`，ld 为 `3715800`：AgentSight 均有对应 exec，AnySentry 在当前任务统计范围未找到。这些属于任务编译链，**不能解释为 Harbor 噪音**。具体断点位于探针、输出、转发、存储还是筛选，尚需排查。

本轮只有两次成功编译被双方共同记录，第三次仅 AgentSight 记录；程序测试、安装尝试也与上轮不同。因此，上轮 polyglot 的 397 / 240 不能作为固定事件总数或稳定优势复用。

## 可信边界与运行状态

- 统计窗口：每个 Harbor Agent 执行开始前 5 秒至结束后 10 秒；以目标 Kimi PID 为根，结合双方 exec 的父子边闭包取子孙范围。AnySentry 按事件 ID 合并版本，exec 仅计 `exec_confirmed=true`。包含 Hook、启动准备及后台行为。
- 这是原始进程范围记录数，不是 Session 归属率或工具绑定准确率。没有独立内核真值，也没有完成全量跨系统事件匹配、进程代际复核；差异不能直接换算漏采率。
- 21 次健康采样中，运行期三个 recorder 的 agentsight、process、sslsniff、stdiocap 均存活，未见 OOM；保存的 recorder 日志没有报错。结束后仅停止本轮创建的三个 recorder。
- **本轮发现 Observer 的 provider hosts 仅含 chatgpt.com、api.openai.com，未包含 api.kimi.com。** AnySentry 未取得本轮 Kimi 模型交互记录；AgentSight 保存 7、7、11 条带请求和响应体的模型记录，与原生请求数相符。为保持复测条件未中途改配置。本轮不能用于证明 AnySentry Kimi TLS 链路正常。
- 原生 wire 和官方 reward 只证明应用轨迹与评分结果，不证明完整内核事件集合。

## 下一步

优先沿第三次 gcc 编译链逐层核对 Observer 原始输出、forwarder 与 ClickHouse，定位 AnySentry exec 差异；对 exit 做相同 PID、同时间窗的逐条复核。另行修复 Kimi provider 配置并独立验收 TLS，避免与本轮内核统计混为一谈。

## 工件

- [逐任务统计](experiments/20261023-s1-rerun/kernel-summary.json)
- [运行清单及版本摘要](experiments/20261023-s1-rerun/manifest.json)
- [本机统计脚本](experiments/20261023-s1-rerun/summarize.py)
- 原始复测目录：`/home/zhongyule/code/terminal-bench/eval/s1-rerun-20261023-165554/`，含任务事件、健康采样、采集器日志。
- Harbor job / AgentSight recording 名称均为 `kimi-s1r2-<任务>-20261023-165554`，分别位于 `.harbor-jobs` 与 `.local/harbor-recordings`。
