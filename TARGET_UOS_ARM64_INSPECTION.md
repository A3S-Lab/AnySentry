# UOS ARM64 目标机器部署前巡检

本文用于采集 AnySentry、Sentry、Observer 和 ClickHouse 离线部署所需的目标机信息。
主巡检命令只读取系统状态，不安装软件、不加载内核模块、不修改防火墙、不访问公网，
也不会读取密码、Token、SSH 私钥或业务文件内容。

建议使用 `root` 执行。执行完成后，将生成的报告文件通过 WinSCP 下载并反馈给构建人员。

## 1. 一次性完整巡检

将下面整个代码块复制到目标环境的 Bash 终端执行：

```bash
REPORT="/mnt/anysentry-host-inspection-$(hostname)-$(date +%Y%m%d-%H%M%S).txt"

section() {
  printf '\n\n========== %s ==========\n' "$1"
}

run() {
  printf '\n$ %s\n' "$*"
  "$@" 2>&1 || printf '[command failed or unavailable, exit=%s]\n' "$?"
}

run_shell() {
  printf '\n$ %s\n' "$1"
  bash -c "$1" 2>&1 || printf '[command failed or unavailable, exit=%s]\n' "$?"
}

export LC_ALL=C

{
  section "REPORT METADATA"
  run date -Is
  run hostname
  run hostnamectl
  run id
  run whoami
  printf '\nReport path: %s\n' "$REPORT"

  section "OPERATING SYSTEM"
  run uname -a
  run uname -m
  run uname -r
  run getconf GNU_LIBC_VERSION
  run ldd --version
  run_shell "cat /etc/os-release 2>/dev/null || true"
  run_shell "cat /etc/debian_version 2>/dev/null || true"
  run_shell "getconf LONG_BIT 2>/dev/null || true"
  run_shell "getconf PAGESIZE 2>/dev/null || true"
  run_shell "file /bin/bash /bin/sh 2>/dev/null || true"
  run_shell "readelf -l /bin/bash 2>/dev/null | grep -F 'Requesting program interpreter' || true"

  section "CPU AND NUMA"
  run lscpu
  run nproc
  run_shell "grep -E '^(processor|model name|CPU implementer|CPU architecture|CPU part|Features|flags)' /proc/cpuinfo | head -n 120"
  run_shell "command -v numactl >/dev/null 2>&1 && numactl --hardware || true"
  run_shell "find /sys/devices/system/node -maxdepth 1 -type d -name 'node[0-9]*' -printf '%f\\n' 2>/dev/null | sort -V"

  section "MEMORY AND SWAP"
  run free -h
  run_shell "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|HugePages_Total|HugePages_Free|Hugepagesize|DirectMap)' /proc/meminfo"
  run_shell "swapon --show --bytes 2>/dev/null || cat /proc/swaps"
  run_shell "sysctl vm.swappiness vm.overcommit_memory vm.max_map_count 2>/dev/null || true"
  run_shell "ulimit -a"

  section "BLOCK DEVICES AND FILESYSTEMS"
  run df -hT
  run df -i
  run_shell "lsblk -e 7 -o NAME,TYPE,SIZE,FSTYPE,FSVER,MOUNTPOINTS,ROTA,RO,MODEL 2>/dev/null || lsblk"
  run_shell "findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS | head -n 200"
  run_shell "for p in / /mnt /opt /var /var/lib /var/log /tmp; do if [ -e \"\$p\" ]; then printf '%-12s writable=%-5s ' \"\$p\" \"\$([ -w \"\$p\" ] && echo yes || echo no)\"; df -Pk \"\$p\" | awk 'NR==2 {printf \"free_kib=%s mount=%s\\n\", \$4, \$6}'; fi; done"
  run_shell "findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS / 2>/dev/null || true"
  run_shell "findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS /mnt 2>/dev/null || true"
  run_shell "findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS /opt 2>/dev/null || true"
  run_shell "findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS /var/lib 2>/dev/null || true"

  section "SYSTEMD AND CGROUPS"
  run ps -p 1 -o pid,comm,args
  run systemctl --version
  run systemctl is-system-running
  run systemd-detect-virt
  run_shell "stat -fc 'cgroup_fs=%T' /sys/fs/cgroup 2>/dev/null || true"
  run_shell "findmnt -t cgroup,cgroup2 -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null || true"
  run_shell "cat /proc/cgroups 2>/dev/null || true"
  run_shell "cat /proc/self/cgroup 2>/dev/null || true"
  run_shell "systemctl show --property=DefaultLimitNOFILE --property=DefaultTasksMax 2>/dev/null || true"

  section "VIRTUALIZATION AND KVM"
  run systemd-detect-virt --vm
  run systemd-detect-virt --container
  run_shell "test -e /dev/kvm && ls -l /dev/kvm || echo '/dev/kvm: absent'"
  run_shell "if [ -e /dev/kvm ]; then [ -r /dev/kvm ] && echo '/dev/kvm readable: yes' || echo '/dev/kvm readable: no'; [ -w /dev/kvm ] && echo '/dev/kvm writable: yes' || echo '/dev/kvm writable: no'; fi"
  run_shell "lsmod 2>/dev/null | grep -Ei '(^kvm|kvm_|vfio|vhost)' || true"
  run_shell "find /sys/module/kvm* -maxdepth 2 -type f -name version -o -name parameters 2>/dev/null | head -n 80"
  run_shell "test -d /sys/module/kvm && echo 'KVM module/builtin state: present' || echo 'KVM module/builtin state: not visible'"
  run_shell "modprobe -n -v kvm 2>/dev/null || true"
  run_shell "command -v virt-host-validate >/dev/null 2>&1 && virt-host-validate qemu || true"
  run_shell "command -v kvm-ok >/dev/null 2>&1 && kvm-ok || true"
  run_shell "dmesg 2>/dev/null | grep -Ei 'kvm|virtualiz|hypervisor' | tail -n 120 || true"
  run_shell "for f in /sys/class/dmi/id/product_name /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/board_vendor; do [ -r \"\$f\" ] && printf '%s=' \"\$f\" && cat \"\$f\"; done"

  section "KERNEL CONFIG FOR EBPF OBSERVER"
  KERNEL_CONFIG=""
  if [ -r "/boot/config-$(uname -r)" ]; then
    KERNEL_CONFIG="/boot/config-$(uname -r)"
    printf 'Kernel config source: %s\n' "$KERNEL_CONFIG"
    grep -E '^CONFIG_(BPF|BPF_SYSCALL|BPF_JIT|BPF_JIT_ALWAYS_ON|BPF_EVENTS|HAVE_EBPF_JIT|CGROUPS|CGROUP_BPF|SOCKET_DIAG|FTRACE|FTRACE_SYSCALLS|KPROBES|KPROBE_EVENTS|UPROBES|UPROBE_EVENTS|TRACEPOINTS|PERF_EVENTS|DEBUG_INFO_BTF|BPF_LSM|IKCONFIG|IKCONFIG_PROC)=' "$KERNEL_CONFIG" | sort
  elif [ -r /proc/config.gz ]; then
    printf 'Kernel config source: /proc/config.gz\n'
    zgrep -E '^CONFIG_(BPF|BPF_SYSCALL|BPF_JIT|BPF_JIT_ALWAYS_ON|BPF_EVENTS|HAVE_EBPF_JIT|CGROUPS|CGROUP_BPF|SOCKET_DIAG|FTRACE|FTRACE_SYSCALLS|KPROBES|KPROBE_EVENTS|UPROBES|UPROBE_EVENTS|TRACEPOINTS|PERF_EVENTS|DEBUG_INFO_BTF|BPF_LSM|IKCONFIG|IKCONFIG_PROC)=' /proc/config.gz | sort
  else
    echo 'Kernel config is not readable from /boot/config-* or /proc/config.gz'
  fi

  run_shell "mount | grep -E ' type (bpf|tracefs|debugfs) ' || true"
  run_shell "findmnt -t bpf,tracefs,debugfs -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null || true"
  run_shell "test -e /sys/kernel/btf/vmlinux && ls -lh /sys/kernel/btf/vmlinux || echo '/sys/kernel/btf/vmlinux: absent'"
  run_shell "test -d /sys/kernel/debug/tracing && echo '/sys/kernel/debug/tracing: present' || echo '/sys/kernel/debug/tracing: absent'"
  run_shell "test -d /sys/kernel/tracing && echo '/sys/kernel/tracing: present' || echo '/sys/kernel/tracing: absent'"
  run_shell "for base in /sys/kernel/tracing/events /sys/kernel/debug/tracing/events; do if [ -d \"\$base/syscalls\" ]; then echo \"tracepoint root: \$base\"; for e in sys_enter_execve sys_enter_connect sys_enter_sendto sys_enter_sendmsg sys_enter_read sys_exit_read sys_enter_openat sys_enter_unlinkat sys_enter_setuid sys_enter_ptrace sys_enter_bind; do [ -d \"\$base/syscalls/\$e\" ] && echo \"  \$e=yes\" || echo \"  \$e=no\"; done; break; fi; done"
  run_shell "sysctl kernel.unprivileged_bpf_disabled kernel.perf_event_paranoid kernel.kptr_restrict 2>/dev/null || true"
  run_shell "cat /sys/kernel/security/lockdown 2>/dev/null || true"
  run_shell "command -v bpftool >/dev/null 2>&1 && bpftool version || echo 'bpftool: not installed (not required at runtime)'"
  run_shell "command -v bpftool >/dev/null 2>&1 && bpftool feature probe kernel 2>&1 | head -n 300 || true"
  run_shell "if [ \"$(printf '%s\\n' 5.8 \"$(uname -r | cut -d- -f1)\" | sort -V | head -n1)\" = 5.8 ]; then echo 'BPF ring buffer kernel version gate: kernel is >= 5.8'; else echo 'BPF ring buffer kernel version gate: kernel is < 5.8; legacy perf-buffer Observer is required'; fi"

  section "KERNEL MODULES AND HEADERS"
  run_shell "ls -ld /lib/modules/$(uname -r) 2>/dev/null || true"
  run_shell "ls -ld /lib/modules/$(uname -r)/build /lib/modules/$(uname -r)/source 2>/dev/null || true"
  run_shell "find /lib/modules/$(uname -r) -maxdepth 2 -type f \( -name 'kvm*.ko*' -o -name '*bpf*.ko*' \) -print 2>/dev/null | head -n 100"
  run_shell "lsmod 2>/dev/null | head -n 200 || true"

  section "SECURITY CONTROLS"
  run_shell "command -v getenforce >/dev/null 2>&1 && getenforce || echo 'SELinux command unavailable'"
  run_shell "command -v sestatus >/dev/null 2>&1 && sestatus || true"
  run_shell "command -v aa-status >/dev/null 2>&1 && aa-status || true"
  run_shell "cat /sys/kernel/security/lsm 2>/dev/null || true"
  run_shell "cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || true"
  run_shell "systemctl is-active firewalld 2>/dev/null || true"
  run_shell "systemctl is-enabled firewalld 2>/dev/null || true"
  run_shell "command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --get-active-zones || true"
  run_shell "command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --list-ports || true"
  run_shell "command -v ufw >/dev/null 2>&1 && ufw status || true"
  run_shell "command -v nft >/dev/null 2>&1 && nft list tables || true"

  section "NETWORK AND REQUIRED PORTS"
  run_shell "ip -br link 2>/dev/null || true"
  run_shell "ip -br address 2>/dev/null || true"
  run_shell "ip route show 2>/dev/null || true"
  run_shell "ip -6 route show 2>/dev/null || true"
  run_shell "grep -E '^[[:space:]]*(nameserver|search|options)' /etc/resolv.conf 2>/dev/null || true"
  run_shell "ss -lntup 2>/dev/null | head -n 300"
  run_shell "ss -lntp 2>/dev/null | grep -E ':(29653|8123)([[:space:]]|$)' || echo 'Ports 29653 and 8123 are currently free or not visible'"
  run_shell "for p in 29653 8123; do if ss -lnt 2>/dev/null | awk -v suffix=\":\$p\" 'NR>1 && substr(\$4,length(\$4)-length(suffix)+1)==suffix {found=1} END {exit !found}'; then echo \"port \$p: in use\"; else echo \"port \$p: free\"; fi; done"

  section "INSTALLATION COMMAND AVAILABILITY"
  for command_name in bash sh tar gzip xz sha256sum curl ss systemctl getconf sort awk sed grep find install cp mv chmod chown id getent groupadd useradd nologin od tr openssl file readelf ldd; do
    if command -v "$command_name" >/dev/null 2>&1; then
      printf '%-18s %s\n' "$command_name" "$(command -v "$command_name")"
    else
      printf '%-18s MISSING\n' "$command_name"
    fi
  done
  run curl --version
  run tar --version
  run sha256sum --version
  run openssl version

  section "EXISTING RUNTIMES AND SERVICES"
  run_shell "for c in docker podman nerdctl containerd ctr crictl node npm pnpm python3 java clickhouse clickhouse-server; do if command -v \"\$c\" >/dev/null 2>&1; then printf '%-20s %s\n' \"\$c\" \"\$(command -v \"\$c\")\"; else printf '%-20s absent\n' \"\$c\"; fi; done"
  run_shell "systemctl list-unit-files --type=service 2>/dev/null | grep -Ei 'docker|podman|containerd|clickhouse|anysentry|observer' || true"
  run_shell "systemctl list-units --type=service --state=running 2>/dev/null | grep -Ei 'docker|podman|containerd|clickhouse|anysentry|observer' || true"

  section "CURRENT RESOURCE PRESSURE"
  run uptime
  run_shell "cat /proc/loadavg"
  run_shell "ps -eo pid,ppid,user,comm,%cpu,%mem,rss,vsz --sort=-rss | head -n 31"
  run_shell "command -v vmstat >/dev/null 2>&1 && vmstat 1 3 || true"

  section "SUMMARY FLAGS"
  printf 'architecture=%s\n' "$(uname -m)"
  printf 'kernel=%s\n' "$(uname -r)"
  printf 'glibc=%s\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null || echo unknown)"
  printf 'cpu_count=%s\n' "$(nproc 2>/dev/null || echo unknown)"
  printf 'memory_kib=%s\n' "$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
  printf 'root_free_kib=%s\n' "$(df -Pk / | awk 'NR==2 {print $4}')"
  printf 'dev_kvm=%s\n' "$([ -e /dev/kvm ] && echo present || echo absent)"
  printf 'systemd=%s\n' "$(systemctl is-system-running 2>/dev/null || echo unavailable)"
  printf 'port_29653=%s\n' "$(ss -lnt 2>/dev/null | grep -Eq '[:.]29653[[:space:]]' && echo in_use || echo free)"
  printf 'port_8123=%s\n' "$(ss -lnt 2>/dev/null | grep -Eq '[:.]8123[[:space:]]' && echo in_use || echo free)"
  printf 'inspection_complete=yes\n'
} 2>&1 | tee "$REPORT"

printf '\n巡检完成。请通过 WinSCP 下载并反馈文件：%s\n' "$REPORT"
```

