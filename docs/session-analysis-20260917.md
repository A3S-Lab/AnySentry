# Session 分析（2026-09-17）

在现有“分析”页内独立实现会话概览、Token 构成、耗时分布、工具排名、系统证据覆盖、
进程资源采样、费用估算、人工评价、可筛选缩放时间线及分析 JSON 导出。
参考 AgentSight 的集中运行视图与 Langfuse 的成本/延迟/质量分层；没有复制其组件、
引入其依赖或将原生工具记录标为内核事件。

## 统计与数据边界

- 调用、结果配对、耗时均来自已加载原生事件；加载历史后重算、按 eventId 去重。
  Turn + Call ID 唯一配对复用已有 Trace 投影，孤立结果单独计数。
- 失败率 = 已配对失败 /（已配对成功 + 失败）。状态未知、缺失结果不当成功。
- Turn / 工具 / TTFT 使用 nearest-rank P50/P95，显示样本数。没有数据展示破折号；
  零耗时可作为真实样本。Turn 耗时合计不同于包含空闲时间的记录跨度。
- Codex 使用原生累计 Token；其他适配器注明解析范围。缓存与输入按适配器语义拆分：
  Claude 输入不含缓存；Codex/Kimi/OpenCode/Gemini/A3S 输入包含缓存。
  Gemini 推理单独计入，其余不重复叠加推理。分类与报告总量不符时提示且禁止估价。
- 没有逐模型 Token 账本，不把所有 Token 归给最新模型。费用为用户自填统一单价的估算，
  缓存读写合并时要求综合单价；无默认价格、非实际账单。
- 人工 1–5 分与说明仅存当前浏览器 `anysentry.session-review.v1:<recordId>`，
  可清除、会话间隔离，存储异常显示错误；不是自动评估或团队评分服务。
- 系统事件只接收 nativeSessionId 相符的 evidence，按 eventId 去重；候选 Call、
  可信 Call、未关联调用独立统计，系统拦截不与工具失败相加。明文请求不会为分析页额外拉取。
- 时间线使用独立时间格展示五类数据，支持类型/来源/PID/失败筛选、1–16 倍缩放、
  时间窗口平移、分页详情。原生工具与 Observer 分轨。导出仅统计，不带输入输出原文。

## 资源采样

新增只读 `GET /security-center/local-records/:recordId/resources`。
沿用已有 Session 精确进程扫描，要求唯一 matchedPid + start ticks；若同代际被其他
记录共享则拒绝分摊。读取宿主机 `/proc/<pid>/stat`、`status`、`/proc/stat`，前后
校验代际。RSS 来自 VmRSS；CPU = 进程 ticks 增量 / 宿主 ticks 增量 × CPU 数 × 100。
宿主总量排除已计入 user/nice 的 guest 字段。仅采集绑定进程，不含子进程树。

页面可见时每 15 秒请求；每记录 5 秒以内请求去重，最多 240 点，内存最多 64 条记录。
API 重启丢失采样历史，不回填历史峰值。首次、跨越 60 秒的间隔、核数变化、计数回退
不生成 CPU 百分比。PID 复用清除该代际历史。来源不可用/未绑定/共享均显式展示。

当前实测两个活跃 Codex 记录返回 shared，OpenCode 共享数据库记录返回 unbound；
不把这类 Session 显示为 CPU=0。独立实际 /proc 读取与合成代际测试均通过。

## 验证

- `pnpm --filter @anysentry/api build`
- `pnpm --filter @anysentry/web exec tsc --noEmit`
- `pnpm --filter @anysentry/web build`
- `node --experimental-strip-types scripts/verify-session-analysis.mjs`
- `node scripts/verify-session-resources.mjs`
- `node scripts/verify-local-record-tracking.mjs`（故障注入警告符合原测试设计）
- `node --experimental-strip-types scripts/verify-local-record-trace.mjs`
- `node scripts/verify-session-analysis-browser.mjs`

浏览器覆盖桌面1600与移动375、类型/来源筛选与空结果、缩放、详情、单价估算、评价
保存后刷新与清除、会话隔离、统计导出不带原文、历史加载及 unbound 资源状态。
无运行时异常。截图/报告：`/tmp/anysentry-session-analysis-20260917/`。

## 发布

- API `anysentry-api:session-analysis-20260917`，基于 opencode-v3，只替换记录服务、
  控制器和新增资源模块。
- Web `anysentry-web:session-analysis-20260917`，基于 session-title，保留同期标题与 Trace 改动。
- 使用 `scripts/deploy-harbor-live-canary.mjs api-analysis / web-analysis`，保留配置与挂载。
  Observer 未重启。
- 回滚容器：`anysentry-anysentry-1-before-live-1789615402259`、
  `anysentry-web-1-before-live-1789615464489`。

未来扩展：完整多模型用量账本、供应商实际账单、持久资源采样、团队共享评分及按会话
完成条件触发的自动评估。不能将这些未接入项描述为本次已完成能力。
