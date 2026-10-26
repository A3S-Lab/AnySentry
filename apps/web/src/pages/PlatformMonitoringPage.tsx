import { useRequest } from "ahooks";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  Network,
  RefreshCw,
  ServerCog,
  XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { VChartView, type VChartSpec } from "@/components/custom/vchart";
import { useSecurityConsole } from "@/components/custom/security-console-header";
import { Button } from "@/components/ui/button";
import {
  type PlatformComponentMetric,
  type PlatformMetricStatus,
  type PlatformMetricsOverview,
  type PlatformPipelineCollectorView,
  type PlatformPipelineHistoryPoint,
  securityCenterApi,
} from "@/lib/api/security-center";
import { formatSecurityDateTime } from "@/lib/date-time";
import { cn } from "@/lib/utils";

function formatPercent(value?: number) {
  return value === undefined ? "--" : `${value.toFixed(1)}%`;
}

function formatBytes(value?: number) {
  if (value === undefined) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (Math.abs(scaled) >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function statusLabel(status: PlatformMetricStatus) {
  if (status === "healthy") return "正常";
  if (status === "warning") return "告警";
  if (status === "critical") return "严重";
  return "未知";
}

function statusClass(status: PlatformMetricStatus) {
  if (status === "critical") return "border-rose-400/35 bg-rose-500/10 text-rose-200";
  if (status === "warning") return "border-amber-400/35 bg-amber-500/10 text-amber-200";
  if (status === "healthy") return "border-teal-400/25 bg-teal-500/8 text-teal-200";
  return "border-white/10 bg-white/[0.03] text-zinc-400";
}

function SummaryMetric({
  label,
  value,
  hint,
  icon: Icon,
  status = "unknown",
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Cpu;
  status?: PlatformMetricStatus;
}) {
  const valueClass = status === "critical"
    ? "text-rose-200"
    : status === "warning"
      ? "text-amber-200"
      : "text-zinc-100";
  return (
    <div className="min-w-0 border-r border-[#232a37] px-4 py-3 last:border-r-0">
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <div className={cn("mt-1 font-mono text-xl font-semibold tabular-nums", valueClass)}>{value}</div>
      <p className="mt-0.5 truncate text-[10px] text-zinc-600" title={hint}>{hint ?? "实时指标"}</p>
    </div>
  );
}

function ComponentRow({ item }: { item: PlatformComponentMetric }) {
  const Icon = item.status === "critical"
    ? XCircle
    : item.status === "healthy"
      ? CheckCircle2
      : AlertTriangle;
  return (
    <div className="grid min-h-11 grid-cols-[minmax(160px,1.2fr)_92px_100px_130px_minmax(160px,1fr)] items-center gap-3 border-b border-[#232a37] px-3 text-xs last:border-b-0 hover:bg-white/[0.025]">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn(
          "size-3.5 shrink-0",
          item.status === "critical" ? "text-rose-300" : item.status === "warning" ? "text-amber-300" : item.status === "healthy" ? "text-teal-300" : "text-zinc-600",
        )} />
        <span className="truncate font-medium text-zinc-200" title={item.name}>{item.name}</span>
      </div>
      <span className={cn("w-fit rounded border px-1.5 py-0.5 text-[10px]", statusClass(item.status))}>
        {statusLabel(item.status)}
      </span>
      <span className="font-mono tabular-nums text-zinc-400">{formatPercent(item.cpuPercent)}</span>
      <span className="font-mono tabular-nums text-zinc-400">
        {formatBytes(item.memoryBytes)}
        {item.memoryPercent !== undefined ? ` · ${formatPercent(item.memoryPercent)}` : ""}
      </span>
      <span className="truncate text-zinc-600" title={item.message}>{item.message ?? item.kind}</span>
    </div>
  );
}

function middlewareSpec(item: NonNullable<PlatformMetricsOverview["middleware"]>["series"][number]): VChartSpec {
  const chartData = item.points.map((point) => ({
    time: Date.parse(point.at),
    value: point.value,
  }));
  const values = chartData.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const pad = span > 0 ? span * 0.25 : Math.max(Math.abs(high) * 0.08, item.unit === "%" ? 1 : 0.5);
  return {
    type: "line",
    data: [{ id: item.key, values: chartData }],
    xField: "time",
    yField: "value",
    height: 168,
    padding: { top: 8, right: 12, bottom: 20, left: 52 },
    point: { visible: chartData.length < 3, style: { size: 4 } },
    line: { style: { lineWidth: 1.5, stroke: "#38bdf8" } },
    axes: [
      {
        orient: "left",
        min: low - pad,
        max: high + pad,
        tick: { tickCount: 4 },
        label: {
          formatMethod: (value: number) => item.unit === "%" ? `${value.toFixed(1)}` : value >= 1000 ? `${Math.round(value)}` : `${Number(value.toFixed(1))}`,
        },
      },
      { orient: "bottom", type: "time", layers: [{ timeFormat: "%H:%M", timeFormatMode: "local" }] },
    ],
    tooltip: { visible: true },
  } as VChartSpec;
}

function utilizationSpec(data?: PlatformMetricsOverview): VChartSpec {
  const selected = data?.series.filter((series) => ["cpu", "memory", "disk"].includes(series.key)) ?? [];
  const chartData = selected.flatMap((series) => series.points.map((point) => ({
    time: Date.parse(point.at),
    value: point.value,
    metric: series.label,
  })));
  return {
    type: "line",
    data: [{ id: "utilization", values: chartData }],
    xField: "time",
    yField: "value",
    seriesField: "metric",
    height: 240,
    padding: { top: 18, right: 18, bottom: 22, left: 44 },
    point: { visible: false },
    line: { style: { lineWidth: 1.5 } },
    color: ["#38bdf8", "#2dd4bf", "#fbbf24"],
    axes: [
      { orient: "left", min: 0, max: 100, tick: { tickCount: 5 }, label: { formatMethod: (value: number) => `${value}%` } },
      {
        orient: "bottom",
        type: "time",
        layers: [{ timeFormat: "%H:%M:%S", timeFormatMode: "local" }],
      },
    ],
    legends: { visible: true, orient: "top", position: "end" },
    tooltip: { visible: true },
  } as VChartSpec;
}

export default function PlatformMonitoringPage() {
  const { filter, refreshVersion } = useSecurityConsole();
  const requestedRange = filter.timeType === "custom" || filter.timeType === "last_7d" || filter.timeType === "last_30d"
    ? "last_1d"
    : filter.timeType ?? "last_1h";
  const { data, loading, error, refresh } = useRequest(
    () => securityCenterApi.platformMetrics(requestedRange),
    {
      refreshDeps: [requestedRange, refreshVersion],
      pollingInterval: 15000,
      pollingWhenHidden: false,
      refreshOnWindowFocus: true,
    },
  );
  const { data: pipeline, refresh: refreshPipeline } = useRequest(
    () => securityCenterApi.platformPipeline(),
    {
      refreshDeps: [refreshVersion],
      pollingInterval: 15000,
      pollingWhenHidden: false,
      refreshOnWindowFocus: true,
    },
  );
  const chartSpec = useMemo(() => utilizationSpec(data), [data]);
  const middlewareCharts = useMemo(
    () => (data?.middleware?.series ?? []).filter((item) => item.points.length > 0),
    [data],
  );
  const hasTrend = data?.series.some((series) => series.points.length > 1);
  const summary = data?.summary;
  const cpuStatus = statusFor(summary?.cpuPercent);
  const memoryStatus = statusFor(summary?.memoryPercent);
  const diskStatus = statusFor(summary?.diskPercent);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[#0a0d12] text-zinc-100">
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-[1680px] space-y-3">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex size-9 items-center justify-center rounded-md border border-[#303948] bg-[#141922] text-teal-300">
                <ServerCog className="size-4.5" />
              </span>
              <div>
                <h1 className="text-base font-semibold text-zinc-50">平台监控</h1>
                <p className="mt-0.5 text-[11px] text-zinc-500">主机、容器与 AnySentry 服务的真实运行指标</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {data ? (
                <span className={cn(
                  "rounded border px-2 py-1 text-[10px]",
                  data.status === "ready"
                    ? "border-teal-400/25 bg-teal-500/8 text-teal-200"
                    : "border-amber-400/30 bg-amber-500/8 text-amber-200",
                )}>
                  {data.source === "prometheus" ? "Prometheus" : "Runtime fallback"} · {data.status === "ready" ? "完整" : "部分"}
                </span>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  refresh();
                  refreshPipeline();
                }}
                className="h-8 border border-white/10 bg-white/5 text-xs text-zinc-200 hover:bg-white/10"
              >
                {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                刷新
              </Button>
            </div>
          </header>

          {error ? (
            <div className="border border-rose-400/25 bg-rose-500/8 px-3 py-2 text-xs text-rose-200">
              平台指标请求失败：{error.message}
            </div>
          ) : null}
          {data?.message ? (
            <div className="border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-100/80">
              {data.message}
            </div>
          ) : null}

          <section className="overflow-hidden rounded-[8px] border border-[#232a37] bg-[#0f131a]">
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
              <SummaryMetric
                label="节点"
                value={summary?.nodeTotal === undefined ? "--" : `${summary.nodeReady ?? 0}/${summary.nodeTotal}`}
                hint="已连接 / 总数"
                icon={ServerCog}
                status={summary?.nodeTotal && summary.nodeReady === summary.nodeTotal ? "healthy" : "unknown"}
              />
              <SummaryMetric label="CPU" value={formatPercent(summary?.cpuPercent)} hint="主机整体利用率" icon={Cpu} status={cpuStatus} />
              <SummaryMetric label="内存" value={formatPercent(summary?.memoryPercent)} hint="主机已用比例" icon={MemoryStick} status={memoryStatus} />
              <SummaryMetric label="磁盘" value={formatPercent(summary?.diskPercent)} hint="最高文件系统利用率" icon={HardDrive} status={diskStatus} />
              <SummaryMetric label="API P95" value={summary?.apiP95Ms === undefined ? "--" : `${summary.apiP95Ms.toFixed(0)}ms`} hint="近 5 分钟" icon={Gauge} status={summary?.apiP95Ms !== undefined && summary.apiP95Ms >= 1000 ? "warning" : "healthy"} />
              <SummaryMetric label="请求速率" value={summary?.apiRequestRate === undefined ? "--" : `${summary.apiRequestRate.toFixed(2)}/s`} hint="AnySentry API" icon={Activity} status="healthy" />
              <SummaryMetric label="组件异常" value={String(summary?.componentAnomalies ?? "--")} hint="阈值与采集异常" icon={AlertTriangle} status={(summary?.componentAnomalies ?? 0) > 0 ? "warning" : "healthy"} />
            </div>
          </section>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.8fr)]">
            <section className="rounded-[8px] border border-[#232a37] bg-[#0f131a]">
              <div className="flex h-11 items-center justify-between border-b border-[#232a37] px-3">
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-teal-300" />
                  <h2 className="text-sm font-semibold text-zinc-100">资源趋势</h2>
                </div>
                <span className="text-[10px] text-zinc-600">CPU / 内存 / 磁盘</span>
              </div>
              <div className="h-[260px] p-2">
                {loading && !data ? (
                  <div className="flex h-full items-center justify-center text-xs text-zinc-600"><LoaderCircle className="mr-2 size-4 animate-spin" />加载真实指标</div>
                ) : hasTrend ? (
                  <VChartView spec={chartSpec} height={244} />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-center">
                    <Database className="size-5 text-zinc-700" />
                    <p className="mt-2 text-xs text-zinc-500">时间序列尚未就绪</p>
                    <p className="mt-1 text-[10px] text-zinc-700">采集启动后会逐步形成趋势，不使用模拟数据填充</p>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 border-t border-[#232a37]">
                <div className="border-r border-[#232a37] px-3 py-2">
                  <span className="text-[10px] text-zinc-600">网络接收</span>
                  <span className="ml-2 font-mono text-xs text-zinc-300">{formatBytes(summary?.networkRxBytesPerSecond)}/s</span>
                </div>
                <div className="px-3 py-2">
                  <span className="text-[10px] text-zinc-600">网络发送</span>
                  <span className="ml-2 font-mono text-xs text-zinc-300">{formatBytes(summary?.networkTxBytesPerSecond)}/s</span>
                </div>
              </div>
            </section>

            <section className="rounded-[8px] border border-[#232a37] bg-[#0f131a]">
              <div className="flex h-11 items-center justify-between border-b border-[#232a37] px-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-amber-300" />
                  <h2 className="text-sm font-semibold text-zinc-100">当前异常</h2>
                </div>
                <span className="font-mono text-[10px] text-zinc-600">{data?.anomalies.length ?? 0}</span>
              </div>
              <div className="max-h-[302px] overflow-y-auto">
                {data?.anomalies.length ? data.anomalies.map((anomaly) => (
                  <div key={anomaly.id} className="border-b border-[#232a37] px-3 py-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn(
                        "text-xs font-semibold",
                        anomaly.severity === "critical" ? "text-rose-200" : "text-amber-200",
                      )}>{anomaly.subject}</span>
                      <span className="font-mono text-[10px] text-zinc-500">{anomaly.value.toFixed(1)}{anomaly.unit}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-zinc-500">{anomaly.message}</p>
                  </div>
                )) : (
                  <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
                    <CheckCircle2 className="size-5 text-teal-400/60" />
                    <p className="mt-2 text-xs text-zinc-400">未发现阈值异常</p>
                    <p className="mt-1 text-[10px] text-zinc-700">仅代表当前已接入指标范围</p>
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className="rounded-[8px] border border-[#232a37] bg-[#0f131a]">
            <div className="flex h-11 items-center justify-between border-b border-[#232a37] px-3">
              <div className="flex items-center gap-2">
                <Database className="size-4 text-teal-300" />
                <h2 className="text-sm font-semibold text-zinc-100">中间件</h2>
              </div>
              <span className="text-[10px] text-zinc-600">API 直接采集 · 15 秒一个点</span>
            </div>
            <div className="grid border-b border-[#232a37] sm:grid-cols-2 xl:grid-cols-4">
              {(data?.middleware?.components ?? []).filter((item) => !item.id.startsWith("collector:")).map((item) => (
                <div key={item.id} className="border-b border-[#232a37] px-3 py-3 sm:border-r xl:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-zinc-200">{item.name}</span>
                    <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", statusClass(item.status))}>{statusLabel(item.status)}</span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-zinc-500" title={item.message}>{item.message}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-4">
              {middlewareCharts.map((item) => {
                const latest = item.points[item.points.length - 1]?.value;
                return (
                  <div key={item.key} className="rounded-md border border-[#232a37] bg-[#0c1016]">
                    <div className="flex items-baseline justify-between gap-2 px-3 pt-2">
                      <span className="truncate text-[11px] text-zinc-400">{item.label}</span>
                      <span className="font-mono text-xs text-zinc-100">{latest === undefined ? "--" : item.unit === "%" ? latest.toFixed(1) : latest >= 100 ? Math.round(latest).toLocaleString("zh-CN") : latest.toFixed(1)} {item.unit}</span>
                    </div>
                    <div className="h-[176px]">
                      <VChartView spec={middlewareSpec(item)} height={168} />
                    </div>
                  </div>
                );
              })}
              {middlewareCharts.length === 0 ? (
                <div className="col-span-full flex min-h-28 flex-col items-center justify-center text-center">
                  <Database className="size-5 text-zinc-700" />
                  <p className="mt-2 text-xs text-zinc-500">中间件时序正在积累</p>
                  <p className="mt-1 text-[10px] text-zinc-700">至少两个采样点后出图，不填充模拟数据</p>
                </div>
              ) : null}
            </div>
            <div className="grid border-t border-[#232a37] sm:grid-cols-3">
              {(data?.middleware?.components ?? []).filter((item) => item.id.startsWith("collector:")).map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2 border-b border-[#232a37] px-3 py-2 text-[11px] last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
                  <span className="text-zinc-400">{item.name}</span>
                  <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", statusClass(item.status))}>{item.message}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[8px] border border-[#232a37] bg-[#0f131a]">
            <div className="flex h-11 items-center justify-between border-b border-[#232a37] px-3">
              <div className="flex items-center gap-2">
                <Network className="size-4 text-sky-300" />
                <h2 className="text-sm font-semibold text-zinc-100">采集管线与积压</h2>
              </div>
              <span className="text-[10px] text-zinc-600">
                Observer 心跳上报 · 洪峰熔断累计丢弃 {pipeline ? pipeline.apiFloodDroppedTotal.toLocaleString("zh-CN") : "--"}
              </span>
            </div>
            {pipeline && pipeline.collectors.length > 0 ? (
              <div>
                {pipeline.collectors.map((collector) => (
                  <PipelineCollectorCard
                    key={collector.collectorId}
                    item={collector}
                    history={pipeline.history.filter((point) => point.collectorId === collector.collectorId)}
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-24 flex-col items-center justify-center text-center">
                <Network className="size-5 text-zinc-700" />
                <p className="mt-2 text-xs text-zinc-500">尚无采集器心跳上报</p>
                <p className="mt-1 text-[10px] text-zinc-700">采集器启动并完成首轮心跳后展示各阶段计数与积压</p>
              </div>
            )}
          </section>

          <section className="rounded-[8px] border border-[#232a37] bg-[#0f131a]">
            <div className="flex h-11 items-center justify-between border-b border-[#232a37] px-3">
              <div className="flex items-center gap-2">
                <Network className="size-4 text-teal-300" />
                <h2 className="text-sm font-semibold text-zinc-100">组件运行状态</h2>
              </div>
              <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                <Clock3 className="size-3" />
                {data ? formatSecurityDateTime(data.updatedAt, "MM-DD HH:mm:ss", "--") : "--"}
              </span>
            </div>
            <div className="grid h-8 grid-cols-[minmax(160px,1.2fr)_92px_100px_130px_minmax(160px,1fr)] items-center gap-3 border-b border-[#232a37] px-3 text-[10px] uppercase tracking-wide text-zinc-600">
              <span>组件</span><span>状态</span><span>CPU</span><span>内存</span><span>说明</span>
            </div>
            {data?.components.length ? data.components.map((item) => (
              <ComponentRow key={item.id} item={item} />
            )) : (
              <div className="flex min-h-24 items-center justify-center text-xs text-zinc-600">尚无组件指标</div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function statusFor(value?: number): PlatformMetricStatus {
  if (value === undefined) return "unknown";
  if (value >= 95) return "critical";
  if (value >= 85) return "warning";
  return "healthy";
}

function formatAge(ms: number) {
  if (ms < 1_000) return "刚刚";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const PIPELINE_THROUGHPUT_SERIES = [
  { key: "received", label: "采集接收", color: "#38bdf8" },
  { key: "apiRetained", label: "API 留存", color: "#2dd4bf" },
  { key: "apiDiscarded", label: "API 丢弃", color: "#a1a1aa" },
  { key: "apiRetryable", label: "等待重试", color: "#fbbf24" },
] as const;

const PIPELINE_BACKLOG_SERIES = [
  { key: "outstandingEvents", label: "内存积压", color: "#fbbf24" },
  { key: "spoolRecords", label: "磁盘积压", color: "#f472b6" },
] as const;

function pipelineTrendSpec(
  points: readonly PlatformPipelineHistoryPoint[],
  series: readonly { key: string; label: string; color: string }[],
): VChartSpec {
  const chartData = points.flatMap((point) =>
    series.map((def) => ({
      time: point.at,
      value: Number(point[def.key as keyof PlatformPipelineHistoryPoint]) || 0,
      metric: def.label,
    })),
  );
  return {
    type: "line",
    data: [{ id: "pipeline", values: chartData }],
    xField: "time",
    yField: "value",
    seriesField: "metric",
    height: 176,
    padding: { top: 8, right: 12, bottom: 20, left: 52 },
    point: { visible: false },
    line: { style: { lineWidth: 1.5 } },
    color: series.map((def) => def.color),
    axes: [
      { orient: "left", min: 0, tick: { tickCount: 4 } },
      { orient: "bottom", type: "time", layers: [{ timeFormat: "%H:%M", timeFormatMode: "local" }] },
    ],
    legends: { visible: true, orient: "top", position: "end" },
    tooltip: { visible: true },
  } as VChartSpec;
}

function PipelineCollectorCard({ item, history }: { item: PlatformPipelineCollectorView; history: PlatformPipelineHistoryPoint[] }) {
  const latest = item.stages.length > 0 ? new Map(item.stages.map((stage) => [stage.stage, stage])) : undefined;
  const currentOf = (stage: string) => latest?.get(stage)?.count ?? 0;
  const spoolWarning = item.spool.atCapacity || item.spool.walPutAtCapacity || item.spool.records > 0;
  const currentStats = [
    { label: "API 留存（当前窗口）", value: `${currentOf("api_retained").toLocaleString("zh-CN")} 条` },
    { label: "等待重试", value: `${currentOf("api_retryable").toLocaleString("zh-CN")} 条` },
    { label: "内存积压", value: `${item.outstandingEvents.toLocaleString("zh-CN")} 条 · ${formatBytes(item.outstandingBytes)}` },
    { label: "重试队列", value: `${(item.backlog?.retryEvents ?? item.retry.queued).toLocaleString("zh-CN")} 条 · 耗尽 ${item.retry.exhausted.toLocaleString("zh-CN")}` },
    { label: "磁盘积压（spool）", value: `${item.spool.records.toLocaleString("zh-CN")} 条 · ${formatBytes(item.spool.walBytes)}` },
    {
      label: "spool 容量",
      value: item.spool.atCapacity || item.spool.walPutAtCapacity
        ? `已满 · 拒绝 ${item.spool.capacityRejects.toLocaleString("zh-CN")} 次`
        : "正常",
    },
  ];
  return (
    <div className="border-t border-[#232a37]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={cn(
            "size-1.5 rounded-full",
            item.status === "healthy" ? "bg-teal-400" : item.status === "degraded" ? "bg-amber-300" : "bg-rose-400",
          )} />
          <span className="truncate text-xs font-medium text-zinc-200" title={item.collectorId}>{item.collectorId}</span>
          <span className="text-[10px] text-zinc-600">心跳 {formatAge(item.ageMs)}</span>
        </div>
        <span className="text-[10px] text-zinc-600">统计窗口 {item.windowSeconds ?? "--"}s（增量计数）</span>
      </div>
      <div className="grid gap-3 p-3 md:grid-cols-2">
        <div className="rounded-md border border-[#232a37] bg-[#0c1016]">
          <div className="flex items-baseline justify-between gap-2 px-3 pt-2">
            <span className="text-[11px] text-zinc-400">阶段吞吐</span>
            <span className="text-[10px] text-zinc-700">每 {item.windowSeconds ?? 30}s 窗口</span>
          </div>
          <div className="h-[184px]">
            {history.length > 1 ? (
              <VChartView spec={pipelineTrendSpec(history, PIPELINE_THROUGHPUT_SERIES)} height={176} />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-zinc-700">积累两个以上心跳后出图</div>
            )}
          </div>
        </div>
        <div className="rounded-md border border-[#232a37] bg-[#0c1016]">
          <div className="flex items-baseline justify-between gap-2 px-3 pt-2">
            <span className="text-[11px] text-zinc-400">积压趋势</span>
            <span className={cn("text-[10px]", spoolWarning ? "text-amber-300" : "text-zinc-700")}>
              {spoolWarning ? "存在积压" : "无积压"}
            </span>
          </div>
          <div className="h-[184px]">
            {history.length > 1 ? (
              <VChartView spec={pipelineTrendSpec(history, PIPELINE_BACKLOG_SERIES)} height={176} />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-zinc-700">积累两个以上心跳后出图</div>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[#232a37] px-3 py-2">
        {currentStats.map((stat) => (
          <span key={stat.label} className="text-[10px] text-zinc-600">
            {stat.label}
            <span className={cn("ml-1.5 font-mono tabular-nums", stat.value.includes("已满") ? "text-rose-200" : "text-zinc-300")}>
              {stat.value}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
