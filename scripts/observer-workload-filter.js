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
  const environment =
    entry.environment ||
    (entry.source === 'kubernetes' ? 'kubernetes' : entry.source === 'docker' ? 'docker' : 'host');
  const processName = text(entry.processName || entry.executable);
  const workloadName =
    text(entry.podName) ||
    text(entry.containerName) ||
    text(entry.systemdUnit) ||
    processName;
  const workloadRef = {
    environment,
    kind:
      environment === 'kubernetes'
        ? 'pod'
        : environment === 'docker'
          ? 'container'
          : entry.systemdUnit
            ? 'service'
            : processName
              ? 'process'
              : 'cgroup',
    ...(workloadName ? { name: workloadName } : {}),
    ...(entry.namespace ? { namespace: entry.namespace } : {}),
    ...(entry.podName ? { podName: entry.podName } : {}),
    ...(entry.podUid ? { podUid: entry.podUid } : {}),
    ...(entry.nodeName ? { nodeName: entry.nodeName } : {}),
    ...(entry.containerName ? { containerName: entry.containerName } : {}),
    ...(entry.containerImage ? { containerImage: entry.containerImage } : {}),
    ...(entry.ownerKind ? { ownerKind: entry.ownerKind } : {}),
    ...(entry.ownerName ? { ownerName: entry.ownerName } : {}),
    ...(entry.systemdUnit ? { systemdUnit: entry.systemdUnit } : {}),
    ...(processName ? { processName } : {}),
    ...(entry.executable ? { executable: entry.executable } : {}),
  };
  return {
    monitored,
    classification,
    ...(entry.agentScopeId ? { agentScopeId: entry.agentScopeId } : {}),
    ...(entry.agentDisplayName ? { agentDisplayName: entry.agentDisplayName } : {}),
    ...(entry.agentInstanceId ? { agentInstanceId: entry.agentInstanceId } : {}),
    ...(entry.physicalWorkloadId ? { physicalWorkloadId: entry.physicalWorkloadId } : {}),
    workloadRef,
    confidence: classification === 'confirmed_agent' ? 1 : classification === 'probable_agent' ? 0.7 : 0,
    reason:
      classification === 'confirmed_agent'
        ? 'authoritative_anchor'
        : classification === 'non_agent'
          ? 'not_agent'
          : 'not_evaluated',
    source: entry.attributionSource || entry.source || 'kubernetes',
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
    this.templateRegistry = options.templateRegistry;
    this.sources = new Map();
    this.sourceMetrics = new Map();
    this.candidateCache = new Map();
    this.cgroupBindings = new Map();
    this.maxEventKeys = Math.max(1_000, Number(options.maxEventKeys) || 50_000);
    this.cgroupHits = 0;
    this.cgroupMisses = 0;
  }

  replace(snapshot, sourceKey = 'kubernetes') {
    if (
      !snapshot ||
      snapshot.schemaVersion !== 'anysentry.workload_identity_snapshot.v1' ||
      !Array.isArray(snapshot.entries)
    ) {
      this.errors++;
      return false;
    }
    const sourceEntries = [];
    for (const entry of snapshot.entries) {
      if (!entry || !Array.isArray(entry.ids) || !text(entry.classification)) continue;
      const template = this.templateRegistry?.classifyEntry(entry);
      const nextEntry = template
        ? {
            ...entry,
            classification: template.attribution.classification,
            agentScopeId: template.attribution.agentScopeId,
            agentDisplayName: template.attribution.agentDisplayName,
            agentInstanceId:
              entry.agentInstanceId ||
              (template.attribution.agentScopeId ? entry.physicalWorkloadId : undefined),
            attributionSource: template.attribution.source,
            evidence: [
              ...(Array.isArray(entry.evidence) ? entry.evidence : []),
              ...(template.attribution.evidence ?? []),
            ].slice(0, 16),
          }
        : entry;
      sourceEntries.push(nextEntry);
    }
    this.sources.set(sourceKey, sourceEntries);
    this.sourceMetrics.set(sourceKey, {
      ready: snapshot.ready === true,
      version: Number(snapshot.version) || 0,
      generatedAt: text(snapshot.generatedAt),
      updatedAt: this.now(),
      errors: Number(snapshot.errors) || 0,
    });
    const next = new Map();
    for (const entries of this.sources.values()) {
      for (const entry of entries) {
        for (const rawId of entry.ids) {
          const id = normalizedContainerId(rawId);
          if (id && !next.has(id)) next.set(id, entry);
        }
      }
    }
    /*
     * A source replacement is atomic from the event loop's perspective. A later Docker source can
     * share this cache without overwriting the Kubernetes snapshot.
     */
    this.byId = next;
    // A snapshot change can reclassify or replace a container. Parsed cgroup candidates remain
    // valid, but the fast cgroup -> identity binding must be rebuilt against the new snapshot.
    this.cgroupBindings.clear();
    const metrics = [...this.sourceMetrics.values()];
    this.ready = metrics.some((source) => source.ready);
    this.version = metrics.reduce((total, source) => total + source.version, 0);
    this.generatedAt = metrics
      .map((source) => source.generatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || '';
    this.updatedAt = this.now();
    this.errors = metrics.reduce((total, source) => total + source.errors, 0);
    return true;
  }

  classify(observerEvent) {
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
    const cgroupKey =
      text(processInfo.cgroupId) ||
      text(processInfo.cgroup_id) ||
      text(processInfo.cgroup);
    const identityInfo =
      observerEvent?.identity && typeof observerEvent.identity === 'object'
        ? observerEvent.identity
        : {};
    const explicitContainerId = normalizedContainerId(identityInfo.session);
    const boundIdentity = cgroupKey ? this.cgroupBindings.get(cgroupKey) : undefined;
    const bindingConflicts =
      boundIdentity &&
      explicitContainerId &&
      boundIdentity !== explicitContainerId &&
      !boundIdentity.startsWith(explicitContainerId) &&
      !explicitContainerId.startsWith(boundIdentity);
    if (bindingConflicts) this.cgroupBindings.delete(cgroupKey);
    if (boundIdentity && !bindingConflicts) {
      const entry = this.byId.get(boundIdentity);
      if (entry) {
        this.hits++;
        this.cgroupHits++;
        return this.resultFor(entry);
      }
      this.cgroupBindings.delete(cgroupKey);
    }
    let identity;
    const workload =
      observerEvent?.workload && typeof observerEvent.workload === 'object'
        ? observerEvent.workload
        : {};
    const candidateParts = [
      cgroupKey,
      text(identityInfo.session),
      text(identityInfo.agent),
      text(workload.provider_unit_id),
      text(workload.replica_id),
    ];
    const candidateKey = candidateParts.some(Boolean) ? candidateParts.join('|') : '';
    if (candidateKey && this.candidateCache.has(candidateKey)) {
      identity = this.candidateCache.get(candidateKey);
    } else {
      identity = eventIdentityCandidates(observerEvent);
      if (candidateKey) {
        if (this.candidateCache.size >= this.maxEventKeys) {
          const oldest = this.candidateCache.keys().next().value;
          if (oldest) this.candidateCache.delete(oldest);
        }
        this.candidateCache.set(candidateKey, identity);
      }
    }
    if (!identity.containerized) return undefined;
    for (const candidate of identity.candidates) {
      const entry = this.byId.get(candidate);
      if (!entry) continue;
      this.hits++;
      if (cgroupKey) this.cgroupBindings.set(cgroupKey, candidate);
      return this.resultFor(entry);
    }
    this.misses++;
    this.cgroupMisses++;
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

  resultFor(entry) {
    const attribution = attributionFor(entry);
    if (entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent') {
      return { state: 'agent', attribution };
    }
    if (entry.classification === 'non_agent') {
      return { state: 'non_agent', attribution };
    }
    return { state: 'unknown', attribution };
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
      sources: Object.fromEntries(
        [...this.sourceMetrics.entries()].map(([source, value]) => [
          source,
          {
            ready: value.ready,
            version: value.version,
            entries: this.sources.get(source)?.length ?? 0,
            errors: value.errors,
          },
        ]),
      ),
      candidateCacheEntries: this.candidateCache.size,
      cgroupBindings: this.cgroupBindings.size,
      cgroupHits: this.cgroupHits,
      cgroupMisses: this.cgroupMisses,
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

  allow(observerEvent, pressure = 0) {
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
    const normalizedPressure = Math.max(0, Math.min(1, Number(pressure) || 0));
    const effectiveLimit = Math.max(
      1,
      Math.floor(this.limit * (1 - normalizedPressure * 0.75)),
    );
    if (window.count >= effectiveLimit) return false;
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
