# AnySentry UOS 20 ARM64 发布通道

本目录将三个仓库经过审核的 integration branch 与 UOS 兼容层组合为可追溯的离线发布包。
兼容代码不写入 `AnySentry`、`Observer`、`Sentry` 的上游开发分支。

## 打包注意事项（2026-10-20 风险检测，必读）

本节随包走。打包前逐条核对；仿真环境首轮部署后逐项验证。

### 1. 本包内两项 API 修复为纯业务代码，仿真环境同样适用

`aggregation.service.ts` 的 `estimateCacheBytes`（有界结构估算器替换全量
JSON.stringify）与 `clickhouse-store.ts` 的 `keep_alive.eagerly_destroy_stale_sockets=true`
均为 Node.js 业务层改动：**与内核版本 ABI、kern_version、寄存器布局、页大小、CPU 型号
无关**，arm64/4.19/64K 页环境行为一致。残留风险仅业务语义层：

- 估算器为采样外推近似值（缓存驱逐用）：非均匀大数组/CJK 长串误差最坏 ~±30%，
  只影响缓存上限记账，不影响数据正确性；单条 >8/16MB 上限的项仍会判大并丢弃。
- keep_alive 选项只增加少量 TCP 新建连接（替代过期复用），协议与数据不变。
- 触发背景（非缺陷）：开发机业务高峰事件洪峰 + 前端常开轮询使 API 事件循环饥饿，
  两缺陷叠加成死亡螺旋；仿真环境业务量低时不会自然触发，但代码缺陷同样潜伏，故修复随包。

### 2. 用户态 uprobe 采集（新特性，kprobe 兜底不变）

- observer unit 新增 `A3S_OBSERVER_SSL=1` 与 `CAP_SYS_PTRACE`（读 /proc/pid/maps
  与 /proc/pid/root 所需；缺失时 uprobe 静默不挂接，kprobe 兜底不受影响）。
- 用户态读一律 `bpf_probe_read_user`(112)/`bpf_probe_read_user_str`(114)，PAN 安全；
  syscall kprobe 底层（kern_version/符号/64K 对齐）冻结未动。
- 首轮部署验证项：任一白名单进程发真实 HTTPS 调用，CH `agent_interactions_v1` 出现
  `tlsAdapterId='openssl-uprobe'` 且 endpoint 正确的记录；同时确认 kprobe 通道
  （纯 HTTP 明文）心跳 Egress/ToolExec 计数仍在增长。

### 3. systemd Environment 引号纪律

Environment 值含空格必须整体加双引号（如 `Environment="NODE_OPTIONS=... --flag"`），
未加引号时空格后内容被 systemd 静默丢弃，无任何报错（开发机已踩坑两次）。

## 构建模型

构建程序按下列顺序执行：

1. 检查 AnySentry、Observer、Sentry 输入仓库均为 clean；
2. 检查 AnySentry 包含审核过的 upstream main，Observer 和 Sentry 等于锁定提交；
3. 使用 `git archive HEAD` 导出到 `.build/uos20-arm64/sources/`；
4. 分组件构建 Sentry、Node、AnySentry、ClickHouse、Redis、Observer、L3 和诊断程序；
5. 校验 ARM64 ELF、glibc 2.28、64 KiB LOAD 对齐、ClickHouse CPU 配置和 BPF 版本；
6. 生成 `VERSION`、`PROVENANCE`、`manifest.sha256`、tar 包及 tar 包 SHA-256。

兼容代码通过 direct merge 保存在 integration 分支；输入提交不符合锁定条件时，构建立刻终止，不生成发布包。`PROVENANCE` 记录三个精确 HEAD 和依赖版本。

## 标准构建

常规基线包使用全量构建：

```bash
cd /home/chensicheng/.config/superpowers/worktrees/AnySentry/uos20-arm64-0.4.0
ANYSENTRY_RELEASE_DIR=/home/chensicheng/a3s/security/release \
  bash uos20-arm64/build.sh --version 0.4.0-compat34
```

输出目录：

```text
/home/chensicheng/a3s/security/release/anysentry-security-suite-0.4.0-compat34-uos20-arm64/
/home/chensicheng/a3s/security/release/anysentry-security-suite-0.4.0-compat34-uos20-arm64.tar.gz
/home/chensicheng/a3s/security/release/anysentry-security-suite-0.4.0-compat34-uos20-arm64.tar.gz.sha256
```

仅检查并准备锁定源码：

```bash
bash uos20-arm64/build.sh --prepare-only
```

分组件构建：

```bash
bash uos20-arm64/build.sh --version 0.4.0-compat34 --component observer
bash uos20-arm64/build.sh --version 0.4.0-compat34 --component app
bash uos20-arm64/build.sh --version 0.4.0-compat34 --component l3
bash uos20-arm64/build.sh --version 0.4.0-compat34 --component assemble
```

