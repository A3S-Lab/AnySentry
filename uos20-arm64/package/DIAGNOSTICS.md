# AnySentry 容器 BPF 能力诊断包

本诊断包用于 UOS 20 / AArch64 / Linux 4.19 容器目标机。

## 推荐执行

以 root 解压后进入目录：

```bash
sha256sum --check SHA256SUMS
./RUN_DIAGNOSTICS.sh
```

如果 collector 不在默认路径，可指定：

```bash
./RUN_DIAGNOSTICS.sh /实际路径/a3s-observer-collector
```

完成后脚本会打印报告路径，例如：

```text
Please return this report file: /当前目录/a3s-container-bpf-diagnostics-*.txt
```

把该文本文件完整返回即可。

## 只做被动检查

如果暂时不允许调用 `bpf(2)`：

```bash
./RUN_PASSIVE_CHECK.sh
```

## 安全边界

- 不联网、不安装依赖；
- 不修改 sysctl、capability 或内核配置；
- 不挂载 bpffs、tracefs 或 debugfs；
- 不启停 AnySentry、Observer 或 ClickHouse 服务；
- 被动脚本不执行 `bpftool feature probe`，也不调用 `bpf(2)`；
- syscall 探测器只创建瞬时 BPF map/program FD 并立即关闭；
- 不 attach KProbe、不 pin BPF 对象、不向 tracefs 写入内容；
- 报告不收集 hostname、IP、MAC、路由、DNS、环境变量或完整 cgroup 路径。

`RUN_DIAGNOSTICS.sh` 最长运行约 45 秒；Linux 4.19 `kern_version` 扫描只进行
`BPF_PROG_LOAD`，不会执行或挂载探针。
