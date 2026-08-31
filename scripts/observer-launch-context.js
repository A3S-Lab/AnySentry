'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'anysentry.agent_launch_context.v1';
const DEFAULT_MAX_ANCESTORS = 32;
const DEFAULT_MAX_ENVIRONMENT_BYTES = 64 * 1024;
const LAUNCH_ENVIRONMENT_KEYS = new Set(['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TMUX', 'STY']);
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'ash']);
const SUPERVISORS = new Map([
  ['pm2', 'pm2'],
  ['supervisord', 'supervisord'],
  ['supervisor', 'supervisord'],
  ['s6-supervise', 's6'],
  ['s6-svscan', 's6'],
  ['runsv', 'runit'],
  ['runit', 'runit'],
  ['openrc', 'openrc'],
  ['monit', 'monit'],
  ['circusd', 'circus'],
  ['tini', 'tini'],
  ['docker-init', 'docker-init'],
  ['podman-init', 'podman-init'],
  ['forever', 'forever'],
]);

function text(value, limit = 1_000) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
  return normalized.slice(0, limit);
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readProcEnvironmentAllowlist(pid, procRoot = '/proc', maxBytes = DEFAULT_MAX_ENVIRONMENT_BYTES) {
  const processId = positiveInt(pid);
  if (!processId) return {};
  let descriptor;
  try {
    descriptor = fs.openSync(path.join(procRoot, String(processId), 'environ'), 'r');
    const buffer = Buffer.alloc(Math.max(1, Math.min(DEFAULT_MAX_ENVIRONMENT_BYTES, maxBytes)));
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const result = {};
    for (const entry of buffer.subarray(0, bytes).toString('utf8').split('\0')) {
      const separator = entry.indexOf('=');
      if (separator <= 0) continue;
      const key = entry.slice(0, separator);
      if (!LAUNCH_ENVIRONMENT_KEYS.has(key)) continue;
      result[key] = text(entry.slice(separator + 1), 1_000);
    }
    return result;
  } catch {
    return {};
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function port(value) {
  const parsed = positiveInt(value);
  return parsed && parsed <= 65_535 ? parsed : undefined;
}

function sshSessionDetails(environment) {
  const connection = text(environment?.SSH_CONNECTION, 1_000).split(/\s+/u).filter(Boolean);
  const client = text(environment?.SSH_CLIENT, 1_000).split(/\s+/u).filter(Boolean);
  const remoteAddress = text(connection[0] || client[0], 200) || undefined;
  const remotePort = port(connection[1] || client[1]);
  const localAddress = text(connection[2], 200) || undefined;
  const localPort = port(connection[3] || client[2]);
  const tty = text(environment?.SSH_TTY, 500) || undefined;
  const terminalSession = text(environment?.TMUX, 1_000)
    ? 'tmux'
    : text(environment?.STY, 1_000)
      ? 'screen'
      : undefined;
  if (!remoteAddress && !remotePort && !localAddress && !localPort && !tty && !terminalSession) {
    return undefined;
  }
  return { remoteAddress, remotePort, localAddress, localPort, tty, terminalSession };
}

function commandName(process) {
  return path.posix.basename(text(process?.comm || process?.exe, 240)).toLowerCase();
}

function systemdUnitFromCgroup(value) {
  const matches = [...text(value, 4_096)
    .matchAll(/(?:^|\/)([^/]+\.(?:service|socket|timer|scope|slice))(?=\/|$)/gu)]
    .map((match) => match[1]);
  return matches.find((unit) => /\.(?:service|socket|timer)$/u.test(unit)) ?? matches.at(-1);
}

function containerOrigin(value) {
  const cgroup = text(value, 4_096).toLowerCase();
  if (!cgroup) return undefined;
  if (/(?:^|\/)kubepods(?:\/|$|-)/u.test(cgroup)) return 'kubernetes';
  if (/(?:docker[-/]|\/docker\/)/u.test(cgroup)) return 'docker';
  if (/(?:libpod|podman)/u.test(cgroup)) return 'podman';
  if (/(?:cri-containerd|containerd)/u.test(cgroup)) return 'containerd';
  if (/lxc\.payload/u.test(cgroup)) return 'lxc';
  return undefined;
}

function addOrigin(origins, seen, type, process, generationKey, name, details = {}) {
  const key = [type, generationKey || process.pid, name].join('\0');
  if (seen.has(key)) return;
  seen.add(key);
  origins.push({
    type,
    ...(generationKey ? { processGenerationKey: generationKey } : {}),
    pid: process.pid,
    name,
    ...details,
  });
}

function detectOrigins(processes, generationKey, getEnvironment) {
  const origins = [];
  const seen = new Set();
  const environments = processes.map((process) => {
    try { return getEnvironment(process.pid) ?? {}; } catch { return {}; }
  });
  const sshContextIndex = environments.findLastIndex((environment) => sshSessionDetails(environment));
  const sshContext = sshContextIndex >= 0 ? sshSessionDetails(environments[sshContextIndex]) : undefined;
  let hasSshOrigin = false;
  for (const process of processes) {
    const command = commandName(process);
    const key = generationKey(process);
    const systemdUnit = systemdUnitFromCgroup(process.cgroup);
    if (systemdUnit) {
      addOrigin(origins, seen, 'systemd_unit', process, key, systemdUnit);
    }
    if (command === 'systemd' || command === 'init') {
      addOrigin(origins, seen, 'service_manager', process, key, command);
    }
    if (command === 'sshd' || command.startsWith('sshd:')) {
      addOrigin(origins, seen, 'ssh_session', process, key, 'sshd', sshContext);
      hasSshOrigin = true;
    }
    if (SHELLS.has(command)) {
      addOrigin(origins, seen, 'shell', process, key, command);
    }
    const supervisor = SUPERVISORS.get(command);
    if (supervisor) {
      addOrigin(origins, seen, 'supervisor', process, key, supervisor);
    }
    if (command === 'cron' || command === 'crond') {
      addOrigin(origins, seen, 'cron', process, key, 'cron');
    }
    const container = containerOrigin(process.cgroup);
    if (container) {
      addOrigin(origins, seen, 'container', process, key, container);
    }
  }
  if (!hasSshOrigin && sshContext && sshContextIndex >= 0) {
    const process = processes[sshContextIndex];
    addOrigin(origins, seen, 'ssh_session', process, generationKey(process), 'ssh', sshContext);
  }
  return origins;
}

function buildLaunchContext(root, options = {}) {
  const getProcess = typeof options.getProcess === 'function' ? options.getProcess : () => undefined;
  const getEnvironment = typeof options.getEnvironment === 'function'
    ? options.getEnvironment
    : () => ({});
  const generationKey = typeof options.generationKey === 'function' ? options.generationKey : () => undefined;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxAncestors = positiveInt(options.maxAncestors) || DEFAULT_MAX_ANCESTORS;
  const rootPid = positiveInt(root?.pid);
  if (!rootPid) return undefined;
  const rootProcessGenerationKey = generationKey(root);
  // LaunchContext is optional on the wire. Do not emit a structurally unverifiable context that
  // would make the API reject an otherwise valid Runtime snapshot.
  if (!rootProcessGenerationKey) return undefined;

  const rootHost = text(root.hostId, 500);
  const rootBoot = text(root.bootId, 500);
  const reversePath = [];
  const seen = new Set();
  let current = root;
  let completeness = 'complete';

  for (let depth = 0; current && depth < maxAncestors; depth += 1) {
    const pid = positiveInt(current.pid);
    if (!pid) {
      completeness = 'missing_parent';
      break;
    }
    if (seen.has(pid)) {
      completeness = 'cycle';
      break;
    }
    seen.add(pid);
    reversePath.push(current);
    if (pid === 1 || !positiveInt(current.ppid)) break;

    const parent = getProcess(current.ppid);
    if (!parent) {
      completeness = 'missing_parent';
      break;
    }
    if (
      (rootHost && text(parent.hostId, 500) && text(parent.hostId, 500) !== rootHost) ||
      (rootBoot && text(parent.bootId, 500) && text(parent.bootId, 500) !== rootBoot)
    ) {
      completeness = 'process_domain_conflict';
      break;
    }
    current = parent;
    if (depth === maxAncestors - 1) completeness = 'depth_limit';
  }

  const processes = reversePath.reverse();
  const nodes = processes.map((process) => {
    const processGenerationKey = generationKey(process);
    const systemdUnit = systemdUnitFromCgroup(process.cgroup);
    return {
      ...(processGenerationKey ? { processGenerationKey } : {}),
      pid: process.pid,
      ppid: process.ppid || 0,
      command: text(process.comm || path.posix.basename(text(process.exe)), 240),
      ...(text(process.exe) ? { exe: text(process.exe) } : {}),
      ...(systemdUnit ? { systemdUnit } : {}),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    rootProcessGenerationKey,
    observedAt: new Date(now()).toISOString(),
    completeness,
    path: nodes,
    origins: detectOrigins(processes, generationKey, getEnvironment),
  };
}

module.exports = {
  SCHEMA_VERSION,
  buildLaunchContext,
  containerOrigin,
  readProcEnvironmentAllowlist,
  sshSessionDetails,
  systemdUnitFromCgroup,
};
