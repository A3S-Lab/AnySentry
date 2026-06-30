import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  EyeOff,
  FileCheck2,
  FileText,
  Gauge,
  LoaderCircle,
  PlugZap,
  RadioTower,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type CoverageIssue,
  type CoverageIssueType,
  type CoverageQuery,
  type SecuritySeverity,
  type SecurityTimeType,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

const SEVERITY_OPTIONS: Array<{ value: SecuritySeverity | "all"; label: string }> = [
  { value: "all", label: "全部等级" },
  { value: "critical", label: "严重" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
  { value: "info", label: "提示" },
];

const TYPE_OPTIONS: Array<{ value: CoverageIssueType | "all"; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "collector_down", label: "Collector 断流" },
  { value: "collector_stale", label: "Collector 陈旧" },
  { value: "collector_degraded", label: "Collector 降级" },
  { value: "collector_quiet", label: "Collector 静默" },
  { value: "agent_stale", label: "Agent 陈旧" },
  { value: "agent_uncovered", label: "Agent 未覆盖" },
  { value: "workspace_quiet", label: "Workspace 静默" },
  { value: "missing_collector_heartbeat", label: "缺心跳" },
  { value: "source_unused", label: "Source 未启用" },
  { value: "source_stale", label: "Source 陈旧" },
  { value: "source_rejected", label: "Source 拒绝" },
  { value: "source_token_rotation_due", label: "Token 到期" },
];

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

