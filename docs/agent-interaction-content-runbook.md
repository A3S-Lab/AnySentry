# Codex 对话与模型请求采集运行手册

> 当前范围：本机单用户 `local_runtime` 模式。AnySentry 使用两条独立且可区分
> 的证据链：本机 Codex Session 提供原生对话记录；AnySentry Observer 自己的
> Codex/Rustls eBPF 探针提供“模型实际收到的用户消息”。两者都加密保存到
> AnySentry。运行链路不读取 AgentSight 数据库，也不依赖 AgentSight 服务。
> 共享环境和生产环境不得启用无认证直显。

## 1. 当前实现

原生 Codex 对话路径是：

```text
指定的 Codex Thread
→ codex app-server / thread/read(includeTurns=true)
→ userMessage + agentMessage
→ ContentStore AES-256-GCM finalize
→ Kafka durable ack
→ PostgreSQL / ClickHouse 可重放投影
→ /conversations 本机解密直显
```

模型请求观测路径是：

```text
用户在 Codex 输入指令
→ Codex 组装 Responses API / WebSocket 请求
→ AnySentry Observer 精确二进制 Rustls uprobe
→ LlmRequestObserved
→ observer-forward 独立 AES-256-GCM WAL
→ AnySentry ContentStore finalize + Kafka durable ack
→ PostgreSQL / ClickHouse 可重放投影
→ 记录追踪 / 进程树 & AI 提示
```

第二条链路显示的是从真实模型请求中提取出的 `user` 消息，不是完整 HTTP
请求体，也不等同于用户尚未提交的键盘草稿。页面必须标记
`captureMethod=ebpf_rustls`、`captureProfile=exact_binary_runtime|exact_pid_runtime`
和端点归因；没有这类投影时只能显示“未观测”，不得拿本地 Session 冒充 eBPF
证据。

采集内容包括：

- 用户发给 Codex 的原生消息；
- Agent 的过程说明（`commentary`）；
- Agent 的最终回复（`final_answer`）；
- 原生 `threadId`、`turnId`、`itemId` 和 Turn 顺序。

不会采集或冒充对话正文的内容包括：

- 隐藏推理；
- Shell 命令输出和工具返回值；
- MCP 结果；
- 仅凭时间窗口推断出的输入/回复关系。

每条正文以 Codex 原生 Item ID 作为稳定来源标识。同一个 Item 重放只产生
duplicate receipt，不会新增逻辑消息；相同标识但正文变化会被拒绝为冲突。

## 2. 打开并阅读对话

浏览器访问：

```text
http://localhost:29653/conversations
```

也可以从左侧导航点击：

```text
Agent 观测 → 对话追踪
```

选择左侧标记为“Codex Runtime”和“对话正文”的会话，右侧会按时间显示：

```text
用户指令
Agent 过程说明
Agent 最终回复
```

当前页面默认加载最近 40 条消息，避免长对话一次发起数百次正文解密请求。
点击时间线顶部的“加载更早记录”可每次向前展开 40 条，最终能查看完整历史。
已展开的卡片也只在接近可见区域时读取正文，不会因为加载更早记录而同时占满
API / PostgreSQL 连接池。

正在执行中的 Turn 不会读取，因为 Agent Message 仍可能变化。该 Turn 进入
`completed`、`interrupted` 或 `failed` 后，下一次轮询才会写入，因此当前正在
生成的回复会在本轮结束后的下一次扫描中出现。

## 3. 一次性同步和持续同步

适配器只读取显式指定的一个 Thread，不会扫描账户内其他会话。

一次性同步当前 Codex Thread：

```bash
cd /home/zhongyule/code/AnySentry
pnpm observe:codex-conversations:once
```

持续同步当前 Codex Thread：

```bash
cd /home/zhongyule/code/AnySentry
pnpm observe:codex-conversations
```

需要退出当前终端后仍持续同步时，使用仓库内的后台管理器：

```bash
pnpm observe:codex-conversations:start -- \
  --thread 01a01383-65fc-7c01-9401-1cc0cdef1ce9
pnpm observe:codex-conversations:status
pnpm observe:codex-conversations:stop
```

