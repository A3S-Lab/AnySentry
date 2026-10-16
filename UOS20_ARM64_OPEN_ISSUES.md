# UOS 现场问题台账（开放项跟踪）

> 维护人：打包工程师。每轮现场反馈后更新；闭环项移入底部归档。
> 部署手册（各 compat 版本全史）见 `UOS20_ARM64_DEPLOYMENT_REVIEW.md`。

状态图例：🔴 待修复 ｜ 🟡 待验证（修复已合入 compat31，等现场窗口）｜ 🔵 待客户/外部输入 ｜ ⚪ 已知限制（不修）

| # | 问题 | 状态 | 归属 | 现象与证据 | 下一步 |
|---|---|---|---|---|---|
| 1 | 前端"观测与研判"卡片恒显示 Observer **部分异常 0/1** | 🟡 待验证 | API 健康评估 | **真根因（开发更正）**：ring 与 outputDropped 是进程累计值，健康评估却按窗口值判——历史溢出把通道永久钉在 degraded（`acf446b` 已改为对上一心跳的窗口增量，ring/delivery 两通道同步；Observer `a7c67a0` 心跳新增 `legacy_counter_temporality:"cumulative"` 标记配套）。**台账更正**：outputDropped 不是"明文准入策略丢弃"，是导出器真实写入失败计数；策略过滤走 filterMetrics 不进 outputDropped。另注意：控制面超时（04:21-04:25）与打包侧 dump 重查询时间重合，诊断负载自身会造成瞬时抖动（自省：dump 后续加限速/分批） | 升级 compat31 后卡片应恢复"正常"；若仍 degraded，看 channels.reasons 是否为窗口内新增丢弃 |
| 2 | 对话追踪页内容**几分钟后消失**，且不按页面时间窗保留 | 🟡 待验证 | API 持久化 | `295ba8b`：新增 `anysentry_session_memberships_v1`（ReplacingMergeTree、月分区、30 天 TTL 与交互表同生命周期），**仅当 PG 未配置时**作为唯一写入方（绝不双写），启动时恢复近 7 天（env 可调）membership。验证脚本含 PG 在场不双写/重启恢复/CH 中断容忍，本地全过 | 升级后对话跨重启保留；若 timeline 仍 `dataSource=hot_ring`，是 CH 交互查询失败，取 API 日志 `[clickhouse] agent interaction query failed` 行交开发 |
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
