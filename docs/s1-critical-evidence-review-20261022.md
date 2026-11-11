# S1 关键内核事件证据复核

日期：2026-10-22。对象：2026-10-19 S1 的 fix-git、db-wal-recovery、polyglot-c-py。

## 一、结论

**已对 20 条推测命题逐项检查历史原始记录。** fix-git 和 db-wal 的部分关键执行/文件访问证据以 AgentSight 更丰富；polyglot 的最终 Python/C 测试执行记录以 AnySentry 更完整。不能用总事件数直接替代关键行为覆盖情况。

本次是**历史证据匹配**，未重新执行任务、未启动独立核验探针。状态为“找到支撑片段、未找到匹配记录、现有字段不足”，不把任何完整命题判为独立 ground truth 确认通过。

## 二、怎么核对

- 命题输入：[S1 关键内核事件推测](s1-critical-kernel-event-claims-20261022.md)，6＋6＋8，共 20 条。
- 原始数据：AnySentry ClickHouse `events`，AgentSight 各轮 `record.db.audit_events`，不使用页面汇总数。
- 范围：沿用已归档的 S1 Harbor 执行窗口（前 5 秒、后 10 秒）和双方 exec PID/PPID 后代闭包。
- 匹配程序实际执行时，只检查**已成功 exec 的目标程序**，不把 Bash 参数中的 `cp`、`git reflog` 或 `python3` 字符串当作该程序已执行。
- 命令取 AnySentry `attributes.argv`、AgentSight `details.full_command`，不以界面是否展示参数判断采集能力。长参数被截断可能导致无法识别子步骤，不自动判漏采。
- 文件只核对目标路径及可读/可写打开标记。打开、读取字节、写入字节、rename 和最终内容，是不同证据层级。
- 每条同时保留“整个任务范围内找到”与“引用工具调用候选时窗内找到”。候选时窗为调用到返回、前后放宽 5 秒；后台安装包含 WaitFor 区间。窗口可能重叠，未逐事件校准时钟，所以不构成确定级工具绑定。
- 按既有 20 条命题提取 41 个可匹配检查项，另有 3 个因字段不足未评分的检查项。相同文件/事件可支撑不同命题，**这些检查项不是独立事件样本，也不汇总成准确率排名**。

## 三、关键差异

下表为各任务范围内找到的匹配记录数；0 表示当前限定记录中未找到，不能直接解释为行为未发生。

| 任务 | 关键证据 | AnySentry | AgentSight | 解释 |
| --- | --- | ---: | ---: | --- |
| fix-git | `git reflog` 实际 exec | 0 | 1 | AnySentry 有外层 Bash 命令，但未找到内层 git reflog 执行记录 |
| fix-git | `.git/MERGE_HEAD` 可写打开 | 0 | 已找到 | AgentSight 更完整地保留了合并状态文件访问 |
| fix-git | Git 对象目录可写打开 | 0 | 已找到 | 两边都有 add/commit 执行，文件层证据不同 |
| db-wal | 两次备份 cp 实际 exec | 0 | 2 | AnySentry 有包含 cp 的 Bash 参数，不能替代 cp 本体 exec |
| db-wal | 两个 `.orig` 备份可写打开 | 0 | 各 1 条 | AgentSight 保留备份目标访问 |
| db-wal | 解码写回的 Python 实际 exec | 0 | 1 | 不包括其他 WAL 分析 Python，也不把外层 Bash 误算进去 |
| db-wal | `recovered.json` 可写打开 | 0 | 1 | 两边都有导出 Python 执行，AnySentry 未找到目标文件访问 |
| polyglot | gcc 实际 exec | 3 | 3 | 编译程序执行一致 |
| polyglot | `cmain` 可写打开 | 0 | 1 | 编译产物的文件层证据以 AgentSight 更丰富 |
| polyglot | `python3 main.py.c N` 实际 exec | 10 | 0 | 最终 Python 测试循环以 AnySentry 更完整 |
| polyglot | `cmain N` 实际 exec | 13 | 3 | AnySentry 含前段 3 次＋最终 10 次，AgentSight 仅找到前段 3 次 |

因此，原评测“polyglot 的 exec 总数 AnySentry 更多”得到具体测试进程记录的支撑；但其中大量安装进程不能自动算作任务关键证据。fix-git/db-wal 则暴露了 AnySentry 的部分关键记录缺口。

## 四、20 条命题逐项结果

这里的结果均为支撑片段，不代表整条命题核验通过。