const TYPE_LABEL: Record<CoverageIssueType, string> = {
  collector_down: "Collector 断流",
  collector_stale: "Collector 陈旧",
  collector_degraded: "Collector 降级",
  collector_quiet: "Collector 静默",
  agent_stale: "Agent 陈旧",
  agent_uncovered: "Agent 未覆盖",
  workspace_quiet: "Workspace 静默",
  missing_collector_heartbeat: "缺心跳",
  source_unused: "Source 未启用",
  source_stale: "Source 陈旧",
  source_rejected: "Source 拒绝",
  source_token_rotation_due: "Token 到期",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function toneBySeverity(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function typeTone(type?: CoverageIssueType) {
  if (type?.startsWith("collector")) return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  if (type?.startsWith("agent")) return "border-violet-400/30 bg-violet-500/10 text-violet-100";
  if (type?.startsWith("source")) return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (type === "workspace_quiet") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-rose-400/30 bg-rose-500/10 text-rose-100";
}

function scoreTone(score?: number) {
  if ((score ?? 0) >= 90) return "border-teal-400/25 bg-teal-500/10 text-teal-100";
  if ((score ?? 0) >= 75) return "border-sky-400/25 bg-sky-500/10 text-sky-100";
  if ((score ?? 0) >= 55) return "border-amber-400/25 bg-amber-500/10 text-amber-100";
  return "border-rose-400/25 bg-rose-500/10 text-rose-100";
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className={cn("rounded-[8px] border px-4 py-3", tone)}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-1 truncate font-mono text-2xl font-semibold">{value}</p>
    </div>
  );
}

function FieldValue({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-zinc-600">{label}</p>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function IssueRow({
  issue,
  active,
  onSelect,
}: {
  issue: CoverageIssue;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_98px_76px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(issue.lastSeenAt ?? issue.detectedAt)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={issue.title}>{issue.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-600" title={issue.description}>{issue.description}</span>
      </span>
      <span><Pill className={issue.suppressedByMaintenance ? "border-indigo-400/30 bg-indigo-500/10 text-indigo-100" : typeTone(issue.type)}>{issue.suppressedByMaintenance ? "维护" : TYPE_LABEL[issue.type]}</Pill></span>
      <span><Pill className={toneBySeverity(issue.severity)}>{SEVERITY_LABEL[issue.severity]}</Pill></span>
    </button>
  );
}

function IssueDetail({ issue, timeType }: { issue?: CoverageIssue; timeType: SecurityTimeType }) {
  if (!issue) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个覆盖问题查看证据</div>
      </section>
    );
  }

  const eventQs = new URLSearchParams();
  if (issue.evidenceEventId) eventQs.set("eventId", issue.evidenceEventId);
  if (issue.agentId) eventQs.set("agentId", issue.agentId);
  if (issue.workspacePath) eventQs.set("workspacePath", issue.workspacePath);
  if (issue.collectorId) eventQs.set("collectorId", issue.collectorId);
  if (issue.sourceId) eventQs.set("sourceId", issue.sourceId);
  const agentQs = new URLSearchParams();
  if (issue.agentId) agentQs.set("agentId", issue.agentId);
  if (issue.workspacePath) agentQs.set("workspacePath", issue.workspacePath);
  const collectorQs = new URLSearchParams();
  if (issue.collectorId) collectorQs.set("collectorId", issue.collectorId);
  const sourceQs = new URLSearchParams();
  if (issue.sourceId) sourceQs.set("sourceId", issue.sourceId);
  const bundleQs = new URLSearchParams({ timeType, issueId: issue.issueId });
  const alertQs = new URLSearchParams({ timeType, kind: "coverage", issueId: issue.issueId });
  const remediationQs = new URLSearchParams({ timeType, sourceType: "coverage", issueId: issue.issueId });
  for (const params of [bundleQs, alertQs, remediationQs]) {
    if (issue.agentId) params.set("agentId", issue.agentId);
    if (issue.workspacePath) params.set("workspacePath", issue.workspacePath);
    if (issue.collectorId) params.set("collectorId", issue.collectorId);
    if (issue.sourceId) params.set("sourceId", issue.sourceId);
  }
  const labels = Object.entries(issue.labels ?? {}).filter(([, value]) => value !== "");

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <EyeOff className="size-4 shrink-0 text-amber-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{issue.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {issue.suppressedByMaintenance ? <Pill className="border-indigo-400/30 bg-indigo-500/10 text-indigo-100">维护抑制</Pill> : null}
          <Pill className={toneBySeverity(issue.severity)}>{SEVERITY_LABEL[issue.severity]}</Pill>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Issue ID" value={issue.issueId} />
          <FieldValue label="Type" value={issue.type} />
          <FieldValue label="Detected" value={formatDate(issue.detectedAt)} />
          <FieldValue label="Agent" value={issue.agentId} />
          <FieldValue label="Workspace" value={issue.workspacePath} />
          <FieldValue label="Collector" value={issue.collectorId} />
          <FieldValue label="Source" value={issue.sourceId} />
          <FieldValue label="Node" value={issue.nodeName} />
          <FieldValue label="Last Seen" value={formatDate(issue.lastSeenAt)} />
          <FieldValue label="Evidence" value={issue.evidenceEventId} />
          <FieldValue label="Maintenance" value={issue.maintenanceTitle} />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">描述</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{issue.description}</div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">处置建议</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{issue.recommendedAction}</div>
        </div>

        {issue.evidenceSubject ? (
          <div>
            <p className="mb-2 text-xs font-medium text-zinc-400">最近证据</p>
            <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{issue.evidenceSubject}</div>
          </div>
        ) : null}

        {labels.length ? (
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {labels.map(([key, value]) => <FieldValue key={key} label={key} value={value} />)}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <Link to={`/evidence?${bundleQs.toString()}`}>
              <FileText className="size-3.5" />
              Evidence
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={`/alerts?${alertQs.toString()}`}>
              <BellRing className="size-3.5" />
              Alert
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={`/remediation?${remediationQs.toString()}`}>
              <FileCheck2 className="size-3.5" />
              Remediation
            </Link>
          </Button>
          {eventQs.toString() ? (
            <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to={`/events?${eventQs.toString()}`}>
                <Search className="size-3.5" />
                事件
              </Link>
            </Button>
          ) : null}
          {issue.agentId ? (
            <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to={`/agents?${agentQs.toString()}`}>
                <Bot className="size-3.5" />
                Agent
              </Link>
            </Button>
          ) : null}
          {issue.collectorId ? (
            <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to={`/collectors?${collectorQs.toString()}`}>
                <RadioTower className="size-3.5" />
                Collector
              </Link>
            </Button>
          ) : null}
          {issue.sourceId ? (
            <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to={`/sources?${sourceQs.toString()}`}>
                <PlugZap className="size-3.5" />
                Source
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default function CoveragePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [severity, setSeverity] = useState<SecuritySeverity | "all">((searchParams.get("severity") as SecuritySeverity) || "all");
  const [type, setType] = useState<CoverageIssueType | "all">((searchParams.get("type") as CoverageIssueType) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedIssueId, setSelectedIssueId] = useState(searchParams.get("issueId") ?? "");
  const scopedAgentId = searchParams.get("agentId") ?? "";
  const scopedWorkspacePath = searchParams.get("workspacePath") ?? "";
  const scopedCollectorId = searchParams.get("collectorId") ?? "";
  const scopedSourceId = searchParams.get("sourceId") ?? "";

  const query = useMemo<CoverageQuery>(() => ({
    timeType,
    issueId: clean(selectedIssueId),
    agentId: clean(scopedAgentId),
    workspacePath: clean(scopedWorkspacePath),
    collectorId: clean(scopedCollectorId),
    sourceId: clean(scopedSourceId),
    severity,
    type,
    q: clean(queryText),
    limit: 200,
  }), [queryText, scopedAgentId, scopedCollectorId, scopedSourceId, scopedWorkspacePath, selectedIssueId, severity, timeType, type]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.coverageOverview(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedIssue = useMemo(() => {
    const items = data?.issues ?? [];
    return items.find((item) => item.issueId === selectedIssueId) ?? items[0];
  }, [data, selectedIssueId]);

  const selectIssue = (issue: CoverageIssue) => {
    setSelectedIssueId(issue.issueId);
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("issueId", issue.issueId);
    next.set("type", issue.type);
    if (issue.agentId) next.set("agentId", issue.agentId);
    if (issue.workspacePath) next.set("workspacePath", issue.workspacePath);
    if (issue.collectorId) next.set("collectorId", issue.collectorId);
    if (issue.sourceId) next.set("sourceId", issue.sourceId);
    if (clean(queryText)) next.set("q", queryText.trim());
    setSearchParams(next);
  };

  const clearFilters = () => {
    setSeverity("all");
    setType("all");
    setQueryText("");
    setSelectedIssueId("");
    setSearchParams({});
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="h-9 shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                返回
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <EyeOff className="size-5 shrink-0 text-amber-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">覆盖盲区</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Collector · Agent · Workspace</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_160px_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={severity} onValueChange={(next) => setSeverity(next as SecuritySeverity | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{SEVERITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={type} onValueChange={(next) => setType(next as CoverageIssueType | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TYPE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="agent / collector / source / workspace" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <X className="size-3.5" />
            清除
          </Button>
          <Button type="button" size="sm" onClick={refresh} disabled={loading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
            <MetricTile label="覆盖分" value={data?.summary.coverageScore ?? 0} tone={scoreTone(data?.summary.coverageScore)} />
            <MetricTile label="问题" value={data?.summary.issueCount ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="Agent 覆盖" value={`${data?.summary.coveredAgents ?? 0}/${data?.summary.observedAgents ?? 0}`} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="Collector 活跃" value={`${data?.summary.activeCollectors ?? 0}/${data?.summary.totalCollectors ?? 0}`} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="Source 健康" value={`${data?.summary.activeSources ?? 0}/${data?.summary.totalSources ?? 0}`} tone={(data?.summary.unhealthySources ?? 0) > 0 ? "border-amber-400/25 bg-amber-500/10 text-amber-100" : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"} />
            <MetricTile label="无归属事件" value={data?.summary.eventsWithoutCollector ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="维护抑制" value={data?.summary.suppressedIssues ?? 0} tone="border-indigo-400/25 bg-indigo-500/10 text-indigo-100" />
          </div>

          <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <FieldValue label="状态" value={data?.summary.statusText ?? "--"} />
              <FieldValue label="严重/高危" value={(data?.summary.criticalIssues ?? 0) + (data?.summary.highIssues ?? 0)} />
              <FieldValue label="陈旧 Agent" value={data?.summary.staleAgents ?? 0} />
              <FieldValue label="未覆盖 Agent" value={data?.summary.uncoveredAgents ?? 0} />
              <FieldValue label="异常 Collector" value={(data?.summary.degradedCollectors ?? 0) + (data?.summary.downCollectors ?? 0)} />
              <FieldValue label="Workspace" value={data?.summary.observedWorkspaces ?? 0} />
            </div>
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_minmax(0,1.15fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-amber-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">覆盖问题</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.issues.length} 条` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载覆盖状态...
                </div>
              ) : (data?.issues?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-500">
                  <CheckCircle2 className="size-4 text-teal-300" />
                  当前窗口没有覆盖问题
                </div>
              ) : (
                <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
                  {data?.issues.map((issue) => (
                    <IssueRow
                      key={issue.issueId}
                      issue={issue}
                      active={issue.issueId === selectedIssue?.issueId}
                      onSelect={() => selectIssue(issue)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-4">
              <IssueDetail issue={selectedIssue} timeType={timeType} />
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Gauge className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">覆盖构成</h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <FieldValue label="Critical" value={data?.summary.criticalIssues ?? 0} />
                  <FieldValue label="High" value={data?.summary.highIssues ?? 0} />
                  <FieldValue label="Medium" value={data?.summary.mediumIssues ?? 0} />
                  <FieldValue label="Low" value={data?.summary.lowIssues ?? 0} />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
