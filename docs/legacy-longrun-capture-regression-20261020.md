# legacy-utility-triage 长程请求采集回归（四轮终表）

**日期**：2026-10-20
**对象**：AnySentry Observer（`a3s-observer-wrapper:kimi-fragment-fix-20261020`）
**评测**：Terminal-Bench 2.1 `legacy-utility-triage`，Kimi Code CLI（`kimi-code/k3-256k`），AgentSight 双观测
**产物**：`agentsight/.local/harbor-recordings/kimi-s3-legacy-fragfix-20261020`、`terminal-bench/.harbor-jobs/kimi-s3-legacy-fragfix-20261020`

---

## 一、结论

| 验收线 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 请求采集率 | ≈100% | **162 / 162 = 100%** | PASS |
| `calls_oversized` | 0 | **0**（全窗口，含 >4 MiB 重链期） | PASS |
| `pump_rechained` 处理 >4 MiB | 无失败 | **231 次重链，`pump_rechain_failed=0`** | PASS |
| `jump_table_entries` | 稳定为 1 | **38/38 个采样点均为 1** | PASS |
| 显式丢失告警 | 0 | **0 条 `capture loss` / `tls_call_truncated`** | PASS |

这是 legacy 长程题第一次做到"一条不丢、且丢失账本全程为零"。此前的所有轮次都存在整请求丢弃或整条 lane 停采。

**但本轮任务本身 reward=0.0**：不是采集缺陷，是容器内 kimi 撞上 5 小时配额 429（详见第五节）。采集结论在配额耗尽前的时间窗内完整成立。

---

## 二、四轮对比终表

| 轮次 | 生产镜像 / 关键改动 | native `llm.request` | AnySentry 采集 | 采集率 | 丢失形态 | AgentSight | 任务结果 |
|---|---|---|---|---|---|---|---|
| R1 基线 | `kimi-keepalive-20261015`（1 MiB 硬顶） | 188 | 15 | **8.0%** | 第 16 个请求起单写越过 1 MiB，整请求丢弃且不可自愈 | 170（90.4%） | 0.0 |
| R2 调上限 | `kimi-oversize-20261020`（4 MiB + `calls_oversized`） | 232 | 43 | **18.5%** | 4 MiB 仍被 8–15 MiB 尾部单写击穿；`calls_oversized=189` 与丢失 1:1 | 181（78.0%） | 0.0 |
| R3 分片首版（P0） | `kimi-fragment-20261020`（tail-call 泵，跳表句柄被 drop） | 144 | 4 | **2.8%** | 前 4 个请求正常后整条 lane 静默；回滚后剩 4 MiB 顶继续丢（`calls_oversized=24`） | 125（86.8%） | 0.0 |
| **R4 分片修复** | **`kimi-fragment-fix-20261020`**（句柄常驻 + 主帧尾调用 + 全套泵计数） | **162** | **162** | **100%** | **无**（`calls_oversized=0`、`calls_incomplete=0`） | **159（98.1%）** | 0.0（配额） |

趋势：**8.0% → 18.5% → 2.8%（P0 回归）→ 100%**。

R3 的 2.8% 不是退步，而是暴露了更深的缺陷（跳表为空导致泵从未运行），修复后 R4 直接到 100%。

---

## 三、R4 关键证据

**记录**：`c801034b467aab7869154748`（`session_db87e6cd-8d54-420f-8033-52edfd947eba`，cwd `/workspace`）

| 项 | 值 |
|---|---|
| `observedLlmRequests` | 162 |
| 响应字段完整性 | 162/162 `completeness=complete`、`parseStatus=parsed`、`contentAvailability=available` |
| native wire `llm.request` | 162（主会话 1166 为宿主机历史累计，不计入本题） |
| 归因 | `binding_method=observer_request`，`kimi-proc:1345073:46384207`，ambiguous/conflict 均为 0 |
| 工具调用 | 162（candidate 80 / unmatched 9 / unsupported 73） |
| 内核事件（窗口） | FileAccess 1103、ToolExec 650、Egress 366、ProcessExit 171 |
| token | input 16,278,451 / output 37,551 / cached 16,108,318 |

**>4 MiB 路径被真实跑通**（这是作者 10 分钟 E2E 覆盖不到的部分）：

