# 基于已完成 TB2.1 双观测的 SERO v0.23 自进化实施分析

日期：2026-11-11。结论：已有材料足以做缺口发现和原型设计，但没有证据证明 C1→C2→C3 自进化已经成立。先修评测解释，再验证证据关系，最后在新执行上验证能力增长；不能把漏采修复、轨迹总结或事件数量增加包装成 C3。

## 1. 本次实际读取范围

- 论文：`/home/zhongyule/下载/SERO_UNIFIED_DRAFT_v0_23.pdf`，14 页；重点为 §2、§3.1–3.3、§6、附录 B.3/B.4。
- 扫描 28 个 `eval/kimi-pro31*/results.json`，229 行，按 job 去重 228 个，涉及 89 个任务名。包括中断、恢复和仍在进行的批次，不能称为全量完成。
- 严格限定含 `finished.json: state=completed` 的 18 个目录：161 个去重 job，50 个任务名。其中 160 个有双方比较且未标 invalid_trial，140 个 reward=1、20 个 reward=0；13 个有 analysis_warning。完成标记只证明脚本完成，不证明原始事件完整、归属正确或任务家族独立。
- 逐项阅读了 11-02 并发轮、11-09 ready17、11-11 已完成轮次报告，并检查六类任务的 claims、claim_checks、observer-evidence；不是人工审完全部原始事件。
- 来源与每条归档状态见 inventory.json。未触发新评测、未修改生产配置。

## 2. 发现的具体问题

| 案例 | 已核实事实 | 应如何处理 | 能否直接进入 C3 |
|---|---|---|---|
| mcmc-sampling-stan；sqlite-with-gcov | 已完成样本中 judge_claim_count=0，analysis_warning 明确写 Judge context too large；没有 critical-claims.json | 长轨迹分段提取、保留来源和未处理段，零清单必须显示未判定 | 否，属于分析工具限制 |
| log-summary-date-ranges | 模型选出 Python 汇总和校验，但双方匹配为 0；归档中实际存在对应 Python exec，AnySentry 所见 argv 为 300 字符，AgentSight 为 255 字符；选择器依赖代码深处片段 | 核对参数在哪层缩短；无足够内容时保持歧义。修复离线参数解析/匹配不是 C3；新增外部证据须在新执行中采集 | 否，零匹配不是无执行证据 |
| large-scale-text-editing | 两家均记录实际 Vim 执行；模型文件命题均 not_machine_verified。AnySentry 此导出投影仅 3 条 FileAccess，未包含目标 CSV；AgentSight 有 Vim 对 input.csv 的 FILE_OPEN 写标志记录 | 先查原始采集、过滤、持久化、导出及路径映射。open 写权限不等于已成功写入内容；补定向写/rename/返回值证据 | 证据与归属门通过后，才是关联规则候选 |
| kv-store-grpc | 原型生成、服务器启动等程序可匹配；代码生成文件、pip 网络和本地 RPC 仍 not_machine_verified；导出有文件、连接与监听事实 | 区分依赖下载与任务 RPC，按进程代际、netns、socket 端点核验服务实例和调用方关系 | 候选；当前不是已证明的残差 |
| video-processing | 多项 Python stdin 命题使用同一个 python - 选择器，多条命题命中相同进程集合 | 保留行为间歧义；程序被启动不证明程序内部完成抽帧、计算、写出等每项行为 | 不能从重复命中直接认定语义已验证 |
| 并发轮双方数量差与 unconfirmed | 部分轮次 AnySentry 更多，部分数据库实例 AgentSight 的关键 exec 更多，且存在重复候选 | 逐事件区分成功、尝试、重复、延迟、过滤、归属不明；双方差异仅用于定位 | 否，差异不是独立真值或新能力证据 |

文件事件缺失仅指已检查的导出投影；未据此判定生产采集器必然漏采。归档参数短也尚未定位到内核、Collector、API 或导出哪一层，不能先归因。

关键来源：

- `terminal-bench/eval/kimi-pro31-ready17-20261109-163510/kp31-wave-10-d-20261109-163510/comparison.json`
- `terminal-bench/eval/kimi-pro31-remaining37-20261111-051102/kp31-rem-1-a-20261111-051102/comparison.json`
- `terminal-bench/eval/kimi-pro31-ready17-20261109-163510/kp31-wave-9-e-20261109-163510/{critical-claims,observer-evidence}.json`
- `terminal-bench/eval/kimi-pro31-ready17-20261109-163510/kp31-wave-9-c-20261109-163510/{critical-claims,observer-evidence}.json`
- `terminal-bench/eval/kimi-pro31-ready17-20261109-163510/kp31-wave-9-b-20261109-163510/{critical-claims,observer-evidence}.json`
- `terminal-bench/eval/kimi-pro31-remaining37-20261111-015812/kp31-rem-3-a-20261111-015812/{critical-claims,comparison}.json`

## 3. 论文要求的闭环

C1：从外部事实形成匿名实例—行为候选，保留支持、反证、未覆盖事实和 unknown；输出须满足完整性与置信要求；对支撑事实做移除重算。PID 与真实路径可用于建立事实关系，但不能作为唯一窗口的识别类别或 residual 签名。

C2：在声明的观察通道、时间和成本范围 Ω 内，选择预计最能减少当前歧义的动作。查询已存记录和启动新探针分别计费；真实返回写入图，模拟返回不写入。resolved、resource_limited、value_limited 必须区分。没有实现并验证这个停止机制，不能凭模型一句“再也看不出来”进入 C3。

