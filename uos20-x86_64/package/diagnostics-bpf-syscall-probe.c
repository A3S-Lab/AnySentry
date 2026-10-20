#define _GNU_SOURCE

#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <unistd.h>

#ifndef SYS_bpf
#ifdef __NR_bpf
#define SYS_bpf __NR_bpf
#else
#error "bpf syscall number is unavailable"
#endif
#endif

enum {
    BPF_MAP_CREATE = 0,
    BPF_PROG_LOAD = 5,
    BPF_MAP_TYPE_ARRAY = 2,
    BPF_MAP_TYPE_PERF_EVENT_ARRAY = 4,
    BPF_MAP_TYPE_PERCPU_ARRAY = 6,
    BPF_PROG_TYPE_SOCKET_FILTER = 1,
    BPF_PROG_TYPE_KPROBE = 2,
};

struct bpf_insn_compat {
    uint8_t code;
    uint8_t dst_src;
    int16_t off;
    int32_t imm;
};

struct bpf_map_create_attr_compat {
    uint32_t map_type;
    uint32_t key_size;
    uint32_t value_size;
    uint32_t max_entries;
    uint32_t map_flags;
    uint32_t inner_map_fd;
    uint32_t numa_node;
    char map_name[16];
    uint32_t map_ifindex;
};

struct bpf_prog_load_attr_compat {
    uint32_t prog_type;
    uint32_t insn_cnt;
    uint64_t insns;
    uint64_t license;
    uint32_t log_level;
    uint32_t log_size;
    uint64_t log_buf;
    uint32_t kern_version;
    uint32_t prog_flags;
    char prog_name[16];
    uint32_t prog_ifindex;
    uint32_t expected_attach_type;
};

_Static_assert(sizeof(struct bpf_insn_compat) == 8, "unexpected BPF instruction size");
_Static_assert(sizeof(struct bpf_map_create_attr_compat) == 48,
               "unexpected Linux 4.19 map attr size");
_Static_assert(sizeof(struct bpf_prog_load_attr_compat) == 72,
               "unexpected Linux 4.19 program attr size");

struct probe_result {
    int fd;
    int error;
    char verifier[65536];
};

static uint32_t kernel_version_code(unsigned int major, unsigned int minor,
                                    unsigned int patch) {
    if (patch > 255)
        patch = 255;
    return (major << 16) | (minor << 8) | patch;
}

static void version_text(uint32_t code, char *buffer, size_t size) {
    snprintf(buffer, size, "%u.%u.%u", code >> 16, (code >> 8) & 0xff,
             code & 0xff);
}

static const char *status_for(const struct probe_result *result) {
    return result->fd >= 0 ? "SUCCESS" : "FAILED";
}

static void sanitize_log(char *log) {
    for (; *log; ++log) {
        if (*log == '\n' || *log == '\r' || *log == '\t')
            *log = ' ';
    }
}

static struct probe_result probe_map(uint32_t map_type, uint32_t key_size,
                                     uint32_t value_size, uint32_t max_entries,
                                     const char *name) {
    struct bpf_map_create_attr_compat attr;
    struct probe_result result;

    memset(&attr, 0, sizeof(attr));
    memset(&result, 0, sizeof(result));
    attr.map_type = map_type;
    attr.key_size = key_size;
    attr.value_size = value_size;
    attr.max_entries = max_entries;
    snprintf(attr.map_name, sizeof(attr.map_name), "%s", name);

    errno = 0;
    result.fd = (int)syscall(SYS_bpf, BPF_MAP_CREATE, &attr, sizeof(attr));
    result.error = result.fd < 0 ? errno : 0;
    return result;
}

