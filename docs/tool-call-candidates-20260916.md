# Tool Call 候选关联（2026-09-16）

## 问题和范围

Session 归属和 Tool Call 执行绑定是两个层次。9 月 16 日开启现有 Observer 后，
日常 Codex 真实测试的 6 个命令标记均进入正确会话，顺序／resume 会话取得 384 条
会话系统事件，但这些事件没有可信 Tool Call 标识。此前前端仅按命令字面量相等
查找候选，无法识别 Observer 记录的 `/usr/bin/bash -c <原始脚本>` 包装。

本次增加服务端只读候选投影。历史缺失的系统事件不能靠此补回；命令和时间匹配
也不能升级为可信绑定。

## 实现

- 记录详情在请求系统证据时返回 `toolEvidence`，版本
  `anysentry.local-tool-evidence.v1`，范围为 `loaded_window`。
- 静态提取普通对象和 `tools.exec_command({cmd: "..."})` 的字符串命令。
  不执行记录代码；模板、正则、动态表达式、重复命令属性及展开属性保守地不解析。
- 仅在相同 Native Session、相同 Call ID／Turn 的调用与首个结果窗口内（±250ms）
  查找原文一致或受支持 Shell 包装的 ToolExec。无结果时为 pending。
- 从命令锚点沿带有效期的进程代际血缘查找后代候选，不能仅凭裸 PID 吸收进程。
  血缘搜索限制为 32 层／256 个节点；截断时标记 partial。
- 同一事件匹配多个调用时标记 ambiguous；重复 Call ID 不匹配。
  冲突的显式绑定不会退回命令候选。只有原有服务端验证的
  `authenticated_agent_adapter` 绑定可计入 confirmed。
- 候选保留在未确认分配区，不修改原始事实，不写调用关联表，不改变 Observer 配置。
- 页面优先展示加载／读取失败状态；已缓存确认结果在刷新失败时标明可能过期。
  空证据、语义窗口外调用、会话已关联但调用待确认分别显示。
- 持久化状态增加 `not_checked`：只读重算未验证持久化时不再显示数据库降级；
  从持久化关系读出的证据显示 persisted，覆盖完整性仍独立判断。

## 验证

API/Web 构建和 Web TypeScript 检查通过。回归脚本：

```sh
pnpm build:api
node --experimental-strip-types scripts/verify-local-tool-evidence.mjs
node --experimental-strip-types scripts/verify-tool-system-evidence.mjs
node scripts/verify-session-event-attribution.mjs
node scripts/verify-local-record-tracking.mjs
node scripts/verify-session-tail-resume.mjs
pnpm --filter @anysentry/web exec tsc --noEmit
pnpm build:web
```

`verify-local-tool-evidence.mjs` 可附加真实详情 JSON 文件路径。
本轮样本 `/tmp/anysentry-daily-codex-rQQC9w/sequential-detail.json` 的 4 个调用
分别得到 5、6、5、5 条候选，confirmed 均为 0。这是实际采集数据的算法回放结果，
不是运行中 API 已发布此功能的证明，也不是采集覆盖率。

浏览器脚本 `verify-link-awareness-browser.mjs` 使用隔离浏览器 fixture，验证后端
投影消费、确认和候选区分、原页签、键盘操作、分页、失败与重试、过滤及持久化状态。
fixture 不向后端写入事件。

本轮浏览器回归通过，预览地址为 `http://127.0.0.1:25173`；桌面／375px 截图在
`/tmp/anysentry-link-browser-LMHo1P/`。此预览只用于验证构建产物，测试后已停止。

## 当前限制与后续

本次改动已部署为 `anysentry-api:tool-candidates-20260916` 与
`anysentry-web:tool-candidates-20260916`。现有 Observer 继续采集，容器 ID 和启动时间均未改变。
投影只覆盖当前详情语义页和系统事件页；动态命令、较早记录、结果后的异步执行可能
不在范围内。前端为旧 API 保留原来的字面量候选兼容逻辑。

要升级为可信调用绑定，需要在实际执行入口取得并验证：
`Session + Turn + Call → executionId → host/boot/PID/start-time`。
Codex 工具返回的 `process_id` 是运行时句柄，不能当作 OS PID。
应先打通受信适配器的绑定生命周期、签名校验与并发隔离，再接现有可信关联投影；
历史候选不能自动升级。调用级关系持久化与修订属于后续工作。

## 在线部署与验收

部署前对运行容器的 JS 与本地构建产物逐项比较：两个已有 API 服务只有本次预期
差异。以 `link-awareness-20260914` 镜像为基础，仅替换这两个服务、新候选 helper
及对应 source map。Web 使用已验证的构建目录。没有从整个未提交工作树重建 API。
构建入口为 `deploy/Dockerfile.tool-candidates`，其上下文结构为 `api/`（三个模块）
和 `web/`（前端 dist）；本轮完整上下文保存在下述发布目录中。

部署复用现有容器配置。已比较新旧 Env、HostConfig 和挂载，均一致；API/Web 容器
healthy，29653 与 29654 代理路径的 healthz 均返回 ok、ClickHouse ready。
运行中三个 API 模块的 SHA256 与本地已验收产物一致。

运行镜像 ID：

- API：`sha256:fde58b4fc8e6fc4f0e8b77b1794c90ea1cb683d66cf89eb2d7c6b5cd2f6201de`
- Web：`sha256:b5577384af94d8000128fe67d0c28d8b3c4b749e7793f622ae80aec7739d6d97`

直接读取运行 API 的真实样本：

| 会话样本 | Session 系统事件 | 各调用候选数 | 已确认事件 |
| --- | ---: | --- | ---: |
| sequential + resume | 384 | 5、6、5、5 | 0 |
| parallel-left | 176 | 5 | 0 |
| parallel-right | 171 | 5 | 0 |
| no-tools | 148 | 无工具调用 | 0 |

这些样本没有跨 Session 候选。持久化状态为 `not_checked`；只读查询未声明写入成功。
样本投影为 partial，仍受已加载窗口和历史证据范围限制。

真实浏览器访问运行站点（没有请求 mock），加载完整 384 条系统事件后，页面显示
4 个调用、21 条去重候选、0 条确认；逐调用数量为 5、6、5、5。工具证据展开、原
会话页签及移动视口检查通过。在线浏览器验收命令：

```sh
ANYSENTRY_WEB_TEST_URL=http://127.0.0.1:29654 \
ANYSENTRY_TEST_REAL_LINK=1 \
ANYSENTRY_TEST_RECORD_ID=31f362b9f1787663efddf944 \
ANYSENTRY_TEST_CANDIDATE_COUNTS='[5,6,5,5]' \
node scripts/verify-link-awareness-browser.mjs
```

发布清单、新旧配置比较、真实 API 响应与验收结果：
`/tmp/anysentry-tool-candidates-release-20260916/`。
真实桌面／移动截图：`/tmp/anysentry-link-browser-2IToyk/`。

回滚容器已停止保留，原有数据卷不变：

- API：`anysentry-anysentry-1-before-live-1789544751510`
- Web：`anysentry-web-1-before-live-1789544807215`

需要回滚时先停当前 Web/API，并改名保留，再将上述旧容器分别改回
`anysentry-anysentry-1` / `anysentry-web-1`，先启动旧 API 并检查健康，再启动旧 Web。
本轮没有执行回滚，没有删除旧容器、镜像或数据卷。
