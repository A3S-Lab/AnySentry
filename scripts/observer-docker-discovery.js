'use strict';

const fs = require('node:fs');
const http = require('node:http');

const WORKLOAD_KIND_LABEL = 'anysentry.io/workload-kind';
const AGENT_ID_LABEL = 'anysentry.io/agent-id';
const SNAPSHOT_SCHEMA = 'anysentry.workload_identity_snapshot.v1';

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

function dockerEntry(container, options = {}) {
  const id = text(container.Id || container.ID || container.id).replace(/^[a-z0-9._-]+:\/\//i, '');
  if (!id) return undefined;
  const labels = boundedLabels(container.Labels || container.labels);
  const workloadKind = text(labels[WORKLOAD_KIND_LABEL]).toLowerCase();
  const selectedAgent = workloadKind === 'agent';
  const explicitNonAgent = ['non-agent', 'non_agent', 'infrastructure'].includes(workloadKind);
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
      ? [`label:${WORKLOAD_KIND_LABEL}=${workloadKind}`]
      : [`label_missing:${WORKLOAD_KIND_LABEL}`];
  return {
    ids: [id, id.slice(0, 12)].filter(Boolean),
    classification,
    physicalWorkloadId: `docker:${hostId}:${id}`,
    source: 'docker',
    environment: 'docker',
    nodeName: text(options.nodeName) || undefined,
    containerName: containerName || undefined,
    containerImage: text(container.Image || container.ImageID || container.image) || undefined,
    labels,
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
    try {
      const containers = await this.requestJson('/containers/json?all=1');
      if (!Array.isArray(containers)) throw new Error('docker container list must be an array');
      this.containers = containers;
      this.ready = true;
      this.version++;
      this.onSnapshot(this.snapshot());
      return true;
    } catch {
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
      now: this.now,
    });
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
    if (
      [
        'create',
        'start',
        'die',
        'destroy',
        'rename',
        'restart',
        'update',
        'unpause',
      ].includes(action)
    ) {
      void this.refresh();
    }
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
    };
  }
}

module.exports = {
  DockerDiscovery,
  dockerEntry,
  dockerSnapshot,
};
