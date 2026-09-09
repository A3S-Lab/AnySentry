'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TLS_AGENT_CGROUPS_SCHEMA = 'anysentry.tls_agent_cgroups.v1';
const MAX_ENTRIES = 65_536;
const MAX_BYTES = 1024 * 1024;

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function cgroupId(value) {
  const normalized = text(value);
  if (!/^\d{1,20}$/u.test(normalized)) return undefined;
  try {
    const parsed = BigInt(normalized);
    return parsed > 0n && parsed <= 0xffff_ffff_ffff_ffffn ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function positivePid(value) {
  const normalized = text(value);
  if (!/^\d{1,20}$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function rootStartTimeTicks(value) {
  const normalized = text(value);
  return /^\d{1,32}$/u.test(normalized) && BigInt(normalized) > 0n
    ? normalized
    : undefined;
}

function processFence(entry) {
  const rootPid = positivePid(entry?.rootPid);
  const rootStart = rootStartTimeTicks(entry?.rootStartTimeTicks ?? entry?.rootStartTime);
  // A half-present fence is not an admission proof. Keep the entry as legacy only when no
  // competing identity exists; the Collector treats any mixed fenced/legacy cgroup as a
  // conflict and will not perform a broad cgroup admission.
  if (!rootPid || !rootStart) return undefined;
  return {
    rootPid,
    rootStartTimeTicks: rootStart,
    ...(text(entry?.rootProcessKey) ? { rootProcessKey: text(entry.rootProcessKey).slice(0, 512) } : {}),
    ...(text(entry?.agentInstanceId) ? { agentInstanceId: text(entry.agentInstanceId).slice(0, 512) } : {}),
  };
}

/**
 * Join live Docker inventory (cgroup inode + running state) with control-plane /
 * identity-snapshot confirmations that often omit kernel cgroupIds. Promoted rows are
 * intentionally fence-free so multi-product CLI labs (Codex + Claude in one container) keep
 * whole-cgroup TLS admission instead of becoming mixed-product conflicts.
 */
function promoteConfirmedDockerTlsEntries(dockerEntries, confirmedPhysicalWorkloadIds) {
  const confirmed = confirmedPhysicalWorkloadIds instanceof Set
    ? confirmedPhysicalWorkloadIds
    : new Set(
      [...(Array.isArray(confirmedPhysicalWorkloadIds) ? confirmedPhysicalWorkloadIds : [])]
        .map((value) => text(value))
        .filter(Boolean),
    );
  const promotedCgroupIds = new Set();
  const entries = (Array.isArray(dockerEntries) ? dockerEntries : []).map((entry) => {
    const physicalWorkloadId = text(entry?.physicalWorkloadId);
    const id = cgroupId(entry?.cgroupId);
    const running = text(entry?.containerState).toLowerCase() === 'running';
    if (
      !physicalWorkloadId
      || !id
      || !running
      || entry?.classification === 'confirmed_agent'
      || !confirmed.has(physicalWorkloadId)
    ) {
      return entry;
    }
    promotedCgroupIds.add(id);
    return {
      classification: 'confirmed_agent',
      cgroupId: id,
      physicalWorkloadId,
      source: text(entry?.source) || 'docker',
      containerState: 'running',
      // Leave agentScopeId / rootPid / agentInstanceId unset: anonymous legacy admission.
      evidence: [
        ...(Array.isArray(entry?.evidence) ? entry.evidence : []),
        'tls_admission:identity_confirmed_docker_cgroup',
      ].slice(0, 16),
    };
  });
  return { entries, promotedCgroupIds };
}

function tlsAgentCgroupDocument(snapshot) {
  const byCgroup = new Map();
  for (const entry of Array.isArray(snapshot?.entries) ? snapshot.entries.slice(0, MAX_ENTRIES) : []) {
    // Docker inventory remains authoritative when it labels a cgroup confirmed_agent. The
    // forwarder also supplies a generation-fenced process snapshot for host/SSH CLIs; keep a
    // running runtime entry when it has an explicit cgroup and instance identity, even if it is
    // still probable_agent. This local admission file is what lets TLS capture continue across a
    // long idle period while the short control-plane lease is renewed.
    const runtimeEntry = entry?.runtimeState === 'running'
      && text(entry?.agentInstanceId)
      && cgroupId(entry?.cgroupId);
    if (entry?.classification !== 'confirmed_agent' && !runtimeEntry) continue;
    const id = cgroupId(entry.cgroupId);
    if (!id) continue;
    const agentScopeId = text(entry.agentScopeId).slice(0, 160);
    const physicalWorkloadId = text(entry.physicalWorkloadId).slice(0, 512);
    const fence = processFence(entry);
    const candidate = {
      cgroupId: id,
      ...(agentScopeId ? { agentScopeId } : {}),
      ...(physicalWorkloadId ? { physicalWorkloadId } : {}),
      ...(fence ?? {}),
    };
    const group = byCgroup.get(id) ?? [];
    // Keep distinct process generations and identities. The Collector must see the competing
    // entries so it can fail closed for a mixed cgroup instead of accepting whichever entry was
    // enumerated first. Exact duplicates remain idempotent.
    const fingerprint = JSON.stringify(candidate);
    if (!group.some((item) => JSON.stringify(item) === fingerprint)) group.push(candidate);
    byCgroup.set(id, group);
  }
  const entries = [...byCgroup.entries()]
    .flatMap(([, group]) => group)
    .sort((left, right) => {
      const a = BigInt(left.cgroupId);
      const b = BigInt(right.cgroupId);
      if (a !== b) return a < b ? -1 : 1;
      const leftPid = Number(left.rootPid ?? 0);
      const rightPid = Number(right.rootPid ?? 0);
      if (leftPid !== rightPid) return leftPid - rightPid;
      return JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
  return {
    schemaVersion: TLS_AGENT_CGROUPS_SCHEMA,
    version: Number.isSafeInteger(snapshot?.version) && snapshot.version >= 0 ? snapshot.version : 0,
    generatedAt: text(snapshot?.generatedAt) || new Date().toISOString(),
    source: 'docker',
    entries,
  };
}

class TlsAgentCgroupPublisher {
  constructor(options = {}) {
    this.file = text(options.file);
    this.fs = options.fs || fs;
    this.lastSerialized = '';
    this.writes = 0;
    this.errors = 0;
  }

  publish(snapshot) {
    if (!this.file) return 0;
    const document = tlsAgentCgroupDocument(snapshot);
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) {
      this.errors++;
      return 0;
    }
    if (serialized === this.lastSerialized) return document.entries.length;
    try {
      const directory = path.dirname(this.file);
      this.fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
      const temporary = `${this.file}.tmp-${process.pid}`;
      this.fs.writeFileSync(temporary, serialized, { mode: 0o640 });
      this.fs.renameSync(temporary, this.file);
      this.lastSerialized = serialized;
      this.writes++;
      return document.entries.length;
    } catch {
      this.errors++;
      return 0;
    }
  }

  metrics() {
    return { writes: this.writes, errors: this.errors };
  }
}

module.exports = {
  TLS_AGENT_CGROUPS_SCHEMA,
  TlsAgentCgroupPublisher,
  promoteConfirmedDockerTlsEntries,
  tlsAgentCgroupDocument,
};
