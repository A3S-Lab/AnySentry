'use strict';

const http = require('node:http');

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_LABEL = 'io.anysentry.observe=false';
const DEFAULT_REFRESH_SECS = 30;

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function staticRoots(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [pidText, serviceName = 'configured-infrastructure'] = entry.split(':', 2);
      const pid = positiveInt(pidText);
      return pid ? { pid, serviceName, source: 'environment' } : undefined;
    })
    .filter(Boolean);
}

function requestJson(socketPath, requestPath, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: requestPath,
      method: 'GET',
      headers: { Host: 'docker' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) req.destroy(new Error('Docker API response exceeded 8 MiB'));
      });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`Docker API returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : undefined);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API exceeded ${timeoutMs}ms`)));
    req.end();
  });
}

class InfrastructureRootResolver {
  constructor(options = {}) {
    this.enabled = options.enabled ?? process.env.ANYSENTRY_INFRA_FILTER !== 'off';
    this.socketPath = options.socketPath || process.env.ANYSENTRY_DOCKER_SOCKET || DEFAULT_DOCKER_SOCKET;
    this.label = options.label || process.env.ANYSENTRY_INFRA_LABEL || DEFAULT_LABEL;
    this.refreshMs = (positiveInt(options.refreshSecs ?? process.env.ANYSENTRY_INFRA_REFRESH_SECS) || DEFAULT_REFRESH_SECS) * 1_000;
    this.configuredRoots = options.configuredRoots || staticRoots(process.env.ANYSENTRY_INFRA_ROOT_PIDS);
    this.fetchJson = options.fetchJson || ((requestPath) => requestJson(this.socketPath, requestPath));
    this.timer = undefined;
  }

  async resolve() {
    if (!this.enabled) return { roots: [], dockerContainers: 0, error: undefined };
    const roots = [...this.configuredRoots];
    try {
      const filters = encodeURIComponent(JSON.stringify({ label: [this.label] }));
      const containers = await this.fetchJson(`/containers/json?all=0&filters=${filters}`);
      const running = Array.isArray(containers) ? containers : [];
      const inspected = await Promise.all(running.map(async (container) => {
        const id = typeof container?.Id === 'string' ? container.Id : '';
        if (!id) return undefined;
        const detail = await this.fetchJson(`/containers/${encodeURIComponent(id)}/json`);
        const pid = positiveInt(detail?.State?.Pid);
        if (!pid || detail?.State?.Running !== true) return undefined;
        const labels = detail?.Config?.Labels && typeof detail.Config.Labels === 'object'
          ? detail.Config.Labels
          : container.Labels || {};
        const serviceName = labels['com.docker.compose.service']
          || labels['app.kubernetes.io/name']
          || String(container.Names?.[0] || detail?.Name || 'infrastructure').replace(/^\//, '');
        return {
          pid,
          serviceName,
          containerId: id,
          source: 'docker_label',
        };
      }));
      roots.push(...inspected.filter(Boolean));
      return { roots, dockerContainers: inspected.filter(Boolean).length, error: undefined };
    } catch (error) {
      return {
        roots,
        dockerContainers: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  start(onUpdate) {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(async () => {
      const result = await this.resolve();
      onUpdate(result);
    }, this.refreshMs);
    this.timer.unref();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

module.exports = {
  InfrastructureRootResolver,
  requestJson,
  staticRoots,
};
