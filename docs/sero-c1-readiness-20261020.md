# SERO C1 就绪度评估（2026-10-20）

对象：SERO Unified Draft v0.1（A3S-Lab），贡献 C1「Registration-free actor–behavior identification」。
问题：以当前 AnySentry / Observer / AgentSight / Terminal-Bench 代码与数据，能否现在完成 C1？

结论：**不能。** 采集侧基本就绪，识别侧与评测侧缺件；按论文自己的否证条款，现在硬跑出来的数字会被 C1 直接排除。

---

## 1. C1 的六个硬门（来自 §2.5 / §4 R1）

| 门 | 论文要求 | 依据 |
|---|---|---|
| G1 | 评测方持有 `Y* = (Z*, B*)`，且运行期监控器完全读不到 | §2.2「Z*, B* 不写回运行期决策」 |
| G2 | 用冻结的 `φ`、`Q_εe`、`ℓΩ` 在评测侧算出 `A_v(D)`，并报告 `Err_v`、`Cov_v`、弃权 | §2.3.1–2.3.2 |
| G3 | 输出空间 `Z_v,K × P_v ∪ {unknown}`，且弃权不等于错误、不掩盖采集丢失 | §2.3.2 |
| G4 | held-out 实现或 harness 切分；跨实现迁移是问题的一部分 | §2.5.1、§2.5.2 |
| G5 | witness `W_v,k` + 删除检验（事实移除后决策是否变化） | §2.5.2 |
| G6 | 基线：AgentSight、Tracee、passive control、instrumentation upper bound | §4 R1 |

C1 被削弱（即做不成）的条件：matched passive 方法同质、held-out 迁移失败、依赖注册或身份捷径、事件采集到了但与正确 `Y*` 关联不上。

---

## 2. 现状对照

### G1 独立 `Y*` —— 未满足（最关键）

- 当前 `recordId` 是采集侧产物，不是评测方标签；`Z*`、`B*` 没有外部冻结定义。
- 五个原生适配器（kimi / claude-code / gemini-cli / opencode / a3s-code）能直接读出 agent 自己的 Session 与 tool call，这**正是论文列为「instrumentation upper bound」的那条基线**。把它同时当 `Y*` 又当监控输入，就是循环论证，且违反 §2.2「不带协作标记」。
- 归属绑定走 `ebpf_session_file` / `proc_fd`（内核侧）——作为独立证据链是合格的，但与监控器共用同一条事件流，误差相关，不能当 oracle。

### G2 评测侧度量 —— 未满足

- 仓库内没有 `A_v(D)`、`ℓΩ`、`Q_εe` 的任何实现；`grep -r "witness"` 在 `apps/`、`scripts/` 零命中。
- 现有数字是采集器/API 自报的归属计数（`歧义 0、冲突 0、未归属 0/1`），属于「已观测事实的查询完整性」，文档本身已声明不是覆盖率（`docs/kimi-kernel-monitoring-20261012.md`）。
- `|D| = 1`：当前只有一个可用窗口（记录 `c801034b467aab7869154748`）。单窗口跑 `A_v` 会把每个样本切成 singleton class，论文明确「切成 singleton 不算识别增益」。

### G3 输出与弃权 —— 部分满足

- `unknown` / `unattributed` / `partial` 状态齐全，采集丢失有独立计数（`calls_oversized`、`dropped`、`output_dropped`），这一条是全篇最扎实的部分。
- 但行为侧几乎全弃权：该记录 loaded window 84 个 tool call → `candidate 9 / unmatched 39 / unsupported 36 / confirmed 0`，`partial=true`；记录级 `toolCallCount=162`。
- 即：actor 侧覆盖率可测，behavior 侧可信绑定 0%，条件错误率无从计算。

### G4 held-out 实现 —— 未满足

- `agentsight/.local/harbor-recordings/` 与 `terminal-bench/.harbor-jobs/` 中全部为 `kimi-*`，无 codex / claude / gemini / opencode 任何一次运行。
- 更硬的阻塞：Observer 转发白名单为 `kimi-cli, opencode, claude code`，**Codex 明确不转发**（`docs/kimi-kernel-monitoring-20261012.md`）。想拿 Codex 做 held-out，先改转发链路。
- 因此当前只有一个 `H` 取值，`H` 切分不存在，C1 的迁移问题无法提出。

### G5 witness / 删除检验 —— 未满足

- 决策不落「支撑事实集合」，无法做 `E \ {e}` 重算。`trusted-correlation.ts` 只保留合成后的关联视图，不保留逐事实依赖。
- 这一条必须新建，不能靠现有 `provenance` 字段拼。

