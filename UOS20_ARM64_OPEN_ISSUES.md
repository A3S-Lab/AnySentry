# UOS 现场问题台账（开放项跟踪）

> 维护人：打包工程师。每轮现场反馈后更新；闭环项移入底部归档。
> 部署手册（各 compat 版本全史）见 `UOS20_ARM64_DEPLOYMENT_REVIEW.md`。

状态图例：🔴 待修复 ｜ 🟡 待验证（修复已合入 compat31，等现场窗口）｜ 🔵 待客户/外部输入 ｜ ⚪ 已知限制（不修）

| # | 问题 | 状态 | 归属 | 现象与证据 | 下一步 |
|---|---|---|---|---|---|
| 1 | 前端"观测与研判"卡片恒显示 Observer **部分异常 0/1** | 🟠 已转为真实问题（CH 反压） | API 健康评估 | 窗口增量修复（`acf446b`）已生效：reasons 现在是窗口语义——capture=`capture_pipeline_loss`、delivery=`spool_backlog_over_slo` 均为**当前窗口真实发生**。驱动根因=ClickHouse 超时（见 #16）：CH 慢→写入反压→spool 积压+采集丢弃。**台账更正**：outputDropped 不是"明文准入策略丢弃"，是导出器真实写入失败计数；策略过滤走 filterMetrics 不进 outputDropped | 与 #16 一并处理：CH 提速后卡片应自然恢复；恢复前它是真实信号不是误报 |
| 2 | 对话追踪页内容**几分钟后消失**，且不按页面时间窗保留 | 🟡 部分验证（机制已通，被 #16 掩盖） | API 持久化 | `295ba8b` 实证生效：`anysentry_session_memberships_v1` 已建表并写入 **963 行**（30 天 TTL，仅无 PG 时写，启动恢复 7 天） | #16 解决后复测跨重启保留；若 timeline 仍 hot_ring，取 `[clickhouse] agent interaction query failed` 日志 |
| 3 | 高峰期 ring 丢块（fragment_sequence_gap 85-96%） | ✅ 已闭环（2026-10-16 验证） | 打包侧 | compat29/30 的 ring 128 页生效：近 6h gap **0 条**（含高峰 1000+ 记录/h 时段） | — |
| 4 | gzip 压缩响应乱码 | ✅ 已闭环（2026-10-16 验证） | 开发（0592615） | 近 6h `content_decode_error` **0 条**（原 ~14/h）；`truncated_compressed_stream` 9 条（截断容错标记正常）；'Qwen3.8' 可检索 60 条 | — |
| 5 | **wire 模板匹配覆盖率低**（对话只有 2 条的直接原因） | 🟡 compat34 待验证 | Observer 解析层 | compat33 现场验证失败并定根：主导形态不是“完整干净 JSON + 空响应”，而是 **legacy 1KiB 截断后拼接下一段 HTTP**——全文 JSON 失败、`messages` 无闭合对象，连 `3dc5765` 的 req_msgs>0 条件都不触发，1393 条仍全 `unparsed/wire_unknown`。compat34（Observer `00ef87c`）补两层：①请求侧保守结构识别（POST + LLM 路由 + JSON Content-Type + messages/role/content 前缀）升级为 `generic-llm-json/partial/Model`，普通 REST 不升级；②legacy 载荷 1KiB→16KiB，perf 记录按 header+实际 len 发送，固定窗口分块读保持 4.19 验证器兼容。回归：现场形态 `partial/model`、普通 REST 保持 `unparsed`、legacy 242/242 | 升级后复测：parseState 应从全 unparsed 变为 partial 为主；timeline 应出现可证实的 user/model 轮次；若仍空，取 `decoded.txt` 与 API `[clickhouse] agent interaction query failed` 日志 |
| 6 | **会话穿线缺失**：每条记录一个随机 sess_ id | 🟡 待验证 | API 会话分组 | `acf446b`：无锚交互按（进程实例+endpoint+keepalive connectionId 或 30 分钟桶）归并采集会话 | 升级后同用户连续问答应成串，会话目录不再只有资产级伪会话 |
| 7 | **前端把 base64 正文原样展示**（用户看到"类似 base64 内容"） | 🟡 待验证 | 前端展示层 | `e220bed`：raw tab 按 encoding 解码 base64（共享 helper decodeContentBody.ts） | 升级后 base64 正文应显示为可读文本 |
| 8 | 明文里直接可见**凭证级内容**（安全发现，价值证明） | 🔵 待客户 | 客户侧 | dump 实证三例：登录接口明文 `username=[已脱敏账号]&password=[已脱敏]`；sandbox 代码内嵌 base64 的 data_vars 含完整 **JWT access_token**；LLM 网关请求头 **Bearer token** 明文（[已脱敏令牌]） | 作为安全发现正式报告客户：明文 HTTP 传凭证+弱密码是业务自身风险；AnySentry 已能抓出——这恰是产品价值的直接证明 |
| 9 | Prometheus 未配置 | ⚪ 已有结论（2026-10-16） | 打包侧（按需） | 现场排查：机器上没有监控平台进程。API 指标端点健康（curl 可取，验收/巡检够用） | 默认不打包内置 Prometheus；客户运维若提出要求，再出 arm64 组件包 |
| 10 | 对话追踪页应**展示 unparsed 记录**（原始证据形态） | 🟡 待验证 | 前端 | `e220bed`：timeline 底部新增可折叠"原始证据（未解析）"车道 | 升级后未解析记录以证据车道可见 |
| 11 | 块分析应**先解码先展示**（渐进式） | 🟡 待验证 | 前端 | `e220bed`："部分"徽标带 partialReasons tooltip（截断原因可见） | 升级后截断内容带标记展示 |
| 12 | 对话界面**按内容搜索**（输入关键词返回命中的对话记录） | 🟡 待验证 | API+前端 | `acf446b` contentQuery 全链路（CH positionCaseInsensitive(payload) 参数化下推 + 热环同谓词 + 投影按组过滤）；`e220bed` 页面搜索框接线透传 | 升级后页面搜索框输入关键词应命中正文 |
| 13 | `probe_call_limit` 标记高发（compat33 及更早为 1KiB/chunk 截断） | 🟡 compat34 待验证 | Observer legacy 采集 | compat33 现场 1163/1393 条带该标记，真实样本在 1024B 处断在 JSON 字符串内并拼接下一段 HTTP。compat34（Observer `00ef87c`）把 legacy 单事件载荷上限提至 16KiB：内核按 1KiB/1KiB/3KiB/4KiB×3 固定窗口复制（避开 4.19 verifier 的变长读限制），用户态只把 header+实际 len 写入 perf 环；超过 16KiB 仍保留 `probe_call_limit`，不伪装完整 | 升级后 16KiB 内常规 OpenAI 请求应不再出现该标记；>16KiB 流仍应诚实标 partial |
| 14 | 合成探针入库时滞 60-90s（idle 边界） | ⚪ 已知限制 | — | 验收脚本已适配（补等 45s）；真实流量不受影响 | 不修 |
| 15 | 后台 API 调用 parseState=unparsed（占大头） | ⚪ 设计行为 | — | 非 LLM 的 REST 调用不做消息级解析；安全视图靠事件表 | 不修 |
| 16 | **agent_interactions_v1 全表扫描**——对话页空、collector degraded 的共同上游 | ✅ 已直修（compat32，待现场验证） | AnySentry API 查询 | **定界实验定论（2026-10-16）**：CH 完全健康（内存 677MB/32G、parts 健康、合并 0）。凶手查询 `SELECT interactionId, argMax(payload, revision) ... WHERE at>=? AND at<=? GROUP BY interactionId`；三变体实测——**V1 时间窗 1h：2,687 行 / 57MB / 0.59s；V2 宽窗 30d：52,446 行 / 969MB / 12.2s；V3 前缀+1h：与 V1 持平（单租户，前缀无增益）**。结论：**时间过滤本身就能剪枝（分支①），真因是调用方传宽窗口**——目录/轮次/目录-v4 的读取路径（尤其本轮新增的会话路径）没把时间窗下推或默认窗过宽（表数据仅约两周，≥2 周窗口≈全表）。超时→热环降级（页面显空）→写入争用→spool 积压（卡片 degraded 变真实） | 打包侧直修（`27a8588`，integration 分支）：`readAgentInteractions` 对目录类读取加 24h 窗口硬上限（exactMembershipRead 点读豁免，旧 id 可达）；实测依据：30d 窗 969MB/12.2s vs 1h 窗 57MB/0.59s。验证脚本 verify-interaction-read-window 钉死四态。metadata-only 投影/翻页取历史留作开发后续 |

## 归档（已闭环，细节见部署手册）

- compat15-16：cgroup hybrid 挂载点 / hostId 一致性（开发修）
- compat17-19：多实例白名单 / 模板踩审核 / legacy 明文从无到有
- compat20：4.19 验证器定长读取（打包侧直修）
- compat21：随包验收脚本 + env 惰性键清理
- compat22-23：chunk 诊断日志（排障全靠它）
- compat24：**PAN 内核根因修复**（probe_read_user）——明文零产出终结
- compat25：CH 系统日志 TTL 化 + otel engine/ttl 冲突修复 + 磁盘回血 11G
- compat26：序号连续化（假 gap 根除）+ 空壳降级 + 1KB chunk
- compat27-28：idle 超时 env 化 → 双车道退休（响应空壳根因修复，现场 1/6→4/4）
- compat29-30：ring 128 页 + gzip 流式解压 + 语义轮次投影放行
