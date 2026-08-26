import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KubeServiceAsset } from './kube-identity.service';
import type { SystemContextMetricFact, SystemContextSourceStatusInput } from './system-context-bundle';

type MetricCategory = 'traffic' | 'errors' | 'latency' | 'saturation' | 'availability';

interface PrometheusMetricSample {
  sampleId: string;
  serviceHint?: string;
  namespace?: string;
  instance?: string;
  name: string;
  value: number;
  unit: string;
  category: MetricCategory;
  observedAt: number;
  status: 'normal' | 'anomalous' | 'unknown';
  recordKind: 'target' | 'query';
}

interface PrometheusQueryDefinition {
  name: string;
  query: string;
  unit: string;
  category: MetricCategory;
  serviceLabels: string[];
  namespaceLabels: string[];
}

const DEFAULT_QUERIES: PrometheusQueryDefinition[] = [
  {
    name: 'http.server.request.rate',
    query: 'sum by (service_name, service_namespace) (rate(http_server_request_duration_seconds_count[5m]))',
    unit: 'requests_per_second',
    category: 'traffic',
    serviceLabels: ['service_name', 'service'],
    namespaceLabels: ['service_namespace', 'namespace'],
  },
  {
    name: 'http.server.error.rate',
    query: 'sum by (service_name, service_namespace) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))',
    unit: 'errors_per_second',
    category: 'errors',
    serviceLabels: ['service_name', 'service'],
    namespaceLabels: ['service_namespace', 'namespace'],
  },
  {
    name: 'http.server.request.duration.p95',
    query: 'histogram_quantile(0.95, sum by (le, service_name, service_namespace) (rate(http_server_request_duration_seconds_bucket[5m])))',
    unit: 'seconds',
    category: 'latency',
    serviceLabels: ['service_name', 'service'],
    namespaceLabels: ['service_namespace', 'namespace'],
  },
];

const MAX_SAMPLES = 10_000;
const MAX_TARGETS = 2_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function text(value: unknown, limit = 500): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= limit ? normalized : undefined;
}

function labels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 128)
    .flatMap(([key, item]) => {
      const safeKey = text(key, 120);
      const safeValue = text(item, 500);
      return safeKey && safeValue ? [[safeKey, safeValue]] : [];
    }));
}

function firstLabel(input: Record<string, string>, names: readonly string[]): string | undefined {
  return names.map((name) => input[name]?.trim()).find(Boolean);
}

function endpointHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.split('/')[0].replace(/:\d+$/u, '').toLowerCase() || undefined;
  }
}

