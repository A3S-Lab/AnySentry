# OpenCode 接入方案与验收

## 目标与参考

沿用现有 Native Session → Tool Call → Observer 系统事实的分层。参考 AgentSight 的精确 `opencode` 进程签名和真实 CLI + 本地模型服务验收方式；不把其进程识别等同于原生 Session 解析。

参考源码：
- https://github.com/eunomia-bpf/agentsight/blob/main/ext/analysis/src/view/process_select.rs
- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts

## 实施

1. 注册 OpenCode 独立运行时签名，只匹配可执行文件/入口，避免提示文本或普通 Bun/Node 误识别。
2. 新增 SQLite 只读适配器：Session 主键区分共享数据库中的会话；读取 message/part，保留原生 parentID、callID、命令、工具状态、时间、模型、Token；读取 WAL 一致性快照，限制行数/字节/耗时，不读认证文件。
3. 复用记录列表、详情、分页和工具候选关联，增加 OpenCode 标签及筛选。数据库 FD 不证明某个 Session 归属，禁止共享 DB 自动建立 Session 绑定。精确命令候选仍按现有证据等级展示。
4. 隔离真实 CLI 状态和工作目录，以本地模拟模型返回确定性工具调用，验证多轮、失败、恢复、并发，再验证在线 API 与页面。

## 验收边界

- 必须：运行时识别、会话发现、用户/AI/工具记录、稳定事件 ID、并发会话隔离、只读 WAL、异常数据库降级、已有适配器回归。
- 必须分别报告：系统执行事实、候选关联、可信 Call 绑定、TLS 模型捕获。候选不升级为可信绑定，未捕获不伪造。
- 当前目标是 SQLite message/part 格式；新的 v2 event schema 或旧 JSON 存储不得静默解释为已完整支持。

## 已实施

- API 适配器：`local-record-opencode.adapter.ts`；只读 sqlite3 N-API 驱动，兼容当前 Node 20 容器及本地 Node 22。
- 每次事务 3 秒预算、锁等待 250ms；每类最多 4096 行、单行 64KiB、每会话有效负载 16MiB，超限明确标记 `recent_window`。关闭后的 WAL 数据库缺辅助文件且挂载只读时，仅在主文件身份/大小/纳秒修改时间保持一致、复制前后都没有 WAL 的条件下使用私有临时副本（上限 128MiB），用后删除。
- `ANYSENTRY_LOCAL_OPENCODE_DATA_DIR(S)` 配置目录；默认 XDG data/opencode。部署须把整个目录只读挂载，不能只挂 DB 而漏掉 WAL。
- 本地注册表与服务端统一规则库均加入精确 OpenCode 签名。真实验收发现：只改本地注册表会被控制面覆盖，不能算接入完成。
- 原生 user message ID 作为 Turn；assistant.parentID 关联其 Turn；tool.callID 配对调用与结果。pending 不提供执行候选；非零 Bash exit 标记失败。Token 来自每条 assistant message，避免与 step-finish 重复累计。
- 共享 DB 不创建 FD/Session 文件绑定。工具候选查询使用完整内核命令 SHA-256、独立的 OpenCode 运行时归属、时间窗口和唯一进程代际；命令展示截断不影响匹配。结果按 callID 和 Turn 配对，不借用同轮其他工具的结果时间。
- Web 增加 OpenCode 筛选/标签；保留同时进行的 Trace 页面更新；Agent 筛选允许窄屏换行。

## 真实验收结果

原版 **OpenCode 1.18.31**，本地固定响应模型服务，实际执行 `/usr/bin/printf`、`sleep`、`false`；没有使用外部模型账号。最终验收标记后缀 `1789579174`。

| 场景 | 原生记录 | 内核命令事件 | 调用候选 | 可信 Call 绑定 |
|---|---:|---:|---:|---:|
| LIVE_A | 通过 | 1 | 5 | 0 |
| RESUME_B（换进程、同 Session） | 通过 | 1 | 5 | 0 |
| FAIL_C（同 Session、exit=1） | 通过 | 1 | 5 | 0 |
| PARALLEL_D | 通过 | 1 | 5 | 0 |
| PARALLEL_E | 通过 | 1 | 5 | 0 |

两个并发工具的执行时间确实重叠，原生记录和系统候选集合均不交叉。恢复后三轮候选全部保留。Observer 的 `attribution.agentScopeId` 为 `opencode`，不能仅凭原始 `agentId`/comm 名称声称成功。

