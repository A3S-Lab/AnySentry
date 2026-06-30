import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  BellRing,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileText,
  LoaderCircle,
  PlugZap,
  RadioTower,
  RefreshCw,
  Save,
  ShieldAlert,
  Target,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type ObjectiveComparator,
  type ObjectiveItem,
  type ObjectiveMetric,
  type ObjectiveQuery,
  type ObjectiveStatus,
  type ObjectiveTargetType,
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

const STATUS_OPTIONS: Array<{ value: ObjectiveStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "breach", label: "违约" },
  { value: "ok", label: "正常" },
  { value: "disabled", label: "禁用" },
];

const TARGET_OPTIONS: Array<{ value: ObjectiveTargetType | "all"; label: string }> = [
  { value: "all", label: "全部目标" },
  { value: "global", label: "Global" },
  { value: "workspace", label: "Workspace" },
  { value: "agent", label: "Agent" },
  { value: "collector", label: "Collector" },
  { value: "source", label: "Source" },
];

const TARGET_FORM_OPTIONS: Array<{ value: ObjectiveTargetType; label: string }> = TARGET_OPTIONS.filter((item) => item.value !== "all") as Array<{ value: ObjectiveTargetType; label: string }>;

const METRIC_OPTIONS: Array<{ value: ObjectiveMetric | "all"; label: string }> = [
  { value: "all", label: "全部指标" },
  { value: "coverage_score", label: "覆盖分" },
  { value: "open_incidents", label: "Open Incidents" },
  { value: "active_alerts", label: "Active Alerts" },
  { value: "overdue_remediations", label: "Overdue Remediations" },
  { value: "risky_events", label: "风险事件" },
  { value: "stale_agents", label: "Stale Agents" },
  { value: "collector_down", label: "Down Collectors" },
  { value: "source_down", label: "Down Sources" },
];

const METRIC_FORM_OPTIONS = METRIC_OPTIONS.filter((item) => item.value !== "all") as Array<{ value: ObjectiveMetric; label: string }>;

