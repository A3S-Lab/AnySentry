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
    if (!id || byCgroup.has(id)) continue;
    const agentScopeId = text(entry.agentScopeId).slice(0, 160);
    const physicalWorkloadId = text(entry.physicalWorkloadId).slice(0, 512);
    byCgroup.set(id, {
      cgroupId: id,
      ...(agentScopeId ? { agentScopeId } : {}),
      ...(physicalWorkloadId ? { physicalWorkloadId } : {}),
    });
  }
  const entries = [...byCgroup.values()].sort((left, right) => {
    const a = BigInt(left.cgroupId);
    const b = BigInt(right.cgroupId);
    return a < b ? -1 : a > b ? 1 : 0;
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
  tlsAgentCgroupDocument,
};