| 命题 | AnySentry | AgentSight |
| --- | --- | --- |
| fix-K1：读取 reflog | 有外层 Bash；未匹配内层 reflog exec 或读取打开 | 有 reflog exec；未匹配读取打开 |
| fix-K2：合并冲突 | 有 merge exec、任务范围内 about.md 可写打开；MERGE_HEAD 未匹配 | 有 merge exec、about.md 与 MERGE_HEAD 可写打开 |
| fix-K3：Read 冲突文件 | 未找到目标读取打开 | 未找到目标读取打开 |
| fix-K4：Edit 修复文件 | 有 about.md 可写打开；缺实际写入/替换及内容验证 | 同左 |
| fix-K5：暂存与提交 | 有 add/commit、index 和 master 锁文件访问；对象写打开未匹配 | 有上述执行及索引、对象、引用文件访问 |
| fix-K6：回读检查 | 有 grep exec；目标读取未匹配 | 未匹配 grep exec 或目标读取 |
| wal-K1：读 WAL 分析 | 有分析 Python exec；xxd exec 与读取打开未匹配 | 有 xxd、分析 Python；任务范围内有 WAL 可读写打开，不能据此归给分析调用 |
| wal-K2：备份 | 未匹配 cp 本体或备份文件打开 | 两个 cp exec 和两个备份目标可写打开 |
| wal-K3：解码写回 | 有任务范围内 WAL 可写打开，但候选调用窗内未找到；解码 Python 未匹配 | 有解码 Python 与 WAL 可写打开；备份读取未匹配 |
| wal-K4：SQLite 查询 | 有 sqlite3 exec；主库读取打开未匹配 | 有 sqlite3 exec、主库可读写打开；仍缺读取结果的独立证明 |
| wal-K5：导出 JSON | 有导出 Python；目标 JSON 打开未匹配 | 有导出 Python、主库可读写打开及 JSON 可写打开；缺实际写入/回读证明 |
| wal-K6：再次验证 | 有校验 Python；JSON 读取未匹配 | 同左 |
| poly-K1：生成源文件 | 有 main.py.c 可写打开；缺内容与修改链核验 | 同左 |
| poly-K2：编译 | 有 3 次 gcc exec；源文件读取、cmain 可写打开未匹配 | 有 3 次 gcc exec、cmain 可写打开；源文件读取未匹配 |
| poly-K3：Python 查找失败 | 字段不足，无法区分查找与失败 exec 路径 | 同左 |
| poly-K4：后台安装 | 有 apt-get、dpkg 和包管理目录可写打开 | 同左 |
| poly-K5：条件网络访问 | 未进行 apt 进程家族的逐连接核验，不用连接总数代替 | 同左 |
| poly-K6：Python 测试 | 有最终 10 次脚本执行；源文件读取未匹配 | 未找到这 10 次脚本执行或源文件读取 |
| poly-K7：C 程序测试 | 有 13 次执行；未完成每次输出、退出、因果核验 | 有前段 3 次执行；同样未完成全链核验 |
| poly-K8：stdout 管道比较 | 现有字段缺完整 pipe/dup/write 数据流，无法判断 | 同左 |

### 支撑检查项统计

| 任务 | 可匹配检查项 | AnySentry：任务范围 / 候选调用窗 | AgentSight：任务范围 / 候选调用窗 |
| --- | ---: | ---: | ---: |
| fix-git | 14 | 8 / 7 | 10 / 10 |
| db-wal-recovery | 17 | 5 / 4 | 14 / 13 |
| polyglot-c-py | 10 | 7 / 7 | 7 / 7 |

上表只是检查项支持数量。polyglot 同为 7 项并不表示表现相同：AgentSight 多的是编译产物文件访问，AnySentry 多的是最终 Python 执行。窗口差异也可能来自文件聚合、时钟或接收延迟，不能把窗外记录直接当作错误归因。

## 五、对已有评测结论的修正

1. **支持分场景比较，不支持整体胜负。** S1 的关键证据存在双方互补，不能只看 exec/file 总量。
2. **文件读取是共同证据缺口。** 当前记录不足以证明 Read、WAL 分析、脚本加载的完整读取行为；只读事件未被记录与实际未读取应分开。
3. **文件写入不应仅凭 open 判通过。** 后续要补写入返回值、替换链和内容断言。
4. **工具确认仍未完成。** 在相同任务和候选时间窗内匹配，不等于确定该 call 导致该事件。
5. **下一步做独立重跑核验。** 优先 fix-git 的 Edit/提交、db-wal 的备份/解码/JSON、polyglot 的最终测试与后台安装；以独立探针和终态检查补齐真值。

## 六、工件

- [results.json](experiments/20261022-s1-verification/results.json)：20 条命题的匹配规则、任务/候选时窗计数、样本事件 ID、PID 与时间。
- [collect-readonly.py](experiments/20261022-s1-verification/collect-readonly.py)：读取历史 ClickHouse/SQLite，在本机 `/tmp/s1-critical-review-20261022` 生成工作快照。
- [evaluate.py](experiments/20261022-s1-verification/evaluate.py)：对工作快照执行规则；重跑会更新结果 JSON，应先另行保存原结果。

本机复查：

```bash
cd /home/zhongyule/code/AnySentry
python3 docs/experiments/20261022-s1-verification/collect-readonly.py
python3 docs/experiments/20261022-s1-verification/evaluate.py
```

仅需历史数据库及 Docker 可用，不启动模型、任务或新探针。完整原始记录留在现有库中，报告附件只输出所需证据标识和截断命令/路径，不打包凭据和模型明文。
