# Kimi Code CLI 接入方案与验收

## 目标与来源

正常 Kimi Code CLI 会话可出现在记录追踪中，展示用户消息、回复、Turn、工具调用与结果，
并关联独立 Observer 采集的进程执行和退出事件。原始内容不伪装成 eBPF 观测。

参考本地 AgentSight `docs/agents.md`、`agentsight-capture/src/binary_resolver.rs`：
`record -- kimi` 沿启动器解析 Python，动态链接 CPython 使用 libssl 探针；
不是读取终端文本或依靠 Kimi 模型名称识别 Agent。AnySentry 使用自己的采集、归因与存储，
不改动 AgentSight 对照环境。

Kimi 官方来源：
- https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py
- https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/types.py
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html

## 实施顺序

1. 原生会话：新增只读 `kimi_cli` 适配器，发现旧版 `sessions/<workspace>/<id>/wire.jsonl`
   及新版 `sessions/<workspace>/<id>/agents/main/wire.jsonl`。解析 Wire 事件时间、流式文本、
   ToolCall/ToolCallPart/ToolResult、TurnBegin/TurnEnd、Token usage。保留 Call ID；
   无原生 Turn ID 时用边界记录位置生成稳定分组 ID，并明确其为本地分组。
2. 进程与会话：精确 Kimi 启动器识别，复用 PID 代际与 FD 绑定；Kimi 每次追加会关闭
   Wire 文件，因此增加只针对 Kimi 会话目录的文件写事件采集，复用会话文件写入归因。
   不按工作目录或时间接近猜测会话，不把通用 Python 进程全部视为 Kimi。
3. 系统事件：Observer 保留 Codex 并增加 Kimi 转发范围；复用独立 exec/exit/lineage 证据。
   Shell 字面命令和执行窗口产生候选关联，不能提升为可信 Call ID 绑定。
4. 网络请求：核查现有 OpenSSL 采集限制，接入 Kimi 的独立 TLS 请求通道；未通过真实
   请求验收前维持“未观测”状态，不能以本地消息替代。
5. 控制台：Kimi 标签、筛选、来源描述与现有公共关系树接入。只有 Turn 列表最新在前。
6. 验收：解析异常尾行、分片工具参数、失败/中断、重复命令、恢复会话、并行会话隔离；
   真实 CLI Shell 标记必须同时出现在原生 Call 和 Observer 事件中；浏览器检查归属。

## 部署与范围

采用保留旧容器的补丁镜像部署，沿用已有配置；只挂载会话数据目录，不挂载认证配置。
测试 CLI 安装于隔离目录，不覆盖用户安装或配置。鉴权信息不写入报告或日志。
无可用模型凭据时，可用真实 CLI 对受控测试服务验证执行链，但必须明确它不是真实模型验收。
部署版本、样本与尚未覆盖范围在验收后追加。

## 已实现与验证结果

- `kimi_cli` 已加入本地会话类型、发现、Wire 解析、来源、页面标签和筛选；兼容
  `ContentPart(type=text)` 与分片工具参数。workspace 从只读 `kimi.json` 索引按目录哈希匹配。
- Kimi 主进程通过实际会话文件写事件绑定；Python 启动器及运行中 setproctitle 的
  身份变化可以建立独立 Agent 根，不再永久继承启动它的 Codex 根。
- Observer 保留 Codex 并增加 Kimi；文件事件在转发入库前按
  `FORWARD_FILE_INCLUDE_PATHS` 过滤。内核文件探针仍观测宿主机写操作，不能把这个转发范围
  宣称为内核路径过滤；没有采集文件内容。读取 auth/config 不是会话适配的一部分。
- 标准目录 `/home/zhongyule/.kimi/sessions` 已配置，API 通过已有宿主机 `/proc/1/root`
  视图只读访问；测试数据使用单独只读挂载的 sessions 和 `kimi.json` 元数据文件。
- 只有 Turn 列表倒序，组内内容保持原顺序。

真实 Kimi CLI **1.50.0** 调用本地受控 OpenAI-compatible 服务，执行真实 Shell；这是
执行与观测链路验收，不是云端模型质量／计费或真实 Moonshot TLS 请求验收。

