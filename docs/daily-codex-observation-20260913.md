# 日常 Codex 采集、归因与关联实测

时间：2026-09-13 17:29–17:35（北京时间）。结论：基础采集和多 Session 隔离本次通过，但完整持久化与恢复会话后的查询仍有缺口，不能宣布稳定验收通过。

## 环境与方法

- 使用本机已登录 Codex CLI，沿用当前用户配置（本次实际模型 gpt-6-astra），不是 Harbor 容器。
- API：`anysentry-api:namespace-stable-20260913`；Observer：`anysentry-observer-wrapper:harbor-live-20260913`，Codex-only、受控 runtime_payload、FILES=0。
- 不改业务代码、配置或数据库，不重启任何服务，不干扰仍运行中的 Terminal-Bench。
- 5 次 CLI 调用：无工具回复、顺序/嵌套 Shell、两个并行 Session、恢复顺序测试的原 Session。共 4 个 Native Session、5 条测试用户指令、6 次实际 Shell 调用。
- 每次 Shell 含一个唯一 `/usr/bin/printf` 标记及 15 秒等待；通过 CLI 成功执行记录、ClickHouse 完整 argv/exec_confirmed 事实、API 返回 eventId、PostgreSQL active LINEAGE 关系四方交叉核对。
- 另运行一个不属于这些 Codex 子进程树的 printf 负对照，确认不会混入测试 Session。
- 本轮轮询记录列表，使现有后台绑定机制工作；没有验证“不打开页面/不轮询”也能持续绑定。

## 结果

| 核对项 | 结果 |
| --- | --- |
| Native Session 用户指令内容一致 | 5/5 |
| eBPF 用户指令解析 SHA256 与真实测试指令一致 | 5/5 |
| Native Session 可见 OK 回复 | 4/4 个 Session；5 次 CLI 均正常完成 |
| 6 个受控 Shell 关键执行行为被采到 | 6/6，argv 完整且 exec_confirmed |
| 关键事件在详情 API 归属正确 Session | 5/6 |
| 关键事件存在正确 Session 的持久 active 关系 | 5/6 |
| 同时满足详情可见和持久归因 | 4/6 |
| 4 个不同 Session 的返回系统事件 ID 交集 | 0 |
| 外部负对照混入测试 Session | 0（负对照本身已采到） |

这是 **6 个受控命令关键执行事件的小样本**，不是 Terminal-Bench 历史 90 次 Shell 调用的重算，不代表生产成功率 83.3%/100%。也未验证文件访问、全部网络事件或 Agent 回复的独立 TLS 明文捕获。

17:33:36、17:34:33、17:35:19 连续检查均未看到恢复后的 A4 出现在系统证据详情；17:34/17:35 查库确认 A3 没有持久关系、A4 已有正确关系。

## 两个复现的问题

### 1. 退出前末尾事件没有被持久归因

顺序 Session：`01a09a1a-3600-74b3-9637-3e3ffe08c31d`，记录 `f47cd8eb56d3f99ca140c7ec`。

- A1：`evt_9c035265b8ca4795`，采到、详情可见、持久 LINEAGE 均成功。
- A2（嵌套 Shell）：`evt_b122646eec08417b`，三者均成功。
- A3：`evt_c4ed6cc21e030d93`，采到、详情可见，但 PostgreSQL 没有对应关系记录。

旧代际绑定 `spb_49442050c1cd6c9d513747d2` 最后 observedAt 为 17:30:36。
代码背景：`scheduleActiveSessionAttribution` 以 60 秒节流，只调度 running Session，没有结束后的尾部补算保障。
这与末尾落库缺失吻合；本次没有用人为数据库写入掩盖缺失。

### 2. 恢复同一 Session 后，详情仍只返回旧进程代际

- 旧 PID `492705` / `pri_02d2c8488e09faeec3854034`。
- 恢复后 PID `505030` / `pri_26672e0b62c63c4bbe899d17`，确实是新进程，不是旧 namespace 分裂。
- A4 `evt_ba5430473dc3ff8e`（printf PID `510393`）已采到，且正确持久关联到新绑定 `spb_83764db10f8d936b489e7b41`，Native Session 相同。
- 详情已读取两代进程的明文请求，Native 对话也有恢复后的新指令与回复；但系统证据仍只有旧代际 169 条，缺 A4。
- 退出后 `processStatus=exited`，但因近期写入 `activityStatus=active`。
- `interactiveExactProcessMatches` 对 active 状态执行 `selected.slice(0, 1)`，沿用 preferred 顺序；旧代际可能排在最前。该分支将两代进程压成一个，响应仍 `hasMore=false`，不能据此判定全 Session 完整。

## 无工具负对照

Session `01a09a1a-07ad-7d23-b29f-b4c1f1313072` 的 Native 工具数为 0，CLI 只回复 OK。
系统证据另有 47 条 ToolExec：底层进程执行不等于模型工具调用。本轮未发现其他测试标记或外部标记进入此 Session，不应把这 47 条当成“模型调用了 47 个工具”。保留 AnySentry 原生 ToolExec 语义，不修改 UI 类型。

## 复核资料与下一步

- 原始结果、CLI 日志、详情和分析：`/tmp/anysentry-daily-codex-PDcOqI/`（目录及日志限制权限；临时目录可能被系统清理）。
- 运行器：`scripts/test-daily-codex-observation.mjs`；只读分析：`scripts/analyze-daily-codex-observation.mjs`。
- 并行 Session：`01a09a1b-2f34-75e2-bfbe-69f2195debfa`、`01a09a1b-2fa3-7a93-92b7-c32b47d5d774`。
- 下一步修复：进程退出后的有界尾部补算；恢复会话的多代际系统证据合并/分页及 completeness 标识，然后原样重复这组测试。
- 优先重用本轮真实事件重放验证，不清库、不用名称/时间或裸 PID 猜测，不把父 Session 的上下文当作子 Session 工具。

本轮只新增测试/分析脚本与报告，没有修改生产业务逻辑。
