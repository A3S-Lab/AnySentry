# Codex 明文请求连接隔离修复与验收（2026-09-14）

## 已部署

- 服务：`anysentry-observer-1`
- 镜像：`anysentry-observer-wrapper:ws-connection-v2-20260914`
- 采集器 SHA-256（本地构建与容器内一致）：`7331a1e6656e6e5de981c37d56553676c29fa34a86afcdf950a7cae28dcc3b9a`
- 最近回滚容器：`anysentry-observer-1-before-live-1789383921387`。
- 原始旧版本容器：`anysentry-observer-1-before-live-1789383328695`。
- 配置、挂载、网络、WAL 卷沿用原配置；未开启全机文件采集。
- 未提交工作区中的其他修改，不以仓库 HEAD 冒充运行镜像版本。

## 根因与修复

旧实现把同一 PID 的 WebSocket 端点和解压字典合并。第二条连接覆盖字典后，第一条连接的后续数据可能解压成错误 JSON，却只计为 ignored。

进一步核对本地 Rustls `ConnectionCommon<T>: PlaintextSink` 实现及匹配二进制反汇编，命中函数的首参是连接对象，不是临时 Writer。旧代码关于“首参一定不稳定”的注释和用例假设不正确。

当前实现：

1. HTTP/1、HTTP/2 和 WebSocket 字节流按 PID＋连接对象指针隔离，同一连接跨 Tokio 线程继续重组。
2. 按进程启动时间校验代际，进程退出/代际变化时释放其连接状态。
3. 解压字典按连接保存；重连握手重置字典，Close 帧释放状态，连接数受容量限制。
4. 重复探针去重限定到同一连接；不再按 Session＋Turn＋用户文本永久合并后续模型请求。
5. 完整 WebSocket 消息中出现无效 JSON 单独计入 `invalid_request_frames` 和 parse_failed，并输出限频、无正文的原因日志。
6. 合法请求中未提取到用户文本的情况单独计入 `requests_without_user_message`，不再只有无法区分原因的汇总计数。

变更位于 `Observer-main-runtime-payload/a3s-observer-collector/src/interaction_fixture.rs` 和 `main.rs`；没有扩大文件 eBPF 采集范围。

## 测试结果与 ground truth

### 离线

- 完整 collector 测试：136/136。
- 覆盖同 PID 多压缩连接、跨线程部分帧、重复探针、不同连接相同正文、PID 代际变化、重连、Close 回收、容量上限和异常 JSON。
- 重放程序：`/tmp/anysentry-ws-diagnosis-9ptB3v`。直接调用真实解析器，以构造的独立连接压缩字节流为 ground truth，每种场景重复 20 次。

| 场景 | 修复前 | 修复后 |
|---|---:|---:|
| 单连接 | 4/4 | 4/4 |
| 同 PID 双连接交错 | 2/5，3 条 ignored | 5/5 |
| 不同 PID 双连接 | 5/5 | 5/5 |

### 真实模型和 API

使用 `scripts/verify-codex-ws-live.mjs` 启动 Codex app-server；在同一进程内创建两个线程，交错/并发发送测试指令。工具测试仅在独立 `/tmp/anysentry-codex-ws-live-0ggO9s` 工作目录执行一次 printf，不读写项目文件。

核对原生 Session 的 user_message 与 API 返回的 Observer 请求：Session ID、Turn ID、正文逐字相等、SHA-256 相等，且来源为 `ebpf_rustls`。本轮总计 **9 个测试会话，16 条用户指令，16/16 匹配**。

| Record ID | 用户指令 | 精确匹配 |
|---|---:|---:|
| ba1423d71a3f1993af5389ef | 3 | 3 |
| 6bb3df494460109c365978a2 | 2 | 2 |
| 458d2d387605b79f151d421b | 3 | 3 |
| f5dec9f2881e28af984d4499 | 2 | 2 |
| e4594ba89fcdbb1298f90399 | 1 | 1 |
| cec4d25b16a6791c2024840b | 1 | 1 |
| 25ce9fe4454f77aab1923c19 | 2 | 2 |
| 9649a7727a0de5cbd21143a7 | 1 | 1 |
| a03ac4e82604c22e1e758d3a | 1 | 1 |

其中最终 v2 部署后的最后三项覆盖 4 条实际发送指令（均匹配）；原计划五轮完整复测被 `gpt-6-astra` 和备选 `gpt-5.6-sol` 的 `serverOverloaded` 中断，不能把模型交互都记为成功。此前工具复测完成了 printf、模型最终回复及 API 明文校验；首次工具测试在输出后模型阶段失败，失败记录保留。

### 浏览器

真实 Chromium 打开记录 `ba1423d71a3f1993af5389ef`，3 条 Observer 正文均渲染；未使用模拟正文。输出：`pass=true, realContent=true, renderedObserverBodies=3`。

## 不能外推的边界

- 16/16 的分母是本轮用户指令，不是所有 HTTP/WebSocket 请求，不是所有 eBPF 事件，也不是模型响应。
- 当前 Interaction 内容合同仍提取请求中的用户文本；只含工具输出的增量请求、预热请求等未提取到用户文本时会单独计数，但不伪造用户文本来生成蓝色卡片。不能据此声称所有模型调用都展示了正文。
- 已经丢失的历史字节无法从 Session 反向伪造为 eBPF 证据。
- Observer 重启时已存在的压缩长连接可能缺少早期字典，需要连接重建；原截图中的未重启旧连接仍待用户重测。不能为了测试擅自终止用户会话。
- 未宣称覆盖所有 Rustls 版本、全部 WebSocket 分片形式或任意丢包/截断场景；异常有计数，不意味着能够恢复缺失明文。
- 多轮测试期间 Observer 的一次资源采样约 9.75% CPU、201.7 MiB；这不是压力测试 SLA。

## 复测命令

```sh
cd /home/zhongyule/code/Observer-main-runtime-payload
cargo test -p a3s-observer-collector -- --test-threads=2

# 真实模型测试会消耗少量模型额度并生成测试 Session。
node /home/zhongyule/code/AnySentry/scripts/verify-codex-ws-live.mjs \
  /tmp/anysentry-codex-ws-live-0ggO9s --concurrent-tools
```

可通过 `ANYSENTRY_TEST_MODEL` 仅覆盖测试模型，不修改用户默认配置。脚本输出 `failedTurns` 与模型错误时，应将模型完成状态和明文捕获状态分开验收。