const SEVERITY_OPTIONS: Array<{ value: SecuritySeverity; label: string }> = [
  { value: "critical", label: "严重" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
  { value: "info", label: "提示" },
];

const COMPARATOR_LABEL: Record<ObjectiveComparator, string> = {
  lte: "<=",
  gte: ">=",
};

const STATUS_LABEL: Record<ObjectiveStatus, string> = {
  ok: "正常",
  breach: "违约",
  disabled: "禁用",
};

const METRIC_LABEL: Record<ObjectiveMetric, string> = {
  coverage_score: "覆盖分",
  open_incidents: "Open Incidents",
  active_alerts: "Active Alerts",
  overdue_remediations: "Overdue Remediations",
  risky_events: "风险事件",
  stale_agents: "Stale Agents",
  collector_down: "Down Collectors",
  source_down: "Down Sources",
};

interface Draft {
  name: string;
  enabled: boolean;
  targetType: ObjectiveTargetType;
  targetId: string;
  metric: ObjectiveMetric;
  comparator: ObjectiveComparator;
  threshold: string;
  severity: SecuritySeverity;
  owner: string;
  description: string;
}

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function defaultDraft(): Draft {
  return {
    name: "",
    enabled: true,
    targetType: "global",
    targetId: "",
    metric: "active_alerts",
    comparator: "lte",
    threshold: "0",
    severity: "high",
    owner: "",
    description: "",
  };
}

function isObjectiveTargetType(value: string | null): value is ObjectiveTargetType {
  return value === "global" || value === "workspace" || value === "agent" || value === "collector" || value === "source";
}

function isObjectiveMetric(value: string | null): value is ObjectiveMetric {
  return value === "coverage_score" || value === "open_incidents" || value === "active_alerts" || value === "overdue_remediations" || value === "risky_events" || value === "stale_agents" || value === "collector_down" || value === "source_down";
}

function splitAgentTargetId(targetId: string) {
  const separator = targetId.lastIndexOf(":");
  if (separator <= 0 || separator >= targetId.length - 1) return { agentId: targetId };
  return {
    workspacePath: targetId.slice(0, separator),
    agentId: targetId.slice(separator + 1),
  };
}

function targetIdFromParams(params: URLSearchParams, targetType: ObjectiveTargetType | undefined) {
  const explicitTargetId = params.get("targetId");
  if (explicitTargetId) return explicitTargetId;
  if (targetType === "workspace") return params.get("workspacePath") ?? "";
  if (targetType === "agent") {
    const agentId = params.get("agentId") ?? "";
    const workspacePath = params.get("workspacePath") ?? "";
    return agentId && workspacePath ? `${workspacePath}:${agentId}` : agentId;
  }
  if (targetType === "collector") return params.get("collectorId") ?? "";
  if (targetType === "source") return params.get("sourceId") ?? "";
  return params.get("sourceId") ?? params.get("collectorId") ?? params.get("workspacePath") ?? "";
}

function draftFromParams(params: URLSearchParams): Draft {
  const draft = defaultDraft();
  const rawTargetType = params.get("targetType");
  const targetType = isObjectiveTargetType(rawTargetType) ? rawTargetType : undefined;
  const targetId = targetIdFromParams(params, targetType);
  const rawMetric = params.get("metric");
  const metric = isObjectiveMetric(rawMetric) ? rawMetric : undefined;
  if (targetType) {
    draft.targetType = targetType;
    draft.targetId = targetType === "global" ? "" : targetId;
  }
  if (metric) {
    draft.metric = metric;
    draft.comparator = metric === "coverage_score" ? "gte" : "lte";
    draft.threshold = metric === "coverage_score" ? "90" : "0";
  }
  if (targetType === "source" && targetId) {
    draft.name = `Source health · ${targetId}`;
    draft.description = `Monitor unhealthy source ${targetId}`;
  }
  return draft;
}

function draftFrom(item?: ObjectiveItem): Draft {
  if (!item) return defaultDraft();
  return {
    name: item.name,
    enabled: item.enabled,
    targetType: item.targetType,
    targetId: item.targetId ?? "",
    metric: item.metric,
    comparator: item.comparator,
    threshold: String(item.threshold),
    severity: item.severity,
    owner: item.owner ?? "",
    description: item.description ?? "",
  };
}

function statusTone(status?: ObjectiveStatus) {
  if (status === "breach") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (status === "ok") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function severityTone(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function Pill({ children, className }: { children: string; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>{children}</span>;
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
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>{value ?? "--"}</p>
    </div>
  );
}

function addObjectiveTargetParams(params: URLSearchParams, item: ObjectiveItem) {
  const targetId = item.targetId?.trim();
  if (!targetId) return;
  if (item.targetType === "workspace") params.set("workspacePath", targetId);
  if (item.targetType === "agent") {
    const scope = splitAgentTargetId(targetId);
    params.set("agentId", scope.agentId);
    if (scope.workspacePath) params.set("workspacePath", scope.workspacePath);
  }
  if (item.targetType === "collector") params.set("collectorId", targetId);
  if (item.targetType === "source") params.set("sourceId", targetId);
}

function objectiveTargetHref(item: ObjectiveItem) {
  const targetId = item.targetId?.trim();
  if (!targetId) return undefined;
  if (item.targetType === "workspace") return `/workspaces?${new URLSearchParams({ workspacePath: targetId }).toString()}`;
  if (item.targetType === "agent") {
    const scope = splitAgentTargetId(targetId);
    const params = new URLSearchParams({ agentId: scope.agentId });
    if (scope.workspacePath) params.set("workspacePath", scope.workspacePath);
    return `/agents?${params.toString()}`;
  }
  if (item.targetType === "collector") return `/collectors?${new URLSearchParams({ collectorId: targetId }).toString()}`;
  if (item.targetType === "source") return `/sources?${new URLSearchParams({ sourceId: targetId }).toString()}`;
  return undefined;
}

function objectiveCoverageHref(item: ObjectiveItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType });
  addObjectiveTargetParams(params, item);
  return `/coverage?${params.toString()}`;
}

function objectiveMaintenanceHref(item: ObjectiveItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType });
  params.set("targetType", item.targetType === "global" ? "all" : item.targetType);
  params.set("targetId", item.targetType === "global" ? "*" : item.targetId ?? "");
  addObjectiveTargetParams(params, item);
  return `/maintenance?${params.toString()}`;
}

