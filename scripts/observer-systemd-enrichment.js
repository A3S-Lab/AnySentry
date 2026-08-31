'use strict';

const { execFile: nodeExecFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 750;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1_024;

function text(value, limit = 1_000) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.slice(0, limit);
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseProperties(output) {
  const properties = {};
  for (const line of text(output, 64 * 1024).split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    properties[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return properties;
}

function timerUnit(properties, serviceUnit) {
  const candidates = [properties.TriggeredBy, properties.Triggers]
    .flatMap((value) => text(value, 2_000).split(/\s+/u))
    .filter((value) => value.endsWith('.timer'));
  if (candidates[0]) return candidates[0];
  return serviceUnit.endsWith('.service')
    ? serviceUnit.slice(0, -'.service'.length) + '.timer'
    : undefined;
}

class SystemdLaunchEnricher {
  constructor(options = {}) {
    this.enabled = options.enabled ?? process.env.ANYSENTRY_LAUNCH_SYSTEMD_ENRICHMENT !== 'off';
    this.timeoutMs = positiveInt(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = positiveInt(options.cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = positiveInt(options.maxCacheEntries) ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.execFile = options.execFile ?? nodeExecFile;
    this.cache = new Map();
    this.inflight = new Map();
    this.stats = { queries: 0, cacheHits: 0, errors: 0 };
  }

  run(unit) {
    return new Promise((resolve) => {
      this.stats.queries++;
      this.execFile(
        'systemctl',
        [
          'show', unit, '--no-pager',
          '--property=Description',
          '--property=FragmentPath',
          '--property=SourcePath',
          '--property=NRestarts',
          '--property=TriggeredBy',
          '--property=Triggers',
          '--property=TimersCalendar',
          '--property=NextElapseUSecRealtime',
          '--property=LastTriggerUSec',
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: this.timeoutMs },
        (error, stdout) => {
          if (error) {
            this.stats.errors++;
            resolve({});
            return;
          }
          resolve(parseProperties(stdout));
        },
      );
    });
  }

  async properties(unit) {
    const key = text(unit, 240);
    if (!this.enabled || !key) return {};
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.stats.cacheHits++;
      return cached.value;
    }
    const active = this.inflight.get(key);
    if (active) return active;
    const query = this.run(key).then((value) => {
      this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtlMs });
      while (this.cache.size > this.maxCacheEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.inflight.delete(key);
      return value;
    });
    this.inflight.set(key, query);
    return query;
  }

  async unitDetails(unit) {
    const service = await this.properties(unit);
    const relatedTimer = timerUnit(service, unit);
    const timer = relatedTimer ? await this.properties(relatedTimer) : {};
    const restartCount = nonNegativeInt(service.NRestarts);
    const scheduleParts = [
      text(timer.TimersCalendar, 500),
      text(timer.LastTriggerUSec, 120) ? `last=${text(timer.LastTriggerUSec, 120)}` : '',
      text(timer.NextElapseUSecRealtime, 120)
        ? `next=${text(timer.NextElapseUSecRealtime, 120)}`
        : '',
    ].filter(Boolean);
    return {
      description: text(service.Description, 500) || undefined,
      unitFile: text(service.FragmentPath || service.SourcePath, 1_000) || undefined,
      restartCount,
      schedule: scheduleParts.length
        ? `${relatedTimer}: ${scheduleParts.join(', ')}`
        : relatedTimer && Object.keys(timer).length > 0
          ? relatedTimer
          : undefined,
    };
  }

  async enrichLaunchContext(context) {
    if (!context?.origins?.length || !this.enabled) return context;
    const units = [...new Set(context.origins
      .filter((origin) => origin.type === 'systemd_unit')
      .map((origin) => text(origin.name, 240))
      .filter(Boolean))];
    if (!units.length) return context;
    const details = new Map(await Promise.all(units.map(async (unit) => [unit, await this.unitDetails(unit)])));
    return {
      ...context,
      path: context.path.map((node) => ({ ...node })),
      origins: context.origins.map((origin) => ({
        ...origin,
        ...(origin.type === 'systemd_unit' ? details.get(origin.name) : {}),
      })),
    };
  }

  async enrichEntries(entries) {
    return Promise.all(entries.map(async (entry) => ({
      ...entry,
      launchContext: entry.launchContext
        ? await this.enrichLaunchContext(entry.launchContext)
        : undefined,
    })));
  }

  metrics() {
    return { ...this.stats, cacheEntries: this.cache.size, inflight: this.inflight.size };
  }
}

module.exports = {
  SystemdLaunchEnricher,
  parseProperties,
  timerUnit,
};
