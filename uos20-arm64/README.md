# AnySentry UOS 20 ARM64 客户发布通道

本目录将三个上游仓库的 current HEAD 与双杨客户 UOS 兼容层组合为可追溯的离线发布包。兼容代码不写入 `AnySentry`、`Observer`、`Sentry` 的开发分支。

## 构建模型

构建程序按下列顺序执行：

1. 检查三个仓库工作区均为 clean；
2. 使用 `git archive HEAD` 导出到 `.build/uos20-arm64/sources/`；
3. 对临时源码执行 `patches/` 中的兼容 patch；
4. 分组件构建 Sentry、Node、AnySentry、ClickHouse、Observer、L3 和诊断程序；
5. 校验 ARM64 ELF、glibc 2.28、64 KiB LOAD 对齐、ClickHouse CPU 配置和 BPF 版本；
6. 生成 `VERSION`、`PROVENANCE`、`manifest.sha256`、tar 包及 tar 包 SHA-256。

兼容 patch 不能应用到 current HEAD 时，构建立刻终止，不生成发布包。`PROVENANCE` 记录三个 HEAD、两个 patch 校验和和依赖版本。

## 标准构建

```bash
cd /home/chensicheng/a3s/security
git -C AnySentry status --short
git -C Observer status --short
git -C Sentry status --short

./uos20-arm64/build.sh --version 0.1.0-compat2
```

输出目录：

```text
release/anysentry-security-suite-0.1.0-compat2-uos20-arm64/
release/anysentry-security-suite-0.1.0-compat2-uos20-arm64.tar.gz
release/anysentry-security-suite-0.1.0-compat2-uos20-arm64.tar.gz.sha256
```

仅准备源码并验证 patch：

```bash
./uos20-arm64/build.sh --prepare-only
```

分组件构建：

```bash
./uos20-arm64/build.sh --version 0.1.0-compat2 --component observer
./uos20-arm64/build.sh --version 0.1.0-compat2 --component app
./uos20-arm64/build.sh --version 0.1.0-compat2 --component assemble
```

`--component` 用于开发定位；正式交付必须执行默认的全量构建。

## 上游迭代与兼容层维护

1. 在三个上游仓库正常开发、测试并合并新功能；
2. 更新本地分支后运行 `./uos20-arm64/build.sh --prepare-only`；
3. 若 patch 冲突，仅修改 `uos20-arm64/patches/` 和配套脚本；不得在客户发布逻辑中固定旧上游源码；
4. 执行 `bash uos20-arm64/tests/run-all.sh`；
5. 执行全量构建，以新版本号生成发布包；
6. 在 UOS 同规格验证机执行 `./install.sh --check`、`./install.sh` 和 `/opt/anysentry/verify.sh`；
7. 交付 tar 包、`.sha256` 和 `PROVENANCE`。

更新兼容 patch 时，应从当前 HEAD 与已验证适配改动之间生成最小差异，并确认其中不包含构建产物、密钥、客户数据或无关功能。

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
