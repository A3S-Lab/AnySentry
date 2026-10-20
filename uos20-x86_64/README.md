# AnySentry UOS 家族 x86_64 调试变体通道

本目录是 `uos20-arm64/` 正式交付通道的 **x86_64 调试变体**，用于客户开发机
（Rocky Linux 9.6 x86_64、内核 5.14、4 KiB 页、glibc 2.34、纯 cgroup v2）上的
快速部署与业务层联调。仿真环境（UOS 20 ARM64）仍以 `uos20-arm64/` 通道的
正式包为准，两个通道互不影响。

## 与 arm64 正式通道的差异

| 项 | arm64 正式通道 | 本调试变体 |
| --- | --- | --- |
| 目标 ABI | UOS 20 Enterprise aarch64、64 KiB 页、glibc 2.28 | x86_64、4 KiB 页、glibc 2.34 |
| BPF kern_version | 4.19.90（0x0004135a） | 5.14.0（0x00050e00，可按目标内核改 versions.env） |
| kprobe 符号 | `__arm64_sys_*` | `__x64_sys_*`（Observer `uos20-x86_64-dev` 分支） |
| ClickHouse | 源码构建 armv8.0-compat | 官方镜像 amd64 二进制 |
| a3s-code .node | glibc 2.28 重编 | hypot 符号版本补丁降到 2.2.5（`scripts/build-code-x64.sh`，发布件仅 hypot@GLIBC_2.35 超过目标 glibc） |
| Redis 端口 | 127.0.0.1:6379 | **127.0.0.1:6380**（开发机宿主已有 Redis 占 6379） |
| Observer 锁定 | `00ef87c`（release 分支） | `f84a70a`（uos20-x86_64-dev：per-arch 符号 + 内核读 helper 参数化） |

## 构建前置

- x86_64 Linux 宿主（WSL2 Ubuntu 24.04 验证通过）：bash、git、tar、sha256sum、
  docker（amd64 镜像仅 create+cp，不执行）、rustup、node/pnpm、patchelf；
- 三仓目录：本仓库（本通道所在 checkout）、`OBSERVER_REPO`（uos20-x86_64-dev）、
  `SENTRY_REPO`（锁定 main 提交）；环境变量可覆盖路径；
- a3s-code 兼容缓存：首次执行 `bash uos20-x86_64/scripts/build-code-x64.sh`（对发布件
  做 hypot 版本补丁，已在 Rocky 9 glibc 2.34 容器内 dlopen 验证）。

## 标准构建

```bash
OBSERVER_REPO=$HOME/a3s/Observer SENTRY_REPO=$HOME/a3s/Sentry \
ANYSENTRY_RELEASE_DIR=$HOME/a3s/release \
  bash uos20-x86_64/build.sh --version 0.4.0-compat35
```

输出 `anysentry-security-suite-0.4.0-compat35-uos20-x86_64.tar.gz`（含 `.sha256`）。

## 已知调试盲区（相对仿真环境）

- 5.14 BPF 验证器比 4.19 宽松：变长读/寄存器等价类问题在开发机不暴露，
  BPF C 代码改动仍需在仿真环境过 4.19 验证器；
- 开发机是纯 cgroup v2，UOS 现场 hybrid（v1+v2 unified）布局的 discovery
  分支走不到；
- ARM64 PAN、64 KiB 页、Redis COW 内核缺陷等历史问题在本机不存在。
