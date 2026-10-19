# Harbor Session namespace 身份稳定性修复

## 根因与修复范围

真实单任务 `observer-live-20260913-1638` 的 Session
`01a099ef-22af-7be3-b976-82f58bf036cd`，PID `190389` / `ticks:35243794`，出现两条身份：

- 完整：`spb_574829b05b1864f56185dc32` / `pri_4da8de1905e68f0ca58faa99` / namespace `4026535075`。
- 缺失 namespace：`spb_efc087fea918b49871cb81bc` / `pri_e5cbdb2eba9f3aff6c7a5314`。

Observer 的 Interaction 转发映射和 API Process 合约没有透传 namespace。
部分身份在短生命周期查询窗内能补齐；根进程退出查询窗后，旧 fallback 生成缺失 namespace 的新 key。
持久绑定查询又按最新时间选择，导致完整进程树与弱身份之间切换。不是用户突然不再执行工具。

本轮修改：

1. `observer-interaction-forwarder.js` 透传同 PID 的 pidNamespace/namespacePid/namespacePpid。
2. `interaction.types.ts` 对 metadata 和正文元数据通道接受、校验、保留上述字段。
3. `session-event-attribution.service.ts` 对部分身份复用唯一已验证完整代际；缺少完整事实时不再创建弱身份。
4. `relational-business-store.service.ts` 查询按 host/boot/namespace/tenant/environment/collector 限定，优先完整身份；多身份冲突或结果截断时拒绝猜测。

不修改原生 ToolExec 类型，不删除历史绑定，不用名称、时间或 PID 单独判定归属。

## 验证

- `pnpm build:api` 通过。
- `verify-session-event-attribution.mjs`：六次完整/部分元数据交替，覆盖根进程超出窗口、PID 复用、跨 Session/collector、namespace 冲突、弱历史绑定；原有嵌套/并行回归通过。
- `verify-session-namespace-stability.mjs`：三轮持久查询测试，完整身份优先、冲突/截断 fail-closed。
- `verify-observer-interaction-forwarder.mjs`：namespace 经正文/metadata 校验后保留；其他 PID 不借用 namespace；加密 WAL/重放/丢失台账通过。初次新断言误读 validator 的 `.process`，改为其实际返回结构 `.metadata.process` 后重跑通过。
- `verify-harbor-parent-tgid.mjs`、`verify-harbor-process-key.mjs`、`verify-session-fd-ownership.mjs`、`verify-local-record-tracking.mjs`、`verify-harbor-live-fd.mjs` 均通过。
- `verify-agent-interaction-metadata.mjs`、`verify-agent-interaction-content-service.mjs`、`verify-agent-interaction-service.mjs` 均通过。

## 实际部署与三轮在线复查

2026-09-13 17:11 左右，仅部署 API 的三个编译文件：
`anysentry-api:namespace-stable-20260913`（基于 `anysentry-api:harbor-live-20260913`）。
旧容器保留为 `anysentry-anysentry-1-before-live-1789290671049`，配置、凭据、挂载与数据库保持不变。
任务容器和 Observer 均未重启。API 健康和 ClickHouse 就绪检查通过。

**Forwarder 的 namespace 透传源码已修复和测试，但当前 Node 进程尚未重载。**
为避免正在评测时造成采集缺口，待任务结束后再重启 Observer 并核对新 Interaction 的 namespace。
线上 API 已能正确处理当前旧 Forwarder 产生的部分身份。

运行以下只读验证：

```bash
node scripts/verify-live-session-namespace.mjs \
  6aca4fae7e38afb1e305aa33 pri_4da8de1905e68f0ca58faa99
```

三次实际响应（北京时间）：

| 时间 | DIRECT | LINEAGE | ToolExec | ProcessExit | Egress | 歧义/冲突/未归因 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 17:12:27 | 168 | 746 | 492 | 255 | 167 | 0 / 0 / 0 |
| 17:12:54 | 170 | 753 | 494 | 260 | 169 | 0 / 0 / 0 |
| 17:13:21 | 172 | 765 | 501 | 265 | 171 | 0 / 0 / 0 |

三次均选择完整 key `pri_4da8de1905e68f0ca58faa99`。补丁前 17:11:04 的弱绑定快照仅 168 条系统事件、5 条 ToolExec。
任务仍在持续产生事件，前后数字不是固定输入的严格覆盖率对照。

## 尚不能宣称的结论 / 后续

- 这证明修复了本 Session 身份分裂与子进程证据不可见，不代表所有 Shell 调用达到 100% 精确匹配。
- 原生 `custom_tool_call: exec` 是 JS 包装，可能包含多个工具；不能用系统事件数除以包装调用数求覆盖率。
- 三次查询 `completeness=complete_as_observed` 仅指已观测事实，且 `persistence=degraded`，不能宣称数据库已完整重算。
- 17:13 PostgreSQL 实查：完整绑定仍有 206 条持久关系，旧弱绑定 178 条；两条历史绑定保留，没有新建第三条。API 实时投影恢复与后台持久增量/全量回填是两件事。
- 后台仅扫描近期 Interaction；唯一请求变旧后可能缺少绑定桥接，且列表触发式调度可能漏短任务。需另补有界独立调度及长时任务的持久绑定复用，再对本 Job 分批回填。
- 本轮 FILES=0，没有验证文件访问覆盖；TLS 丢片/重组丢失与 Native Shell 逐条对应仍需最终审计。
- 该任务截至验证仍运行，未读取到最终得分；不要重复启动，也不要把一个任务当作全部 66 个任务。
