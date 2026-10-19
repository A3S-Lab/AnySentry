# Trace 逐行追踪视图（2026-09-17）

## 用户入口和功能

记录追踪 → 打开一个会话 → **链路感知 → Trace → 系统证据**。
Trace 将当前已加载窗口映射为逐行表格，保留原有对话、关系树和系统证据入口。

- 类型：Turn 汇总、Observer 模型请求、工具调用、对话消息、系统事件。
- 15 个可选字段列，默认展示 10 个：时间、类型、名称、Trace/Turn、输入、输出、状态、
  耗时、执行关联、元数据；可额外显示模型、PID、Call ID、记录 ID、Session ID。
  2026-09-18 按用户要求移除列表及字段选择中的“来源”列，详情和导出仍保留来源证据。
- 文本搜索覆盖输入/输出、名称、标识和元数据；支持类型与状态筛选。
- 时间/耗时排序、已筛选窗口的时间分布、每页 50 行、加载更早记录及更多系统事件。
- 每行用按钮展开完整输入/输出和字段 JSON；可通过键盘操作。
- 导出当前已加载且符合筛选的行到 JSON，不声称导出整个历史会话。
- 小屏支持面板内横向滚动；Trace 模式下页面头部可滚走，避免挤压表格。

## 数据语义

独立实现的纯展示投影位于 `apps/web/src/lib/local-record-trace.ts`，React 表格位于
`apps/web/src/components/custom/local-record-trace.tsx`，接入既有 LocalRecordTrackingPage。
没有新增采集器、改写原始事件、改变 Session/Turn 归属或增加可信调用绑定。

工具调用和结果要求同一 Turn、相同 Call ID 且各自唯一，结果位置在调用之后。
重复 Call ID、跨 Turn 或加载不完整时不猜配；未配对结果保留独立行。
Turn 是已加载本地事件的汇总，没有完整边界时不补造耗时；Turn ID 不充当 Trace ID。
缺少字段显示 `—`，系统 Trace ID 仅使用源事件提供的标识。

模型请求行仅来自 `observedLlmRequests`，不把用户消息/AI 回复装成独立网络采集。
自动审核和其他线程保留自己的 Session/Thread/Turn 标识；请求没有响应证据时输出为空。
只有 `contentAvailability=available` 的请求正文才能显示。读取失败时移除旧正文或
旧系统证据，并显示重试；候选保持候选状态，未返回系统证据时显示“未核验”。

因此前述 Kimi 多轮测试发现的恢复绑定、TLS 明文、文件覆盖等缺口仍然存在。
Trace 是展示入口，不是这些采集/归因缺口已解决的证明。

## 本地参考范围

只读研究 `/home/zhongyule/code/langfuse` 的以下文件，理解截图所示产品交互：

- `web/src/components/table/use-cases/observations.tsx`：字段列、输入/输出预览。
- `web/src/features/filters/config/observations-config.ts`：类型/状态/字段筛选。
- `web/src/features/tracing-tables/README.md`：表格状态职责。

没有复制这些文件的组件、查询、store 或字段构造代码，也没有引入 Langfuse 依赖。
AnySentry 使用自己的只读 API、展示类型、配对规则、React 状态和样式实现。

## 验证与发布

- `pnpm --filter @anysentry/web exec tsc --noEmit` 通过。
- `pnpm build:web` 通过。
- `node scripts/verify-local-record-trace.mjs`：唯一调用配对、重复/缺失窗口、跨 Turn、
  正文权限、自动审核隔离、不伪造 Trace ID/耗时等测试通过。
- `scripts/verify-trace-browser.mjs` 使用真实 Kimi/Codex API 检查搜索、筛选、字段列、
  键盘展开、导出、分页、Observer 来源及手机滚动；客户端注入读失败验证旧证据移除和重试，
  不向后端注入任何事件。开发页面验证通过，线上发布后再次运行。

Web 镜像 `anysentry-web:trace-20260917`，image ID
`sha256:ab0c22fc972fb3d49331e6dceee191848a1649e6dbcd866c06cf74f4ff2a12e9`。
基于部署时的 `anysentry-web:opencode-20260917`；保留同期 OpenCode 改动。
回滚容器：`anysentry-web-1-before-live-1789579171548`。
本轮只发布 Web，没有部署 API 或 Observer；它们的同期 OpenCode 版本变化来自其他工作。

开发浏览器产物 `/tmp/anysentry-trace-browser-KSOz2p/`；构建上下文
`/tmp/anysentry-trace-20260917/context/`。线上最终验收产物在下方追加。

线上最终验收通过：Trace `/tmp/anysentry-trace-browser-NAAT4M/`，包括真实系统事件
字段和工具“候选 5 条”展示；原链路感知回归 `/tmp/anysentry-link-browser-OEgwLo/`。
Web running/healthy，测试用开发服务器已关闭。

## 2026-09-17 类型图标更新

类型列和类型筛选使用项目已有 Lucide 图标：TURN 机器人、MODEL 脑回路、
TOOL 扳手、MESSAGE 对话框、SYSTEM 盾牌。保留文字标签及颜色，装饰图标
标记 `aria-hidden`。不改变数据、关联或排序逻辑。

类型检查与 Web 构建通过；线上真实 Kimi 22 行及 Codex 模型请求检查覆盖五类图标，
确认类型文字保留、徽标不溢出单元格、375 px 移动端面板不溢出，无浏览器异常。
截图产物：`/tmp/anysentry-trace-browser-DMS4xn/`。

Web 镜像 `anysentry-web:trace-icons-20260917` 基于当前 `opencode-trace-20260917`，
保留同期 OpenCode 更新。回退容器：`anysentry-web-1-before-live-1789612986196`。

## 2026-09-18 移除来源列

从字段定义中移除 source，并将默认字段数调整为 10，字段选择器共 15 项。
展开详情及导出保留原始来源信息。类型检查和 Web 构建通过；线上真实记录验证
10 个数据表头、15 个可选字段均不包含“来源”，加载 28 行、浏览器异常 0。
截图：`/tmp/anysentry-trace-browser-LK6hav/trace-no-source.png`。

Web 镜像 `anysentry-web:trace-no-source-20260918`，基于 `evidence-dedup-20260917`。
构建上下文 `/tmp/anysentry-trace-no-source-20260918/context`；可用
`node scripts/deploy-harbor-live-canary.mjs web-trace-no-source` 发布。
回退容器 `anysentry-web-1-before-live-1789708684452`。API 未发布，Observer/AgentSight 未启动。
