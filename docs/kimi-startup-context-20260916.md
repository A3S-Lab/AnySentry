# Kimi 启动上下文误报身份冲突修复

用户截图：record `0b9664c8f94a467fee7b9e22`，Native Session
`326da478-873a-4ae0-a0cd-6386f22ab005`，8 条 `agent_identity_conflict`。

## 根因与证据

已回查 ClickHouse 原始事件。PID 3784505 / start ticks 61945975 先运行 bash，
后来 exec Kimi；exec 不改变这两个标识。其启动期间的 locale-check、locale、Python
子进程及初始 Kimi exec 共 8 条事件保留 Codex 身份 `ari_5622822b3627332513783eb8`。
后续会话文件写入明确观测到 Kimi 根 `ari_de7584ee437b903360cb85a7`。

旧逻辑把整个 OS 进程代际的历史都与当前 Kimi 绑定比较，将切换前的历史报成了当前
身份冲突。v3 样本 `eb01b4fa76f5cf357c065a4d` 也有 4 条同类启动历史，因此不能仅
解释为“用户打开旧样本”。

## 修复规则

归因算法由 v11 更新为 v12。只在以下证据同时存在时识别启动上下文：

- 同一精确 OS 进程代际曾发生 ToolExec，并被观测为不同 Agent 根身份。
- 随后同一进程明确宣告与当前绑定一致的自身根身份，PID 与启动时间均相符。
- 事件携带该早期身份，时间严格早于新身份观测点，且只有一个活动会话候选。

不以工作目录、命令相似、单纯时间接近、子进程身份或进程退出事件判定切换。
保守边界是“当前根身份首次被观测到”，不宣称等于 Agent 实际启动的精确时刻。

符合规则的事件保留原始事实，归因结果为 `UNATTRIBUTED`，原因
`before_agent_identity_transition`，另通过 `startupContext` 返回页面。
它们不计入确定证据或 Tool Call 候选，也不抹除原身份。页面以可展开的普通说明显示，
未归属数量明确注明启动上下文。切换后的身份冲突仍按原规则提示；真实冲突增加中文说明。

## 验证与部署

已通过 API 构建、Web 类型检查与构建、Kimi 解析及分页回归、Session 归因完整回归。
新增测试覆盖启动 Shell/子进程、切换后的真实冲突、缺失根证据、仅退出证据、错误代际、
仅子进程证据和相同时间戳，确保不通过扩大可信关联来消除提示。

补丁镜像基于已上线的 Kimi v3 API 与 Kimi Web；Observer 不需变更或重启。
部署脚本保留旧容器与既有配置。现场核验结果在部署后追加。

已上线 API/Web `kimi-startup-context-20260916`，均 running/healthy；Observer 保持
`kimi-monitoring-v3-20260916`，未重启。回滚容器分别为
`anysentry-anysentry-1-before-live-1789557014410`、
`anysentry-web-1-before-live-1789557056102`。

| 原始会话 record | 修复前冲突 | 修复后冲突 | 启动上下文（未归属） | 确定证据 | 工具候选 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `0b9664c8f94a467fee7b9e22` | 8 | 0 | 8 | 16 | 5 |
| `eb01b4fa76f5cf357c065a4d` | 4 | 0 | 4 | 18 | 5 |

截图会话的启动上下文 ID 集合与原 8 条冲突完全一致；确定证据 ID 集合及 Tool Call
候选对象与修复前完全一致。未更改原始事件、增加可信绑定或伪造采集。
真实浏览器验收通过：无原黄色冲突提示，启动上下文可用键盘展开，桌面与 375px 宽度
均可查看全部 8 条，长 ID 无横向溢出。截图 `/tmp/anysentry-link-browser-etpV9g/`。

排查原始产物：`/tmp/kimi-conflict-detail.json`、`/tmp/kimi-conflict-events.jsonl`。
构建与验收目录：`/tmp/anysentry-kimi-startup-20260916/`。
