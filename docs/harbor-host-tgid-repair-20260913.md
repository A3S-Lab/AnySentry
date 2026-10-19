# Harbor 父子进程身份修复：第一阶段验收（2026-09-13）

后续 argv 与实时 Session 修复已推进，当前状态请见 [第二阶段报告](harbor-live-session-argv-repair-20260913.md)。
本文保留第一阶段历史结论；其中“argv incomplete、尚无实时适配器”不再代表最新源码状态。

## 范围与现状

本轮修复实际评测工作树 `/home/zhongyule/code/Observer-main-runtime-payload`，分支
`integration/observer-main-runtime-payload`。AnySentry 分支为 `feat/flink-osv-risk-streaming`。
两个仓库原先均有大量未提交改动，全部保留；未复制覆盖另一份 `/home/zhongyule/code/Observer`。

未修改前端、未放宽后端归因、未清库或重算历史、未调用模型、未启动 Terminal-Bench。
正式 `anysentry-observer-1` 仍是停止的旧 `process-birth-v2-0909` 包装镜像。
独立测试容器只运行 metadata Collector，无 Forwarder、无网络、无数据库写入；完成后自动移除。

## 已修复

- 移除 `sys_exit_clone/fork/vfork` 返回值写入宿主机 PID 索引的路径。
- `sched_process_fork` 改为 raw tracepoint，在 child 可运行之前读取内核 task 对象。
- 从 child 的 `pid/tgid` 判断进程/线程；不把 worker thread 建成新进程代际。
- 从 child 的 `real_parent->tgid` 获取真实父进程，覆盖 `CLONE_PARENT`，不是简单取创建线程/当前 TGID。
- 从 `start_boottime` 获取真实出生时间；每次 fork 清除该 PID 的旧 exec/birth 状态后创建新代际。
- 从运行中内核的 BTF 解析字段偏移，不硬编码 task_struct 或 sched tracepoint 的格式偏移。
- BTF 不可用或 ancestry 探针加载失败时显式启动失败，不回退到已知会混用 namespace PID 的逻辑。
- 修正旧 birth 补丁遗漏的一处 ExitEvent ABI 测试断言（现有结构 80 字节，旧断言 72）；没有更改 ABI。

## 文件

- Observer `a3s-observer-ebpf/src/main.rs`：raw fork 采集。
- Observer `a3s-observer-collector/src/task_layout.rs`：BTF 字段解析与测试。
- Observer `a3s-observer-collector/src/main.rs`：布局注入及 raw probe 加载。
- Observer `a3s-observer-common/src/lib.rs`：修正现有 ABI 测试。
- Observer `scripts/verify-process-ancestry.py`、`scripts/process-clone-parent.c`：真实内核测试。
- AnySentry `scripts/verify-harbor-parent-tgid.mjs`：历史故障形状的内存归因回归。

## 已通过的验证

- `cargo test -p a3s-observer-common -p a3s-observer-collector -p a3s-observer --quiet`：
  28 个库测试、7 个 workload 契约测试、126 个 Collector 测试、7 个 common 测试通过。
- AnySentry `pnpm build:api`。
- `verify-session-event-attribution.mjs`、`verify-harbor-process-key.mjs`、
  `verify-harbor-record-discovery.mjs`、`verify-harbor-parent-tgid.mjs`。
- 多轮真实内核测试：宿主机 PID 空间、两个并行独立 PID namespace；每轮
  108/108 直接短命 exec 的父进程和出生/退出代际匹配，36/36 嵌套 shell 链正确。
- 新二进制和新 Docker 镜像各自通过特殊 CLONE_PARENT 测试（每轮 3/3）。
- 后端回归维持拒绝 worker TID 猜测、namespace-local PID、不同 host/boot、缺失出生时间、
  不合法代际或父进程退出后关联；并行 Session 不因同名命令串线。
- 旧镜像对照仍在 CLONE_PARENT 验证失败，新镜像通过；这不是放宽测试规则得到的成功。
- 单独跳过特殊 CLONE_PARENT 断言复测旧镜像：宿主机 36/36 通过，但 container-a
  把父进程记录为 `4142938`，实际根进程是 `4142780`，原始容器父线程问题得到重现。

以上分母是合成测试中的已知操作，不是历史 Terminal-Bench 的归因覆盖率。
PID 复用防护经过后端代际回归验证，尚未在宿主机强制造成真实 PID wrap/reuse。

## 新镜像与复测

Collector 镜像：`a3s-observer:host-tgid-20260913`（尚未替换正式包装镜像）。

```bash
cd /home/zhongyule/code/Observer-main-runtime-payload
OBSERVER_TEST_COLLECTOR_IMAGE=a3s-observer:host-tgid-20260913 \
  python3 -u scripts/verify-process-ancestry.py

cd /home/zhongyule/code/AnySentry
pnpm build:api
node scripts/verify-harbor-parent-tgid.mjs
```

测试需要本地已有 `ubuntu:24.04`、`python:3.12-slim`、C 编译器和可运行特权容器的 Docker。
不下载镜像；测试目前只在本机 Linux/x86_64 验证，不能据此承诺所有发行版/内核。

## 仍未解决，下一阶段

1. 特殊 C 短命子进程虽身份/父子链正确，但每轮 3 条 argv 仍标记 incomplete；需要单独定位
   参数读取/重组缺口。不得把身份关联成功描述为命令全文采集完整。
2. Harbor 运行期 Session 发现/受限读取尚未新增；实时 FD 绑定、历史持久化、归档合并仍需实现/验收。
3. 需要构建并灰度部署新包装镜像，再跑一个真实 Harbor 任务，对照 Native Tool Call、内核事件、
   Session 关系和精确工具关联分别统计覆盖率。当前不能说 20% 问题已全部消失。
4. 历史缺失父子身份不能凭相邻 PID、同容器或时间窗口猜测补齐；仅证据充分时重算。
5. 不得修改原生 ToolExec 语义或把所有 runtime 事件直接视作 Agent 工具调用。