`--component` 用于开发定位；常规正式基线必须执行默认全量构建。现场热修允许使用审核过的
组件增量包，但必须复制上一版 stage、只替换目标组件，并重新执行 assemble 与发布合同校验。

## 分支规则与增量打包流程

1. 只使用三个 integration worktree：
   AnySentry/Observer `uos20-arm64-0.4.0` 与 Sentry 锁定工作树；不得修改开发检出和稳定包工作树。
2. 提交前三个输入仓库必须 clean；`uos20-arm64/versions.env` 必须写入完整提交 SHA，
   不得凭短 SHA 或记忆填值。
3. 版本钉死：AnySentry 包版本只递增 compat 号；`@a3s-lab/code=8.6.0`、
   `@a3s-lab/sentry npm=0.3.0`、BPF 内核代号 `0x0004135a` 不得随 compat 号改变。
4. 每次提交前执行 `bash uos20-arm64/tests/run-all.sh`；Observer 代码变更还要执行默认特性、
   `legacy-kernel-4-19` 特性测试和双特性 clippy。
5. 只改 Observer 的现场热修：
   先 `cp -a` 上一版 stage 到新版号，删除新版 stage 的 `observer/`，再执行
   `--component observer`，最后 `--component assemble`。
6. 重编 `app` 后必须跟跑 `--component l3`，否则 a3s-code 的 `.node` 与 zvec 会被
   fresh pnpm 安装清掉。
7. 每次交付必须校验 tar `.sha256`、解包 `manifest.sha256`、`@RELEASE_VERSION@` 零残留、
   `install.sh --help`、a3s-code `.node`/zvec，以及 PROVENANCE 中的三个提交号。
8. 现场未验收前，问题台账只能写“待现场验证”，不能写“已闭环”。
9. 现场会话默认不推远程；打包工程师在完成上述检查和门禁后，按任务要求推送 integration 分支。

## 上游迭代与兼容层维护

1. 在三个上游仓库正常开发、测试并合并新功能；
2. 从稳定 UOS 分支创建新的 integration branch；
3. direct merge 上游 main，按语义解决冲突并更新 `versions.env` 锁定提交；
4. 执行 `bash uos20-arm64/tests/run-all.sh`；
5. 执行全量构建，以新版本号生成发布包；
6. 在 UOS 同规格验证机执行 `./install.sh --check`、`./install.sh`、
   `/opt/anysentry/ACCEPTANCE_CHECK.sh` 和 `/opt/anysentry/verify.sh`；
7. 交付 tar 包、`.sha256` 和 `PROVENANCE`。

更新兼容层时，应在新的 integration 分支提交最小、可审计差异，并确认其中不包含构建产物、
密钥、环境数据或无关功能。

## 固定目标 ABI

- 操作系统：UnionTech OS Server 20 Enterprise；
- 架构：aarch64，Kunpeng 920；
- glibc：最低 2.28；
- 页大小：65536；
- 内核显示版本：`4.19.0-arm64-server`；
- BPF 程序版本：`4.19.90`，版本码 `0x0004135a`；
- ClickHouse：`armv8.0-compat`；
- Observer：`perf-kprobe-legacy`，不依赖内核 BTF。

该发布通道用于指定 UOS ABI，不替代上游通用 Linux 发布流程。

现场已经遇到的打包和部署要点写在仓库根目录 [UOS20_ARM64_DEPLOYMENT_REVIEW.md](../UOS20_ARM64_DEPLOYMENT_REVIEW.md)。双环境调试铁律（开发机 x86_64 调试场 / 本通道交付基准的边界）见
[UOS_DUAL_ENV_DEBUGGING.md](../UOS_DUAL_ENV_DEBUGGING.md)。其中包括服务进程不能写 `/opt`、compat 版本与 glibc、ClickHouse 旧表补列、端口占用，以及 Docker 镜像通配模板。

## 新增功能的环境适配边界（2026-10-23）

- R1（ring 容量字节目标自适应）与 R2（per-map 丢失计数 perfLostByMap）为纯 Rust/API 改动，
  本通道直接生效；64K 页下 ring 默认仍为 8 页/CPU/map，无需改打包参数。
- R3（截断补读 cursor reread）**当前仅 x86 生效**：BPF 游标代码全部 x86 门控，arm64 对象与
  冻结基线字节一致。仿真侧启用需先解除门控并通过 4.19 验证器实机加载验证（128K 指令预算），
  适配步骤与回退标准见《UOS_仿真环境验证清单》第六节。未经验证不得把 x86 构建参数
  （DST_NARROW/DIAG/显式页数）带入本通道。
