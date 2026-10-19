# Trace 最新会话记录缺失定位（2026-09-18）

## 样本与结论

Session `01a094a4-0b4f-7663-b2c4-8e55fbd9e16e`，主 recordId
`d12e75b6dc796cf1c8b24724`；检查北京时间 13:23:10–13:25:23。

- AnySentry API 使用页面相同 limit=250 参数返回 114 个原生事件；该时间段有
  1 条用户消息、4 次工具调用、4 条工具结果、3 条助手消息以及 Turn 开始/完成。
  limit=500 结果一致；不存在这轮原生事件未被后端读取的问题。
- 截图原生计数停在 Turn 8 / 工具 28 / 消息 28，系统证据和顶部更新时间继续变化。
  浏览器重新打开同一记录，计数恢复为 Turn 9 / 工具 32 / 消息 32。
- Langfuse 去重后该时间段有 5 GENERATION、4 TOOL、2 AGENT 包装记录，其中一个
  AGENT 仅 19ms、无输入输出/turn_id、工具数 0，不能按两轮用户任务汇报。
  本地 tracing 插件 Stop hook 读取 rollout，根据 token_count 重建模型步骤并用
  OTel 上报；这些不是独立 TLS 抓包。
- AnySentry 新增的第 8 条 Observer 请求为 13:25:15.092 的 codex-auto-review，
  不是主模型请求。Trace MODEL 仍仅投影 observedLlmRequests；尚未实现本地
  LLM 步骤投影，不能宣称与 Langfuse 逐步输入/输出覆盖一致。

## 刷新故障

LocalRecordTrackingPage 的 detailRequest 同时设置 pollingInterval=15000 和
staleTime=15000。ahooks 3.9.7 的 polling onBefore 先清除定时器，cache onBefore
在新鲜缓存命中时 returnNow；Fetch.runAsync 提前返回，不执行 onFinally，因而
没有重新安排下一次轮询。缓存窗口内手动刷新可稳定触发此问题。
系统证据独立请求 staleTime=0，且合并时覆盖 record 标题指标，不覆盖 events，
造成系统事件/更新时间持续更新、原生消息和工具冻结的表象。

旧版真实浏览器：首次详情请求 1 次，点击刷新后仍为 1 次，再等待 18 秒仍为 1 次；
浏览器异常 0。修复为详情请求 staleTime=0，保留缓存用于初始展示，但刷新总是重验。
回归脚本 scripts/verify-local-record-refresh-browser.mjs 断言手动刷新产生新请求，
随后自动轮询继续产生请求；使用真实只读 API，不改写原始会话记录。

## 验证

`pnpm --filter @anysentry/web exec tsc --noEmit`、`pnpm build:web` 通过。
修复后真实浏览器详情请求计数为首次 1、手动刷新后 2、下一次轮询后 3；
Turn 9 / 工具 32 / 消息 32，Observer 请求 8，浏览器异常 0。

## 发布与边界

Web 镜像 anysentry-web:trace-refresh-20260918，回退容器
anysentry-web-1-before-live-1789709621628。保留之前来源列移除等页面变更。
API、Observer 镜像未改变；Observer 已在本轮此前按用户“开启”指令于 13:22 启动，
旧交接的停止状态是此前时点，AgentSight 未开启。

本修复解决原生事件实时刷新；不补造主模型明文请求，不补造模型响应，也不把本地
记录投影当作内核证据。模型步骤与网络采集缺口参见 trace-content-gap-diagnosis-20260917.md。
