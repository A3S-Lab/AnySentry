# 正常 Codex 对话关联修复（2026-09-16）

用户要求正常使用 Codex 时，直接看到工具调用及对应底层事件；本轮没有修改 Codex
本体、启动方式或用户配置。验收对象改为正在进行的 Any0916 会话，而不是另起的
受控 CLI 样本。

## 复现与原因

会话 `01a0a84f-a7c6-7310-b060-8e26e0db7f86`，record
`625319c33f318cb506d7e9e7` 在恢复后由新的 Codex 进程持有原生 Session FD。
旧进程 PID 374191 已停止产生事件，新进程为 2469945（启动器 2469920）。

1. 交互查询按旧 Observer 请求筛选进程代际，排除了还没有新请求元数据的当前 FD
   持有者。内核已采到新命令，详情却只查到旧进程的系统事件。
2. 接入层为展示将 argv 截到 300 字，但此前候选匹配只比较展示字符串。长命令的
   完整哈希已保存在 `anysentry.kernel.command_hash`，未被详情候选消费。
3. 系统证据请求只在打开页签／手动刷新时执行，正常对话继续后页面不自动更新。
4. 长会话的血缘广度查询使用无排序 LIMIT，旧分支可能占满预算，查询结束时尚未
   到达新命令所在的后代层。真实 500-fact 对比：旧查询最新事实仍在 16:09，新查询
   已到 16:22；两者都查询同一 root、host/boot 和时间窗。

## 改动

- 交互查询优先保留当前精确 FD 匹配的进程代际，再合并近期 Observer 请求的代际。
  仍按 PID + start ticks 隔离，最多 4 个代际，超出范围标 partial。
- 系统事件投影增加 commandHash，仅接受成功 exec 且 argv 未截断、未缺失的采集。
  对原始静态命令计算相同 SHA256，绕开展示截断；不增加原文采集或存储。
  完整命令的首尾空白保留，以免改变哈希。
- 证据页可见时每 15 秒自动刷新；保留加载、错误和部分窗口状态。
- 有界血缘查询优先读取近期分支，并为后续层保留预算；并行查询合并不超过总上限。
  每层行数或深度触顶会显式上报覆盖受限，即使关系写入成功，也保持 partial，不能
  推进后台完整性 checkpoint。PID 代际和 Session 边界校验继续执行。
- 原生调用、系统事实不改写；命令／血缘匹配仍是候选，不冒充运行时 Call ID 证明。

## 验证

API/Web 编译与 Web 类型检查通过；候选、Session 归因、tail/resume、记录详情回归
通过。新增回归覆盖“新 FD 进程尚无 Observer 请求”、同 PID 不同代际、代际数量上限、
长命令展示截断、命令末尾换行、失败／不完整 exec 不能提供哈希匹配键。

正常对话里直接调用 exec_command 执行标记命令后：

- Call：`call_uEypGMnu87UKUiwwTBPZ14cF`
- 原生 Turn：`01a0a939-56ed-7720-b989-26cc23cee05a`
- Shell 事件：`evt_a23a3482e7e1c194`
- 实际 printf 事件：`evt_5fe1490d70c8978e`
- 修复后的真实 API 能在该 Call 候选下返回该 printf 事件。

固定同一份真实响应、同一批已加载事件比较：旧命令匹配找到 34 个调用，新完整命令
哈希匹配找到 53 个调用。此数值只用于验证修复，不是全会话或所有工具的覆盖率。
原生工具记录还包括等待、write_stdin、图片查看、apply_patch 等，不应把每种工具
都当作新 Shell 进程。本次没有声称这些类别全部建立了底层执行映射。

发布与验收产物：`/tmp/anysentry-normal-dialogue-release-20260916/`。
`detail-full-after.json` 为真实响应，`hash-comparison.json` 为同窗口对比。

最后一轮默认页验收直接在本对话执行了正常 exec_command，未新建专用 Codex 实例：

- Call：`call_PxQwFdStn2pMiGZ2cJzp1W3G`
- printf 事件：`evt_bb95d740a27c6c90`
- 默认 250 条系统证据中首次读取即找到对应事件，查询耗时 3586ms。
- 此 Call 展示 23 条匹配候选，包括命令启动、进程退出等事件；不是 23 次工具调用。
- 真实浏览器核对 Call 与同一事件 ID、原页签、证据展开和自动刷新通过，无请求 mock。
  浏览器报告在 `browser-result.jsonl`，截图在 `/tmp/anysentry-link-browser-8DCg48/`。

浏览器轮询断言从当前请求结束后计时，避免将大页读取时间误算为轮询失效；状态断言
只检查状态区，避免会话中展示的代码字符串被误当成页面加载状态。

## 部署

最终 API/Web 镜像：`anysentry-api:normal-dialogue-v3-20260916`、
`anysentry-web:normal-dialogue-20260916`，基于上一轮 tool-candidates 镜像增量发布。
初版 API 仅替换三个相关模块及 source map；v2/v3 另更新 ClickHouse 有界血缘读取和
覆盖完整性传递。更新前已确认本地 ClickHouse 模块与运行模块 SHA256 一致。
Env、HostConfig 保持一致。Observer 未重启。

回滚容器已停止保留：

- `anysentry-anysentry-1-before-live-1789545884865`
- `anysentry-web-1-before-live-1789546028925`

最终 v3 的直接回滚容器为 `anysentry-anysentry-1-before-live-1789547243214`（v2）。
最终镜像 ID、配置比较和四个运行模块哈希核对在 `final-deployment.json`。
真实浏览器验收使用 v2 的关联算法与当前 Web；v3 随后补充覆盖受限信号，并通过
服务回归，Web 产物未变。

## 边界

原截图中的 9 月 12 日调用处于 Observer 没有采集数据的时段，无法补造历史事件。
语义页与系统事件页分别分页，当前页面没有加载到调用时间段的事件时，仍不能判定
“没执行”或“没采到”。动态命令、等待／复用执行、文件类工具及调用后的异步活动，
还不能宣称全部具有唯一的调用归属；可信执行身份绑定没有因此自动完成。
