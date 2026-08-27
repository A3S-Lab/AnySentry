import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { statfsSync } from 'node:fs';
import { cpus } from 'node:os';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import * as T from './types';

interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}

interface PrometheusResult {
  metric: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
}

interface PrometheusResponse {
  status: 'success' | 'error';
  data?: {
    resultType: 'vector' | 'matrix' | 'scalar' | 'string';
    result: PrometheusResult[];
  };
}

interface MetricWindow {
  fromMs: number;
  toMs: number;
  stepSeconds: number;
}

const HISTOGRAM_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const RANGE_SECONDS: Record<string, number> = {
  last_30m: 30 * 60,
  last_1h: 60 * 60,
  last_2h: 2 * 60 * 60,
  last_3h: 3 * 60 * 60,
  last_1d: 24 * 60 * 60,
};

function finite(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rounded(value: number | undefined, digits = 1): number | undefined {
  if (value === undefined) return undefined;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function statusForPercent(value: number | undefined): T.PlatformMetricStatus {
  if (value === undefined) return 'unknown';
  if (value >= 95) return 'critical';
  if (value >= 85) return 'warning';
  return 'healthy';
}

function maxStatus(a: T.PlatformMetricStatus, b: T.PlatformMetricStatus): T.PlatformMetricStatus {
  const rank: Record<T.PlatformMetricStatus, number> = { unknown: 0, healthy: 1, warning: 2, critical: 3 };
  return rank[b] > rank[a] ? b : a;
}

function pointSeries(
  key: T.PlatformMetricSeries['key'],
  label: string,
  unit: T.PlatformMetricSeries['unit'],
  result: PrometheusResult[] | undefined,
): T.PlatformMetricSeries {
  const values = result?.flatMap((series) => series.values ?? []) ?? [];
  const pointsByTimestamp = new Map<number, number>();
  for (const [at, value] of values) {
    const numericValue = Number(value);
    if (Number.isFinite(at) && Number.isFinite(numericValue)) {
      pointsByTimestamp.set(at, numericValue);
    }
  }
  return {
    key,
    label,
    unit,
    points: [...pointsByTimestamp.entries()]
      .sort(([left], [right]) => left - right)
      .map(([at, value]) => ({ at: new Date(at * 1000).toISOString(), value })),
  };
}

@Injectable()
export class PlatformMetricsService {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly startedAt = Date.now();
  private lastCpuUsage = process.cpuUsage();
  private lastCpuAt = process.hrtime.bigint();
  private processCpuPercent = 0;
  private cpuSampler: NodeJS.Timeout;

  constructor() {
    this.eventLoopDelay.enable();
    this.cpuSampler = setInterval(() => this.sampleProcessCpu(), 5000);
    this.cpuSampler.unref();
  }

  recordHttp(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = [method.toUpperCase(), route, statusClass].join('|');
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    const histogram = this.histograms.get(key) ?? {
      count: 0,
      sum: 0,
      buckets: HISTOGRAM_BUCKETS.map(() => 0),
    };
    histogram.count += 1;
    histogram.sum += durationSeconds;
    HISTOGRAM_BUCKETS.forEach((bucket, index) => {
      if (durationSeconds <= bucket) histogram.buckets[index] += 1;
    });
    this.histograms.set(key, histogram);
  }

  prometheusText(): string {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const lines = [
      '# HELP anysentry_http_requests_total Completed AnySentry HTTP requests.',
      '# TYPE anysentry_http_requests_total counter',
    ];
    for (const [key, count] of this.counters) {
      const [method, route, statusClass] = key.split('|');
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"`;
      lines.push(`anysentry_http_requests_total{${labels}} ${count}`);
    }
    lines.push(
      '# HELP anysentry_http_request_duration_seconds AnySentry HTTP request duration.',
      '# TYPE anysentry_http_request_duration_seconds histogram',
    );
    for (const [key, histogram] of this.histograms) {
      const [method, route, statusClass] = key.split('|');
      const base = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"`;
      HISTOGRAM_BUCKETS.forEach((bucket, index) => {
        lines.push(`anysentry_http_request_duration_seconds_bucket{${base},le="${bucket}"} ${histogram.buckets[index]}`);
      });
      lines.push(`anysentry_http_request_duration_seconds_bucket{${base},le="+Inf"} ${histogram.count}`);
      lines.push(`anysentry_http_request_duration_seconds_sum{${base}} ${histogram.sum}`);
      lines.push(`anysentry_http_request_duration_seconds_count{${base}} ${histogram.count}`);
    }
    lines.push(
      '# HELP process_resident_memory_bytes Resident memory size in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${memory.rss}`,
      '# HELP nodejs_heap_size_used_bytes Process heap used in bytes.',
      '# TYPE nodejs_heap_size_used_bytes gauge',
      `nodejs_heap_size_used_bytes ${memory.heapUsed}`,
      '# HELP nodejs_heap_size_total_bytes Process heap total in bytes.',
      '# TYPE nodejs_heap_size_total_bytes gauge',
      `nodejs_heap_size_total_bytes ${memory.heapTotal}`,
      '# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.',
      '# TYPE process_cpu_user_seconds_total counter',
      `process_cpu_user_seconds_total ${cpu.user / 1_000_000}`,
      '# HELP process_cpu_system_seconds_total Total system CPU time spent in seconds.',
      '# TYPE process_cpu_system_seconds_total counter',
      `process_cpu_system_seconds_total ${cpu.system / 1_000_000}`,
      '# HELP process_uptime_seconds Process uptime in seconds.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${process.uptime()}`,
      '# HELP anysentry_event_loop_lag_p95_seconds P95 event loop delay in seconds.',
      '# TYPE anysentry_event_loop_lag_p95_seconds gauge',
      `anysentry_event_loop_lag_p95_seconds ${this.eventLoopDelay.percentile(95) / 1e9}`,
      '',
    );
    return lines.join('\n');
  }

  async overview(range = 'last_1h'): Promise<T.PlatformMetricsOverview> {
    const window = this.window(range);
    const prometheusUrl = process.env.ANYSENTRY_PROMETHEUS_URL?.trim();
    if (!prometheusUrl) return this.runtimeFallback(window, 'Prometheus 未配置，当前仅展示 AnySentry API 进程的真实运行数据。');
    try {
      return await this.prometheusOverview(prometheusUrl.replace(/\/$/, ''), window);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.runtimeFallback(window, `Prometheus 暂时不可用：${message}`);
    }
  }

  private sampleProcessCpu(): void {
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage(this.lastCpuUsage);
    const elapsedMicros = Number(now - this.lastCpuAt) / 1000;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuAt = now;
    if (elapsedMicros <= 0) return;
    this.processCpuPercent = Math.max(0, ((usage.user + usage.system) / elapsedMicros) * 100);
  }

  private window(range: string): MetricWindow {
    const seconds = RANGE_SECONDS[range] ?? RANGE_SECONDS.last_1h;
    const toMs = Date.now();
    const desiredPoints = seconds <= 3600 ? 60 : seconds <= 10800 ? 90 : 120;
    return {
      fromMs: toMs - seconds * 1000,
      toMs,
      stepSeconds: Math.max(15, Math.ceil(seconds / desiredPoints)),
    };
  }

  private async prometheusOverview(baseUrl: string, window: MetricWindow): Promise<T.PlatformMetricsOverview> {
    const composeProject = (process.env.ANYSENTRY_METRICS_COMPOSE_PROJECT || 'anysentry')
      .replace(/[^a-zA-Z0-9_.-]/g, '')
      .slice(0, 80) || 'anysentry';
    const composeSelector = `container_label_com_docker_compose_project="${composeProject}"`;
    const queries = {
      cpu: '100 * (1 - avg(rate(node_cpu_seconds_total{job="node",mode="idle"}[5m])))',
      memory: '100 * (1 - (node_memory_MemAvailable_bytes{job="node"} / node_memory_MemTotal_bytes{job="node"}))',
      disk: '100 * max(1 - (node_filesystem_avail_bytes{job="node",fstype!~"tmpfs|overlay|squashfs|nsfs|tracefs"} / node_filesystem_size_bytes{job="node",fstype!~"tmpfs|overlay|squashfs|nsfs|tracefs"}))',
      networkRx: 'sum(rate(node_network_receive_bytes_total{job="node",device!~"lo|veth.*|docker.*|br-.*"}[5m]))',
      networkTx: 'sum(rate(node_network_transmit_bytes_total{job="node",device!~"lo|veth.*|docker.*|br-.*"}[5m]))',
      nodeReady: 'sum(max by (instance) (up{job="node"}))',
      nodeTotal: 'count(max by (instance) (up{job="node"}))',
      apiP95: '1000 * histogram_quantile(0.95, sum by (le) (rate(anysentry_http_request_duration_seconds_bucket[5m])))',
      apiError: '100 * sum(rate(anysentry_http_requests_total{status_class=~"4xx|5xx"}[5m])) / clamp_min(sum(rate(anysentry_http_requests_total[5m])), 0.000001)',
      apiRate: 'sum(rate(anysentry_http_requests_total[5m]))',
      componentCpu: `100 * sum by (container_label_com_docker_compose_service) (rate(container_cpu_usage_seconds_total{${composeSelector},container_label_com_docker_compose_service!=""}[5m])) / scalar(count(node_cpu_seconds_total{job="node",mode="idle"}))`,
      componentMemory: `sum by (container_label_com_docker_compose_service) (container_memory_working_set_bytes{${composeSelector},container_label_com_docker_compose_service!=""})`,
      componentLimit: `sum by (container_label_com_docker_compose_service) (container_spec_memory_limit_bytes{${composeSelector},container_label_com_docker_compose_service!=""})`,
      targets: 'up{job=~"anysentry-api|node|cadvisor|clickhouse"}',
    };
    const instantEntries = await Promise.all(
      Object.entries(queries).map(async ([key, query]) => [key, await this.query(baseUrl, query)] as const),
    );
    const instant = Object.fromEntries(instantEntries) as Record<string, PrometheusResult[]>;
    const rangeEntries = await Promise.all([
      ['cpu', queries.cpu],
      ['memory', queries.memory],
      ['disk', queries.disk],
      ['networkRx', queries.networkRx],
      ['networkTx', queries.networkTx],
      ['apiP95', queries.apiP95],
      ['apiError', queries.apiError],
    ].map(async ([key, query]) => [key, await this.queryRange(baseUrl, query, window)] as const));
    const ranges = Object.fromEntries(rangeEntries) as Record<string, PrometheusResult[]>;
    const scalar = (key: string) => finite(instant[key]?.[0]?.value?.[1]);
    const cpuPercent = rounded(scalar('cpu'));
    const memoryPercent = rounded(scalar('memory'));
    const diskPercent = rounded(scalar('disk'));
    const apiP95Ms = rounded(scalar('apiP95'));
    const apiErrorRatePercent = rounded(scalar('apiError'), 2);

    const componentMap = new Map<string, T.PlatformComponentMetric>();
    const component = (name: string) => {
      const normalized = name || 'unknown-service';
      const existing = componentMap.get(normalized);
      if (existing) return existing;
      const created: T.PlatformComponentMetric = {
        id: `service:${normalized}`,
        name: normalized,
        kind: 'service',
        status: 'healthy',
        lastSeen: new Date().toISOString(),
      };
      componentMap.set(normalized, created);
      return created;
    };
    for (const result of instant.componentCpu ?? []) {
      const item = component(result.metric.container_label_com_docker_compose_service);
      item.cpuPercent = rounded(finite(result.value?.[1]));
      item.status = maxStatus(item.status, statusForPercent(item.cpuPercent));
    }
    for (const result of instant.componentMemory ?? []) {
      const item = component(result.metric.container_label_com_docker_compose_service);
      item.memoryBytes = rounded(finite(result.value?.[1]), 0);
    }
    for (const result of instant.componentLimit ?? []) {
      const item = component(result.metric.container_label_com_docker_compose_service);
      const limit = finite(result.value?.[1]);
      if (limit && limit < 1e18) item.memoryLimitBytes = rounded(limit, 0);
      if (item.memoryBytes !== undefined && item.memoryLimitBytes) {
        item.memoryPercent = rounded((item.memoryBytes / item.memoryLimitBytes) * 100);
        item.status = maxStatus(item.status, statusForPercent(item.memoryPercent));
      }
    }
    for (const result of instant.targets ?? []) {
      const job = result.metric.job || 'unknown-target';
      const target = result.metric.instance || job;
      const up = finite(result.value?.[1]) === 1;
      const name = result.metric.component || job;
      const item = component(name);
      item.kind = job === 'node' ? 'node' : item.kind;
      item.status = up ? item.status : 'critical';
      item.lastSeen = result.value ? new Date(result.value[0] * 1000).toISOString() : item.lastSeen;
      item.message = up ? target : `${target} 指标采集失败`;
    }
    const components = [...componentMap.values()].sort((a, b) => {
      const rank: Record<T.PlatformMetricStatus, number> = { critical: 0, warning: 1, unknown: 2, healthy: 3 };
      return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name);
    });
    const anomalies = this.anomalies({
      cpuPercent,
      memoryPercent,
      diskPercent,
      apiP95Ms,
      apiErrorRatePercent,
    }, components);
    const series: T.PlatformMetricSeries[] = [
      pointSeries('cpu', 'CPU', '%', ranges.cpu),
      pointSeries('memory', '内存', '%', ranges.memory),
      pointSeries('disk', '磁盘', '%', ranges.disk),
      pointSeries('network_rx', '网络接收', 'B/s', ranges.networkRx),
      pointSeries('network_tx', '网络发送', 'B/s', ranges.networkTx),
      pointSeries('api_p95', 'API P95', 'ms', ranges.apiP95),
      pointSeries('api_error_rate', 'API 错误率', '%', ranges.apiError),
    ];
    const requiredSeriesReady = [cpuPercent, memoryPercent, diskPercent].filter((value) => value !== undefined).length;
    return {
      schemaVersion: 'anysentry.platform_metrics.v1',
      status: requiredSeriesReady === 3 ? 'ready' : 'partial',
      source: 'prometheus',
      from: new Date(window.fromMs).toISOString(),
      to: new Date(window.toMs).toISOString(),
      stepSeconds: window.stepSeconds,
      updatedAt: new Date().toISOString(),
      summary: {
        nodeReady: rounded(scalar('nodeReady'), 0),
        nodeTotal: rounded(scalar('nodeTotal'), 0),
        cpuPercent,
        memoryPercent,
        diskPercent,
        networkRxBytesPerSecond: rounded(scalar('networkRx'), 0),
        networkTxBytesPerSecond: rounded(scalar('networkTx'), 0),
        apiP95Ms,
        apiErrorRatePercent,
        apiRequestRate: rounded(scalar('apiRate'), 2),
        componentAnomalies: anomalies.length,
      },
      series,
      components,
      anomalies,
      message: requiredSeriesReady === 3 ? undefined : '部分指标尚未形成时间序列，请检查对应采集目标。',
    };
  }

  private async query(baseUrl: string, query: string): Promise<PrometheusResult[]> {
    const url = new URL(`${baseUrl}/api/v1/query`);
    url.searchParams.set('query', query);
    return this.fetchPrometheus(url);
  }

  private async queryRange(baseUrl: string, query: string, window: MetricWindow): Promise<PrometheusResult[]> {
    const url = new URL(`${baseUrl}/api/v1/query_range`);
    url.searchParams.set('query', query);
    url.searchParams.set('start', String(window.fromMs / 1000));
    url.searchParams.set('end', String(window.toMs / 1000));
    url.searchParams.set('step', String(window.stepSeconds));
    return this.fetchPrometheus(url);
  }

  private async fetchPrometheus(url: URL): Promise<PrometheusResult[]> {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as PrometheusResponse;
    if (payload.status !== 'success') throw new Error('查询返回失败');
    return payload.data?.result ?? [];
  }

  private anomalies(
    summary: Pick<T.PlatformMetricsOverview['summary'], 'cpuPercent' | 'memoryPercent' | 'diskPercent' | 'apiP95Ms' | 'apiErrorRatePercent'>,
    components: T.PlatformComponentMetric[],
  ): T.PlatformMetricAnomaly[] {
    const anomalies: T.PlatformMetricAnomaly[] = [];
    const addPercent = (metric: string, subject: string, value: number | undefined) => {
      if (value === undefined || value < 85) return;
      const critical = value >= 95;
      anomalies.push({
        id: `${metric}:${subject}`,
        severity: critical ? 'critical' : 'warning',
        metric,
        subject,
        value,
        unit: '%',
        threshold: critical ? 95 : 85,
        message: `${subject} ${metric} 已达到 ${value.toFixed(1)}%`,
      });
    };
    addPercent('CPU', '主机', summary.cpuPercent);
    addPercent('内存', '主机', summary.memoryPercent);
    addPercent('磁盘', '主机', summary.diskPercent);
    if (summary.apiP95Ms !== undefined && summary.apiP95Ms >= 1000) {
      anomalies.push({
        id: 'api:p95',
        severity: summary.apiP95Ms >= 3000 ? 'critical' : 'warning',
        metric: 'API P95',
        subject: 'AnySentry API',
        value: summary.apiP95Ms,
        unit: 'ms',
        threshold: 1000,
        message: `API P95 延迟为 ${summary.apiP95Ms.toFixed(0)}ms`,
      });
    }
    if (summary.apiErrorRatePercent !== undefined && summary.apiErrorRatePercent >= 5) {
      anomalies.push({
        id: 'api:error-rate',
        severity: summary.apiErrorRatePercent >= 15 ? 'critical' : 'warning',
        metric: 'API 错误率',
        subject: 'AnySentry API',
        value: summary.apiErrorRatePercent,
        unit: '%',
        threshold: 5,
        message: `API 错误率为 ${summary.apiErrorRatePercent.toFixed(2)}%`,
      });
    }
    for (const item of components) {
      if (item.status === 'critical' && item.message?.includes('指标采集失败')) {
        anomalies.push({
          id: `target:${item.id}`,
          severity: 'critical',
          metric: '采集状态',
          subject: item.name,
          value: 0,
          unit: '%',
          threshold: 100,
          message: item.message ?? `${item.name} 指标采集失败`,
        });
      }
      addPercent('CPU', item.name, item.cpuPercent);
      addPercent('内存', item.name, item.memoryPercent);
    }
    return anomalies;
  }

  private runtimeFallback(window: MetricWindow, message: string): T.PlatformMetricsOverview {
    const memory = process.memoryUsage();
    let diskPercent: number | undefined;
    try {
      const disk = statfsSync('/');
      const total = Number(disk.blocks) * Number(disk.bsize);
      const available = Number(disk.bavail) * Number(disk.bsize);
      diskPercent = total > 0 ? rounded(((total - available) / total) * 100) : undefined;
    } catch {
      diskPercent = undefined;
    }
    const cpuPercent = rounded(this.processCpuPercent / Math.max(1, cpus().length));
    const component: T.PlatformComponentMetric = {
      id: 'service:anysentry-api',
      name: 'anysentry-api',
      kind: 'service',
      status: maxStatus(statusForPercent(cpuPercent), statusForPercent(undefined)),
      cpuPercent,
      memoryBytes: memory.rss,
      lastSeen: new Date().toISOString(),
      message: `API 进程已运行 ${Math.round((Date.now() - this.startedAt) / 1000)} 秒`,
    };
    const anomalies = this.anomalies({ cpuPercent, diskPercent }, [component]);
    return {
      schemaVersion: 'anysentry.platform_metrics.v1',
      status: 'unavailable',
      source: 'runtime_fallback',
      from: new Date(window.fromMs).toISOString(),
      to: new Date(window.toMs).toISOString(),
      stepSeconds: window.stepSeconds,
      updatedAt: new Date().toISOString(),
      summary: {
        cpuPercent,
        diskPercent,
        componentAnomalies: anomalies.length,
      },
      series: [],
      components: [component],
      anomalies,
      message,
    };
  }
}

@Injectable()
export class PlatformMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: PlatformMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = process.hrtime.bigint();
    const request = context.switchToHttp().getRequest<{ method?: string }>();
    const response = context.switchToHttp().getResponse<{ statusCode?: number }>();
    const handler = context.getHandler().name || 'handler';
    const controller = context.getClass().name.replace(/Controller$/, '') || 'controller';
    const route = `${controller}.${handler}`;
    return next.handle().pipe(finalize(() => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.recordHttp(request.method ?? 'UNKNOWN', route, response.statusCode ?? 200, durationSeconds);
    }));
  }
}
