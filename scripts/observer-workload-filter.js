'use strict';

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizedContainerId(value) {
  return text(value).replace(/^[a-z0-9._-]+:\/\//i, '');
}

function eventIdentityCandidates(observerEvent) {
  const identity = observerEvent?.identity && typeof observerEvent.identity === 'object'
    ? observerEvent.identity
    : {};
  const workload = observerEvent?.workload && typeof observerEvent.workload === 'object'
    ? observerEvent.workload
    : {};
  const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
  const cgroup = text(processInfo.cgroup);
  const containerIds = [];
  const podIds = [];
  const add = (target, value) => {
    const normalized = normalizedContainerId(value);
    if (normalized && !target.includes(normalized)) target.push(normalized);
  };

  // Container-specific facts win over Pod-level identity so a sidecar cannot inherit the
  // classification of another container in the same Pod.
  add(containerIds, identity.session);
  add(containerIds, workload.provider_unit_id);
  for (const match of cgroup.matchAll(/(?:^|[-/])([a-f0-9]{64})(?:\.scope|$|[/.-])/gi)) {
    add(containerIds, match[1]);
    add(containerIds, match[1].slice(0, 12));
  }

  add(podIds, identity.agent);
  add(podIds, workload.replica_id);
  for (const match of cgroup.matchAll(/pod([a-f0-9][a-f0-9_-]{28,})/gi)) {
    add(podIds, match[1].replaceAll('_', '-'));
  }
  return {
    candidates: [...containerIds, ...podIds],
    containerized:
      containerIds.length > 0 ||
      Object.keys(workload).length > 0 ||
      /(?:kubepods|docker|containerd|crio|libpod)/i.test(cgroup),
  };
}

function attributionFor(entry) {
  const classification = entry.classification;
  const monitored = classification === 'confirmed_agent' || classification === 'probable_agent';
  return {
    monitored,
    classification,
    ...(entry.agentScopeId ? { agentScopeId: entry.agentScopeId } : {}),
    ...(entry.agentDisplayName ? { agentDisplayName: entry.agentDisplayName } : {}),
    ...(entry.agentInstanceId ? { agentInstanceId: entry.agentInstanceId } : {}),
    ...(entry.physicalWorkloadId ? { physicalWorkloadId: entry.physicalWorkloadId } : {}),
    confidence: classification === 'confirmed_agent' ? 1 : classification === 'probable_agent' ? 0.7 : 0,
    reason:
      classification === 'confirmed_agent'
        ? 'authoritative_anchor'
        : classification === 'non_agent'
          ? 'not_agent'
          : 'not_evaluated',
    source: 'kubernetes',
    evidence: Array.isArray(entry.evidence) ? entry.evidence.slice(0, 16) : [],
  };
}

class WorkloadIdentityCache {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.byId = new Map();
    this.ready = false;
    this.version = 0;
    this.generatedAt = '';
    this.updatedAt = 0;
    this.errors = 0;
    this.hits = 0;
    this.misses = 0;
  }

  replace(snapshot) {
    if (
      !snapshot ||
      snapshot.schemaVersion !== 'anysentry.workload_identity_snapshot.v1' ||
      !Array.isArray(snapshot.entries)
    ) {
      this.errors++;
      return false;
    }
    const next = new Map();
    for (const entry of snapshot.entries) {
      if (!entry || !Array.isArray(entry.ids) || !text(entry.classification)) continue;
      for (const rawId of entry.ids) {
        const id = normalizedContainerId(rawId);
        if (id && !next.has(id)) next.set(id, entry);
      }
    }
    this.byId = next;
    this.ready = snapshot.ready === true;
    this.version = Number(snapshot.version) || 0;
    this.generatedAt = text(snapshot.generatedAt);
    this.updatedAt = this.now();
    this.errors = Number(snapshot.errors) || 0;
    return true;
  }

  classify(observerEvent) {
    const identity = eventIdentityCandidates(observerEvent);
    if (!identity.containerized) return undefined;
    for (const candidate of identity.candidates) {
      const entry = this.byId.get(candidate);
      if (!entry) continue;
      this.hits++;
      const attribution = attributionFor(entry);
      if (entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent') {
        return { state: 'agent', attribution };
      }
      if (entry.classification === 'non_agent') {
        return { state: 'non_agent', attribution };
      }
      return { state: 'unknown', attribution };
    }
    this.misses++;
    // Container evidence without a registry match is never handed to host PID-name heuristics.
    // Metadata may be starting, stale, or temporarily unavailable, so the only safe state is
    // unknown and the event remains observable.
    return {
      state: 'unknown',
      attribution: {
        monitored: false,
        classification: 'unknown',
        confidence: 0,
        reason: 'not_evaluated',
        source: 'none',
        degraded: !this.ready,
        evidence: [this.ready ? 'workload_snapshot:miss' : 'workload_snapshot:not_ready'],
      },
    };
  }

  metrics() {
    return {
      ready: this.ready,
      version: this.version,
      ageSeconds: this.updatedAt ? Math.max(0, Math.round((this.now() - this.updatedAt) / 1000)) : -1,
      entries: this.byId.size,
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
    };
  }
}

class DiscoveryBudget {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.limit = Math.max(1, Number(options.limit) || 20);
    this.windowMs = Math.max(100, Number(options.windowMs) || 1_000);
    this.maxKeys = Math.max(100, Number(options.maxKeys) || 10_000);
    this.windows = new Map();
  }

  allow(observerEvent) {
    const identity = eventIdentityCandidates(observerEvent);
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
    const rawPayload = Object.values(observerEvent?.event ?? {})[0];
    const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
    const key =
      identity.candidates[0] ||
      text(processInfo.cgroupId) ||
      text(processInfo.cgroup_id) ||
      text(observerEvent?.identity?.agent) ||
      text(processInfo.pid) ||
      text(payload.pid) ||
      'unknown';
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) return false;
    window.count++;
    if (this.windows.size > this.maxKeys) {
      for (const [candidate, item] of this.windows) {
        if (now - item.startedAt >= this.windowMs) this.windows.delete(candidate);
      }
      while (this.windows.size > this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (!oldest) break;
        this.windows.delete(oldest);
      }
    }
    return true;
  }
}

module.exports = {
  DiscoveryBudget,
  WorkloadIdentityCache,
  eventIdentityCandidates,
  normalizedContainerId,
};
