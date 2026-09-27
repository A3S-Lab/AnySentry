#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  listProcPids,
  processKey,
  readProcInfo,
} = require('./observer-agent-attribution');
const {
  buildLaunchContext,
  readProcEnvironmentAllowlist,
} = require('./observer-launch-context');

const DEFAULT_MAX_PROCESSES = 20_000;
const DEFAULT_MAX_FDS = 200_000;

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function enabledValue(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const normalized = text(value, 40).toLowerCase();
  return normalized ? !['0', 'false', 'off', 'no', 'disabled'].includes(normalized) : fallback;
}

function text(value, limit = 4_096) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
  return normalized.slice(0, limit);
}

function processGenerationKey(info, defaults = {}) {
  const key = processKey(info, defaults);
  return key
    ? `pgk_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`
    : undefined;
}

function socketInodesForPort(procRoot, port, listenersOnly = true) {
  const target = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const name of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const tcp = name.startsWith('tcp');
    let content;
    try {
      content = fs.readFileSync(path.join(procRoot, 'net', name), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10) continue;
      const local = fields[1]?.split(':');
      const remote = fields[2]?.split(':');
      const state = fields[3];
      if (tcp && listenersOnly && state !== '0A') continue;
      if (!tcp && state !== '07' && state !== '01') continue;
      const localMatch = local?.[1] === target;
      const remoteMatch = !listenersOnly && remote?.[1] === target;
      if (localMatch || remoteMatch) inodes.add(fields[9]);
    }
  }
  return inodes;
}

function normalizedFileTarget(value) {
  const absolute = path.resolve(value);
  try {
    return { absolute, real: fs.realpathSync.native(absolute) };
  } catch {
    return { absolute, real: absolute };
  }
}

function defaultContainerPid(runtime, value) {
  const executable = runtime === 'containerd' ? 'nerdctl' : runtime;
  if (!['docker', 'podman', 'nerdctl'].includes(executable)) return undefined;
  const result = spawnSync(
    executable,
    ['inspect', '--format', '{{.State.Pid}}', '--', value],
    { encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024 },
  );
  return result.status === 0 ? positiveInt(result.stdout) : undefined;
}

class AttributionRepairResolver {
  constructor(options = {}) {
    this.procRoot = options.procRoot || '/proc';
    this.hostId = text(options.hostId, 500) || 'local-host';
    this.bootId = text(options.bootId, 500) || 'unknown-boot';
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.maxProcesses = positiveInt(options.maxProcesses) || DEFAULT_MAX_PROCESSES;
    this.maxFds = positiveInt(options.maxFds) || DEFAULT_MAX_FDS;
    this.launchSessionEnrichmentEnabled = enabledValue(
      options.launchSessionEnrichmentEnabled ?? process.env.ANYSENTRY_LAUNCH_SESSION_ENRICHMENT,
      true,
    );
    this.listPids = typeof options.listPids === 'function'
      ? options.listPids
      : () => listProcPids(this.procRoot);
    this.readProcess = typeof options.readProcess === 'function'
      ? options.readProcess
      : (pid) => readProcInfo(pid, this.procRoot);
    this.containerPid = typeof options.containerPid === 'function'
      ? options.containerPid
      : defaultContainerPid;
  }

  scanDescriptors(match) {
    const pids = [];
    let scannedProcesses = 0;
    let scannedFds = 0;
    const allPids = this.listPids();
    let truncated = allPids.length > this.maxProcesses;
    for (const pid of allPids.slice(0, this.maxProcesses)) {
      scannedProcesses++;
      let entries;
      try {
        entries = fs.readdirSync(path.join(this.procRoot, String(pid), 'fd'));
      } catch {
        continue;
      }
      for (const fd of entries) {
        if (scannedFds >= this.maxFds) {
          truncated = true;
          break;
        }
        scannedFds++;
        let target;
        try {
          target = fs.readlinkSync(path.join(this.procRoot, String(pid), 'fd', fd));
        } catch {
          continue;
        }
        if (match(target)) {
          pids.push(pid);
          break;
        }
      }
      if (truncated) break;
    }
    return { pids: [...new Set(pids)].sort((left, right) => left - right), scannedProcesses, scannedFds, truncated };
  }

