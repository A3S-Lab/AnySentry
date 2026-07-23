# AnySentry UOS 20 ARM64 客户发布通道

本目录将三个仓库经过审核的 integration branch 与双杨客户 UOS 兼容层组合为可追溯的离线发布包。兼容代码不写入 `AnySentry`、`Observer`、`Sentry` 的上游开发分支。

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

```bash
cd /home/chensicheng/.config/superpowers/worktrees/AnySentry/uos20-arm64-0.2.0
ANYSENTRY_RELEASE_DIR=/home/chensicheng/a3s/security/release \
./uos20-arm64/build.sh --version 0.2.0-compat3
```

输出目录：

```text
/home/chensicheng/a3s/security/release/anysentry-security-suite-0.2.0-compat3-uos20-arm64/
/home/chensicheng/a3s/security/release/anysentry-security-suite-0.2.0-compat3-uos20-arm64.tar.gz
/home/chensicheng/a3s/security/release/anysentry-security-suite-0.2.0-compat3-uos20-arm64.tar.gz.sha256
```

仅检查并准备锁定源码：

```bash
./uos20-arm64/build.sh --prepare-only
```

分组件构建：

```bash
./uos20-arm64/build.sh --version 0.2.0-compat3 --component observer
./uos20-arm64/build.sh --version 0.2.0-compat3 --component app
./uos20-arm64/build.sh --version 0.2.0-compat3 --component assemble
```

`--component` 用于开发定位；正式交付必须执行默认的全量构建。

## 上游迭代与兼容层维护

1. 在三个上游仓库正常开发、测试并合并新功能；
2. 从稳定 UOS 分支创建新的 integration branch；
3. direct merge 上游 main，按语义解决冲突并更新 `versions.env` 锁定提交；
4. 执行 `bash uos20-arm64/tests/run-all.sh`；
5. 执行全量构建，以新版本号生成发布包；
6. 在 UOS 同规格验证机执行 `./install.sh --check`、`./install.sh` 和 `/opt/anysentry/verify.sh`；
7. 交付 tar 包、`.sha256` 和 `PROVENANCE`。

更新兼容层时，应在新的 integration 分支提交最小、可审计差异，并确认其中不包含构建产物、密钥、客户数据或无关功能。

## 固定客户 ABI

- 操作系统：UnionTech OS Server 20 Enterprise；
- 架构：aarch64，Kunpeng 920；
- glibc：最低 2.28；
- 页大小：65536；
- 内核显示版本：`4.19.0-arm64-server`；
- BPF 程序版本：`4.19.90`，版本码 `0x0004135a`；
- ClickHouse：`armv8.0-compat`；
- Observer：`perf-kprobe-legacy`，不依赖内核 BTF。

该发布通道是指定客户 ABI，不替代上游通用 Linux 发布流程。
