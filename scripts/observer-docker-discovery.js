'use strict';

const fs = require('node:fs');
const http = require('node:http');

const WORKLOAD_KIND_LABEL = 'anysentry.io/workload-kind';
const WORKLOAD_ROLE_LABEL = 'anysentry.io/workload-role';
const LEGACY_OBSERVE_LABEL = 'io.anysentry.observe';
const AGENT_ID_LABEL = 'anysentry.io/agent-id';
const SNAPSHOT_SCHEMA = 'anysentry.workload_identity_snapshot.v1';
const WORKLOAD_ROLES = new Set([
  'agent',
  'anysentry_internal',
  'platform_infrastructure',
  'business_service',
  'ordinary_process',
  'unknown',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function enabledValue(value) {
  return !['0', 'false', 'off', 'no', 'disabled'].includes(text(value).toLowerCase());
}

function boundedLabels(labels) {
  return Object.fromEntries(
    Object.entries(labels && typeof labels === 'object' ? labels : {})
      .slice(0, 64)
      .map(([key, value]) => [text(key).slice(0, 128), text(value).slice(0, 256)]),
  );
}

function normalizedContainerId(value) {
  return text(value).replace(/^[a-z0-9._-]+:\/\//i, '');
}

function normalizedImageDigest(value) {
  const normalized = text(value).toLowerCase().replace(/^[a-z0-9._-]+:\/\//i, '');
  const match = normalized.match(/(?:^|@)(sha256:[a-f0-9]{64})$/u);
  return match?.[1] || '';
}

function boundedArgv(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  if (value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2_048)) {
    return undefined;
  }
  return value.slice();
}

function dockerHealthchecks(inspect) {
  const config = inspect?.Config && typeof inspect.Config === 'object' ? inspect.Config : {};
  const test = boundedArgv(config?.Healthcheck?.Test);
  if (!test || test[0] === 'NONE') return [];
  if (test[0] === 'CMD') {
    const argv = boundedArgv(test.slice(1));
    return argv ? [{ activitySubtype: 'docker_healthcheck', argv }] : [];
  }
  if (test[0] !== 'CMD-SHELL' || test.length !== 2) return [];
  const shell = boundedArgv(config.Shell) ?? ['/bin/sh', '-c'];
  const argv = boundedArgv([...shell, test[1]]);
  return argv ? [{ activitySubtype: 'docker_healthcheck', argv }] : [];
}

function dockerRuntimeIdentity(inspect, options = {}) {
  const hostPid = Number(inspect?.State?.Pid);
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) return {};
  const procRoot = text(options.procRoot) || '/proc';
  const cgroupRoot = text(options.cgroupRoot) || '/sys/fs/cgroup';
  try {
    const membership = fs.readFileSync(`${procRoot}/${hostPid}/cgroup`, 'utf8');
    const unifiedPath = membership
      .split('\n')
      .map((line) => line.match(/^0::(.+)$/u)?.[1])
      .find(Boolean);
    if (!unifiedPath || unifiedPath.includes('..')) return { hostPid };
    const relative = unifiedPath.replace(/^\/+/, '');
    const cgroupPath = relative ? `${cgroupRoot}/${relative}` : cgroupRoot;
    const stat = fs.statSync(cgroupPath, { bigint: true });
    const cgroupId = stat.ino > 0n ? stat.ino.toString() : '';
    const statLine = fs.readFileSync(`${procRoot}/${hostPid}/stat`, 'utf8').trim();
    const close = statLine.lastIndexOf(')');
    const fields = close >= 0 ? statLine.slice(close + 1).trim().split(/\s+/u) : [];
    const rootStartTimeTicks = fields[19] && /^\d+$/u.test(fields[19]) ? fields[19] : undefined;
    return {
      hostPid,
      cgroupPath: unifiedPath,
      ...(cgroupId ? { cgroupId } : {}),
      ...(rootStartTimeTicks ? { rootStartTimeTicks } : {}),
    };
  } catch {
    return { hostPid };
  }
}

function dockerEntry(container, options = {}) {
  const id = normalizedContainerId(container.Id || container.ID || container.id);
  if (!id) return undefined;
  const labels = boundedLabels(container.Labels || container.labels);
  const workloadKind = text(labels[WORKLOAD_KIND_LABEL]).toLowerCase();
  // Inventory role is an exact deployment fact. Do not normalize arbitrary values into a known
  // role, because a typo must remain visible as unresolved rather than silently changing capture.
  const declaredRole = labels[WORKLOAD_ROLE_LABEL];
  const workloadRole = WORKLOAD_ROLES.has(declaredRole) ? declaredRole : undefined;
  const selectedAgent = workloadKind === 'agent';
  const legacyInfrastructure = ['0', 'false', 'off', 'no', 'disabled']
    .includes(text(labels[LEGACY_OBSERVE_LABEL]).toLowerCase());
  const explicitNonAgent = ['non-agent', 'non_agent', 'infrastructure'].includes(workloadKind)
    || legacyInfrastructure;
  const classification = selectedAgent
    ? 'confirmed_agent'
    : explicitNonAgent
      ? 'non_agent'
      : 'unknown';
  const names = Array.isArray(container.Names) ? container.Names : [container.Name];
  const containerName = text(names.find(Boolean)).replace(/^\/+/, '');
  const agentScopeId = selectedAgent
    ? text(labels[AGENT_ID_LABEL]) || containerName || id.slice(0, 12)
    : undefined;
  const hostId = text(options.hostId) || 'local';
  const evidence = selectedAgent
    ? [
        `label:${WORKLOAD_KIND_LABEL}=agent`,
        `label:${AGENT_ID_LABEL}=${agentScopeId}`,
      ]
    : explicitNonAgent
      ? [legacyInfrastructure
          ? `label:${LEGACY_OBSERVE_LABEL}=${text(labels[LEGACY_OBSERVE_LABEL]).toLowerCase()}`
          : `label:${WORKLOAD_KIND_LABEL}=${workloadKind}`]
      : [`label_missing:${WORKLOAD_KIND_LABEL}`];
  if (workloadRole) evidence.push(`label:${WORKLOAD_ROLE_LABEL}=${workloadRole}`);
  return {
    ids: [id, id.slice(0, 12)].filter(Boolean),
    classification,
    physicalWorkloadId: `docker:${hostId}:${id}`,
    source: 'docker',
    environment: 'docker',
    hostId,
    bootId: text(options.bootId) || undefined,
    containerState: text(container.State || container.state).toLowerCase() || undefined,
    nodeName: text(options.nodeName) || undefined,
    containerName: containerName || undefined,
    containerImage: text(container.Image || container.ImageID || container.image) || undefined,
    imageDigest: normalizedImageDigest(container.ImageID || container.imageID) || undefined,
    labels,
    ...(workloadRole ? { workloadRole } : {}),
    ...(options.runtimeById?.get(id) ?? {}),
    ...(options.inspectById?.get(id)?.length
      ? { platformHealthchecks: options.inspectById.get(id).map((probe) => ({ ...probe, argv: [...probe.argv] })) }
      : {}),
    agentScopeId,
    agentDisplayName: agentScopeId,
    agentInstanceId: selectedAgent ? id : undefined,
    evidence,
  };
}

function dockerSnapshot(containers, options = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    version: Number(options.version) || 0,
    generatedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
    ready: options.ready !== false,
    nodeName: text(options.nodeName) || undefined,
    entries: (Array.isArray(containers) ? containers : [])
      .map((container) => dockerEntry(container, options))
      .filter(Boolean),
    errors: Number(options.errors) || 0,
    source: 'docker',
  };
}

function defaultRequestJson(socketPath, requestPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: requestPath,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`docker api returned ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('docker api timeout')));
    request.end();
  });
}

class DockerDiscovery {
  constructor(options = {}) {
    this.socketPath = text(options.socketPath || process.env.ANYSENTRY_DOCKER_SOCKET) || '/var/run/docker.sock';
    const configured = text(options.enabled ?? process.env.ANYSENTRY_DOCKER_DISCOVERY).toLowerCase();
    this.enabled =
      configured === 'on' ||
      configured === 'true' ||
      configured === '1' ||
      ((!configured || configured === 'auto') &&
        (options.socketExists ? options.socketExists(this.socketPath) : fs.existsSync(this.socketPath)));
    if (configured && !['auto', 'on', 'true', '1'].includes(configured)) {
      this.enabled = enabledValue(configured) && this.enabled;
    }
    this.nodeName = text(options.nodeName);
    this.hostId = text(options.hostId || this.nodeName) || 'local';
    this.bootId = text(options.bootId);
    this.requestJson =
      options.requestJson ||
      ((requestPath) => defaultRequestJson(this.socketPath, requestPath, this.timeoutMs));
    this.streamFactory = options.streamFactory;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.timeoutMs = boundedNumber(options.timeoutMs, 5_000, 250, 120_000);
    this.refreshMs = boundedNumber(
      options.refreshMs ?? Number(process.env.ANYSENTRY_DOCKER_REFRESH_SECS) * 1000,
      60_000,
      1_000,
      3_600_000,
    );
    this.reconnectMs = boundedNumber(options.reconnectMs, 2_000, 100, 60_000);
    this.version = 0;
    this.errors = 0;
    this.reconnects = 0;
    this.ready = false;
    this.containers = [];
    this.inspectById = new Map();
    this.runtimeById = new Map();
    this.inspectInFlight = new Map();
    this.inspectEpoch = new Map();
    this.inspectConcurrency = boundedNumber(options.inspectConcurrency, 4, 1, 16);
    this.refreshGeneration = 0;
    this.refreshInFlight = undefined;
    this.refreshRequested = false;
    this.onSnapshot = () => {};
    this.refreshTimer = undefined;
    this.reconnectTimer = undefined;
    this.eventRequest = undefined;
    this.stopped = false;
  }

  async start(onSnapshot) {
    this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : () => {};
    if (!this.enabled) return false;
    await this.refresh();
    this.openEventStream();
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshMs);
    this.refreshTimer.unref();
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.eventRequest?.destroy();
    this.refreshTimer = undefined;
    this.reconnectTimer = undefined;
    this.eventRequest = undefined;
  }

  async refresh() {
    if (!this.enabled || this.stopped) return false;
    if (this.refreshInFlight) {
      this.refreshRequested = true;
      return this.refreshInFlight;
    }
    const generation = this.refreshGeneration;
    const operation = this.refreshOnce(generation);
    this.refreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined;
      if (this.refreshRequested && !this.stopped) {
        this.refreshRequested = false;
        void this.refresh();
      }
    }
  }

  async refreshOnce(generation) {
    try {
      const containers = await this.requestJson('/containers/json?all=1');
      if (!Array.isArray(containers)) throw new Error('docker container list must be an array');
      if (this.stopped || generation !== this.refreshGeneration) {
        this.refreshRequested = true;
        return false;
      }
      await this.inspectContainers(containers);
      if (this.stopped || generation !== this.refreshGeneration) {
        this.refreshRequested = true;
        return false;
      }
      this.containers = containers;
      this.ready = true;
      this.version++;
      this.onSnapshot(this.snapshot());
      return true;
    } catch {
      if (generation !== this.refreshGeneration) {
        this.refreshRequested = true;
        return false;
      }
      this.errors++;
      this.onSnapshot(this.snapshot());
      return false;
    }
  }

  snapshot() {
    return dockerSnapshot(this.containers, {
      version: this.version,
      ready: this.ready,
      errors: this.errors,
      nodeName: this.nodeName,
      hostId: this.hostId,
      bootId: this.bootId,
      now: this.now,
      inspectById: this.inspectById,
      runtimeById: this.runtimeById,
    });
  }

  async inspectContainers(containers) {
    const ids = containers
      .map((container) => normalizedContainerId(container?.Id || container?.ID || container?.id))
      .filter(Boolean);
    const liveIds = new Set(ids);
    const knownIds = new Set([...this.inspectById.keys(), ...this.inspectInFlight.keys()]);
    for (const id of knownIds) {
      if (liveIds.has(id)) continue;
      this.invalidateInspect(id);
    }
    const pending = ids.filter((id) => !this.inspectById.has(id));
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const id = pending[cursor++];
        await this.inspectContainer(id);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.inspectConcurrency, pending.length) },
      () => worker(),
    ));
  }

  async inspectContainer(id) {
    if (this.inspectById.has(id)) return;
    const existing = this.inspectInFlight.get(id);
    if (existing) return existing;
    const epoch = this.inspectEpoch.get(id) ?? 0;
    const operation = this.requestJson(`/containers/${encodeURIComponent(id)}/json`)
      .then((inspect) => {
        if ((this.inspectEpoch.get(id) ?? 0) === epoch) {
          this.inspectById.set(id, dockerHealthchecks(inspect));
          this.runtimeById.set(id, dockerRuntimeIdentity(inspect));
        }
      })
      .catch(() => {
        // A failed inspect is deliberately not negative-cached; the existing bounded refresh path
        // may retry it while events remain conservatively classified as Agent actions.
        this.errors++;
      })
      .finally(() => {
        if (this.inspectInFlight.get(id) === operation) {
          this.inspectInFlight.delete(id);
          this.inspectEpoch.delete(id);
        }
      });
    this.inspectInFlight.set(id, operation);
    return operation;
  }

  invalidateInspect(id) {
    this.inspectById.delete(id);
    this.runtimeById.delete(id);
    this.inspectEpoch.set(id, (this.inspectEpoch.get(id) ?? 0) + 1);
    if (!this.inspectInFlight.has(id)) this.inspectEpoch.delete(id);
  }

  openEventStream() {
    if (!this.enabled || this.stopped || this.eventRequest) return;
    if (this.streamFactory) {
      this.eventRequest = this.streamFactory(
        (event) => this.handleEvent(event),
        () => this.scheduleReconnect(),
      );
      return;
    }
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
    const request = http.request(
      {
        socketPath: this.socketPath,
        path: `/events?filters=${filters}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      (response) => {
        if ((response.statusCode || 500) >= 400) {
          response.resume();
          this.errors++;
          this.scheduleReconnect();
          return;
        }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              this.handleEvent(JSON.parse(line));
            } catch {
              this.errors++;
            }
          }
        });
        response.on('end', () => this.scheduleReconnect());
      },
    );
    request.on('error', () => {
      if (!this.stopped) {
        this.errors++;
        this.scheduleReconnect();
      }
    });
    request.end();
    this.eventRequest = request;
  }

  handleEvent(event) {
    const action = text(event?.Action || event?.status);
    const refreshActions = [
      'create',
      'start',
      'die',
      'destroy',
      'rename',
      'restart',
      'update',
      'unpause',
    ];
    if (!refreshActions.includes(action)) return;
    this.refreshGeneration++;
    if (action === 'destroy') {
      const id = normalizedContainerId(event?.Actor?.ID || event?.id || event?.ID);
      if (id) {
        this.invalidateInspect(id);
        // Remove probe semantics from the hot classification cache immediately. The subsequent
        // authoritative list refresh removes the destroyed identity itself.
        this.version++;
        this.onSnapshot(this.snapshot());
      }
    }
    void this.refresh();
  }

  scheduleReconnect() {
    this.eventRequest?.destroy();
    this.eventRequest = undefined;
    if (this.stopped || this.reconnectTimer) return;
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.refresh();
      this.openEventStream();
    }, this.reconnectMs);
    this.reconnectTimer.unref();
  }

  metrics() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      version: this.version,
      entries: this.containers.length,
      errors: this.errors,
      reconnects: this.reconnects,
      inspected: this.inspectById.size,
      runtimeIdentities: this.runtimeById.size,
      healthchecks: [...this.inspectById.values()].reduce((total, probes) => total + probes.length, 0),
    };
  }
}

module.exports = {
  DockerDiscovery,
  dockerHealthchecks,
  dockerRuntimeIdentity,
  dockerEntry,
  dockerSnapshot,
  normalizedImageDigest,
};