```
pump_stashed=163      # 进入泵的调用数（≈本题 162 + 宿主 1）
pump_entries=394      # 泵跳数（每跳 ≤ 4 MiB）
pump_rechained=231    # 231 次自链，全部成功
pump_rechain_failed=0
pump_tailcall_failed=0  pump_stash_missing=0  pump_loop_failed=0
pump_emit_output_failed=0  pump_ceiling_clamped=0
pump_hop_completed=163
```

按 394 跳 / 163 调用反推，单请求平均约 **9.6 MiB**——与 K2.8 `thinkingEffort=max + thinkingKeep=all` 全量重发历史时的 8–15 MiB 尾部单写吻合。也就是说，本轮不是"没触发大请求所以看起来没丢"，而是**大请求全部走了分片泵并成功重组**。

**请求方向账本**：`requests_completed=231`、`requests_parsed=167`（162 本题 + 宿主若干）、`requests_ignored=65`（非 allowlist provider/遥测）、`parse_failed=0`、`capacity_dropped=0`、`calls_incomplete=0`。

**响应方向账本**：`fragments_observed=3918`、`responses_completed=158`、`responses_paired=158`、`responses_failed=2`、`responses_timeout=9`、`parse_failed=0`、`capacity_dropped=0`。

---

## 四、`jump_table_entries` 生产读数（本次要求复核项）

采样区间 11:53–12:44 UTC（19:53–20:44 +08），共 50 个 60 秒心跳，其中回归窗口 38 个：

| 指标 | 结果 |
|---|---|
| `jump_table_entries` | **恒为 1**（无一次为 0） |
| `pump_tailcall_failed` | 0 全程 |
| `pump_rechain_failed` | 0 全程 |
| `pump_stash_unavailable` / `pump_stash_missing` | 0 全程 |
| `pump_loop_failed` | 0 全程 |
| `pump_emit_output_failed` | 0 全程 |
| `pump_ceiling_clamped` | 0（未触 16 MiB 天花板） |
| `ssl_record_parse_failed` | 0 全程 |

结论：跳表句柄常驻的修复在**生产连续 50 分钟**内稳定成立，R3 的"句柄 drop 导致空表"形态未复发。

---

## 五、任务结果与采集窗口的边界

- 容器内 kimi 在 UB-016（19 个用例中的第 16 个）时收到 `429 You've reached your 5-hour usage limit`，`NonZeroAgentExitCodeError` → `reward=0.0`。
- 运行时长 19:53:24–20:29:55，其中采集在 19:54:02–20:28:42 持续入账 162 条，**中间无断档**（每分钟 0–10 条）。
- 因此本轮能证明的是"配额耗尽前的 162 个请求 100% 采到"，不能证明"完整跑完 19 题的全程采集"。若需后者，应在配额重置后重跑一次同题。

---

## 六、与 AgentSight 对比

| 系统 | 请求采集 | 说明 |
|---|---|---|
| AnySentry | **162/162（100%）** | 分片泵 + 16 MiB 天花板，无 cap 丢失 |
| AgentSight | 159/162（98.1%） | `record.db.llm_calls=159`；仍受约 256 KiB 请求体上限约束，尾部最大请求会漏 |

AgentSight 另有 158 条 tool_calls、645 个进程节点；但**没有 kimi 的 agent-native session 解析**，`session_id` 恒为 null，页面按 proc trace 展示，无法按会话聚合。AnySentry 这边归因到具体记录与进程代际（PID 1345073），这是两者在"可调查性"上的实质差异。

---

## 七、遗留

1. **配额**：容器 OAuth 与宿主机共享 5 小时窗口，长程评测会撞 429。建议评测前确认配额余量，或为评测单独准备配额。
2. **`requests_ignored` 65**：非 allowlist provider（claude 等）与遥测连接，按设计忽略；若后续要覆盖多 agent，需要扩 allowlist。
3. **响应 `responses_completed=158`（对应 162 个请求）**：差 4 条是配额 429 截断与流式未收尾；`responses_unpaired=75` / `responses_timeout=9` 主要为宿主侧非 chat 连接与超时窗口。请求方向不受影响。
4. **R3 教训固化**：泵相关计数器已进 60 秒心跳，后续任何分片异常可直接读 `pump_*`，不必再靠 bpftool 事后定位。
5. 生产仍是 `kimi-fragment-fix-20261020`（`jump_table_entries=1` 已连续 50 分钟），回滚点与 `.env` 同步状态未变。