| 样本 | Native Session | AnySentry record | 结果 |
| --- | --- | --- | --- |
| B | `326da478-873a-4ae0-a0cd-6386f22ab004` | `0701daca73f03e9650f9cb23` | 1 个调用、5 条候选，PID 3759933 |
| A | `326da478-873a-4ae0-a0cd-6386f22ab005` | `0b9664c8f94a467fee7b9e22` | 1 个调用、5 条候选，PID 3784505 |

B 的 printf 事件为 `evt_25d1acf8fa6871e1`，Shell 锚点为 `evt_f5f1c72c87d28929`；
A 的 printf 事件为 `evt_659e2c8a1328d0de`。两次默认 250 条窗口返回的命令标记隔离，
未将 A/B 互相挂入另一 Session。可信确认均为 0。B 的真实页面和手机宽度浏览器检查通过。
产物：`/tmp/anysentry-kimi-20260916/session-004.json`、`session-005.json`、`isolation.json`；
截图 `/tmp/anysentry-link-browser-gr46Ll/`。

已通过：API/Web 构建、Web 类型检查、Kimi 解析与服务分页/FD 测试、Gemini 适配回归、
Session 归因及 tail/resume 既有回归、Forwarder 身份/持久队列/计数合同、Kimi 路径范围的
真实 Forwarder 子进程测试。完整 `verify-filter-pipeline.mjs` 在既有 `wrong-retry-reason`
用例的 5 秒等待处超时；新增 Kimi 范围用例单独运行通过，不能写成整个套件通过。

调试样本 001 的初始测试服务因上下文上限配置导致重复 Call ID，正确标为歧义；002 暴露
继承 Codex 根的问题；003 发生于 Observer 转发计数枚举错误造成的采集中断期间。
已补齐 `file_path_scope` 计数合同并重启；这些样本不用于成功验收，也未补造缺失事件。

## 明确的支持边界与后续工作

**现在支持 Kimi 原生对话、工具调用/结果、独立进程/网络元数据及工具对应执行候选。**
Kimi 的独立 OpenSSL 明文模型请求通道尚未接入：现有 Collector 的运行时自动探针仍为
Codex/Rustls，OpenSSL 实现限隔离 fixture。AgentSight 能捕获不代表 AnySentry 已实现。
后续需要精确 Kimi PID/加载的 libssl 发现、生命周期卸载、请求重组与身份绑定，并以
真实模型请求验收。保持 `observedLlmRequests=[]`，不伪造为 eBPF 网络事实。

Wire 文件最多 64 MiB，内容展示最多 64 KiB；子 Agent 日志不折叠进 main，缺少 Wire
时间戳不会用 context 内容伪造执行时间。恢复会话的解析已测，多个进程写同一 Session
导致绑定歧义时仍不强行选定一代进程；完整跨进程恢复的持久化覆盖不是本轮已验收能力。
本轮早期身份切换前的事件可能保留原冲突状态，不重写历史事实。

## 最终部署

- API：`anysentry-api:kimi-monitoring-v3-20260916`；前一容器
  `anysentry-anysentry-1-before-live-1789556009792`。
- Web：`anysentry-web:kimi-monitoring-20260916`；前一容器
  `anysentry-web-1-before-live-1789555429700`。
- Observer：`anysentry-observer-wrapper:kimi-monitoring-v3-20260916`；前一容器
  `anysentry-observer-1-before-live-1789556069711`。

Observer 延续已有 scripts 绑定挂载，镜像 tag 不足以证明脚本版本；实际脚本 SHA256 记录于
`/tmp/anysentry-kimi-20260916/forwarder-hashes.json`，容器镜像 ID 在 `deployment.json`。
旧容器共享此脚本挂载，回滚容器只回滚配置和镜像，不能宣称自动回滚这些脚本。

最终版本重新运行原版 Kimi，Session `326da478-873a-4ae0-a0cd-6386f22ab006`，
record `eb01b4fa76f5cf357c065a4d`，Kimi PID 3802775，默认窗口仍为 5 条候选。
printf 事件 `evt_bec0792281bda4f1` 已验证属于该调用候选，回复 1 条且 cwd 正确。
证据为 `final-v3-detail.json`；保留 4 条归因冲突，不把这些事件混入工具候选。
最终 v3 的真实页面浏览器验收也通过：1 个调用、5 条候选、可信确认 0；
桌面及移动宽度截图在 `/tmp/anysentry-link-browser-pU8JgP/`。
验收后关闭本轮本地模型测试服务，保留会话与系统证据供页面检查。
