'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT_NAMES = 'codex,a3s,a3s-code,a3s code,claude,claude-code,claude code';
const DEFAULT_MAX_PROCS = 20_000;
const DEFAULT_MAX_ANCESTORS = 32;
const RECORD_TTL_MS = 30 * 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 15_000;
const WORKSPACE_CACHE_SIZE = 4096;
const EPHEMERAL_WORKSPACE_ROOTS = ['/tmp', '/var/tmp', '/proc', '/sys', '/run', '/dev'];

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

function canonicalWorkspacePath(value) {
  const normalized = text(value);
  if (!normalized || !path.posix.isAbsolute(normalized) || normalized === '/') return undefined;
  return path.posix.normalize(normalized).replace(/\/+$/, '');
}

function isPathWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isEphemeralWorkspacePath(value) {
  const normalized = canonicalWorkspacePath(value);
  return Boolean(normalized && EPHEMERAL_WORKSPACE_ROOTS.some((root) => isPathWithin(normalized, root)));
}

function findGitWorkspace(value, fsApi = fs) {
  let current = canonicalWorkspacePath(value);
  if (!current || isEphemeralWorkspacePath(current)) return undefined;
  while (current && current !== '/') {
    try {
      fsApi.lstatSync(path.join(current, '.git'));
      return current;
    } catch {}
    current = path.posix.dirname(current);
  }
  return undefined;
}

function eventPayload(observerEvent) {
  const entries = Object.entries(observerEvent?.event ?? {});
  return entries.length > 0 && entries[0][1] && typeof entries[0][1] === 'object' ? entries[0][1] : {};
}

function argvText(value) {
  if (Array.isArray(value)) return value.map(String).join(' ');
  return text(value);
}