## 2. 执行后检查报告文件

```bash
ls -lh /mnt/anysentry-host-inspection-*.txt
tail -n 30 /mnt/anysentry-host-inspection-*.txt
```

需要反馈的是最新生成的完整 `.txt` 文件，而不只是最后 30 行。

## 3. 可选：内网本地模型连通性检查

这部分会向内网模型发送真实 HTTP 请求，不属于上面的只读主机巡检。确认模型地址和
模型 ID 后再执行。`LLM_BASE_URL` 应填写到 OpenAI-compatible 的 `/v1` 层级，末尾不要写
`/chat/completions`。

先填写非敏感配置：

```bash
LLM_BASE_URL='http://10.0.0.10:8000/v1'
LLM_MODEL='请替换为模型ID'
```

如果模型需要 API Key，使用静默输入；不需要时直接按回车：

```bash
read -r -s -p 'LLM API Key（不需要则直接回车）: ' LLM_API_KEY
printf '\n'
```

检查 `/models` 接口：

```bash
if [ -n "$LLM_API_KEY" ]; then
  curl --connect-timeout 5 --max-time 30 -fsS \
    -H "Authorization: Bearer $LLM_API_KEY" \
    "$LLM_BASE_URL/models"
else
  curl --connect-timeout 5 --max-time 30 -fsS \
    "$LLM_BASE_URL/models"
fi
```

