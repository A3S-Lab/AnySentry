# UOS 现场问题台账（开放项跟踪）

> 维护人：打包工程师。每轮现场反馈后更新；闭环项移入底部归档。
> 部署手册（各 compat 版本全史）见 `UOS20_ARM64_DEPLOYMENT_REVIEW.md`。

状态图例：🔴 待修复 ｜ 🟡 待验证（修复已发，等现场窗口）｜ 🔵 待客户/外部输入 ｜ ⚪ 已知限制（不修）

| # | 问题 | 状态 | 归属 | 现象与证据 | 下一步 |
|---|---|---|---|---|---|
| 1 | 前端"观测与研判"卡片恒显示 Observer **部分异常 0/1** | 🔴 待开发 | API 健康评估 | 现场取证实锤（2026-10-16）：`state=degraded` 来自 delivery 通道 `reasons=["spool_backlog_over_slo"]`（spool 最老记录 71s > 60s SLO；pendingPut 487 条/4.8MB、WAL 14.5MB、compaction 推迟 4515 次——转发层 spool 持续欠账）；capture 通道 `warning: capture_recovering_after_recent_failure`。**修正初判**：不是 outputDropped 误判（那条路径没触发），是真实的 spool 积压——但严重度低（批次送达 87/87 ack 201，无 retry/失败），60s SLO 对此流量形态过紧。另注意：控制面超时（04:21-04:25）与打包侧 dump 重查询时间重合，诊断负载自身会造成瞬时抖动 | 开发：① spool 积压的 SLO 校准或 draining 提速（plain 洪峰下 60s 太紧）；② 卡片 degraded 应区分"积压中"与"丢失"。打包侧自省：dump 脚本全量拉取是重负载，加限速/分批 |
| 2 | 对话追踪页内容**几分钟后消失**，且不按页面右上角时间窗保留 | 🔴 待开发 | API 持久化 | 现场**无 PostgreSQL**（打包清单无此组件，`ANYSENTRY_DATABASE_URL/POSTGRES_URL` 均未设）→ 会话 membership/轮次投影只活在内存热环；实测 timeline `dataSource=hot_ring`。热环被 pruneInteractionHot 按条数/字节淘汰 → 几分钟后消失；热环读不受页面时间窗约束 | 二选一并入设计：① membership/轮次投影持久化到已有的 ClickHouse；② 打包内置轻量关系库。注意审核记录（config 表）走 CH 没受影响，不要混淆 |
| 3 | 高峰期 ring 丢块（fragment_sequence_gap 85-96%） | ✅ 已闭环（2026-10-16 验证） | 打包侧 | compat29/30 的 ring 128 页生效：近 6h gap **0 条**（含高峰 1000+ 记录/h 时段）；此前 compat28 时代高峰 85-96% | — |
| 4 | gzip 压缩响应乱码 | ✅ 已闭环（2026-10-16 验证） | 开发（0592615） | 近 6h `content_decode_error` **0 条**（原 ~14/h）；`truncated_compressed_stream` 9 条（截断容错标记正常）；'Qwen3.8' 可检索 60 条 | — |
| 4b | **wire 模板匹配覆盖率低**（对话只有 2 条的直接原因） | 🔴 待开发 | Observer 解析层 | dump 实证（60min）：LLM 对话类 69 条仅 2 条转化；compat30 纯窗口语义转化率 0.3-1.2%（fidelity 实测）——投影放行已生效但 wire 形状容错不足。样本特征：SSE+chunked+gzip 混合、keepalive 同连接多请求串联（样本尾部混入下一请求的 POST 头）、捕获窗口起始可能不在请求头 | 把 dump 的 decoded.txt 作为真实样本库给开发，逐形状补 wire 模板/容错解析；转化率目标：LLM 对话类 >80% 进轮次 |
| 4c | **会话穿线缺失**：每条记录一个随机 sess_ id | 🔴 待开发 | API 会话分组 | dump 实证：235 条记录 = 235 个互不相同的一次性 sessionId（各 1 条）——unparsed 证据没有 provider 会话键/共享锚点，会话目录只剩资产级伪会话 | 开发设计：按 (endpoint, 进程, 时间窗) 或 connectionId 做会话归并，让同一用户的连续问答穿成一条会话 |
| 4d | **前端把 base64 正文原样展示**（用户看到"类似 base64 内容"） | 🔴 待开发 | 前端展示层 | dump 实证：68 条记录 body 以 encoding=base64 存储（非 UTF-8/控制字符内容的正常编码），解码后全部是可读文本——前端对 unparsed 证据记录未按 encoding 解码就渲染 | 前端按 `encoding=base64` 解码后展示；或 API 返回前预解码 |
| 4e | 明文里直接可见**凭证级内容**（安全发现，价值证明） | 🔵 待客户 | 客户侧 | dump 实证三例：登录接口明文 `username=[已脱敏账号]&password=[已脱敏]`；sandbox 代码内嵌 base64 的 data_vars 含完整 **JWT access_token**；LLM 网关请求头 **Bearer token** 明文（[已脱敏令牌]） | 作为安全发现正式报告客户：明文 HTTP 传凭证+弱密码是业务自身风险；AnySentry 已能抓出——这恰是产品价值的直接证明 |
| 5 | Prometheus 未配置 | ⚪ 已有结论（2026-10-16） | 打包侧（按需） | 现场排查：`ps -ef` 无 prometheus/vmagent/grafana/node_exporter/夜莺——**机器上没有监控平台**。API 指标端点健康（curl 可取，验收/巡检够用） | 默认不打包内置 Prometheus（磁盘刚回血、9090 属新开口子）；客户运维若提出要求，再出 arm64 组件包 |
| 6 | 对话追踪页应**展示 unparsed 记录**（原始证据形态） | 🔴 待开发 | 前端+投影 | 现场测试者反馈：测试产生的对话记录找不到——多数记录被 `interactionType=unparsed` 过滤出投影，页面上等于"不存在"。诉求：解析不了的也按原始证据形态列出来（原文+乱码标记），不能只展示解析成功的 | 开发设计：对话追踪增加"未解析证据"分组/开关，数据源 agent_interactions_v1 全量；compat30 已放行 LLM 形状的 partial，本条要求覆盖剩余全部 |
| 7 | 块分析应**先解码先展示**（渐进式），不等完整重组 | 🔴 待开发 | API/前端展示 | 现场反馈：现在是"完全获取全部对话后才展示"。诉求：采到多少解多少、先出部分内容（截断标记注明），大块/慢流不卡住展示 | 开发：详情接口对截断内容先返回已解码前缀 + truncated 标记（compat30 的 truncated_compressed_stream 已是此语义，延伸到所有截断形态） |
| 8 | 对话界面**按内容搜索**（输入关键词返回命中的对话记录） | 🔴 待开发 | API+前端 | 现场反馈：测试产生的对话记录无法找到（无搜索入口）。agents/interactions 现有 path/model 等过滤但无正文搜索 | 开发：interactions 接口加 `contentQuery`（CH payload LIKE/positionCaseInsensitive 即可），前端加搜索框；这是现场自验的刚需，建议优先 |
| 6 | `probe_call_limit` 标记高发（1KB/chunk 截断） | ⚪ 已知限制 | — | 4.19 验证器要求定长读取（compat20）；跨块重组已保证内容完整（捕获率 p50=1.0），标记仅为提示 | 不修 |
| 7 | 合成探针入库时滞 60-90s（idle 边界） | ⚪ 已知限制 | — | 验收脚本已适配（补等 45s）；真实流量不受影响 | 不修 |
| 8 | 后台 API 调用 parseState=unparsed（占大头） | ⚪ 设计行为 | — | 非 LLM 的 REST 调用不做消息级解析；安全视图靠事件表 | 不修 |

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
