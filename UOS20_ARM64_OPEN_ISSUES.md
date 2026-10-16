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
| 5 | **wire 模板匹配覆盖率低**（对话只有 2 条的直接原因） | 🟡 待验证 | Observer 解析层 | `3ad0e8d`：F7 keepalive 串联切分（`keepalive_request_splice`）、F8a 中流起始头重扫（`midstream_head_resync`，限 4KB/64 行）、F8b orphan 响应配对合成占位请求（`midstream_response_only`）；LLM 形状响应（choices/output/candidates）即使请求侧缺失也升级 generic-llm-json/partial/Model 进投影。3 条回归测试，本地 238/238 | 升级后复测 LLM 转化率，目标 >80%；不达标把 decoded.txt 对应失败行交开发 |
| 6 | **会话穿线缺失**：每条记录一个随机 sess_ id | 🟡 待验证 | API 会话分组 | `acf446b`：无锚交互按（进程实例+endpoint+keepalive connectionId 或 30 分钟桶）归并采集会话 | 升级后同用户连续问答应成串，会话目录不再只有资产级伪会话 |
| 7 | **前端把 base64 正文原样展示**（用户看到"类似 base64 内容"） | 🟡 待验证 | 前端展示层 | `e220bed`：raw tab 按 encoding 解码 base64（共享 helper decodeContentBody.ts） | 升级后 base64 正文应显示为可读文本 |
| 8 | 明文里直接可见**凭证级内容**（安全发现，价值证明） | 🔵 待客户 | 客户侧 | dump 实证三例：登录接口明文 `username=[已脱敏账号]&password=[已脱敏]`；sandbox 代码内嵌 base64 的 data_vars 含完整 **JWT access_token**；LLM 网关请求头 **Bearer token** 明文（[已脱敏令牌]） | 作为安全发现正式报告客户：明文 HTTP 传凭证+弱密码是业务自身风险；AnySentry 已能抓出——这恰是产品价值的直接证明 |
| 9 | Prometheus 未配置 | ⚪ 已有结论（2026-10-16） | 打包侧（按需） | 现场排查：机器上没有监控平台进程。API 指标端点健康（curl 可取，验收/巡检够用） | 默认不打包内置 Prometheus；客户运维若提出要求，再出 arm64 组件包 |
| 10 | 对话追踪页应**展示 unparsed 记录**（原始证据形态） | 🟡 待验证 | 前端 | `e220bed`：timeline 底部新增可折叠"原始证据（未解析）"车道 | 升级后未解析记录以证据车道可见 |
| 11 | 块分析应**先解码先展示**（渐进式） | 🟡 待验证 | 前端 | `e220bed`："部分"徽标带 partialReasons tooltip（截断原因可见） | 升级后截断内容带标记展示 |
| 12 | 对话界面**按内容搜索**（输入关键词返回命中的对话记录） | 🟡 待验证 | API+前端 | `acf446b` contentQuery 全链路（CH positionCaseInsensitive(payload) 参数化下推 + 热环同谓词 + 投影按组过滤）；`e220bed` 页面搜索框接线透传 | 升级后页面搜索框输入关键词应命中正文 |
| 13 | `probe_call_limit` 标记高发（1KB/chunk 截断） | ⚪ 已知限制 | — | 4.19 验证器要求定长读取（compat20）；跨块重组已保证内容完整（捕获率 p50=1.0），标记仅为提示 | 不修 |
| 14 | 合成探针入库时滞 60-90s（idle 边界） | ⚪ 已知限制 | — | 验收脚本已适配（补等 45s）；真实流量不受影响 | 不修 |
| 15 | 后台 API 调用 parseState=unparsed（占大头） | ⚪ 设计行为 | — | 非 LLM 的 REST 调用不做消息级解析；安全视图靠事件表 | 不修 |
| 16 | **agent_interactions_v1 大列全表扫描**——对话页空、collector degraded 的共同上游 | 🔴 待开发（查询形态修复） | AnySentry API 查询 | check-ch-health 定论（2026-10-16）：**CH 完全健康**——内存仅 677MB（预算 32G）、parts 健康、合并空闲、load 7.8/16 中等。凶手是这一个查询：`SELECT interactionId, argMax(payload, revision) ... FROM agent_interactions_v1 WHERE at>=? AND at<=? GROUP BY interactionId`——单次**读 892MiB / 5.1 万行（≈全表）**，典型 700ms、峰值 5.9s（撞穿 5s 预算），30 分钟 6 次。后果链：查询超时→目录/轮次回退热环（页面显空、partial=hot_ring_only）→写入争用→spool 积压+采集丢弃（卡片 degraded 变真实）。`at` 在 ORDER BY 第 4 位（tenant/environment/agent 之后），仅按时间过滤无法裁剪 marks，payload 大列被整表读 | ① 按 AC 的窗口裁剪实验定"调用方传宽窗口"还是"排序键不剪枝"（命令已给用户）；② 修复方向：调用方必带 tenant+agent+时间下推 / 查询改排序键适配 / payload 拆列。热环降级是 API 设计内的预算保护，不是 bug |

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
