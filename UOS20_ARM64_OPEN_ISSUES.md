# UOS 现场问题台账（开放项跟踪）

> 维护人：打包工程师。每轮现场反馈后更新；闭环项移入底部归档。
> 部署手册（各 compat 版本全史）见 `UOS20_ARM64_DEPLOYMENT_REVIEW.md`。

状态图例：🔴 待修复 ｜ 🟡 待验证（修复已发，等现场窗口）｜ 🔵 待客户/外部输入 ｜ ⚪ 已知限制（不修）

| # | 问题 | 状态 | 归属 | 现象与证据 | 下一步 |
|---|---|---|---|---|---|
| 1 | 前端"观测与研判"卡片恒显示 Observer **部分异常 0/1** | 🔴 待开发 | API 健康评估 | 前端把 `degraded+stale+down` 计为异常（SecurityMonitorPage.tsx:3399-3430）；API 交付通道评估把 `outputDropped > 0` 当"永久输出丢失"severity=2（aggregation.service.ts deliveryEvaluation），而本机 outputDropped 是**明文准入的策略性丢弃计数**（验收实测 627007，设计如此）→ 通道永久 degraded → 卡片永远部分异常。采集通道同理：`ringDropped > 0` 用原始累计值而非窗口增量（同文件 265 行注释明说"累计值不应永久 degraded"，但 ring 分支没用增量） | 现场取证：`curl -s -X POST http://127.0.0.1:29653/security-center/collectors/health -H 'Content-Type: application/json' -H "x-anysentry-admin-token: $TOKEN" -d '{}'` 看 items[].state 与 channels 的 reasons；确认为误报后交开发：策略丢弃与真实输出丢失分开计数 |
| 2 | 对话追踪页内容**几分钟后消失**，且不按页面右上角时间窗保留 | 🔴 待开发 | API 持久化 | 现场**无 PostgreSQL**（打包清单无此组件，`ANYSENTRY_DATABASE_URL/POSTGRES_URL` 均未设）→ 会话 membership/轮次投影只活在内存热环；实测 timeline `dataSource=hot_ring`。热环被 pruneInteractionHot 按条数/字节淘汰 → 几分钟后消失；热环读不受页面时间窗约束 | 二选一并入设计：① membership/轮次投影持久化到已有的 ClickHouse；② 打包内置轻量关系库。注意审核记录（config 表）走 CH 没受影响，不要混淆 |
| 3 | 高峰期 ring 丢块（fragment_sequence_gap 85-96%） | 🟡 待验证 | 打包侧 | compat29 已扩 ring 64→128 页（随 compat30 生效）；compat28 时代数据已证与流量强相关 | 下一个业务高峰跑 `check-content-fidelity.sh 120`，gap 应 <20% |
| 4 | gzip 压缩响应乱码 / 语义轮次为零 | 🟡 待验证 | 开发已交付 | compat30 已带 0592615（流式解压+投影放行）；现场已见首个完整轮次（user/model "步骤三"） | 纯 compat30 窗口复跑 fidelity：partial 为主、content_decode_error≈0、modelCallCount 持续增长 |
| 4b | **wire 模板匹配覆盖率低**（对话只有 2 条的直接原因） | 🔴 待开发 | Observer 解析层 | dump 实证（60min）：LLM 对话类 69 条仅 2 条转化——1 条 `parsed`（命中已知模板 openai-chat-completions，短问答完整解析）、1 条 `partial`（新 generic-llm-json 升级生效）；其余 67 条 `wire_template_unparsed/wire_unknown`。样本特征：SSE+chunked+gzip 混合、keepalive 同连接多请求串联（样本尾部混入下一请求的 POST 头）、捕获窗口起始可能不在请求头 | 把 dump 的 decoded.txt 作为真实样本库给开发，逐形状补 wire 模板/容错解析；转化率目标：LLM 对话类 >80% 进轮次 |
| 4c | **会话穿线缺失**：每条记录一个随机 sess_ id | 🔴 待开发 | API 会话分组 | dump 实证：235 条记录 = 235 个互不相同的一次性 sessionId（各 1 条）——unparsed 证据没有 provider 会话键/共享锚点，会话目录只剩资产级伪会话 | 开发设计：按 (endpoint, 进程, 时间窗) 或 connectionId 做会话归并，让同一用户的连续问答穿成一条会话 |
| 4d | **前端把 base64 正文原样展示**（用户看到"类似 base64 内容"） | 🔴 待开发 | 前端展示层 | dump 实证：68 条记录 body 以 encoding=base64 存储（非 UTF-8/控制字符内容的正常编码），解码后全部是可读文本——前端对 unparsed 证据记录未按 encoding 解码就渲染 | 前端按 `encoding=base64` 解码后展示；或 API 返回前预解码 |
| 4e | 明文里直接可见**凭证级内容**（安全发现，价值证明） | 🔵 待客户 | 客户侧 | dump 实证三例：登录接口明文 `username=[已脱敏账号]&password=[已脱敏]`；sandbox 代码内嵌 base64 的 data_vars 含完整 **JWT access_token**；LLM 网关请求头 **Bearer token** 明文（[已脱敏令牌]） | 作为安全发现正式报告客户：明文 HTTP 传凭证+弱密码是业务自身风险；AnySentry 已能抓出——这恰是产品价值的直接证明 |
| 5 | Prometheus 未配置 | 🔵 待客户 | 客户运维/打包侧 | API 指标端点 `/security-center/platform/metrics/prometheus` 实测健康（curl 可取）；机器上是否有统一监控平台未知（查 `ps -ef \| grep -iE 'prometheus\|vmagent\|grafana\|node_exporter\|夜莺'`） | 有平台→交单机版 scrape 配置（targets 127.0.0.1:29653）；没有→再议是否打包内置 arm64 Prometheus（9090 不在端口禁区） |
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