检查 L2/L3 必需的 `/chat/completions` 接口和 JSON 输出能力：

```bash
LLM_BODY=$(printf '{"model":"%s","temperature":0,"messages":[{"role":"system","content":"Return only valid JSON."},{"role":"user","content":"Return exactly: {\\"verdict\\":\\"allow\\",\\"severity\\":\\"low\\",\\"reason\\":\\"connectivity test\\"}"}]}' "$LLM_MODEL")

if [ -n "$LLM_API_KEY" ]; then
  curl --connect-timeout 5 --max-time 120 -fsS \
    -X POST "$LLM_BASE_URL/chat/completions" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $LLM_API_KEY" \
    --data-binary "$LLM_BODY"
else
  curl --connect-timeout 5 --max-time 120 -fsS \
    -X POST "$LLM_BASE_URL/chat/completions" \
    -H 'Content-Type: application/json' \
    --data-binary "$LLM_BODY"
fi

unset LLM_API_KEY LLM_BODY
```

请反馈以下非敏感信息，不要反馈真实 API Key：

```text
LLM_BASE_URL=
LLM_MODEL=
LLM_REQUIRES_API_KEY=yes/no
/models HTTP 结果=
/chat/completions HTTP 结果=
模型响应是否位于 choices[0].message.content=yes/no
```

## 4. 判定重点

构建人员会重点检查：

- `architecture=aarch64`。
- glibc 不低于 `2.28`。
- `/`、`/opt`、`/var/lib` 所在文件系统至少有 5 GiB 可用空间。
- PID 1 是 systemd，且 `systemctl` 可用。
- TCP `29653` 和 `8123` 未被其他进程占用。
- `/dev/kvm` 是否存在，仅影响是否可在目标机运行虚拟化测试，不是 AnySentry 的运行前提。
- `CONFIG_BPF`、`CONFIG_BPF_SYSCALL`、`CONFIG_PERF_EVENTS`、tracepoint、kprobe、uprobe 等 Observer 能力。
- Linux 4.19 不支持 BPF Ring Buffer，因此目标包必须使用 legacy perf-buffer Observer。
- 防火墙是否允许授权网段访问 `29653/tcp`；ClickHouse `8123/tcp` 只监听本机回环地址。
- 本地模型是否提供 OpenAI-compatible `/v1/chat/completions`，以及模型 ID、超时和鉴权要求。
