# Kimi 多轮全链路监测验收（2026-09-17）

## 结论

**未达到全链路监测。** 9 轮真实 Kimi CLI 工具执行均完成，本地对话、调用、结果完整；
同进程的执行候选可展示，并发隔离通过。但跨进程恢复导致整个会话的系统证据无法展示，
另有短命进程身份分裂、工作区文件事件范围不足、模型请求明文未采集和缺少可信调用绑定。
测试执行成功不等于监测验收通过。

## 环境与方法

- 时间：2026-09-17 00:48–00:50（Asia/Shanghai），之后再次读取 API 并核查浏览器。
- 原版 Kimi CLI 1.50.0，以 `--wire` 在同一进程中接收连续提示；关闭后以同一 Session
  重启，随后并发启动两个不同 Session。测试没有使用子 Agent 或修改业务代码。
- 模型是本地受控 HTTP/SSE 服务，返回固定 Shell 工具调用；Shell 是 Kimi 自己真实执行。
  共 18 次模型端请求、1 次网络探测请求。它们是测试真值，不能冒充 AnySentry 采集证据。
- Observer 独立采集，回查得到 126 条属于这四个 Kimi 进程根的原始事件。
- API/Web 保持 `kimi-startup-context-20260916`；Observer 保持 `kimi-monitoring-v3-20260916`。
  本轮没有部署或重启服务。测试结束后关闭模型 fixture 和全部测试 Kimi 进程。
- 全部 Shell 内容仅涉及测试标记、sleep、故意返回 7、独立测试文件和 localhost 网络探测。

## 逐轮结果

| 轮次 | 场景 | 原生对话/调用/结果 | 运行期间的调用候选 | 底层核验 |
| --- | --- | --- | ---: | --- |
| R1 | printf + sleep | 完整 | 5 | exec/exit 可见 |
| R2 | 固定重复命令第一次 | 完整 | 5 | 独立进程事件 |
| R3 | 同一命令第二次 | 完整 | 最终 5 | 与 R2 候选 ID 无交集 |
| R4 | bash 返回 exit 7 | 正确标为失败 | 1 | Session 中有 3 条事件，2 条未进入 Call 候选 |
| R5 | Python 写入并读取测试文件 | 完整，内容正确 | 最终 3 | 有 exec/exit；目标文件 FileAccess 为 0 |
| R6 | Python 请求 localhost | 完整，收到响应 | 4 | 包含独立 Egress 事件 |
| R7 | 新进程恢复原 Session | 第 7 轮完整 | 0 | 会话证据绑定失败，前 6 轮候选同时归零 |
| R8 | 并发会话 A 执行同一重复命令 | 完整 | 5 | 与 B 隔离 |
| R9 | 并发会话 B 执行同一重复命令 | 完整 | 5 | 与 A 隔离 |

R8/R9 的执行时间窗口实际重叠 **956 ms**；各候选的原始 Observer root PID 均对应自己的
Session，事件 ID 无交集。不同会话启动不是仅顺序运行。

9 次工具调用、9 次结果、9 条用户消息与回复完整读取；其中 1 次工具失败。
所有 **confirmedEventIds 均为空**，上述数量均为候选关联，不是可信 Call ID 绑定。
R3/R5 在结束后首次读取短暂没有候选，后续读取恢复，说明即时可见性有延迟；此轮没有
进一步分离缓存、转发和入库各阶段的延迟，不能直接称为内核漏采。

## 缺口与证据

### 1. 跨进程恢复使整个会话系统证据消失（优先修复）

同一 Wire 文件由 PID **2255767** 和 **2260723** 两个进程代际先后写入，原始数据库
分别有 28 和 7 条文件事件。`resolveBindingFromSessionFile` 要求候选代际只能有一个；
出现两个即返回 undefined。目前没有组合“各代际有效时间段”的会话证据覆盖。

恢复前 R6：41 条直接归属 + 28 条血缘归属；6 个调用候选数 `[5,5,5,1,3,4]`。
恢复后及最终复查：7 轮内容仍在，`systemEvidence` 缺失，候选数 `[0,0,0,0,0,0,0]`。
原始事件仍在，属于**已采集但无法归属/展示**，不是数据被删或工具没有执行。

### 2. 短命进程的命名空间字段缺失使调用关联不完整

失败命令 PID **2259006**，start ticks **64081103**：

- `evt_62d8fda6344bb48e`：启动包装 Shell，带 pidNamespace，进程键 `pri_7f69a46e8d803fd9bea3b3e8`。
- `evt_dd84c309e0fd1023`：exec 内层 bash，缺 pidNamespace，进程键 `pri_7f3f9fa52985f5a97e384ab1`。
- `evt_d482c3b64205b89f`：ProcessExit，同样缺 pidNamespace。

三者都是 Session 的 LINEAGE 证据，但仅第一条作为调用候选。
需要在严格 host/boot/PID/start-time 和唯一命名空间约束下统一代际，不能放宽到只按 PID。

### 3. 工作区文件读写不在当前文件事件转发范围

真实文件 `workspace/multiturn-04659b17c9.txt` 内容为 `ASMT_04659b17c9_FILE`。
查询该绝对路径的 FileAccess/FileDelete，结果为 **0**。当前 `FORWARD_FILE_INCLUDE_PATHS`
只包含 Kimi 会话目录。这是当前配置覆盖不足；不能据此断言内核从未观测到文件操作。

### 4. 模型网络明文请求与可信调用绑定缺失

本地模型服务记录 18 次请求，AnySentry 的 `observedLlmRequests` 始终为 **0**。
R6 的 `evt_c1ef7507bc929f1f` 证明工具进程的网络元数据已观测；Egress 不等于请求明文、
模型语义或 TLS 捕获。此前已知的 Kimi OpenSSL 运行时接入仍未完成。本轮 HTTP fixture
不能验证真实云端 TLS、云端模型质量或 Token 计费。

所有调用仍为候选，没有经过认证的 `Call ID → execution ID → OS generation` 绑定。

## 可查看样本

- 恢复失败会话：<http://127.0.0.1:29654/record-tracking?record=fe516bdf86482c93ead5a18a>
  Native Session `f82232ff-6e5d-4276-97be-11ab9e824d9b`。
- 并发 A：<http://127.0.0.1:29654/record-tracking?record=f47446b003e62b29a307f0c6>
- 并发 B：<http://127.0.0.1:29654/record-tracking?record=ad0f8b621f22b8a9fcd7c988>

恢复前的 6 轮证据已保存在 `R6_NET.json`，不能用恢复后的空页面替代这份时间点证据。
真实浏览器验证：并发 A 展示 5 条候选；恢复会话展示 7 次工具、0 条候选。
桌面/移动截图分别为 `/tmp/anysentry-link-browser-AneElL/` 和
`/tmp/anysentry-link-browser-6HjCao/`。

## 复现与后续顺序

脚本：`python3 scripts/verify-kimi-multiturn-live.py`。
依赖当前隔离 Kimi 安装和已配置的 sessions 挂载/转发范围；每次使用新 UUID/标记，
写入新的测试记录，不复用旧成功样本。脚本不自动安装软件或改监测配置。

证据目录 `/tmp/anysentry-kimi-multiturn-20260917-004833/`，包含 manifest、逐轮 API 和 Wire
快照、模型端请求真值、原始事件、跨代际写入统计及 `verified-results.json`。

建议依次修复：跨进程恢复的分段绑定与历史持久化；短命进程代际统一；工作区文件监测
范围；Kimi 独立 TLS 请求采集；可信调用绑定。每项均复跑对应场景，不以清空冲突或
把候选改成“已确认”来代替验收。
