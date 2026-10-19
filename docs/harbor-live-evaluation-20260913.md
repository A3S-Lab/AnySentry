# 新链路 Terminal-Bench 单任务验收

2026-09-13，用户要求用修复后的版本重新评测。

完成状态补记：该 Job 已于 17:39:34 完成，`n_completed_trials=1`、`n_errored_trials=0`、reward/mean=1.0。
下文保留执行中的阶段审计，不能把旧“进行中”描述当作当前状态。模型任务通过不等于观测完整；
后续日常 Codex 归因修复与新测试见 `session-tail-resume-repair-20260913.md`。

## 已部署

- API：`anysentry-api:harbor-live-20260913`，仅替换 LocalRecordTrackingService，基线为之前运行的 `anysentry-api:modules`。
- Observer：`anysentry-observer-wrapper:harbor-live-20260913`，只替换新 Collector/eBPF 二进制，保留原 Forwarder 挂载和配置。
- 已核对容器与已测试文件的 SHA256 一致：
  - Collector `32f2b04ee528141bb4633c0fe2b2bcf01d362066acc36ff9c2a0f99b5127846f`
  - LocalRecord service `54ff5432e96ba71f2482f113bc7cf85619aeb6ef0644440f901b02fd48671b92`
- API、ClickHouse、PostgreSQL 健康；Observer 探针已挂载，Codex allowlist 生效。
- 保留原容器，不删除数据/卷：
  - `anysentry-anysentry-1-before-live-1789288626599`
  - `anysentry-observer-1-before-live-1789288652836`
- 使用 `scripts/deploy-harbor-live-canary.mjs` 保留原 Env（只在内存使用，不输出密钥）、挂载、网络别名和权限进行窄范围切换。
  这是本地 canary，不是 Compose 声明配置已永久更新；后续 Compose recreate 前须显式指定新镜像，避免回到旧版。

## 评测配置

Job：`observer-live-20260913-1638`

任务：`terminal-bench/layout-config-recreation2`，数据集 `terminal-bench/terminal-bench@4.0.0`。
模型：`openai/gpt-5.6-sol`；Harbor 0.22.0；Agent 为新的 `scripts.harbor_live_codex:LiveCodex`。
单任务、单并发、一次尝试；不是全量 66 任务。

首次任务过滤使用短名未匹配到任务、未开始 Trial；改用包含 `terminal-bench/` 前缀的完整任务名后正常创建 Trial：
`layout-config-recreation2__9xsqgPK`。

```bash
cd /home/zhongyule/code/terminal-bench
bash scripts/run-codex-chatgpt-progress.sh \
  -d terminal-bench/terminal-bench@4.0.0 \
  --include-task-name terminal-bench/layout-config-recreation2 \
  --n-tasks 1 --job-name <新的唯一名称>
```

本次任务已经启动，不要复制命令另开一次。

## 观察边界与审计

- 延用受控 `runtime_payload`、Codex-only 配置；不是只过滤该 Trial 的所有内核采集，审计按本 Job 的 Native Session 隔离。
- `A3S_OBSERVER_FILES=0`，本轮主要测进程/Shell/网络与 Session 归因，不代表文件访问/删除覆盖通过。
- 新 API 的实时 FD 绑定依赖记录列表被轮询。`scripts/watch-harbor-observation.mjs` 每 20 秒轮询并触发既有后台绑定，
  每三轮查询一次该 Job 的 Session 证据，不输出指令正文或凭据；最多运行 9 小时。
- 审计持久文件：`.harbor-jobs/observer-live-20260913-1638/observer-audit.jsonl`。
- Job 结束后再采样三轮，写入同目录 `observer-audit.md`，包含模型得分与 Session/证据计数。
- 任务得分来自同目录 `result.json`，需要 `finished_at` 非空才是最终结果。
- Session DIRECT/LINEAGE 数不是 Tool Call 精确匹配率；仍需逐条对应 Native Shell 与系统 exec，不能用关系总数除以工具数。
- 全局 Collector 仍出现 argv incomplete/truncated 计数（也包含其他 Codex、平台依赖安装等）；尚未据此得出本 Trial 的缺失率。

## 已确认的阶段结果（不是最终结果）

16:43 起原生 Session 在任务结束前实时可见：`01a099ef-22af-7be3-b976-82f58bf036cd`，
记录 ID `6aca4fae7e38afb1e305aa33`。列表 PID `190344` 是 launcher，精确 FD 写入进程 PID `190389`；不能混用。
16:43:45 的 API 快照：DIRECT 34、LINEAGE 172、AMBIGUOUS/CONFLICT/UNATTRIBUTED 均 0，
其中 ToolExec 114、ProcessExit 59、Egress 33。随后 PostgreSQL 确认 proc_fd 绑定以及 206 条关系已写入。
页面的 `persistence=degraded` 是该查询快照状态，不可仅凭它断言完全没有入库；已额外查库核实。

本次 Native 工具采用 `custom_tool_call: exec` 的 JS 包装调用，不能将包装调用次数当作 Shell 次数。
审计脚本已改为分开输出 `directShellCalls` 和 `wrappedExecCalls`；早期 audit 行的 `shellCalls=0`
仅表示没有匹配到直接工具名，不表示没有执行 Shell。

当前尚无完成得分/最终覆盖率；不能预先判定本轮成功。

### 本轮新发现：相同 PID 代际的身份分裂

16:45 的后续查询出现第二条绑定。PostgreSQL 实查同一 Native Session、PID `190389`、
`ticks:35243794` 对应：

- `spb_574829b05b1864f56185dc32` / `pri_4da8de1905e68f0ca58faa99` / pidNamespace `4026535075`。
- `spb_efc087fea918b49871cb81bc` / `pri_e5cbdb2eba9f3aff6c7a5314` / pidNamespace 为空。

查询切换后关系数量从 248 降至 48（当时的快照），不能解释成工具停止执行。
这证明真实链路仍有“完整身份与缺失 namespace 身份共存”的归因问题，当前版本不能宣称已完整修复。
发现问题时计划保留固定版本到结束；随后用户要求“修复”，17:11 已进行 API 窄更新，任务和 Observer 未重启。
因此这份审计横跨补丁前后两个 API 版本，不能当作单一固定版本覆盖率结果。
缺失 namespace 的来源为 Interaction 映射/合约；三轮在线查询已稳定选择完整身份并恢复子进程证据。
具体变更、验证数据、部署与未完成的后台回填见 `harbor-namespace-stability-repair-20260913.md`。
审计保留两种历史绑定身份，不能删除补丁前异常或只展示最后一次计数。

查看进度：

```bash
bash /home/zhongyule/code/terminal-bench/scripts/watch-harbor-progress.sh \
  /home/zhongyule/code/terminal-bench/.harbor-jobs/observer-live-20260913-1638
```
