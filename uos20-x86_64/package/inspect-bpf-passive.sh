#!/usr/bin/env bash
set -u
set -o pipefail

timestamp=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown-time)
output=${A3S_DIAG_OUTPUT:-a3s-container-bpf-passive-$timestamp.txt}
collector=${1:-/opt/anysentry/observer/bin/a3s-observer-collector}

section() { printf '\n===== %s =====\n' "$1"; }
run() {
  local title=$1
  shift
  printf '\n$ %s\n' "$title"
  "$@" 2>&1 || printf '[unavailable or denied; exit=%s]\n' "$?"
}
run_shell() {
  local title=$1 command=$2
  printf '\n$ %s\n' "$title"
  bash -o pipefail -c "$command" 2>&1 || printf '[unavailable or denied; exit=%s]\n' "$?"
}
has_cap() {
  local hex=$1 bit=$2 value
  value=$((16#$hex))
  (( (value & (1 << bit)) != 0 )) && printf YES || printf NO
}

exec > >(tee "$output") 2>&1

section "REPORT"
printf 'schema=a3s.container-bpf-passive.v1\n'
printf 'report=%s\n' "$output"
printf 'collected_at=%s\n' "$(date --iso-8601=seconds 2>/dev/null || date)"
printf 'collector_path=%s\n' "$collector"

section "OS ABI"
run "cat /etc/os-release" cat /etc/os-release
run "uname without hostname" uname -srmv
run "uname -m" uname -m
run "getconf GNU_LIBC_VERSION" getconf GNU_LIBC_VERSION
run "getconf PAGESIZE" getconf PAGESIZE
run "getconf LONG_BIT" getconf LONG_BIT

section "CONTAINER AND NAMESPACES"
run "systemd-detect-virt" systemd-detect-virt
run "systemd-detect-virt --container" systemd-detect-virt --container
run_shell "container marker files" 'for f in /.dockerenv /run/.containerenv /run/systemd/container; do if [ -e "$f" ]; then printf "%s=PRESENT\n" "$f"; else printf "%s=ABSENT\n" "$f"; fi; done'
run_shell "namespace identities" 'for n in user pid mnt net cgroup uts ipc; do printf "self.%s=" "$n"; readlink "/proc/self/ns/$n" 2>/dev/null || echo unavailable; printf "pid1.%s=" "$n"; readlink "/proc/1/ns/$n" 2>/dev/null || echo unavailable; done'
run_shell "cgroup filesystem only" 'stat -fc "cgroup.fs_type=%T" /sys/fs/cgroup 2>/dev/null || true; if [ -f /sys/fs/cgroup/cgroup.controllers ]; then echo cgroup.version=2; else echo cgroup.version=1_or_unavailable; fi'

section "IDENTITY CAPABILITIES SECCOMP"
run "id" id
run_shell "selected process status" "grep -E '^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|Seccomp_filters):' /proc/self/status"
cap_eff=$(awk '/^CapEff:/ {print $2}' /proc/self/status 2>/dev/null)
cap_bnd=$(awk '/^CapBnd:/ {print $2}' /proc/self/status 2>/dev/null)
cap_eff=${cap_eff:-0}
cap_bnd=${cap_bnd:-0}
printf 'cap_eff.CAP_SYS_ADMIN=%s bit=21\n' "$(has_cap "$cap_eff" 21)"
printf 'cap_eff.CAP_SYS_RESOURCE=%s bit=24\n' "$(has_cap "$cap_eff" 24)"
printf 'cap_eff.CAP_PERFMON=%s bit=38\n' "$(has_cap "$cap_eff" 38)"
printf 'cap_eff.CAP_BPF=%s bit=39\n' "$(has_cap "$cap_eff" 39)"
printf 'cap_bnd.CAP_SYS_ADMIN=%s bit=21\n' "$(has_cap "$cap_bnd" 21)"
printf 'cap_bnd.CAP_SYS_RESOURCE=%s bit=24\n' "$(has_cap "$cap_bnd" 24)"
printf 'cap_bnd.CAP_PERFMON=%s bit=38\n' "$(has_cap "$cap_bnd" 38)"
printf 'cap_bnd.CAP_BPF=%s bit=39\n' "$(has_cap "$cap_bnd" 39)"
run "capsh --print" capsh --print

section "KERNEL CONFIGURATION"
run "cat /proc/version" cat /proc/version
run_shell "relevant kernel config" 'cfg="/boot/config-$(uname -r)"; if [ -r "$cfg" ]; then echo "config.source=$cfg"; grep -E "^CONFIG_(BPF|BPF_SYSCALL|BPF_JIT|BPF_EVENTS|BPF_LSM|DEBUG_INFO_BTF|KPROBES|KPROBE_EVENTS|UPROBE_EVENTS|TRACEPOINTS|PERF_EVENTS|SECCOMP|SECCOMP_FILTER|SECURITY|SECURITY_LOCKDOWN_LSM|LSM|USER_NS|PID_NS|NET_NS|CGROUPS|CGROUP_BPF)(=|_)" "$cfg" | sort; elif [ -r /proc/config.gz ]; then echo config.source=/proc/config.gz; zgrep -E "^CONFIG_(BPF|BPF_SYSCALL|BPF_JIT|BPF_EVENTS|BPF_LSM|DEBUG_INFO_BTF|KPROBES|KPROBE_EVENTS|UPROBE_EVENTS|TRACEPOINTS|PERF_EVENTS|SECCOMP|SECCOMP_FILTER|SECURITY|SECURITY_LOCKDOWN_LSM|LSM|USER_NS|PID_NS|NET_NS|CGROUPS|CGROUP_BPF)(=|_)" /proc/config.gz | sort; else echo config.source=UNAVAILABLE; fi'
run_shell "security-only boot parameters" 'for token in $(cat /proc/cmdline 2>/dev/null); do case "$token" in lockdown=*|lsm=*|security=*|selinux=*|enforcing=*|apparmor=*|audit=*|audit_backlog_limit=*) echo "$token";; esac; done'

section "BPF KPROBE PERF FILESYSTEMS"
run_shell "BPF and perf sysctls" 'for k in kernel.unprivileged_bpf_disabled kernel.perf_event_paranoid kernel.kptr_restrict kernel.dmesg_restrict; do sysctl "$k" 2>&1 || true; done'
run_shell "known filesystem mounts" 'for p in /sys/fs/bpf /sys/kernel/tracing /sys/kernel/debug /sys/kernel/debug/tracing; do if [ -e "$p" ]; then printf "%s present=yes " "$p"; stat -fc "fs=%T" "$p" 2>/dev/null || true; findmnt -n -o FSTYPE,OPTIONS "$p" 2>/dev/null || true; else printf "%s present=no\n" "$p"; fi; done'
run_shell "BTF availability" 'if [ -r /sys/kernel/btf/vmlinux ]; then stat -c "btf.present=yes size=%s mode=%a" /sys/kernel/btf/vmlinux; else echo btf.present=no; fi'
run_shell "kprobe control files" 'for p in /sys/kernel/tracing/kprobe_events /sys/kernel/debug/tracing/kprobe_events; do if [ -e "$p" ]; then printf "%s present=yes readable=" "$p"; [ -r "$p" ] && printf yes || printf no; printf " writable="; [ -w "$p" ] && echo yes || echo no; else echo "$p present=no"; fi; done'
run_shell "required ARM64 symbols (addresses redacted)" 'if [ -r /proc/kallsyms ]; then grep -E " [tT] (do_exit|__arm64_sys_execve|__arm64_sys_connect|__arm64_sys_setuid|__arm64_sys_ptrace|__arm64_sys_bind|__arm64_sys_openat|__arm64_sys_unlinkat)$" /proc/kallsyms | awk "{print \$3}" | sort -u; else echo kallsyms=UNREADABLE; fi'
run_shell "BPF-related dmesg tail" 'dmesg 2>/dev/null | grep -Ei "bpf|verifier|kprobe|perf|lockdown|seccomp|apparmor|selinux|denied" | tail -n 160 || true'

section "SECURITY MODULES"
run_shell "active LSM list" 'if [ -r /sys/kernel/security/lsm ]; then cat /sys/kernel/security/lsm; else echo lsm.list=UNAVAILABLE; fi'
run_shell "kernel lockdown" 'if [ -r /sys/kernel/security/lockdown ]; then cat /sys/kernel/security/lockdown; else echo lockdown=UNAVAILABLE; fi'
run "getenforce" getenforce
run "aa-status" aa-status

section "RESOURCE LIMITS"
run_shell "ulimit" 'ulimit -a'
run_shell "selected limits" "grep -E '^(Max locked memory|Max open files|Max processes)' /proc/self/limits"
run_shell "memory availability" "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo"

section "TOOLS"
for tool in bash timeout sha256sum file readelf objdump strace bpftool capsh getconf systemd-detect-virt findmnt; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf 'tool.%s=FOUND path=%s\n' "$tool" "$(command -v "$tool")"
  else
    printf 'tool.%s=MISSING\n' "$tool"
  fi
done
run "bpftool version" bpftool version

section "COLLECTOR ABI"
if [ -f "$collector" ]; then
  run "sha256sum collector" sha256sum "$collector"
  run "file collector" file "$collector"
  run_shell "collector ELF header" "LANG=C readelf -h '$collector' 2>&1 | grep -E 'Class:|Data:|Machine:|Type:'"
  run_shell "collector interpreter and LOAD alignment" "LANG=C readelf -lW '$collector' 2>&1 | grep -E 'Requesting program interpreter|^[[:space:]]*LOAD'"
  run_shell "collector highest GLIBC" "LANG=C readelf -W --version-info --dyn-syms '$collector' 2>/dev/null | sed -nE 's/.*Name: GLIBC_([0-9.]+).*/GLIBC_\\1/p' | sort -Vu | tail -n 1"
  run "collector --version" "$collector" --version
else
  printf 'collector.present=NO path=%s\n' "$collector"
fi

section "PASSIVE ASSESSMENT"
printf 'assessment.cap_sys_admin=%s\n' "$(has_cap "$cap_eff" 21)"
if systemd-detect-virt --container >/dev/null 2>&1; then
  printf 'assessment.container=YES\n'
else
  printf 'assessment.container=NO_OR_UNKNOWN\n'
fi
if [ "$(has_cap "$cap_eff" 21)" = NO ]; then
  printf 'assessment.primary=PROCESS_LACKS_CAP_SYS_ADMIN\n'
else
  printf 'assessment.primary=REQUIRES_RAW_BPF_SYSCALL_PROBE\n'
fi
printf 'passive.completed=yes\n'
printf '\nReport saved to: %s\n' "$output"
