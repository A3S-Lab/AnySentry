# Tool Call 明细为空修复（2026-09-17）

样本 record `d12e75b6dc796cf1c8b24724`，call `call_1MO4NSRnru4QGCNPb2mACKz6`。
原始 bash/printf/sleep/exit 事件一直保留，但默认 API 只发现 50 条会话关系，调用
返回 unmatched。扩大到 5,000 也只发现 58 条关系，没有目标调用的候选。

## 原因与修复

进程生命周期表的重复版本在后台合并前占用查询 LIMIT；应用层随后按 factId 去重
已经太晚。实测取 833 个物理行只有 10 个独立事实，目标进程被挤出。

- 在 SQL 中按 factId 聚合，以 argMax(tuple(fields), tuple(receivedAt, identityRevision))
  保留同一个最新版本的全部字段，然后排序、限制数量；没有清理或重写原始事件。
- 查询额度预留后续两层，避免按最大六层均分使第一层遗漏较早的直接子进程；仍受
  原有总条数、深度、host/boot/start-time 和时间窗口限制。
- page 增加 processFamilyTruncated；结构查询截断时 hasMore=true。
  前端扩大查询不再被当前已发现的 totalRelations 卡住，上限仍为 5,000。
- 调用明细标明“证据未查全”，避免空候选被理解为未采集。候选不升级为可信关联。

## 验证

- API 构建、Web 类型检查及构建通过。
- `verify-lifecycle-dedup-before-limit.mjs` 使用连接局部 Memory 临时表执行生产 SQL：
  202 个版本行归并成 2 个事实，旧子进程保留，最新版本字段正确；不写生产表。
- `verify-session-event-attribution.mjs`（含结构截断分页）、
  `verify-local-tool-evidence.mjs`、`verify-tool-system-evidence.mjs` 通过。
- 只读真实家族回放在默认 500 个结构事实预算下找到目标 6 个事件（含启动包装）。
- 发布后默认 evidenceLimit=250：220 条 Session 关系，截图目标调用恢复 5 条候选，
  confirmedEventIds 仍为空。原 API 快照 `/tmp/anysentry-empty-call-evidence-250.json`，
  发布后 `/tmp/anysentry-evidence-dedup-20260917/api-after.json`。
- 真实浏览器恢复目标调用 5 条明细，截图 `/tmp/anysentry-link-browser-OLAmvR/`。
  浏览器回归包含候选/可信区分、键盘展开、结构查询截断后的加载、错误重试与筛选。

## 部署

API/Web 镜像均为 `evidence-dedup-20260917`，基于最新 `session-analysis-20260917`，
保留同期分析功能；API 只覆盖 clickhouse-store、session-event-attribution.service、
local-record-tracking.service 的编译文件。Observer 未重启。

回退容器：
- `anysentry-anysentry-1-before-live-1789621291546`
- `anysentry-web-1-before-live-1789621310445`

仍有边界：长会话结构查询可能为 partial；本轮没有修复 Trace 模型步骤、TLS 请求解析
或请求响应配对。没有提交或清理用户原有工作区改动。