function containerIdFromCgroup(value) {
  const cgroup = text(value);
  if (!cgroup) return undefined;
  return cgroup.match(/(?:^|\/)docker[-/]([a-f0-9]{12,64})(?:\.scope)?(?:$|\/)/i)?.[1]
    || cgroup.match(/(?:^|\/)(?:cri-containerd|crio)[-/]([a-f0-9]{12,64})(?:\.scope)?(?:$|\/)/i)?.[1]
    || cgroup.match(/(?:^|\/)([a-f0-9]{64})(?:\.scope)?(?:$|\/)/i)?.[1];
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
    let cgroup = '';
    let cwd = '';
    try {
      const status = fs.readFileSync(path.join(base, 'status'), 'utf8');
      tgid = positiveInt(status.match(/^Tgid:\s+(\d+)/m)?.[1]);
    } catch {}
    try { exe = fs.readlinkSync(path.join(base, 'exe')); } catch {}
    try { argv = fs.readFileSync(path.join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' '); } catch {}
    try { cgroup = fs.readFileSync(path.join(base, 'cgroup'), 'utf8'); } catch {}
    try { cwd = fs.readlinkSync(path.join(base, 'cwd')); } catch {}
    return { pid, tgid, ppid, startTime, comm, exe, argv, cgroup, cwd };
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
    this.findWorkspaceRoot = typeof options.findWorkspaceRoot === 'function'
      ? options.findWorkspaceRoot
      : findGitWorkspace;
    this.workspaceCache = new Map();
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
    this.infrastructureRoots = new Map();
    this.infrastructureContainers = new Map();
    if (Array.isArray(options.infrastructureRoots)) this.setInfrastructureRoots(options.infrastructureRoots);
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
      this.remember({
        ...info,
        state: 'agent',
        agentId,
        rootPid: info.tgid || info.pid,
        workspacePath: this.resolveWorkspace(info.cwd).workspacePath,
        lastSeen: now,
      });
      roots++;
    }

    let descendants = 0;
    let infrastructureDescendants = 0;
    for (const info of snapshot.values()) {
      if (['agent', 'infrastructure'].includes(this.procs.get(info.pid)?.state)) continue;
      const scope = this.resolveSnapshotScope(info, snapshot);
      if (!scope) continue;
      if (scope.state === 'agent') {
        this.remember({
          ...info,
          state: 'agent',
          agentId: scope.agentId,
          rootPid: scope.rootPid,
          ...this.resolveWorkspace(info.cwd, scope.workspacePath),
          lastSeen: now,
        });
        descendants++;
      } else if (scope.state === 'infrastructure') {
        this.remember({
          ...info,
          state: 'infrastructure',
          rootPid: scope.rootPid,
          serviceName: scope.serviceName,
          containerId: scope.containerId,
          lastSeen: now,
        });
        infrastructureDescendants++;
      }
    }
    // Keep the remaining process facts as short-lived unknown entries. The initial snapshot has
    // already paid for these reads, so discarding them would make the first event for every
    // unrelated host process walk /proc again. Unknown remains fail-open and is never promoted to
    // non-Agent merely because it appeared in the snapshot.
    for (const info of snapshot.values()) {
      if (!this.procs.has(info.pid)) this.remember({ ...info, state: 'unknown', lastSeen: now });
    }
    return {
      scanned: snapshot.size,
      roots,
      descendants,
      infrastructureRoots: this.infrastructureRoots.size,
      infrastructureDescendants,
    };
  }

  resolveSnapshotScope(info, snapshot) {
    let current = info;
    const visited = new Set();
    for (let depth = 0; current && depth < this.maxAncestors; depth++) {
      if (visited.has(current.pid)) return undefined;
      visited.add(current.pid);

      const containerScope = this.matchInfrastructure(current);
      if (containerScope) return containerScope;

      const tgid = positiveInt(current.tgid);
      if (tgid && tgid !== current.pid) {
        const leader = this.procs.get(tgid);
        if (leader?.state === 'agent') return this.agentScope(leader);
        if (leader?.state === 'infrastructure') return this.infrastructureScope(leader);
      }
      const cached = this.procs.get(current.pid);
      if (cached?.state === 'agent') return this.agentScope(cached);
      if (cached?.state === 'infrastructure') return this.infrastructureScope(cached);

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
      cgroup: text(processInfo.cgroup),
      cwd: text(processInfo.cwd) || text(payload.cwd),
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
      cgroup: observed.cgroup || (sameCachedProcess ? cached.cgroup : ''),
      cwd: observed.cwd || (sameCachedProcess ? cached.cwd : ''),
    };
    if (sameCachedProcess) this.stats.cacheHits++;
    else this.stats.cacheMisses++;

    const directAgent = this.matchAgent(current);
    if (directAgent) return this.finish(pid, this.rememberAgent(current, directAgent, pid, 'hint_only', 'argv'), exiting, current);

    const existing = sameCachedProcess ? cached : undefined;
    // Observer normally supplies the complete process instance. `/proc` is now a cache-miss and
    // missing-fact fallback instead of an unconditional per-event read.
    if (!sameCachedProcess && (!current.ppid || !current.startTime || !current.comm || (!current.cgroup && !current.cwd))) {
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
          cgroup: current.cgroup || live.cgroup,
          cwd: current.cwd || live.cwd,
        };
      }
    }

    const directInfrastructure = this.matchInfrastructure(current);
    if (directInfrastructure) {
      return this.finish(
        pid,
        this.rememberInfrastructure(
          current,
          directInfrastructure.rootPid,
          directInfrastructure.serviceName,
          directInfrastructure.containerId,
        ),
        exiting,
        current,
      );
    }

    if (existing?.state === 'agent') {
      // A short process can emit ToolExec and ProcessExit after /proc/<pid>/cwd has already
      // disappeared. Preserve an earlier conflict decision for the same PID instead of silently
      // turning the later event into an unresolved-but-trusted Agent event.
      const workspace = canonicalWorkspacePath(observed.cwd)
        ? this.resolveWorkspace(current.cwd, existing.workspacePath)
        : {
            workspacePath: existing.workspacePath,
            workspaceSource: existing.workspaceSource || 'unresolved',
            workspaceConflict: existing.workspaceConflict === true,
          };
      Object.assign(existing, current, workspace, { lastSeen: now });
      return this.finish(pid, this.agentResult(existing), exiting, current);
    }
    if (existing?.state === 'infrastructure') {
      return this.finish(pid, this.infrastructureResult(existing), exiting, current);
    }
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

    // Short-process events can arrive out of order. Re-evaluate negative cache entries when
    // a later event carries a usable parent, otherwise ProcessExit can hide the ToolExec lineage.
    const ancestry = this.resolveAncestry(current.ppid, now);
    if (ancestry.state === 'agent') {
      return this.finish(
        pid,
        this.rememberAgent(
          current,
          ancestry.agentId,
          ancestry.rootPid,
          'process_lineage',
          'process_graph',
          ancestry.workspacePath,
        ),
        exiting,
        current,
      );
    }

    if (ancestry.state === 'infrastructure') {
      return this.finish(
        pid,
        this.rememberInfrastructure(current, ancestry.rootPid, ancestry.serviceName, ancestry.containerId),
        exiting,
        current,
      );
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
      if (cached?.state === 'agent') return this.agentScope(cached);
      if (cached?.state === 'infrastructure') return this.infrastructureScope(cached);
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

      const containerScope = this.matchInfrastructure(live);
      if (containerScope) {
        this.remember({
          ...live,
          state: 'infrastructure',
          rootPid: containerScope.rootPid,
          serviceName: containerScope.serviceName,
          containerId: containerScope.containerId,
          lastSeen: now,
        });
        return containerScope;
      }

      const tgid = positiveInt(live.tgid);
      if (tgid && tgid !== pid) {
        const leaderCached = this.procs.get(tgid);
        if (leaderCached?.state === 'agent') {
          const scope = this.agentScope(leaderCached);
          this.remember({
            ...live,
            state: 'agent',
            agentId: scope.agentId,
            rootPid: scope.rootPid,
            ...this.resolveWorkspace(live.cwd, scope.workspacePath),
            lastSeen: now,
          });
          return scope;
        }
        if (leaderCached?.state === 'infrastructure') {
          this.remember({
            ...live,
            state: 'infrastructure',
            rootPid: leaderCached.rootPid,
            serviceName: leaderCached.serviceName,
            containerId: leaderCached.containerId,
            lastSeen: now,
          });
          return this.infrastructureScope(leaderCached);
        }

        const leader = this.readProcess(tgid, 'ancestry');
        if (leader) {
          this.discardReusedPid(leader);
          const leaderAgent = this.matchAgent(leader);
          if (leaderAgent) {
            const { workspacePath } = this.resolveWorkspace(leader.cwd);
            const root = { ...leader, state: 'agent', agentId: leaderAgent, rootPid: tgid, workspacePath, lastSeen: now };
            this.remember(root);
            this.remember({
              ...live,
              state: 'agent',
              agentId: leaderAgent,
              rootPid: tgid,
              ...this.resolveWorkspace(live.cwd, workspacePath),
              lastSeen: now,
            });
            return this.agentScope(root);
          }
        }
      }

      const directAgent = this.matchAgent(live);
      if (directAgent) {
        const root = {
          ...live,
          state: 'agent',
          agentId: directAgent,
          rootPid: pid,
          workspacePath: this.resolveWorkspace(live.cwd).workspacePath,
          lastSeen: now,
        };
        this.remember(root);
        return this.agentScope(root);
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

  rememberAgent(info, agentId, rootPid, reason, source, inheritedWorkspacePath) {
    const workspace = this.resolveWorkspace(info.workspacePath || info.cwd, inheritedWorkspacePath);
    const record = { ...info, state: 'agent', agentId, rootPid, ...workspace, lastSeen: this.now() };
    this.remember(record);
    return {
      state: 'agent',
      ...workspace,
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
        ...(workspace.workspaceConflict ? { conflict: true } : {}),
      },
    };
  }

  agentResult(record) {
    record.lastSeen = this.now();
    return {
      state: 'agent',
      workspacePath: record.workspacePath,
      workspaceSource: record.workspaceSource,
      workspaceConflict: record.workspaceConflict,
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
        ...(record.workspaceConflict ? { conflict: true } : {}),
      },
    };
  }

  agentScope(record) {
    return {
      state: 'agent',
      agentId: record.agentId,
      rootPid: record.rootPid,
      workspacePath: record.workspacePath,
    };
  }

  cachedGitWorkspace(value) {
    const normalized = canonicalWorkspacePath(value);
    if (!normalized || isEphemeralWorkspacePath(normalized)) return undefined;
    if (this.workspaceCache.has(normalized)) return this.workspaceCache.get(normalized) || undefined;
    const workspacePath = canonicalWorkspacePath(this.findWorkspaceRoot(normalized));
    if (this.workspaceCache.size >= WORKSPACE_CACHE_SIZE) this.workspaceCache.clear();
    this.workspaceCache.set(normalized, workspacePath || null);
    return workspacePath;
  }

  resolveWorkspace(ownValue, inheritedValue) {
    const ownPath = canonicalWorkspacePath(ownValue);
    const inheritedPath = canonicalWorkspacePath(inheritedValue);
    const ownGitWorkspace = this.cachedGitWorkspace(ownPath);
    if (ownGitWorkspace) {
      return { workspacePath: ownGitWorkspace, workspaceSource: 'event_git_root', workspaceConflict: false };
    }

    if (!ownPath || isEphemeralWorkspacePath(ownPath)) {
      return inheritedPath
        ? { workspacePath: inheritedPath, workspaceSource: 'agent_root', workspaceConflict: false }
        : { workspacePath: undefined, workspaceSource: 'unresolved', workspaceConflict: false };
    }

    if (!inheritedPath) {
      return { workspacePath: ownPath, workspaceSource: 'event_cwd', workspaceConflict: false };
    }

    if (isPathWithin(ownPath, inheritedPath) || isPathWithin(inheritedPath, ownPath)) {
      return { workspacePath: inheritedPath, workspaceSource: 'agent_root', workspaceConflict: false };
    }

    return { workspacePath: undefined, workspaceSource: 'conflict', workspaceConflict: true };
  }

  setInfrastructureRoots(roots) {
    const next = new Map();
    const containers = new Map();
    for (const root of Array.isArray(roots) ? roots : []) {
      const pid = positiveInt(root?.pid);
      if (!pid) continue;
      const live = this.readProcess(pid, 'fallback');
      const record = {
        ...(live || {}),
        pid,
        startTime: live?.startTime,
        state: 'infrastructure',
        rootPid: pid,
        serviceName: text(root.serviceName) || 'infrastructure',
        containerId: text(root.containerId) || undefined,
        lastSeen: this.now(),
      };
      next.set(pid, record);
      if (record.containerId) containers.set(record.containerId, record);
      const existing = this.procs.get(pid);
      if (existing?.state !== 'agent') this.remember(record);
    }
    this.infrastructureRoots = next;
    this.infrastructureContainers = containers;
    return next.size;
  }

  matchInfrastructure(info) {
    const observedId = containerIdFromCgroup(info?.cgroup);
    if (!observedId) return undefined;
    for (const [containerId, record] of this.infrastructureContainers) {
      if (containerId.startsWith(observedId) || observedId.startsWith(containerId)) {
        return this.infrastructureScope(record);
      }
    }
    return undefined;
  }

  rememberInfrastructure(info, rootPid, serviceName, containerId) {
    const record = {
      ...info,
      state: 'infrastructure',
      rootPid,
      serviceName,
      containerId,
      lastSeen: this.now(),
    };
    this.remember(record);
    return this.infrastructureResult(record);
  }

  infrastructureScope(record) {
    return {
      state: 'infrastructure',
      rootPid: record.rootPid,
      serviceName: record.serviceName,
      containerId: record.containerId,
    };
  }

  infrastructureResult(record) {
    record.lastSeen = this.now();
    return {
      ...this.infrastructureScope(record),
      reason: 'infrastructure_root',
      source: record.containerId ? 'docker_label' : 'configured_root',
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

module.exports = {
  AgentAttributor,
  canonicalWorkspacePath,
  findGitWorkspace,
  isEphemeralWorkspacePath,
  containerIdFromCgroup,
  readProcInfo,
  listProcPids,
};