后台管理器会验证 PID 的真实命令行，避免误停 PID 被复用的其他进程。PID 状态
和仅含计数的日志存放在 `.local/`，权限为 `0600`。

也可以显式指定 Thread：

```bash
node scripts/codex-conversation-observer.mjs \
  --watch \
  --thread 01a01383-65fc-7c01-9401-1cc0cdef1ce9
```

默认每 10 秒读取一次持久化历史。上传并发默认为 1，并在消息间留出 50ms，
防止大量历史首次导入时压满 API / PostgreSQL 连接池。

适配器的输出只有 Thread ID、计数、重试状态和错误分类，不打印正文或凭据。

## 4. 持久性和断点恢复

接收成功边界是：

```text
ContentStore finalize + Kafka durable ack
```

只有收到这个 Receipt 后，适配器才推进本地游标。API 超时、背压或短暂不可用时，
适配器会指数退避重试；未收到确认的 Item 不会从待同步集合中删除。

本地文件：

```text
.local/codex-conversation-observer.env
.local/codex-conversation-observer-state.json
.local/interaction-content.env
```

这些文件均被 Git 忽略并保持 `0600` 权限。游标只保存不可逆指纹和原生 Item ID，
不保存正文。凭据文件不得打印、复制到日志或提交到仓库。

## 5. 本机直显与正文加密

`local_runtime` 表示正文来源是明确选择的本机 Runtime，不代表明文落库。
服务端仍使用 AES-256-GCM 加密正文：

```text
ANYSENTRY_INTERACTION_CONTENT_CAPTURE_MODE=local_runtime
ANYSENTRY_INTERACTION_UNSAFE_LOCAL_DIRECT_VIEW=on
```

“本地对话直显”只省略浏览器端的再次输入密钥步骤。服务端仍然解密密文后返回，
响应带 `Cache-Control: no-store`，正文不会进入会话列表或普通详情接口。

关闭无密钥直显后，正文查看必须恢复为：

- 真实用户认证；
- 服务端 RBAC；
- 独立 Raw View 权限；
- 查看原因与审计；
- 正式 KMS / 版本化租户密钥。

这些安全 Gate 完成前，共享或生产环境必须使用 `metadata-only`，不得使用
`local_runtime` 或 `ANYSENTRY_INTERACTION_UNSAFE_LOCAL_DIRECT_VIEW=on`。

## 6. 验证

```bash
pnpm verify:codex-conversation-observer
pnpm verify:agent-interaction-metadata
pnpm verify:agent-interaction-service
pnpm verify:agent-interaction-content-store
pnpm verify:agent-interaction-content-service
pnpm build:api
pnpm build:web
```

真实环境还应检查：

```bash
curl -fsS http://127.0.0.1:29653/security-center/interactions/status
curl -fsS http://127.0.0.1:29653/security-center/conversations?limit=300
```

状态至少应满足：

- `ready=true`；
- `contentCaptureMode=local_runtime_encrypted`；
- `directViewEnabled=true`（仅本机）；
- `projection.state=ready`。

## 7. 仍然存在的边界

当前可以声明：

> AnySentry 能读取一个明确选择的 Codex 原生 Thread，持久采集其中已结束 Turn
> 的用户消息、Agent 过程说明和最终回复；在显式受控模式下，AnySentry Observer
> 还能从精确 Codex/Rustls 请求中提取模型实际收到的用户消息，并通过自己的加密
> Interaction 通道在“记录追踪”中展示。

当前不能声明：

- 已采集所有 Agent 产品和所有账户会话；
- 已采集用户在 IDE/TUI 中键入但尚未进入 Codex Thread 的草稿；
- 已还原 Agent 发给 LLM 的完整请求体、系统提示或隐藏上下文；
- 已采集隐藏推理、工具输出或命令输出；
- 已将每条指令与所有 Tool / File / Process / Egress 动作精确关联；
- 本机无密钥直显适用于共享环境或生产环境。

其他 Agent 需要各自经过验证的 Runtime Adapter。若需要把对话 Turn 与底层行为
精确关联，下一阶段应让 Runtime 提供稳定的 `turnId` / `toolCallId`，再与现有
Observer 事件做证据关联；不能仅凭时间接近强行归因。