static struct probe_result probe_program(uint32_t prog_type, uint32_t kern_version,
                                         const char *name) {
    static const struct bpf_insn_compat instructions[] = {
        {.code = 0xb7, .dst_src = 0, .off = 0, .imm = 0},
        {.code = 0x95, .dst_src = 0, .off = 0, .imm = 0},
    };
    static const char license[] = "GPL";
    struct bpf_prog_load_attr_compat attr;
    struct probe_result result;

    memset(&attr, 0, sizeof(attr));
    memset(&result, 0, sizeof(result));
    attr.prog_type = prog_type;
    attr.insn_cnt = sizeof(instructions) / sizeof(instructions[0]);
    attr.insns = (uint64_t)(uintptr_t)instructions;
    attr.license = (uint64_t)(uintptr_t)license;
    attr.log_level = 1;
    attr.log_size = sizeof(result.verifier);
    attr.log_buf = (uint64_t)(uintptr_t)result.verifier;
    attr.kern_version = kern_version;
    snprintf(attr.prog_name, sizeof(attr.prog_name), "%s", name);

    errno = 0;
    result.fd = (int)syscall(SYS_bpf, BPF_PROG_LOAD, &attr, sizeof(attr));
    result.error = result.fd < 0 ? errno : 0;
    sanitize_log(result.verifier);
    return result;
}

static void print_result(const char *key, const struct probe_result *result) {
    printf("%s.status=%s\n", key, status_for(result));
    printf("%s.errno=%d\n", key, result->error);
    printf("%s.error=%s\n", key,
           result->error ? strerror(result->error) : "none");
    printf("%s.verifier_log=%s\n", key,
           result->verifier[0] ? result->verifier : "EMPTY");
}

static unsigned long long read_status_hex(const char *field) {
    FILE *file = fopen("/proc/self/status", "r");
    char line[256];
    unsigned long long value = 0;

    if (!file)
        return 0;
    while (fgets(line, sizeof(line), file)) {
        if (strncmp(line, field, strlen(field)) == 0) {
            char *separator = strchr(line, ':');
            if (separator)
                value = strtoull(separator + 1, NULL, 16);
            break;
        }
    }
    fclose(file);
    return value;
}

static int self_test(void) {
    char version[32];
    uint32_t code = kernel_version_code(4, 19, 300);

    version_text(code, version, sizeof(version));
    if (code != 0x0413ff || strcmp(version, "4.19.255") != 0)
        return 1;
    if (sizeof(struct bpf_map_create_attr_compat) != 48 ||
        sizeof(struct bpf_prog_load_attr_compat) != 72)
        return 1;
    puts("SELF_TEST=PASS");
    return 0;
}

