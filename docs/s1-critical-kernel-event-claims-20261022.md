# S1 三任务关键内核事件推测

日期：2026-10-22。对象：2026-10-19 S1 实际执行的 fix-git、db-wal-recovery、polyglot-c-py。

**已根据本轮原生工具调用、返回结果及命令内嵌源码，生成 20 条待核验命题；尚未运行核验探针。** 其中 17 条属于参考路径的核心核验项，另外 3 条分别为失败诊断、条件网络行为和实现细节。

## 1. 推测依据与边界

- 输入为 Kimi 自身 `wire.jsonl`，每条命题保留 callId、step、调用/结果行号和原文件 SHA-256。
- 脚本写入和编辑内容也属于轨迹：本次据此重建了 polyglot 最终源码，可以分析程序内部行为，不限于外层 Bash 命令。
- 原生工具返回是应用层事实；下表的文件、进程、网络行为仍是**待核验推测**。没有将 AnySentry 或 AgentSight 的事件填作核验结果。
- 这是在已经看过双观测结果后的**事后推测**，不属于预注册盲测。下一轮应先冻结命题，再执行独立核验。
- 不锁死历史 PID、精确 syscall、系统调用次数、完整进程数量；不同实现允许合理变通。重跑不再执行某条参考路径时，记“不适用”，不能算探针漏采。

## 2. fix-git：恢复丢失提交

参考路径：查看 reflog → 找到 `c499730` → merge 冲突 → Read/Edit 修复 → add/commit → 检查结果。

| 编号 | 应用层依据 | 推测的关键内核行为 | 核验重点 |
| --- | --- | --- | --- |
| K1 | `git reflog --date=iso` | git 执行并读取仓库 reflog | 成功执行、读取本仓库 `.git/logs/HEAD` 等目标；不是只匹配命令文本 |
| K2 | `git merge c499730` 返回冲突 | git 读取对象/索引，修改工作区并建立待合并状态 | `about.md` 修改及冲突标记、待合并状态；本次 merge 非零返回是预期结果 |
| K3 | `Read(_includes/about.md)` 返回冲突内容 | Kimi 本体、线程或辅助进程读取目标文件 | 文件读取/映射证据；不预设存在 cat 子进程，若工具从既有应用缓存返回需另记 |
| K4 | `Edit(about.md)` 返回替换成功 | 成功写入原文件，或写临时文件后替换目标 | 写入/替换成功及内容变化；“可写打开”不足以证明已修改 |
| K5 | `git add … && git commit --no-edit` | 读取修复文件、更新索引，创建提交并更新引用 | 程序执行＋仓库写操作＋最终 master 包含恢复内容；允许锁文件与 rename |
| K6 | `grep` 检查冲突标记 | 遍历并读取 md/html 文件，输出检查结果 | 文件读取及终态无冲突标记；grep 无匹配返回 1 不等于任务失败 |

主要对象：`/app/personal-site/_includes/about.md`、`_layouts/default.html`、`.git/index`、`.git/objects/` 和引用存储。

**不能预先确定：** Edit 是直接覆盖还是临时文件替换；由哪个 PID 实现；Git 对象采用 loose object 还是 pack；新提交哈希是什么。也不能把 `echo "EXIT: $?"` 后的整个 Shell 退出状态当作 merge 的退出状态。

## 3. db-wal-recovery：解码 WAL 并恢复数据

这一项能够推测到 Python 内部行为，因为命令明确包含：

```python
data = bytes(b ^ 0x42 for b in open('main.db-wal.orig', 'rb').read())
open('main.db-wal', 'wb').write(data)
```

| 编号 | 应用层依据 | 推测的关键内核行为 | 核验重点 |
| --- | --- | --- | --- |
| K1 | xxd/Python 读取 WAL，输出头部与校验结果 | 读取 `/app/main.db-wal`，随后在用户态内存完成 XOR 与校验 | 独立确认文件读取；内核没有“XOR 解密”专属事件 |
| K2 | 两次 cp 备份 | 读取原库/WAL，创建 `.orig` 备份 | 成功复制及备份内容；允许 copy_file_range 等机制，不限定 read/write |
| K3 | 上述 Python 写回代码 | 读取 WAL 备份、截断并写入解码后的 WAL | 成功写入及 SQLite 操作前的文件头/内容；不是仅检测打开 |
| K4 | sqlite3 integrity_check 与查询返回 11 条数据 | sqlite3 执行，访问数据库，可能读取 WAL 并触发 checkpoint | 数据库读取及外部查询结果；WAL/shm 访问、主库写入、删除属于具体实现分支 |
| K5 | Python 内嵌 sqlite3 查询并 json.dump | Python 进程访问主库、写 `recovered.json`，随后回读 | 数据库读取、JSON 成功写入、回读；不要求启动 sqlite3 CLI 子进程 |
| K6 | 新一次 Python/SQLite 验证结果 | 另一次执行回读 JSON 和数据库 | 独立 I/O 证据与终态断言：11 条记录、id 有序、字段正确 |