C3：仅对完整性与归属门通过、C2 停为 value_limited、同类残差在独立 episode 复现的情况提出更新。签名使用关系类型及粗相对顺序，不含 PID、具体路径、样本 ID。同一运行的多个窗口只算一次复现。阈值 r、α、κ、η、ν 要在公开校准后冻结，本文不事后指定通过值。

更新可为 BehaviorSpec、RelationSpec、范围内的 MonitorPatch 或其组合。监控 Agent 做 promote/revise/defer/reject 的语义决定；确定性代码检查来源、范围、资源、复现、回滚，并执行安装条件。新 Lv 必须真正被固定解释器 φ 和动作策略 π 读取，在后续执行改变证据类别、实际动作或输出。

运行期使用公开验证，不读取隐藏评测答案。最终 C3 验收在隐藏后续集 Df 上看混合度 A 的下降，并检查条件错误率、覆盖率与旧能力集 Do 的保留。只改文案、原任务回放成功、减少覆盖率来降低错误，均不能通过。

## 4. 建议的第一个原型：进程—资源—结果关联

先选择 `large-scale-text-editing` 的可核验外部关系作为候选场景，再用其他任务家族的文件转换/构建/导出行为检验迁移。不是先写死“文本编辑”标签。先让冻结的 M0 在外部事实下运行：如果 M0 已能识别，或 C2 补充事实后已能识别，就不能把这个场景算作 C3 成果。

试点步骤：

1. 只给监控器外部事实投影，隐藏 task 名、原生 Session/tool log、官方评分及期望答案。原生轨迹保留在评测侧，帮助定义工具事实，但不冒充内核真值。
2. 恢复完整的进程代际和文件对象关系；对声明的文件动作取得定向证据，例如目标文件写入、rename、返回状态。后验哈希/verifier 只能证明终态，不证明确切写入进程；FILE_OPEN(write=true) 也不能替代成功内容写。
3. 由 M0 输出竞争解释和事实引用，例如只运行编辑器、实际修改资源、随后验证资源三者尚未区分，不能强迫它输出预先命名的行为。
4. 执行 C2：查询已有文件事件、补查 namespace/挂载映射；必要时在新执行中启动范围受限的文件或 IPC 探针。成功取得更多证据后若已能消歧，记为 C2 收益。
5. 若观察动作价值耗尽后仍存在相同结构性残差，且不同独立执行也复现，再让 Agent 自己生成关联条件及拒绝条件。人工给出的示意规则只能算设计或人工基线，不算自动生成。
6. 以 RelationSpec 安装新能力，保留原模型、解释器和预算。Actor、资源和时序约束必须可机器检查；失败操作、其他实例写同一路径、并发验证等作为反例。
7. 公开验证通过后形成 M1；在预先隔离的新任务家族与新执行上比较 M0/M1，并回归旧能力。若只帮助了触发任务，报告局部工程收益，不报告通用自进化。

这个原型的目标是理解可核验的外部行为关系，不推断编辑宏的正确性、视频语义或模型隐藏推理。

## 5. 最小模块与复用范围

| 模块 | 输入/输出 | 现有基础与缺件 |
|---|---|---|
| evidence projector | source event → 匿名进程、对象、时间、事实图 | 复用 Observer/WAL/事件库；补源事实与解释隔离、完整性账本 |
| identifier + witness | 图、Lv → 候选/unknown/逐事实依赖 | 归属字段可复用；补开放候选、校准与移除重算 |
| acquisition controller | 歧义 → 有范围的查询/探针/停止状态 | 已有查询与采集入口；补价值估计、真实成本及停止账本 |
| residual gate | 终态、完整性、归属、独立复现 → 合格候选 | 新建；禁止把丢弃、分析超长和漏读当成能力缺口 |
| capability registry | Agent 提案 → 不可变 Lv、可执行规则 | 新建论文 schema；现有 unknown-learning 的 keep/sample/aggregate 不等价于此能力 |
| promotion + evaluator | 公开验证、安装 → 新版；隐藏集 → 是否支持 C3 | 复用灰度/回滚/审计；补 Active、A、Err、Cov、旧能力保留测试 |

建议记录 `ResidualRecord`：事实引用、竞争解释、完整性、归属、动作成本、停止原因、独立 episode ID 和匿名关系签名。

建议记录 `UpdateCandidate`：base version、残差来源、Agent 提案、BehaviorSpec/RelationSpec/MonitorPatch、预算、作用域、公开验证与回滚。

建议记录 `ActivationReport`：M0/M1 在公开验证上实际变化的类别、动作、输出；没有变化时 Active=0。

## 6. 实验及下一步

先把现有归档当发现与回归材料；这些已查看结果不能事后声称为预注册隐藏测试。历史回放不替代线上 C2，不可回填当时没有的事实。下一轮提前冻结任务家族切分：发现、公开验证、隐藏后续、旧能力保留；同一任务的种子和派生变体不能跨发现/验证/Df。跨 harness 主张另需至少两个实现，单 Kimi 只能支持限定条件下的结论。

四个对照：冻结 M0；仅主动补观测而不更新；完整 C1+C2+C3；相同更新/观测预算的非残差驱动增长。AgentSight 保留作采集与归属比较，不是 C3 的充分对照，也不能担任独立真值。

先实现离线 residual audit（不安装能力、不改探针），输出四类：工程/分析问题、证据不足、归属不足、待检验语义残差。再选少量任务补定向真值与 C1/C2。只有实际通过 gate 才开始第一个能力更新。

验收必须展示：独立执行中的复现、公开验证与安装、新执行上的 Active、隐藏 Df 上 A 降低且错误/弃权在容差内、Do 不退化、拒绝与回滚案例、成本与损失账本。事件增多、候选数量下降和模型置信度变高均不单独构成 C3。