### G6 基线 —— 部分满足

| 基线 | 状态 |
|---|---|
| AgentSight | 有，同题四轮对照数据可用 |
| passive control | 无实现（工作量小） |
| instrumentation upper bound | 有（原生适配器），但当前混在监控路径里，需剥离 |
| Tracee | 未接入 |

### 版本与 ⊕ —— 有骨架，非 C1 语义

`unknown-learning` 已有 `candidate → shadow → replay_validated → canary → enforced`、`revision`、`rollback`、审计链，是现成的 `⊕` 骨架。但它作用于检测规则策略，不是识别能力 `L_v`；也没有 `δA`、`ρ_future`、`ρ_old`、coverage floor 这组验收不等式。

---

## 3. 评分

| 门 | 状态 |
|---|---|
| G1 独立 Y* | ✗ |
| G2 度量实现 | ✗ |
| G3 输出/弃权 | ◐（采集侧强，行为侧 0% 可信） |
| G4 held-out H | ✗ |
| G5 witness | ✗ |
| G6 基线 | ◐ |
| ⊕/版本 | ◐ |

**约 1.5 / 6。** 缺的不是探针，是「评测契约」。

---

## 4. 如果现在硬跑会得到什么

一个看起来能写进论文、但会被 C1 自己否掉的数字：

- `Cov` 用事件级归属率（≈100%），`Err` 用「歧义 0」当正确率 → 循环，因 `Y*` 来自同一链条；
- held-out 迁移无从计算 → 只能报同实现内结果，正好触发「held-out transfer fails」；
- 行为侧 `confirmed = 0` → 无论 `Err` 取多少，`P_v` 全是 `⊥`，`A_v` 退化为「actor 单侧可识别性」，不是 C1 的 actor–behavior 联合关系；
- 单任务、reward=0（配额 429 中断），`n=1`，无法做保留集 `D_old` 与未来集 `D_future`。

---

## 5. 最小可执行路径

### P0（不做则 C1 无法起跑）

1. **冻结评测契约**：定义 `Z*`（容器 + 启动代际 + 命名空间）、`B*`（外部行为关系类型，不含自由文本）、`ℓΩ`（actor 用共实例、behavior 用固定类型匹配）、最小有效覆盖率下限。落成 `docs/sero-c1-contract.md` + 一个只读的 `scripts/sero-c1-eval.mjs`。
2. **造 oracle**：用 Harbor 侧真值（容器↔任务↔请求序列）+ 原生 Session 日志交叉生成 `Y*`，生成后**冻结并对运行期隐藏**（单独目录、独立进程、监控器无读权限）。
3. **剥离监控路径**：新增 kernel-only 模式，关闭五个原生适配器，监控器只吃 `E_v,k`（eBPF 事件 + LLM 明文）。否则 C1 的 non-intrusive 主张站不住。
4. **补行为侧绑定**：把 `confirmed` 从 0 抬起来。当前 9/84 candidate、0 confirmed，C1 的行为错误率没有意义。这是最大的工程量，优先级高于再跑评测。

### P1（决定 C1 能不能出结论）

5. **held-out H 切分**：训练/校准用 Kimi，测试用 Codex 与 Claude Code。前置：把 Codex 加入 Observer 转发白名单，并确认 codex 的明文与进程证据链能跑通。
6. **基线补齐**：Tracee 接入、passive control、把原生日志固定为 upper bound 独立跑。
7. **规模**：≥3 实现 × ≥8 任务 × 2 并发档（含并发干扰项）。并发档是必需的——单容器单 agent 时 `Z*` 退化，识别问题不存在。现有 S1/S2/S3 是「两探针对同一次运行」，不是「一条流多归属」，不能直接复用。

### P2（C1 的加分项，可后置）

8. witness 落盘 + 删除检验重算。
9. 类别规模与 singleton 比例报告（防止把切碎当增益）。
10. `A_v` 与运行时 surrogate `Â` 的校准曲线（公共校准集）。

---

## 6. 一句话

**C1 现在做不了，但不是因为采不到——是因为还没有「谁的证据、按什么规则、算作对」这套评测契约，也没有第二个实现来做 held-out。** 采集侧四轮 8%→100% 的成果，是 C1 的必要条件，不是充分条件。按上面的 P0 顺序做，C1 的第一个可信数字大约在「行为绑定 confirmed 起来 + 至少两个实现」之后才出现。