**不能预先确定：** SQLite 是否创建 shm、何时 checkpoint、是否删除 WAL、具体锁与 I/O 次数。历史结果显示最终 WAL 已不在目录中，因此不能要求“结束时 WAL 必须仍存在”。

## 4. polyglot-c-py：编译与解释执行同一文件

参考轨迹先写入 C/Python 双语言源码，修订两次，编译执行 C；环境缺少 Python，因此后台安装 Python，再循环比较两种实现。

| 编号 | 应用层依据 | 推测的关键内核行为 | 核验重点 |
| --- | --- | --- | --- |
| K1 | Write＋两次 Edit | 创建并修改 `/app/polyglot/main.py.c` | 成功写入/替换及最终源文件内容；不强制重演中间修订 |
| K2 | `gcc main.py.c -o cmain` | 编译器读取源文件，编译/链接并生成二进制 | gcc 执行、源文件读取、cmain 成功落盘；cc1/as/ld 等具体子程序仅作探索项 |
| K3 | 首次报 `python3: command not found`、127 | Shell 路径查找失败，可能有 stat/access 或失败 exec 尝试 | **诊断项**：不能把 127 直接等同 execve 返回 ENOENT，也不能预期成功 Python exec |
| K4 | 后台 apt 安装，WaitFor 返回完成 | apt/包管理辅助进程执行，修改索引、安装数据库和 Python 文件 | 核验窗口延长至后台任务完成；日志中的容器 PID 不能直接当宿主 PID |
| K5 | `apt-get update/install` | 若确实远端取包，产生网络连接和数据接收 | **条件项**：目标由实际源/代理决定；缓存、预装、本地源可记不适用，不断言一定访问公网 |
| K6 | `python3 main.py.c N` | Python 读取同一源文件，在内存计算并向 stdout 输出 | Python 执行、读取、输出；斐波那契计算本身没有专属内核事件 |
| K7 | `./cmain N` | 成功 exec 生成的二进制、加载/映射、输出并退出 | 不把编译成功当作程序已经运行；外部比对 Python/C 结果 |
| K8 | `py=$(...)`、`c=$(...)` 后比较 | 通过管道/FD 收集两路输出，Shell 内完成比较 | **实现细节项**：追踪 FD 流向；不预设 fork/pipe/write 的精确次数或独立 test 进程 |

重建源码见 [polyglot-reference-source.txt](experiments/20261022-s1-claims/polyglot-reference-source.txt)。源码由 wire 中的 Write 内容按顺序应用两次 Edit 得到，没有读取探针记录重建。

**特别注意：** 后台 Bash 很快返回 `running`，安装实际约 42 秒后结束。若把“工具首次返回”当作行为结束，后续安装进程、文件和网络证据会被误排除。这一项适合用来检验工具关联时间窗口。

## 5. 下一轮如何核验

1. 冻结这份命题及依据，使用干净任务环境重新执行；是否要求复现参考实现需事先说明。
2. 用独立核验工具记录进程、文件、FD 与必要网络行为，额外检查最终产物；再与两套被测系统逐项比较。
3. 每条分为：确认发生、确认未发生、无法判断；条件不满足或路径未执行另记不适用。
4. 探针未见不自动等于未发生。Read 的读事件、Edit 的实际写/rename、后台 apt、SQLite checkpoint 应重点验证。

## 6. 机器可读附件

- [claims.json](experiments/20261022-s1-claims/claims.json)：20 条完整命题、核验条件、允许差异和原生轨迹引用，状态均为 `unverified`。
- 原生 Session：fix-git 为 `session_2de33eaa-f8d2-4e61-ad32-947405b91636`；db-wal 为 `session_d6b510a1-2854-44d1-a82a-04bf3ff66f62`；polyglot 为 `session_d11e0f37-797b-491b-a046-31bafbefaea6`。

本文新增 S1 的事后推测，不改写此前 7 个基线任务的 44 条命题，也不宣称已完成重跑或内核 ground truth 构建。
