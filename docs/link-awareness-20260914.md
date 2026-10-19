# 链路感知（2026-09-14）

## 范围

在记录追踪的“会话 & 模型请求”右侧新增“链路感知”页签。复用同一个
SemanticTreePanel，保留用户消息、模型请求、AI 回复、工具调用/结果、Turn 折叠、
过滤、加载更早记录，以及独立且默认折叠的自动审核请求/关联线程。
仅新页签在 Tool Call 下增加可展开的系统证据区，原页签不增加此区。

## 证据语义

- 已确认：系统事件已被归属到相同 Native Session，且 API 输出既有的、服务端验证过的
  authenticated_agent_adapter Tool Call 标识，匹配当前调用的 Call ID。
  重复 Call ID 不确认。不复用 traceId/PID/命令字符串作为可信调用 ID。
- 候选：同 Session 的 ToolExec，命令与调用的静态字面量完全相等，时间位于调用到同
  Call ID、同 Turn 的首个结果之间（±250ms）。仅供复核，不计为确认，不改写存储。
  一条事件可成为并发调用的候选；统计对 eventId 去重，候选仍保留在未分配区。
- 未关联：不等于未执行或漏采。动态代码、复合 exec、异步后续执行、未加载的记录等
  均可能缺少映射。不把整个 Session 的进程树分配给某个调用。
- 解析 code-mode 仅提取限定格式的静态双引号 cmd 字面量；不 eval、不执行日志代码，
  不把匹配字面量本身当成真实执行证明。
- 仅统计当前已加载窗口；保留部分结果、加载中、失败和分页提示。可信关联的原有 rollout
  开关保持不变；off 时不输出新增可信调用绑定字段。

这是证据展示与现有可信标识消费能力，不是新增 Observer 调用级采集协议，也不代表
历史 Terminal-Bench 或所有日常 Codex 调用已经完成 Turn 级闭环。

## 关键改动

- `apps/web/src/pages/LocalRecordTrackingPage.tsx`：页签、复用关系树、证据加载与统计。
- `apps/web/src/components/custom/tool-system-evidence.tsx`：调用证据折叠区与原始事件入口。
- `apps/web/src/lib/tool-system-evidence.ts`：只读确认/候选索引，Session 隔离与歧义保护。
- `apps/api/src/security-monitoring/system-tool-call-binding.ts`：既有可信声明的只读投影。
- `session-event-attribution.service.ts`：当前及历史系统证据均附加可选绑定字段；算法不变。
- 手动刷新系统证据改为实际重新请求，避免 staleTime 缓存吞掉刷新/重试。

## 验证与部署

通过 API/Web TypeScript、Web 构建、`verify-tool-system-evidence.mjs`、
`verify-session-event-attribution.mjs`、`verify-link-awareness-browser.mjs`，以及
`verify-observer-content-browser.mjs` 的审核线程隔离/正文授权回归。
浏览器覆盖原页签不变、确认/候选分离、展开键盘操作、分页、错误重试与过滤；留存桌面和
375px 截图。浏览器 fixture 仅在隔离浏览器中拦截读取，不向后端写入假事件。

真实 Session `01a094a4-0b4f-7663-b2c4-8e55fbd9e16e` 的开发环境检查：
17 个调用都有证据入口，已加载 250 条系统事件，确认 0、候选 0。此为窗口读数，
不能将其包装为采集失败率或历史调用归因覆盖率。

发布镜像：`anysentry-api:link-awareness-20260914`、
`anysentry-web:link-awareness-20260914`。
API 仅替换 system-event attribution 展示服务及新增 helper 的两个 JS 文件；构建前已确认
本地旧 service/trusted-correlation/correlation-rollout 与运行镜像哈希一致。
API/Web 窄部署，不修改 Observer/AgentSight 配置与镜像。
回滚镜像：API `anysentry-api:before-link-awareness-20260914`，
Web `anysentry-web:review-collapse-20260914`。
