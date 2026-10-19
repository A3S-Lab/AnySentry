# 日常 Codex：退出尾部补算与恢复 Session 多代际修复

日期：2026-09-13。原始问题与失败样本保留在 `daily-codex-observation-20260913.md`，不要覆盖为通过结果。

## 修改范围

- `local-record-tracking.service.ts`：每 30 秒有界后台发现，不要求浏览器保持打开；同一 Session 按 PID + start ticks 分别保留补算项，退出后保留 10 分钟并重复扫描冻结的尾部窗口。只有完整且已持久化的结果才能推进该代际 checkpoint。
- 恢复 Session 后，详情合并最近最多 4 个明确进程代际，而不是 active 时只取旧代际；超限和合并截断会标记 partial / hasMore，不伪装成完整。
- 补强：近期明文请求明确携带 Native Session/thread ID、host、boot、PID/start ticks 时，可以发现未被可写 FD 扫描看到的短进程。仍由正式绑定/生命周期算法验证，不以裸 PID、名称或时间邻近猜测，不把 FD 缺失伪装成进程退出。
- `verify-session-tail-resume.mjs`：退出尾部、晚到事实、PID 复用、持久化失败不推进、过期有界、恢复代际合并/分页、独立调度，以及无 FD 的明确请求发现与缺失/错误身份拒绝。
- 新增窄镜像和部署目标；只替换 API 的上述编译模块，保留原镜像/容器作回退，没有清库、删卷或更改原生 ToolExec 展示。

## 已取得的真实结果

### 旧失败样本重放（不是自动恢复验收）

目录 `/tmp/anysentry-daily-codex-PDcOqI`。旧 A3 `evt_c4ed6cc21e030d93` 原无持久关系；旧 A4 `evt_ba5430473dc3ff8e` 原已持久归因但详情不可见。

API v1 部署后，仅对 `spb_49442050c1cd6c9d513747d2` 的窗口 `1789291780000–1789292020000` 使用 `scripts/replay-session-binding.cjs`，先只读演算、再显式 `--apply` 正式算法重放。没有手工拼接关系或改事件 PID。重放 26 DIRECT / 143 LINEAGE；20:03 复核 6/6 标记采集、详情可见、持久归因均通过。

### 全新 v1 测试（自动持久化）

目录 `/tmp/anysentry-daily-codex-G9SDwB`，标记 `mtzrk7j9`。5 次 CLI 调用 / 4 个 Native Session：无工具、顺序含嵌套 Shell、双并行、恢复原 Session。沿用已登录本机 Codex 配置。

20:07:15 的独立分析结果：

| 核对项 | 结果 |
| --- | --- |
| Native 与 eBPF 解析的用户指令一致 | 5/5 |
| 受控 printf 实际执行、完整 argv / exec_confirmed | 6/6 |
| 正确 Session 详情中可见 | 6/6 |
| PostgreSQL active DIRECT/LINEAGE 关系正确 | 6/6 |
| 不同测试 Session 的系统事件 ID 交集 | 0 |
| 已采到的外部负对照混入测试 Session | 0 |

未对此新样本手工重放。A3 `evt_f214885fc910a067` 已自动补齐；A4 `evt_67b262e570aba3dd` 早期查询尚未持久化，最终已有 `spb_e968a119e753bcee26f9931e` 正确关系。该绑定 method 是 `proc_fd`：只能确认后台归因有延迟，不能据早期缺失断言错过 FD。无 FD 的请求发现是额外边界补强，由专项用例验证。

### v2 无测试脚本页面轮询验收

已部署 `anysentry-api:tail-resume-v2-20260913`；备份 `anysentry-anysentry-1-before-live-1789301539189`。模块 SHA256：`e5bd5a53df25c4e78e1cba8c859bc64ed89f6f0543a4bf73ebccaee8f2828aaf`，运行文件与本地编译产物一致。API、ClickHouse、PostgreSQL 健康，Observer 未重启。

运行 `node scripts/test-daily-codex-observation.mjs --headless`，产物 `/tmp/anysentry-daily-codex-5tuZc0`，标记 `mtzrymyn`。CLI 从 20:12:59 到 20:15:38；运行器在执行阶段不调用本地记录 API，全部结束等待 90 秒后才读取详情。独立 SQL 在首次详情读取前已查到顺序/恢复和并行进程的持久绑定。20:17:36 分析器先查持久库再读详情：