function objectiveNotificationHref(item: ObjectiveItem) {
  const params = new URLSearchParams({ objectiveId: item.objectiveId, kind: "objective", minSeverity: item.severity });
  addObjectiveTargetParams(params, item);
  return `/notifications?${params.toString()}`;
}

function ObjectiveTargetIcon({ type }: { type: ObjectiveTargetType }) {
  const className = "size-3.5";
  if (type === "workspace") return <BriefcaseBusiness className={className} />;
  if (type === "agent") return <Bot className={className} />;
  if (type === "collector") return <RadioTower className={className} />;
  if (type === "source") return <PlugZap className={className} />;
  return <Target className={className} />;
}

function objectiveBundleHref(item: ObjectiveItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, objectiveId: item.objectiveId });
  addObjectiveTargetParams(params, item);
  return `/evidence?${params.toString()}`;
}

function objectiveAlertsHref(item: ObjectiveItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, kind: "objective", objectiveId: item.objectiveId });
  addObjectiveTargetParams(params, item);
  return `/alerts?${params.toString()}`;
}

function objectiveRemediationHref(item: ObjectiveItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, objectiveId: item.objectiveId });
  addObjectiveTargetParams(params, item);
  return `/remediation?${params.toString()}`;
}

function ObjectiveRow({ item, active, onSelect }: { item: ObjectiveItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("grid w-full grid-cols-[minmax(0,1fr)_86px_76px_76px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]", active && "bg-teal-400/8")}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={item.name}>{item.name}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={item.targetId ?? item.targetType}>
          {item.targetType}:{item.targetId ?? "*"} · {METRIC_LABEL[item.metric]}
        </span>
      </span>
      <span className="text-right font-mono text-xs text-zinc-300">{item.currentValue}</span>
      <span><Pill className={statusTone(item.status)}>{STATUS_LABEL[item.status]}</Pill></span>
      <span><Pill className={severityTone(item.severity)}>{item.severity}</Pill></span>
    </button>
  );
}