  resolveTarget(target) {
    if (target.type === 'pid') {
      const pid = positiveInt(target.value);
      return { pids: pid ? [pid] : [], scannedProcesses: 0, scannedFds: 0, truncated: false };
    }
    if (target.type === 'port') {
      const port = positiveInt(target.value);
      if (!port || port > 65_535) return { pids: [], scannedProcesses: 0, scannedFds: 0, truncated: false };
      let inodes = socketInodesForPort(this.procRoot, port, true);
      let matchMode = 'listener';
      if (inodes.size === 0) {
        inodes = socketInodesForPort(this.procRoot, port, false);
        matchMode = 'connection_fallback';
      }
      return { ...this.scanDescriptors((value) => {
        const inode = value.match(/^socket:\[(\d+)\]$/u)?.[1];
        return Boolean(inode && inodes.has(inode));
      }), matchMode };
    }
    if (target.type === 'file') {
      const file = normalizedFileTarget(String(target.value));
      return this.scanDescriptors((value) => value === file.absolute || value === file.real);
    }
    if (target.type === 'name') {
      const query = text(target.value, 240).toLowerCase();
      const pids = [];
      let scannedProcesses = 0;
      const allPids = this.listPids();
      for (const pid of allPids.slice(0, this.maxProcesses)) {
        scannedProcesses++;
        const info = this.readProcess(pid);
        if (!info) continue;
        const values = [info.comm, path.basename(text(info.exe)), text(info.argv)]
          .map((value) => text(value, 4_096).toLowerCase());
        if (values.some((value) => target.exact ? value === query : value.includes(query))) pids.push(pid);
      }
      return {
        pids: [...new Set(pids)].sort((left, right) => left - right),
        scannedProcesses,
        scannedFds: 0,
        truncated: allPids.length > this.maxProcesses,
      };
    }
    if (target.type === 'container') {
      const runtime = text(target.runtime, 40).toLowerCase() || 'docker';
      const pid = this.containerPid(runtime, text(target.value, 500));
      return { pids: pid ? [pid] : [], scannedProcesses: 0, scannedFds: 0, truncated: false };
    }
    return { pids: [], scannedProcesses: 0, scannedFds: 0, truncated: false };
  }

  repair(target) {
    const resolved = this.resolveTarget(target);
    const processTable = new Map();
    const read = (pid) => {
      if (processTable.has(pid)) return processTable.get(pid);
      const process = this.readProcess(pid);
      const normalized = process ? {
        ...process,
        hostId: text(process.hostId, 500) || this.hostId,
        bootId: text(process.bootId, 500) || this.bootId,
      } : undefined;
      processTable.set(pid, normalized);
      return normalized;
    };
    const candidates = resolved.pids.map((pid) => {
      const process = read(pid);
      if (!process) return { pid, state: 'process_unavailable' };
      const generationKey = (value) => processGenerationKey(value, {
        hostId: text(value?.hostId, 500) || this.hostId,
        bootId: text(value?.bootId, 500) || this.bootId,
      });
      return {
        pid,
        state: 'observed',
        processGenerationKey: generationKey(process),
        process: {
          pid: process.pid,
          ppid: process.ppid,
          startTime: process.startTime,
          comm: text(process.comm, 240),
          exe: text(process.exe, 1_000),
          cwd: text(process.cwd, 1_000),
          cgroup: text(process.cgroup, 4_096),
        },
        launchContext: buildLaunchContext(process, {
          now: this.now,
          getProcess: read,
          generationKey,
          getEnvironment: this.launchSessionEnrichmentEnabled
            ? (pid) => readProcEnvironmentAllowlist(pid, this.procRoot)
            : () => ({}),
        }),
      };
    });
    return {
      schemaVersion: 'anysentry.attribution_repair.v1',
      authority: 'userspace_snapshot',
      observedAt: new Date(this.now()).toISOString(),
      target: {
        type: target.type,
        value: text(target.value, 1_000),
        ...(target.runtime ? { runtime: text(target.runtime, 40) } : {}),
        ...(target.exact === true ? { exact: true } : {}),
      },
      candidates,
      scan: {
        scannedProcesses: resolved.scannedProcesses,
        scannedFds: resolved.scannedFds,
        truncated: resolved.truncated,
        ...(resolved.matchMode ? { matchMode: resolved.matchMode } : {}),
      },
      partial: resolved.truncated || candidates.some((candidate) => candidate.state !== 'observed'),
    };
  }
}

function cliTarget(argv) {
  const types = new Map([
    ['--pid', 'pid'],
    ['--port', 'port'],
    ['--file', 'file'],
    ['--name', 'name'],
    ['--container', 'container'],
  ]);
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const type = types.get(argv[index]);
    if (!type) continue;
    if (target || !argv[index + 1]) return undefined;
    target = { type, value: argv[++index] };
  }
  if (!target) return undefined;
  if (argv.includes('--exact')) target.exact = true;
  const runtimeIndex = argv.indexOf('--runtime');
  if (runtimeIndex >= 0 && argv[runtimeIndex + 1]) target.runtime = argv[runtimeIndex + 1];
  return target;
}

if (require.main === module) {
  const target = cliTarget(process.argv.slice(2));
  if (!target) {
    console.error('usage: observer-attribution-repair.js (--pid N | --port N | --file PATH | --name NAME | --container ID) [--runtime docker|podman|nerdctl|containerd] [--exact]');
    process.exitCode = 4;
  } else {
    const result = new AttributionRepairResolver().repair(target);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.candidates.length ? 0 : 2;
  }
}

module.exports = {
  AttributionRepairResolver,
  processGenerationKey,
  socketInodesForPort,
};
