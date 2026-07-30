'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT_NAMES = 'codex,a3s,a3s-code,a3s code,claude,claude-code,claude code';
const DEFAULT_MAX_PROCS = 20_000;
const DEFAULT_MAX_ANCESTORS = 32;
const RECORD_TTL_MS = 30 * 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 15_000;

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return '';
}

function enabledValue(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(normalized);
}

function basename(value) {
  const normalized = text(value).toLowerCase();
  return normalized ? path.posix.basename(normalized) : '';
}

function canonicalAgentName(value) {
  const normalized = text(value).toLowerCase();
  if (normalized === 'a3s' || normalized === 'a3s-code' || normalized === 'a3s code') return 'a3s code';
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claude code') return 'Claude Code';
  return normalized;
}

function eventPayload(observerEvent) {
  const entries = Object.entries(observerEvent?.event ?? {});
  return entries.length > 0 && entries[0][1] && typeof entries[0][1] === 'object' ? entries[0][1] : {};
}

function argvText(value) {
  if (Array.isArray(value)) return value.map(String).join(' ');
  return text(value);
}

function readProcInfo(pid, procRoot = '/proc') {
  try {
    const base = path.join(procRoot, String(pid));
    const stat = fs.readFileSync(path.join(base, 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ppid = positiveInt(fields[1]);
    const startTime = fields[19] || undefined;
    const comm = fs.readFileSync(path.join(base, 'comm'), 'utf8').trim();
    let tgid;
    let exe = '';
    let argv = '';
    try {
      const status = fs.readFileSync(path.join(base, 'status'), 'utf8');
      tgid = positiveInt(status.match(/^Tgid:\s+(\d+)/m)?.[1]);
    } catch {}
    try { exe = fs.readlinkSync(path.join(base, 'exe')); } catch {}
    try { argv = fs.readFileSync(path.join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' '); } catch {}
    return { pid, tgid, ppid, startTime, comm, exe, argv };
  } catch {
    return undefined;
  }
}

function listProcPids(procRoot = '/proc') {
  try {
    return fs.readdirSync(procRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => positiveInt(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

class AgentAttributor {
  constructor(options = {}) {
    this.procRoot = options.procRoot || '/proc';
    this.maxProcs = positiveInt(options.maxProcs) || DEFAULT_MAX_PROCS;
    this.maxAncestors = positiveInt(options.maxAncestors) || DEFAULT_MAX_ANCESTORS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.readProc = typeof options.readProc === 'function' ? options.readProc : (pid) => readProcInfo(pid, this.procRoot);
    this.listPids = typeof options.listPids === 'function' ? options.listPids : () => listProcPids(this.procRoot);
    this.builtinHintsEnabled = enabledValue(
      options.builtinHintsEnabled ?? process.env.ANYSENTRY_BUILTIN_AGENT_HINTS,
      true,
    );
    const configuredRootNames =
      options.rootNames ??
      process.env.ANYSENTRY_AGENT_ROOT_NAMES ??
      (this.builtinHintsEnabled ? DEFAULT_ROOT_NAMES : '');
    this.rootNames = new Set(text(configuredRootNames)
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
    this.procs = new Map();
    this.tombstones = new Map();
    this.tombstoneTtlMs =
      positiveInt(options.tombstoneTtlMs) ||
      positiveInt(process.env.ANYSENTRY_PROCESS_TOMBSTONE_MS) ||
      DEFAULT_TOMBSTONE_TTL_MS;
    this.maxTombstones =
      positiveInt(options.maxTombstones) ||
      positiveInt(process.env.ANYSENTRY_PROCESS_MAX_TOMBSTONES) ||
      this.maxProcs;
    this.negativeTtlMs =
      positiveInt(options.negativeTtlMs) ||
      positiveInt(process.env.ANYSENTRY_PROCESS_NEGATIVE_TTL_MS) ||
      1_000;
    this.stats = {
      classifications: 0,
      cacheHits: 0,
      cacheMisses: 0,
      procReads: 0,
      bootstrapProcReads: 0,
      fallbackProcReads: 0,
      ancestryProcReads: 0,
    };
  }

  readProcess(pid, reason = 'fallback') {
    this.stats.procReads++;
    if (reason === 'bootstrap') this.stats.bootstrapProcReads++;
    else if (reason === 'ancestry') this.stats.ancestryProcReads++;
    else this.stats.fallbackProcReads++;
    return this.readProc(pid);
  }

  seedFromProc() {
    const now = this.now();
    const snapshot = new Map();
    for (const pid of this.listPids().slice(0, this.maxProcs)) {
      const info = this.readProcess(pid, 'bootstrap');
      if (info) snapshot.set(pid, info);
    }

    let roots = 0;
    for (const info of snapshot.values()) {
      const agentId = this.matchAgentExecutable(info);
      if (!agentId) continue;
      this.remember({ ...info, state: 'agent', agentId, rootPid: info.tgid || info.pid, lastSeen: now });
      roots++;
    }

    let descendants = 0;
    for (const info of snapshot.values()) {
      if (this.procs.get(info.pid)?.state === 'agent') continue;
      const scope = this.resolveSnapshotScope(info, snapshot);
      if (!scope) continue;
      this.remember({ ...info, state: 'agent', agentId: scope.agentId, rootPid: scope.rootPid, lastSeen: now });
      descendants++;
    }
    // Keep the remaining process facts as short-lived unknown entries. The initial snapshot has
    // already paid for these reads, so discarding them would make the first event for every
    // unrelated host process walk /proc again. Unknown remains fail-open and is never promoted to
    // non-Agent merely because it appeared in the snapshot.
    for (const info of snapshot.values()) {
      if (!this.procs.has(info.pid)) this.remember({ ...info, state: 'unknown', lastSeen: now });
    }
    return { scanned: snapshot.size, roots, descendants };
  }

  resolveSnapshotScope(info, snapshot) {
    let current = info;
    const visited = new Set();
    for (let depth = 0; current && depth < this.maxAncestors; depth++) {
      if (visited.has(current.pid)) return undefined;
      visited.add(current.pid);

      const tgid = positiveInt(current.tgid);
      if (tgid && tgid !== current.pid) {
        const leader = this.procs.get(tgid);
        if (leader?.state === 'agent') return { agentId: leader.agentId, rootPid: leader.rootPid };
      }
      const cached = this.procs.get(current.pid);
      if (cached?.state === 'agent') return { agentId: cached.agentId, rootPid: cached.rootPid };

      const ppid = positiveInt(current.ppid);
      if (!ppid || ppid === 1) return undefined;
      current = snapshot.get(ppid);
    }
    return undefined;
  }

  classify(observerEvent) {
    const now = this.now();
    this.stats.classifications++;
    const payload = eventPayload(observerEvent);
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object' ? observerEvent.process : {};
    const pid = positiveInt(processInfo.pid) || positiveInt(payload.pid) || positiveInt(observerEvent?.identity?.task);
    if (!pid) return this.unknown();
    const exiting = Object.prototype.hasOwnProperty.call(observerEvent?.event ?? {}, 'ProcessExit');
    const toolExec = Object.prototype.hasOwnProperty.call(observerEvent?.event ?? {}, 'ToolExec');
    const observed = {
      pid,
      ppid: positiveInt(processInfo.ppid) || positiveInt(payload.ppid),
      startTime:
        text(processInfo.startTimeTicks) ||
        text(processInfo.start_time_ticks) ||
        text(processInfo.startTimeNs) ||
        text(processInfo.start_time_ns),
      cgroupId: text(processInfo.cgroupId) || text(processInfo.cgroup_id),
      comm: text(processInfo.comm) || text(observerEvent?.identity?.agent),
      exe: text(processInfo.exe),
      argv: argvText(payload.argv),
    };
    this.discardReusedPid(observed);
    const cached = this.procs.get(pid);
    const sameCachedProcess = Boolean(
      cached &&
      (
        (observed.startTime && cached.startTime === observed.startTime) ||
        (!observed.startTime &&
          observed.cgroupId &&
          cached.cgroupId &&
          observed.cgroupId === cached.cgroupId)
      ),
    );
    let current = {
      ...(sameCachedProcess ? cached : {}),
      ...observed,
      ppid: observed.ppid || (sameCachedProcess ? cached.ppid : undefined),
      startTime: observed.startTime || (sameCachedProcess ? cached.startTime : undefined),
      cgroupId: observed.cgroupId || (sameCachedProcess ? cached.cgroupId : undefined),
      comm: observed.comm || (sameCachedProcess ? cached.comm : ''),
      exe: observed.exe || (sameCachedProcess ? cached.exe : ''),
      argv: observed.argv || (sameCachedProcess ? cached.argv : ''),
    };
    if (sameCachedProcess) this.stats.cacheHits++;
    else this.stats.cacheMisses++;

    const directAgent = this.matchAgent(current);
    if (directAgent) return this.finish(pid, this.rememberAgent(current, directAgent, pid, 'hint_only', 'argv'), exiting, current);

    const existing = sameCachedProcess ? cached : undefined;
    if (existing?.state === 'agent') return this.finish(pid, this.agentResult(existing), exiting, current);
    const tombstone = this.tombstoneFor(current);
    if (tombstone?.state === 'agent') {
      return this.finish(pid, this.agentResult(tombstone), exiting, current);
    }

    // Routine file/network/security observations reuse a recent negative result. ToolExec and
    // ProcessExit re-evaluate because they are lifecycle/high-signal boundaries and can repair
    // out-of-order parent information.
    if (!toolExec && !exiting && existing?.nextResolveAt > now) {
      if (existing.state === 'non_agent') return this.nonAgentResult();
      return this.unknown();
    }

    // Observer normally supplies the complete process instance. `/proc` is now a cache-miss and
    // missing-fact fallback instead of an unconditional per-event read.
    if (!current.ppid || !current.startTime || !current.comm) {
      const live = this.readProcess(pid, 'fallback');
      if (live) {
        this.discardReusedPid(live);
        current = {
          ...live,
          ...current,
          ppid: current.ppid || live.ppid,
          startTime: current.startTime || live.startTime,
          comm: current.comm || live.comm,
          exe: current.exe || live.exe,
          argv: current.argv || live.argv,
        };
      }
    }

    // Short-process events can arrive out of order. Re-evaluate negative cache entries when
    // a later event carries a usable parent, otherwise ProcessExit can hide the ToolExec lineage.
    const ancestry = this.resolveAncestry(current.ppid, now);
    if (ancestry.state === 'agent') {
      return this.finish(pid, this.rememberAgent(current, ancestry.agentId, ancestry.rootPid, 'process_lineage', 'process_graph'), exiting, current);
    }

    if (ancestry.state === 'non_agent') {
      this.remember({ ...current, state: 'non_agent', lastSeen: now });
      return this.finish(pid, this.nonAgentResult(), exiting, current);
    }

    this.remember({ ...current, state: 'unknown', lastSeen: now });
    return this.finish(pid, this.unknown(), exiting, current);
  }

  nonAgentResult() {
    return {
      state: 'non_agent',
      attribution: {
        monitored: false,
        classification: 'non_agent',
        confidence: 1,
        reason: 'not_agent',
        source: 'process_graph',
        evidence: ['process_lineage:pid1'],
      },
    };
  }

  finish(pid, result, exiting, current) {
    if (exiting) {
      const record = this.procs.get(pid) || (
        result.state === 'agent'
          ? {
              ...current,
              state: 'agent',
              agentId: result.attribution.agentScopeId,
              rootPid: result.attribution.rootPid ?? pid,
              lastSeen: this.now(),
            }
          : undefined
      );
      if (record?.startTime) this.rememberTombstone(record);
      this.procs.delete(pid);
    }
    return result;
  }

  tombstoneFor(info) {
    this.pruneTombstones();
    if (!info.startTime) return undefined;
    const tombstone = this.tombstones.get(info.pid);
    if (!tombstone || tombstone.expiresAt <= this.now()) return undefined;
    return tombstone.record.startTime === info.startTime ? tombstone.record : undefined;
  }

  rememberTombstone(record) {
    this.tombstones.set(record.pid, {
      record: { ...record },
      expiresAt: this.now() + this.tombstoneTtlMs,
    });
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest == null) break;
      this.tombstones.delete(oldest);
    }
  }

  pruneTombstones() {
    const now = this.now();
    for (const [pid, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(pid);
    }
  }

  resolveAncestry(initialPpid, now) {
    let pid = positiveInt(initialPpid);
    if (!pid) return { state: 'unknown' };
    const visited = new Set();

    for (let depth = 0; depth < this.maxAncestors; depth++) {
      if (visited.has(pid)) return { state: 'unknown' };
      visited.add(pid);

      const cached = this.procs.get(pid);
      if (cached?.state === 'agent') return { state: 'agent', agentId: cached.agentId, rootPid: cached.rootPid };
      if (cached?.state === 'non_agent' && cached.nextResolveAt > now) {
        return { state: 'non_agent' };
      }
      if (pid === 1) return { state: 'non_agent' };

      // A recent unknown entry still contains useful parent/start facts. Follow that cached
      // parent without re-reading /proc; once the negative TTL expires, refresh it normally.
      if (cached?.state === 'unknown' && cached.nextResolveAt > now) {
        pid = positiveInt(cached.ppid);
        if (!pid) return { state: 'unknown' };
        continue;
      }

      const live = this.readProcess(pid, 'ancestry');
      if (!live) return cached?.state === 'non_agent' ? { state: 'non_agent' } : { state: 'unknown' };
      this.discardReusedPid(live);

      const tgid = positiveInt(live.tgid);
      if (tgid && tgid !== pid) {
        const leaderCached = this.procs.get(tgid);
        if (leaderCached?.state === 'agent') {
          this.remember({ ...live, state: 'agent', agentId: leaderCached.agentId, rootPid: leaderCached.rootPid, lastSeen: now });
          return { state: 'agent', agentId: leaderCached.agentId, rootPid: leaderCached.rootPid };
        }

        const leader = this.readProcess(tgid, 'ancestry');
        if (leader) {
          this.discardReusedPid(leader);
          const leaderAgent = this.matchAgent(leader);
          if (leaderAgent) {
            this.remember({ ...leader, state: 'agent', agentId: leaderAgent, rootPid: tgid, lastSeen: now });
            this.remember({ ...live, state: 'agent', agentId: leaderAgent, rootPid: tgid, lastSeen: now });
            return { state: 'agent', agentId: leaderAgent, rootPid: tgid };
          }
        }
      }

      const directAgent = this.matchAgent(live);
      if (directAgent) {
        this.remember({ ...live, state: 'agent', agentId: directAgent, rootPid: pid, lastSeen: now });
        return { state: 'agent', agentId: directAgent, rootPid: pid };
      }

      this.remember({ ...live, state: 'unknown', lastSeen: now });
      pid = positiveInt(live.ppid);
      if (!pid) return { state: 'unknown' };
    }
    return { state: 'unknown' };
  }

  matchAgent(info) {
    const executableMatch = this.matchAgentExecutable(info);
    if (executableMatch) return executableMatch;
    if (!this.builtinHintsEnabled) return undefined;
    const argv = text(info.argv).toLowerCase();
    if (!argv) return undefined;
    // Only the command prefix is identity evidence. Scanning every argument lets untrusted
    // prompts such as "Actor: a3s code" misclassify an ordinary node process as an Agent.
    const tokens = argv.split(/\s+/).filter(Boolean);
    const command = basename(tokens[0]);
    if (command === 'codex') return 'codex';
    if (command === 'a3s-code' || (command === 'a3s' && tokens[1] === 'code')) return 'a3s code';
    if (command === 'claude' || command === 'claude-code' || (command === 'claude' && tokens[1] === 'code')) return 'Claude Code';
    return undefined;
  }

  matchAgentExecutable(info) {
    const candidates = [basename(info.comm), basename(info.exe)];
    for (const root of this.rootNames) {
      if (candidates.includes(root)) return canonicalAgentName(root);
    }
    return undefined;
  }

  rememberAgent(info, agentId, rootPid, reason, source) {
    const record = { ...info, state: 'agent', agentId, rootPid, lastSeen: this.now() };
    this.remember(record);
    return {
      state: 'agent',
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        agentScopeId: agentId,
        agentDisplayName: agentId,
        rootPid,
        confidence: source === 'process_graph' ? 0.9 : 0.85,
        reason,
        source,
        evidence: [source === 'process_graph' ? 'process_lineage:agent_root' : 'process_signature:command'],
      },
    };
  }

  agentResult(record) {
    record.lastSeen = this.now();
    return {
      state: 'agent',
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        agentScopeId: record.agentId,
        agentDisplayName: record.agentId,
        rootPid: record.rootPid,
        confidence: 0.9,
        reason: 'process_lineage',
        source: 'process_graph',
        evidence: ['process_lineage:cached_agent_root'],
      },
    };
  }

  unknown() {
    return {
      state: 'unknown',
      attribution: {
        monitored: false,
        classification: 'unknown',
        confidence: 0,
        reason: 'not_evaluated',
        source: 'none',
        evidence: ['process_lineage:incomplete'],
      },
    };
  }

  discardReusedPid(info) {
    const existing = this.procs.get(info.pid);
    if (existing?.startTime && info.startTime && existing.startTime !== info.startTime) this.procs.delete(info.pid);
    const tombstone = this.tombstones.get(info.pid);
    if (
      tombstone?.record.startTime &&
      info.startTime &&
      tombstone.record.startTime !== info.startTime
    ) {
      this.tombstones.delete(info.pid);
    }
  }

  remember(record) {
    const now = this.now();
    if (this.procs.size >= this.maxProcs) {
      for (const [pid, item] of this.procs) {
        if (item.lastSeen < now - RECORD_TTL_MS) this.procs.delete(pid);
      }
      if (this.procs.size >= this.maxProcs) this.procs.clear();
    }
    this.procs.set(record.pid, {
      ...record,
      nextResolveAt:
        record.state === 'agent'
          ? 0
          : record.nextResolveAt ?? now + this.negativeTtlMs,
    });
  }

  metrics() {
    this.pruneTombstones();
    return {
      processes: this.procs.size,
      tombstones: this.tombstones.size,
      ...this.stats,
    };
  }
}

module.exports = { AgentAttributor, readProcInfo, listProcPids };