| 核对项 | 结果 |
| --- | --- |
| Native 指令与真实测试指令一致 | 5/5 |
| CLI 正常完成、Native 中可见 OK | 5/5 次调用、4/4 Session |
| eBPF 明文请求 SHA256 匹配 | **3/5，未全部通过** |
| 受控 Shell 关键行为采集、完整 argv / exec_confirmed | 6/6 |
| API 正确归属并可见 | 6/6 |
| PostgreSQL active 关系正确 | 6/6 |
| 跨 Session 事件交集 / 外部负对照串入 | 0 / 0 |

关键行为证据：A1 `evt_727720bc26acd6a0`、A2 `evt_686e8f48386d607f`、A3 `evt_ad34978703559577`、B1 `evt_c4ab261eea10d085`、C1 `evt_38368745005fb67a`、A4 `evt_3756a96b0f754697`。本轮未人工回填。

20:18:53 再次独立查库与详情复核：仍为 Shell 6/6 采集、6/6 可见、6/6 持久正确，跨 Session/负对照错误均 0；Native 5/5、eBPF 明文 3/5，没有因多等待一轮变成全量成功。

顺序/恢复 Session `01a09aaf-7efc-7743-ae08-fcb4fc77e92b` 已同时显示两代事件；恢复根 PID 1602408 的 A4 持久 LINEAGE 为 `spb_11bddb31b22568b9682dea45`。

**新暴露的独立采集缺口：** no-tools `01a09aaf-6147-7282-bb51-4c2ab25f0d15`（约 7.6 秒）和 parallel-left `01a09ab0-db98-72d2-bfac-6ea97c27b361` 的 eBPF 请求元数据缺失。前者没有可信系统绑定，保持未归属；后者仍能凭 FD 与生命周期正确关联实际 Shell。Native 内容完整不能当作 eBPF 独立捕获成功。实际丢失点仍需区分探针发现/首请求时机、TLS 重组、转发与投影，不能仅凭运行时长认定原因。

20:12–20:16 的 Collector 累计 interaction_dropped 一直为 1825，output_dropped 一直为 0；不能把旧累计值当成本轮新增损失。机器同时出现明显磁盘 I/O 等待和 Forwarder identity snapshot timeout，应纳入后续延迟排查，而不是直接声称由归因算法导致明文缺失。

## 回归与边界

API build、tail/resume、local-record-tracking、session-event-attribution、namespace stability、Harbor inode FD、16 项 FD 所有权/竞态、host TGID 与 Interaction metadata 回归通过。测试的过期和模拟超时告警是断言场景，不代表线上无故障。

- 6 个受控行为不是 Terminal-Bench 全部 90 次历史 Shell 调用覆盖率，也不是生产 100% 稳定性保证。
- FILES=0，本轮不声明文件访问完整、全部网络事件完整或回复独立 TLS 捕获完整；Native Session 与 eBPF 来源分开。
- 补算队列是内存且保留 10 分钟；长时间停机/晚到、超限历史仍需显式有界重放。超过 4 代的完整历史展示仍有分页/接口优化空间。
- 详情 read-only 路径的 `persistence=degraded` 不能直接推断关系库无数据；本轮按 eventId 实查 PostgreSQL。
- Observer namespace 透传源码此前已改但未重启加载；当前 API 兼容旧部分身份，不把源码修改误说成全部上线。
- 实际 Harbor job `observer-live-20260913-1638` 已于 17:39:34 完成，单任务 reward=1.0 / errors=0；它不是全套 66 任务评测，也不是本轮采集覆盖率。
- 当前窄镜像未同步成 Compose 默认镜像；直接 Compose recreate 可能恢复旧版本，应明确指定验证镜像。没有执行 git commit。

## 下一步

1. 优先复现两类缺失明文请求：仅回复 OK 的极短 CLI 与并行首次请求；按单 PID 代际核对发现、attach、片段、重组、转发、Interaction 入库各阶段，而不是降低可信归因门槛。
2. 量化尾部落库延迟与背景扫描的 I/O 负担；做长时间 API 停机后的有界恢复验收。
3. 再逐条审计已结束 Harbor 任务的全部实际 Shell，不能以本轮两组共 12 个受控标记成功替代历史 90 次工具的覆盖验收。
