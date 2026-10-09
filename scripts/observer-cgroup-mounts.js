'use strict';

const fs = require('node:fs');

// Hybrid cgroup layouts (UOS 20, older RHEL/CentOS) mount v1 controllers at
// /sys/fs/cgroup/<controller> and the v2 unified hierarchy at /sys/fs/cgroup/unified. Only the
// unified hierarchy's kernfs inodes match what bpf_get_current_cgroup_id reports in-kernel, so
// resolving a `0::/docker/<id>` membership line must follow the real cgroup2 mount point instead
// of assuming /sys/fs/cgroup. Mount points are static after boot, so the lookup is cached.
const rootCache = new Map();

function decodeMountField(value) {
  // /proc/mounts escapes space as \040, tab as \011, newline as \012, backslash as \134.
  return value.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function resolveCgroup2Root(procRoot = '/proc', fallbackRoot = '/sys/fs/cgroup') {
  const key = `${procRoot}|${fallbackRoot}`;
  const cached = rootCache.get(key);
  if (cached) return cached;
  let resolved = fallbackRoot;
  try {
    const mounts = fs.readFileSync(`${procRoot}/mounts`, 'utf8');
    for (const line of mounts.split('\n')) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length >= 3 && fields[2] === 'cgroup2' && fields[1]) {
        resolved = decodeMountField(fields[1]);
        break;
      }
    }
  } catch {
    // No mounts table (unit fixtures, restricted sandboxes): keep the configured root.
  }
  rootCache.set(key, resolved);
  return resolved;
}

module.exports = {
  resolveCgroup2Root,
};