function sampleId(parts: unknown[]): string {
  return `prom_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
}

function queryDefinitions(): PrometheusQueryDefinition[] {
  const configured = process.env.ANYSENTRY_PROMETHEUS_CONTEXT_QUERIES_JSON?.trim();
  if (!configured) return DEFAULT_QUERIES;
  try {
    const parsed = JSON.parse(configured) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_QUERIES;
    return parsed.slice(0, 16).flatMap((value): PrometheusQueryDefinition[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      const name = text(item.name, 240);
      const query = text(item.query, 4_096);
      const unit = text(item.unit, 80) ?? '1';
      const category = text(item.category, 40) as MetricCategory | undefined;
      if (!name || !query || !category || !['traffic', 'errors', 'latency', 'saturation', 'availability'].includes(category)) return [];
      const cleanLabels = (candidate: unknown, fallback: string[]): string[] => Array.isArray(candidate)
        ? candidate.map((entry) => text(entry, 120)).filter((entry): entry is string => Boolean(entry)).slice(0, 16)
        : fallback;
      return [{
        name,
        query,
        unit,
        category,
        serviceLabels: cleanLabels(item.serviceLabels, ['service_name', 'service', 'app', 'job']),
        namespaceLabels: cleanLabels(item.namespaceLabels, ['service_namespace', 'namespace', 'kubernetes_namespace']),
      }];
    });
  } catch {
    return DEFAULT_QUERIES;
  }
}

@Injectable()
export class PrometheusContextService implements OnModuleInit, OnModuleDestroy {
  private readonly baseUrl = process.env.ANYSENTRY_PROMETHEUS_URL?.trim().replace(/\/+$/u, '');
  private readonly pollMs = positiveInt(
    process.env.ANYSENTRY_PROMETHEUS_CONTEXT_POLL_SECS,
    30,
    10,
    600,
  ) * 1_000;
  private readonly sourceId = this.baseUrl
    ? `prometheus:${createHash('sha256').update(this.baseUrl).digest('hex').slice(0, 16)}`
    : 'prometheus:unconfigured';
  private samples: PrometheusMetricSample[] = [];
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private lastAttemptAt?: number;
  private lastSuccessAt?: number;
  private lastError?: string;
  private destroyed = false;

  onModuleInit(): void {
    if (!this.baseUrl) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (!this.baseUrl || this.destroyed) return;
    if (this.inFlight) return this.inFlight;
    const operation = this.pollOnce();
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = undefined;
    }
  }

  metricsForAssets(assets: readonly KubeServiceAsset[], referenceAt = Date.now()): SystemContextMetricFact[] {
    const facts: SystemContextMetricFact[] = [];
    for (const sample of this.samples) {
      if (sample.observedAt > referenceAt + 60_000) continue;
      const candidates = assets.filter((asset) => {
        if (sample.namespace && asset.namespace !== sample.namespace) return false;
        const hints = new Set([
          asset.name.toLowerCase(),
          ...asset.endpointAliases.map((alias) => endpointHost(alias)).filter((value): value is string => Boolean(value)),
        ]);
        return Boolean(
          sample.serviceHint && hints.has(sample.serviceHint.toLowerCase()) ||
          sample.instance && hints.has(endpointHost(sample.instance) ?? ''),
        );
      });
      if (candidates.length !== 1) continue;
      const asset = candidates[0];
      facts.push({
        metricId: `${sample.sampleId}:${asset.serviceAssetId}`,
        resourceId: asset.serviceAssetId,
        name: sample.name,
        value: sample.value,
        unit: sample.unit,
        kind: sample.category === 'traffic' || sample.category === 'errors' ? 'rate' : 'gauge',
        status: sample.status,
        observedAt: sample.observedAt,
        evidence: {
          sourceId: this.sourceId,
          sourceKind: 'prometheus',
          authority: 'configured_prometheus_api',
          recordId: sample.sampleId,
          observedAt: sample.observedAt,
          freshnessTtlMs: Math.max(this.pollMs * 3, 60_000),
          confidence: 1,
          associationMethod: sample.recordKind === 'target'
            ? 'prometheus_target_service_labels'
            : 'prometheus_metric_service_labels',
          inferred: false,
        },
      });
    }
    return facts;
  }

  sourceStatus(referenceAt = Date.now()): SystemContextSourceStatusInput {
    const configured = Boolean(this.baseUrl);
    const fresh = this.lastSuccessAt !== undefined && referenceAt - this.lastSuccessAt <= this.pollMs * 3;
    return {
      domain: 'metrics',
      sourceId: this.sourceId,
      sourceKind: 'prometheus',
      state: configured && fresh ? 'complete' : configured ? 'partial' : 'partial',
      checkedAt: referenceAt,
      lastObservedAt: this.lastSuccessAt,
      freshnessTtlMs: Math.max(this.pollMs * 3, 60_000),
      required: true,
      recordsRead: this.samples.length,
      reason: !configured
        ? 'prometheus_not_configured'
        : fresh
          ? undefined
          : this.lastError ?? 'prometheus_stale_or_unavailable',
    };
  }

  private async pollOnce(): Promise<void> {
    this.lastAttemptAt = Date.now();
    try {
      const samples = [
        ...await this.targetSamples(),
        ...await this.querySamples(),
      ].sort((left, right) => right.observedAt - left.observedAt).slice(0, MAX_SAMPLES);
      this.samples = samples;
      this.lastSuccessAt = Date.now();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 240) : 'prometheus_poll_failed';
    }
  }

  private async targetSamples(): Promise<PrometheusMetricSample[]> {
    const payload = await this.request('/api/v1/targets?state=active');
    const activeTargets = (payload.data as { activeTargets?: unknown[] } | undefined)?.activeTargets;
    const samples: PrometheusMetricSample[] = [];
    for (const rawTarget of Array.isArray(activeTargets) ? activeTargets.slice(0, MAX_TARGETS) : []) {
      if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) continue;
      const target = rawTarget as Record<string, unknown>;
      const targetLabels = { ...labels(target.discoveredLabels), ...labels(target.labels) };
      const serviceHint = firstLabel(targetLabels, ['service_name', 'service', 'app', 'kubernetes_name', 'job']);
      const namespace = firstLabel(targetLabels, ['service_namespace', 'namespace', 'kubernetes_namespace']);
      const instance = firstLabel(targetLabels, ['instance', '__address__']) ?? endpointHost(text(target.scrapeUrl));
      const observedAt = Date.parse(text(target.lastScrape) ?? '') || Date.now();
      const health = text(target.health, 40) ?? 'unknown';
      const common = [serviceHint, namespace, instance, observedAt];
      samples.push({
        sampleId: sampleId([...common, 'up']),
        serviceHint,
        namespace,
        instance,
        name: 'prometheus.target.up',
        value: health === 'up' ? 1 : 0,
        unit: 'boolean',
        category: 'availability',
        observedAt,
        status: health === 'up' ? 'normal' : 'anomalous',
        recordKind: 'target',
      });
      const duration = Number(target.lastScrapeDuration);
      if (Number.isFinite(duration) && duration >= 0) {
        samples.push({
          sampleId: sampleId([...common, 'duration']),
          serviceHint,
          namespace,
          instance,
          name: 'prometheus.scrape.duration',
          value: duration,
          unit: 'seconds',
          category: 'latency',
          observedAt,
          status: health === 'up' ? 'normal' : 'anomalous',
          recordKind: 'target',
        });
      }
    }
    return samples;
  }

  private async querySamples(): Promise<PrometheusMetricSample[]> {
    const samples: PrometheusMetricSample[] = [];
    for (const definition of queryDefinitions()) {
      try {
        const payload = await this.request(`/api/v1/query?query=${encodeURIComponent(definition.query)}`);
        const result = (payload.data as { result?: unknown[] } | undefined)?.result;
        for (const rawResult of Array.isArray(result) ? result.slice(0, MAX_SAMPLES) : []) {
          if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) continue;
          const item = rawResult as Record<string, unknown>;
          const metricLabels = labels(item.metric);
          const rawValue = Array.isArray(item.value)
            ? item.value
            : Array.isArray(item.values)
              ? item.values.at(-1)
              : undefined;
          if (!Array.isArray(rawValue)) continue;
          const timestamp = Number(rawValue[0]);
          const value = Number(rawValue[1]);
          if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue;
          const serviceHint = firstLabel(metricLabels, definition.serviceLabels);
          const namespace = firstLabel(metricLabels, definition.namespaceLabels);
          const instance = firstLabel(metricLabels, ['instance']);
          const observedAt = timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000;
          samples.push({
            sampleId: sampleId([definition.name, serviceHint, namespace, instance, observedAt]),
            serviceHint,
            namespace,
            instance,
            name: definition.name,
            value,
            unit: definition.unit,
            category: definition.category,
            observedAt,
            status: 'unknown',
            recordKind: 'query',
          });
        }
      } catch {
        // One absent metric family must not discard target health or other configured queries.
      }
    }
    return samples;
  }

  private async request(path: string): Promise<Record<string, unknown>> {
    const tokenFile = process.env.ANYSENTRY_PROMETHEUS_TOKEN_FILE?.trim();
    const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`prometheus_http_${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error('prometheus_response_too_large');
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('prometheus_response_too_large');
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload.status !== 'success') throw new Error('prometheus_query_failed');
    return payload;
  }
}