export default function ObjectivesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const routeTargetType = isObjectiveTargetType(searchParams.get("targetType")) ? searchParams.get("targetType") as ObjectiveTargetType : undefined;
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [status, setStatus] = useState<ObjectiveStatus | "all">((searchParams.get("status") as ObjectiveStatus) || "all");
  const [targetType, setTargetType] = useState<ObjectiveTargetType | "all">((searchParams.get("targetType") as ObjectiveTargetType) || "all");
  const [targetId, setTargetId] = useState(targetIdFromParams(searchParams, routeTargetType));
  const [metric, setMetric] = useState<ObjectiveMetric | "all">((searchParams.get("metric") as ObjectiveMetric) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedId, setSelectedId] = useState(searchParams.get("objectiveId") ?? "");
  const [draft, setDraft] = useState<Draft>(() => draftFromParams(searchParams));
  const [saving, setSaving] = useState(false);

  const query = useMemo<ObjectiveQuery>(() => ({
    timeType,
    objectiveId: clean(selectedId),
    status,
    targetType,
    targetId: clean(targetId),
    metric,
    q: clean(queryText),
    limit: 200,
  }), [metric, queryText, selectedId, status, targetId, targetType, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.objectives(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selected = useMemo(() => (data?.items ?? []).find((item) => item.objectiveId === selectedId), [data, selectedId]);

  useEffect(() => {
    if (selected) setDraft(draftFrom(selected));
    else if (!selectedId) setDraft(draftFromParams(searchParams));
  }, [selected?.objectiveId, selectedId]);

  const selectObjective = (item: ObjectiveItem) => {
    setSelectedId(item.objectiveId);
    setStatus(item.status);
    setTargetType(item.targetType);
    setTargetId(item.targetId ?? "");
    setMetric(item.metric);
    setDraft(draftFrom(item));
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("objectiveId", item.objectiveId);
    next.set("status", item.status);
    next.set("targetType", item.targetType);
    if (item.targetId) next.set("targetId", item.targetId);
    next.set("metric", item.metric);
    addObjectiveTargetParams(next, item);
    setSearchParams(next);
  };

  const clearFilters = () => {
    setStatus("all");
    setTargetType("all");
    setTargetId("");
    setMetric("all");
    setQueryText("");
    setSelectedId("");
    setDraft(defaultDraft());
    setSearchParams({});
  };

  const saveObjective = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name || `${METRIC_LABEL[draft.metric]} ${COMPARATOR_LABEL[draft.comparator]} ${draft.threshold}`,
        enabled: draft.enabled,
        targetType: draft.targetType,
        targetId: draft.targetType === "global" ? undefined : draft.targetId,
        metric: draft.metric,
        comparator: draft.comparator,
        threshold: Number(draft.threshold || 0),
        severity: draft.severity,
        owner: draft.owner,
        description: draft.description,
      };
      const updated = selectedId
        ? await securityCenterApi.updateObjective(selectedId, body)
        : await securityCenterApi.createObjective(body);
      setSelectedId(updated.objectiveId);
      setDraft(draftFrom(updated));
      await refresh();
    } finally {
      setSaving(false);
    }
  };
  const selectedTargetHref = selected ? objectiveTargetHref(selected) : undefined;

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
                <Target className="size-5 shrink-0 text-lime-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">监控目标</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Objectives · SLO · Breach</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-[120px_120px_130px_minmax(160px,1fr)_160px_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={status} onValueChange={(next) => setStatus(next as ObjectiveStatus | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={targetType} onValueChange={(next) => setTargetType(next as ObjectiveTargetType | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TARGET_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="targetId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Select value={metric} onValueChange={(next) => setMetric(next as ObjectiveMetric | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{METRIC_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="name / target / owner / evidence" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <MetricTile label="目标" value={data?.summary.totalObjectives ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="启用" value={data?.summary.enabledObjectives ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="违约" value={data?.summary.breachedObjectives ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="高危违约" value={data?.summary.highSeverityBreaches ?? 0} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
            <MetricTile label="正常" value={data?.summary.okObjectives ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="禁用" value={data?.summary.disabledObjectives ?? 0} tone="border-zinc-400/20 bg-zinc-500/10 text-zinc-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_minmax(0,1.15fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Target className="size-4 text-lime-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Objectives</h2>
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={() => { setSelectedId(""); setDraft(defaultDraft()); }} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                  新建
                </Button>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500"><LoaderCircle className="mr-2 size-4 animate-spin" />加载目标...</div>
              ) : (data?.items.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-500"><CheckCircle2 className="size-4 text-teal-300" />暂无目标</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((item) => <ObjectiveRow key={item.objectiveId} item={item} active={item.objectiveId === selectedId} onSelect={() => selectObjective(item)} />)}
                </div>
              )}
            </section>

            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <h2 className="text-sm font-semibold text-zinc-100">{selectedId ? "编辑目标" : "新建目标"}</h2>
                {selected ? <Pill className={statusTone(selected.status)}>{STATUS_LABEL[selected.status]}</Pill> : null}
              </div>
              <div className="space-y-4 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">名称</span>
                    <Input value={draft.name} onChange={(event) => setDraft((cur) => ({ ...cur, name: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Owner</span>
                    <Input value={draft.owner} onChange={(event) => setDraft((cur) => ({ ...cur, owner: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)]">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">目标类型</span>
                    <Select value={draft.targetType} onValueChange={(next) => setDraft((cur) => ({ ...cur, targetType: next as ObjectiveTargetType, targetId: next === "global" ? "" : cur.targetId }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>{TARGET_FORM_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">目标 ID</span>
                    <Input value={draft.targetId} disabled={draft.targetType === "global"} onChange={(event) => setDraft((cur) => ({ ...cur, targetId: event.target.value }))} placeholder="workspacePath / agentId / collectorId / sourceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_100px_120px_120px]">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">指标</span>
                    <Select value={draft.metric} onValueChange={(next) => setDraft((cur) => ({ ...cur, metric: next as ObjectiveMetric, comparator: next === "coverage_score" ? "gte" : "lte" }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>{METRIC_FORM_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">比较</span>
                    <Select value={draft.comparator} onValueChange={(next) => setDraft((cur) => ({ ...cur, comparator: next as ObjectiveComparator }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lte">&lt;=</SelectItem>
                        <SelectItem value="gte">&gt;=</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">阈值</span>
                    <Input value={draft.threshold} onChange={(event) => setDraft((cur) => ({ ...cur, threshold: event.target.value.replace(/[^\d.]/g, "") }))} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">等级</span>
                    <Select value={draft.severity} onValueChange={(next) => setDraft((cur) => ({ ...cur, severity: next as SecuritySeverity }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>{SEVERITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                </div>
                <Input value={draft.description} onChange={(event) => setDraft((cur) => ({ ...cur, description: event.target.value }))} placeholder="描述" className="h-9 border-white/10 bg-white/5 text-xs" />

                {selected ? (
                  <div className="grid gap-3 md:grid-cols-3">
                    <FieldValue label="Current" value={selected.currentValue} />
                    <FieldValue label="Threshold" value={`${COMPARATOR_LABEL[selected.comparator]} ${selected.threshold}`} />
                    <FieldValue label="Evidence" value={selected.evidence} />
                    <FieldValue label="Evaluated" value={formatDate(selected.evaluatedAt)} />
                    <FieldValue label="Created" value={formatDate(selected.createdAt)} />
                    <FieldValue label="Updated" value={formatDate(selected.updatedAt)} />
                  </div>
                ) : null}

                {selected ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
                      <Link to={objectiveBundleHref(selected, timeType)}>
                        <FileText className="size-3.5" />
                        证据包
                      </Link>
                    </Button>
                    <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                      <Link to={objectiveAlertsHref(selected, timeType)}>
                        <ShieldAlert className="size-3.5" />
                        Alert
                      </Link>
                    </Button>
                    <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                      <Link to={objectiveRemediationHref(selected, timeType)}>
                        <FileCheck2 className="size-3.5" />
                        Remediation
                      </Link>
                    </Button>
                    {selectedTargetHref ? (
                      <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                        <Link to={selectedTargetHref}>
                          <ObjectiveTargetIcon type={selected.targetType} />
                          Target
                        </Link>
                      </Button>
                    ) : null}
                    <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                      <Link to={objectiveCoverageHref(selected, timeType)}>
                        <CheckCircle2 className="size-3.5" />
                        Coverage
                      </Link>
                    </Button>
                    <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                      <Link to={objectiveMaintenanceHref(selected, timeType)}>
                        <CalendarClock className="size-3.5" />
                        Maintenance
                      </Link>
                    </Button>
                    <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                      <Link to={objectiveNotificationHref(selected)}>
                        <BellRing className="size-3.5" />
                        Notifications
                      </Link>
                    </Button>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={saveObjective} disabled={saving || (draft.targetType !== "global" && !clean(draft.targetId))} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
                    {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    保存目标
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setDraft((cur) => ({ ...cur, enabled: !cur.enabled }))} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                    {draft.enabled ? "禁用" : "启用"}
                  </Button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
