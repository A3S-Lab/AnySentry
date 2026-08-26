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
  const chartSpec = useMemo(() => utilizationSpec(data), [data]);
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
                onClick={refresh}
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