int main(int argc, char **argv) {
    struct utsname uts;
    unsigned int major = 0, minor = 0, patch = 0;
    uint32_t uname_code;
    char uname_version[32];
    struct probe_result result;
    int candidate_found = 0;
    uint32_t candidate_code = 0;
    int candidate_errno = EINVAL;

    if (argc > 1 && strcmp(argv[1], "--self-test") == 0)
        return self_test();
    if (geteuid() != 0)
        fprintf(stderr, "WARN: run as root for authoritative capability results\n");
    if (uname(&uts) != 0) {
        perror("uname");
        return 2;
    }
    if (sscanf(uts.release, "%u.%u.%u", &major, &minor, &patch) < 2) {
        fprintf(stderr, "unable to parse kernel release: %s\n", uts.release);
        return 2;
    }
    uname_code = kernel_version_code(major, minor, patch);
    version_text(uname_code, uname_version, sizeof(uname_version));

    puts("===== A3S RAW BPF SYSCALL PROBE =====");
    printf("probe.schema=a3s.bpf-syscall-probe.v1\n");
    printf("probe.uid=%ld\n", (long)geteuid());
    printf("probe.kernel_release=%s\n", uts.release);
    printf("probe.uname_version_code=0x%08" PRIx32 "\n", uname_code);
    printf("probe.uname_version=%s\n", uname_version);
    printf("probe.cap_eff=0x%016llx\n", read_status_hex("CapEff"));
    printf("probe.has_cap_sys_admin=%s\n",
           (read_status_hex("CapEff") & (1ULL << 21)) ? "yes" : "no");

    result = probe_map(BPF_MAP_TYPE_ARRAY, sizeof(uint32_t), sizeof(uint64_t), 1,
                       "a3s_array");
    print_result("map.array", &result);
    if (result.fd >= 0)
        close(result.fd);

    result = probe_map(BPF_MAP_TYPE_PERCPU_ARRAY, sizeof(uint32_t),
                       sizeof(uint64_t), 1, "a3s_percpu");
    print_result("map.percpu_array", &result);
    if (result.fd >= 0)
        close(result.fd);

    result = probe_map(BPF_MAP_TYPE_PERF_EVENT_ARRAY, sizeof(uint32_t),
                       sizeof(uint32_t), 1, "a3s_perf");
    print_result("map.perf_event_array", &result);
    if (result.fd >= 0)
        close(result.fd);

    result = probe_program(BPF_PROG_TYPE_SOCKET_FILTER, 0, "a3s_socket");
    print_result("prog.socket_filter", &result);
    if (result.fd >= 0)
        close(result.fd);

    result = probe_program(BPF_PROG_TYPE_KPROBE, uname_code, "a3s_kprobe");
    print_result("prog.kprobe_uname_version", &result);
    if (result.fd >= 0) {
        candidate_found = 1;
        candidate_code = uname_code;
        candidate_errno = 0;
        close(result.fd);
    } else if (result.error != EINVAL) {
        candidate_found = 1;
        candidate_code = uname_code;
        candidate_errno = result.error;
    }

    if (!candidate_found && major == 4 && minor == 19) {
        unsigned int sublevel;
        puts("scan.kprobe_4_19.started=yes");
        for (sublevel = 0; sublevel <= 255; ++sublevel) {
            uint32_t code = kernel_version_code(4, 19, sublevel);
            if (code == uname_code)
                continue;
            result = probe_program(BPF_PROG_TYPE_KPROBE, code, "a3s_kprobe");
            if (result.fd >= 0 || result.error != EINVAL) {
                candidate_found = 1;
                candidate_code = code;
                candidate_errno = result.fd >= 0 ? 0 : result.error;
                if (result.fd >= 0)
                    close(result.fd);
                break;
            }
        }
        puts("scan.kprobe_4_19.completed=yes");
    } else {
        puts("scan.kprobe_4_19.started=no");
        puts("scan.kprobe_4_19.completed=no");
    }

    if (candidate_found) {
        char candidate_version[32];
        version_text(candidate_code, candidate_version, sizeof(candidate_version));
        puts("scan.kprobe_candidate.found=yes");
        printf("scan.kprobe_candidate.version=%s\n", candidate_version);
        printf("scan.kprobe_candidate.version_code=0x%08" PRIx32 "\n",
               candidate_code);
        printf("scan.kprobe_candidate.errno=%d\n", candidate_errno);
        printf("scan.kprobe_candidate.error=%s\n",
               candidate_errno ? strerror(candidate_errno) : "none");
    } else {
        puts("scan.kprobe_candidate.found=no");
        puts("scan.kprobe_candidate.version=none");
        puts("scan.kprobe_candidate.errno=22");
        puts("scan.kprobe_candidate.error=all_candidates_returned_EINVAL");
    }

    if (!(read_status_hex("CapEff") & (1ULL << 21)))
        puts("assessment=NO_CAP_SYS_ADMIN");
    else if (!candidate_found)
        puts("assessment=KPROBE_TYPE_OR_VENDOR_ABI_UNAVAILABLE");
    else if (candidate_errno == EPERM)
        puts("assessment=KPROBE_BLOCKED_BY_SECURITY_POLICY");
    else if (candidate_errno == 0 && candidate_code != uname_code)
        puts("assessment=KERNEL_VERSION_CODE_MISMATCH");
    else if (candidate_errno == 0)
        puts("assessment=MINIMAL_KPROBE_LOAD_SUPPORTED");
    else
        puts("assessment=KPROBE_LOAD_FAILED_OTHER_ERRNO");

    puts("probe.completed=yes");
    return 0;
}