三轮会话 recordId：`28cb7921eb9141ee37cad234`；native session：`ses_f54c4d4deffeyt1pTOBl8Y1wTV`。并发记录：`7f2e97b757dd77720d0860d6`、`e79c4582b4e94d20d4fe16fb`。

真实浏览器通过 OpenCode 筛选、3 个 Turn/3 个 Tool Call、15 条候选、无 JavaScript 异常；1440px 桌面及 375px 窄屏无全页横向溢出。自动化适配器测试覆盖 WAL 活跃写入、关闭后的只读目录、坏行/超大行、缺失与损坏 DB、恢复更新、pending、失败、原生 ID 稳定性、共享 FD 不绑定、分页及 Bun/Node 假阳性。

通过的命令：

```sh
pnpm --filter @anysentry/api build
pnpm --filter @anysentry/web build
node scripts/verify-opencode-local-record-tracking.mjs
node scripts/verify-agent-runtime-signatures.mjs
node scripts/verify-unified-filter-rule-core.mjs
node scripts/verify-observer-unified-filter-policy.mjs
node scripts/verify-session-event-attribution.mjs
node scripts/verify-local-tool-evidence.mjs
node scripts/verify-local-record-tracking.mjs
node scripts/verify-kimi-cli-local-record-tracking.mjs
node scripts/verify-gemini-cli-local-record-tracking.mjs
node scripts/verify-claude-code-local-record-tracking.mjs
node scripts/verify-a3s-code-local-record-tracking.mjs
python3 scripts/verify-opencode-live.py
python3 scripts/verify-opencode-evidence.py
node scripts/verify-opencode-browser.mjs
```

真实 CLI 脚本需要先启动 `python3 scripts/opencode-live-model-fixture.py`，并在隔离 XDG config/opencode/opencode.json 配置 `@ai-sdk/openai-compatible` provider：`baseURL=http://127.0.0.1:29868/v1`、model=`local-fixture`、permission=`allow`。完整配置保存在下列测试目录，复跑只产生新的测试会话。

测试数据、配置、报告、截图：`/home/zhongyule/code/anysentry-e2e-work/opencode-20260917/`，报告在 `results/live-report.json`、`results/system-evidence-report.json`、`results/browser-report.json`。安装与构建临时目录 `/tmp/anysentry-opencode-20260917/`。

最终 API/Web healthy，Observer running；验收后已停止临时模型服务，Agent 原始记录与验收报告保留。

## 保留的能力边界

- **没有**宣称可信 Call ID → 内核事件绑定；25 条匹配均为候选，带 `partial`，未持久化成可信绑定。
- TLS 模型请求捕获为 **0**；本地消息不冒充 eBPF 模型请求。
- 共享 SQLite 不证明 Session 对应哪个存活 PID，所以记录的进程状态可为 `unknown`，与 Observer 已识别 OpenCode 进程并不矛盾。
- SQLite 是可变状态投影，稳定的是原生事件 ID；分页 offset 是当前投影的局部游标，流式插入时需重新刷新。
- 复用的精确命令候选恢复只检查最近 8 个命令锚点，系统证据不是全会话采集覆盖率。重复/并发同命令存在多个进程候选时拒绝自动选择。
- 当前支持实际验证过的 message/part SQLite 格式；旧 JSON 或未来仅 v2 event schema 尚未验收。FileAccess 范围保留已有 Kimi 目录并增加隔离 OpenCode data/workspace，未打开全主机文件转发。

## 部署与回退

API 最终镜像 `anysentry-api:opencode-v3-20260917`；Observer `anysentry-observer-wrapper:opencode-20260917`；Web `anysentry-web:opencode-trace-20260917`（基于同时更新的 `trace-20260917`，保留 Trace 功能）。使用 `scripts/deploy-harbor-live-canary.mjs` 的 opencode targets，保留原配置、密钥、挂载及旧容器。部署期间有受控服务重启，不能声称零采集间隙。

回退时先停止并重命名当前容器，再将对应 `*-before-live-*` 备份恢复原名并启动；不要删除数据卷或修改 Agent 会话源文件。API 初次接入前备份 `anysentry-anysentry-1-before-live-1789578838895`，Observer 初次接入前备份 `anysentry-observer-1-before-live-1789578852713`。后续版本的备份名称由部署命令输出。
