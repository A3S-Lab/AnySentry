# Trace 内容不全定位（2026-09-17）

本轮只读检查代码、会话原文件、API、ClickHouse 和 Observer 日志；未修改业务代码、
未部署或重启。以下会话样本不能代表所有 Agent 的采集覆盖率。

## 检查样本

- recordId：`625319c33f318cb506d7e9e7`
- native Session：`01a0a84f-a7c6-7310-b060-8e26e0db7f86`
- 原文件：`~/.codex/sessions/2026/09/16/rollout-2026-09-16T11-43-07-01a0a84f-a7c6-7310-b060-8e26e0db7f86.jsonl`
- 文件快照约 43.43 MB，包含 27 条 task_started、417 条 custom_tool_call、6 条
  function_call、449 条 token_usage_record、451 条 token_count、3 条 turn_aborted。
  文件仍在增长；这些是原始类型数量，不等于已验证的模型请求数量。
- API 首批 250 条事件，`hasMore=true`；返回 1 条 Observer 请求，模型为
  `codex-auto-review`，属于关联审核线程。
- ClickHouse 对 native Session 直接过滤、分组查询也只有上述 1 条 AgentInputObserved。
  因而该样本缺少主会话请求并非前端过滤或 API 的 500 条请求上限造成。

## 1. 缺少本地 LLM 步骤模型（主要功能缺口）

本机 Codex tracing 插件
`~/.codex/plugins/cache/codex-observability-plugin/tracing/0.3.0/dist/index.mjs`
的 `parseSession` / `emitTurn` 会从 rollout 的 response_item、token_count、工具结果
构建步骤，生成 Codex Turn → LLM generation → tool 层级；后续步骤的 input 使用
上一轮工具结果，output 包含文本/工具调用，usage 使用该步骤记录。这是本地记录重建，
不能等同完整网络请求/响应正文。未执行插件，也未复制实现。

AnySentry `local-record-tracking.service.ts:3650` 读取 token usage 后仅更新汇总 metrics
并 continue，没有模型步骤事件；`local-record-trace.ts:105` 的 MODEL 行仅遍历
observedLlmRequests。现有本地消息和工具记录因此不会形成截图中的连续 LLM 行。
此外 timeline 未处理 turn_aborted，可能使中断 Turn 只显示“边界未齐”。

## 2. Observer 请求丢失发生在采集解析层

实际维护分支为 `Observer-main-runtime-payload`，与部署修复文档
`docs/codex-websocket-connection-fix-20260914.md` 一致。

- `interaction_fixture.rs:1898` 强制提取最新用户消息；提取不到时记录
  `model_request_without_user_message` 并忽略整个请求。只含工具结果的后续请求无法
  因为“没有新用户文本”就被视为无效，但当前路径确实有这个门槛。
- 转发器 `scripts/observer-interaction-forwarder.js:233` 再次要求非空 user_instruction，
  只将该用户文本作为 AgentInputObserved 正文，未转发完整请求输入数组。
- 2026-09-17 10:51:51（北京时间）Observer 全实例累计计数：requests_completed=56、
  requests_parsed=6、requests_without_user_message=50、parse_failed=192、
  invalid_request_frames=173。它们不是该样本的独立计数，也不是覆盖率。
- 同次检查近 15 分钟 PID 2225268 的限频日志有 16 条 websocket_invalid_json、
  1 条 tls_call_truncated、1 条 model_request_without_user_message。
  该 PID 是记录进程 PID 2225261（Node 启动器）的 Codex 子进程。
- PID 2225268 的入库请求中还能看到另一个 Session 的 gpt-6-astra 请求，说明不能
  把同 PID 的全部请求/丢失都归到本样本。没有保留出错帧正文，尚不能证明 JSON 失败
  最终是分帧、压缩状态还是截断引起；需要带连接身份的受控复现。

## 3. 请求/响应接口没有闭环

`interaction.service.ts:693` 的 instructionsForRuntimeSession 仅选 AgentInputObserved。
即使存储层支持其他输出类型，这个接口也不提供模型响应。
`local-record-trace.ts` 的 MODEL 投影没有 output/endAt/duration，并将
responseAvailability 标记为 not_collected；所以模型输出缺失是当前数据接口设计限制。
本地 AI 回复独立作为 MESSAGE 展示，尚未形成可审计的逐步骤输入/输出关联。

## 4. 历史窗口与正文展示限制

- `LocalRecordTrackingPage.tsx:1438` 首批 250 个本地事件，历史需手动加载；系统关系
  独立分批读取，最大 5,000。表格每页 50 行是另一层分页。
- `local-record-trace.tsx:174` 使用单行 truncate；展开可查看 API 已返回的内容。
- 后端 cleanText 最多 64 Ki 字符并带截断提示，展开不能恢复被后端截掉的正文。
- 请求先全局读取最多 10,000 条再按 Session 筛选是另外的潜在窗口问题，但本样本
  已经由直接 SQL 排除它作为“仅一条请求”的原因，不能混为本次已证实根因。

## 修复顺序

1. 从本地已记录事件独立实现模型步骤投影，保留源 offset/边界/usage/工具结果；明确
   标记 local_session_reconstructed，不能冒充 Observer 网络观测或精确服务端耗时。
2. 扩展请求模型以支持没有新用户消息的工具续传；增加请求/响应标识与完整内容的
   有界采集，并复现 WebSocket 解析损失，验证并发会话与恢复场景。
3. 将本地步骤与 Observer 请求/响应并列展示，仅在有明确标识时建立确定关联；
   补上历史分页、加载范围说明及正文可读性。
