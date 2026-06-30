import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  FileText,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Siren,
  UserCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type IncidentListItem,
  type IncidentQuery,
  type IncidentStatus,
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

const STATUS_OPTIONS: Array<{ value: IncidentStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "open", label: "待处理" },
  { value: "acknowledged", label: "已确认" },
  { value: "resolved", label: "已解决" },
];

const SEVERITY_OPTIONS: Array<{ value: SecuritySeverity | "all"; label: string }> = [
  { value: "all", label: "全部等级" },
  { value: "info", label: "提示" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "critical", label: "严重" },
];

const STATUS_LABEL: Record<IncidentStatus, string> = {
  open: "待处理",
  acknowledged: "已确认",
  resolved: "已解决",
};

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
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

function toneByStatus(status?: IncidentStatus) {
  if (status === "open") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (status === "acknowledged") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-teal-400/30 bg-teal-500/10 text-teal-100";
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={cn("rounded-[8px] border px-4 py-3", tone)}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold">{value}</p>
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

function incidentEvidenceHref(incident: IncidentListItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({
    timeType,
    eventId: incident.lastEventId,
    traceId: incident.traceId,
    sessionId: incident.sessionId,
    agentId: incident.agentId,
    workspacePath: incident.workspacePath,
  });
  if (incident.collectorId) params.set("collectorId", incident.collectorId);
  if (incident.sourceId) params.set("sourceId", incident.sourceId);
  return `/events?${params.toString()}`;
}

function incidentBundleHref(incident: IncidentListItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({
    timeType,
    incidentId: incident.incidentId,
    eventId: incident.lastEventId,
    traceId: incident.traceId,
    runId: incident.runId,
    sessionId: incident.sessionId,
    agentId: incident.agentId,
    workspacePath: incident.workspacePath,
  });
  if (incident.collectorId) params.set("collectorId", incident.collectorId);
  if (incident.sourceId) params.set("sourceId", incident.sourceId);
  return `/evidence?${params.toString()}`;
}

function IncidentRow({
  incident,
  active,
  onSelect,
}: {
  incident: IncidentListItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_80px_80px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(incident.updatedAt)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={incident.title}>{incident.title}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={incident.traceId}>
          {incident.agentId} / {incident.riskCategory}
        </span>
      </span>
      <span><Pill className={toneBySeverity(incident.severity)}>{SEVERITY_LABEL[incident.severity]}</Pill></span>
      <span><Pill className={toneByStatus(incident.status)}>{STATUS_LABEL[incident.status]}</Pill></span>
    </button>
  );
}

function IncidentDetail({
  incident,
  owner,
  note,
  saving,
  timeType,
  onOwnerChange,
  onNoteChange,
  onStatus,
}: {
  incident?: IncidentListItem;
  owner: string;
  note: string;
  saving: boolean;
  timeType: SecurityTimeType;
  onOwnerChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onStatus: (status: IncidentStatus) => void;
}) {
  if (!incident) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个 Incident 查看处置详情</div>
      </section>
    );
  }

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldAlert className="size-4 shrink-0 text-rose-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{incident.title}</h2>
        </div>
        <Pill className={toneByStatus(incident.status)}>{STATUS_LABEL[incident.status]}</Pill>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Incident ID" value={incident.incidentId} />
          <FieldValue label="Trace ID" value={incident.traceId} />
          <FieldValue label="Run ID" value={incident.runId} />
          <FieldValue label="Agent" value={incident.agentId} />
          <FieldValue label="Session" value={incident.sessionId} />
          <FieldValue label="Workspace" value={incident.workspacePath} />
          <FieldValue label="Collector" value={incident.collectorId} />
          <FieldValue label="Source" value={incident.sourceId} />
          <FieldValue label="风险分类" value={incident.riskCategory} />
          <FieldValue label="风险名称" value={incident.riskName} />
          <FieldValue label="事件数" value={incident.eventCount} />
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">最高风险分</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-zinc-100">{incident.maxRiskScore}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">打开时间</p>
            <p className="mt-1 font-mono text-xs text-zinc-300">{formatDate(incident.openedAt)}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">最近事件</p>
            <p className="mt-1 truncate text-xs text-zinc-300" title={incident.lastEventSubject}>{incident.lastEventSubject}</p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">描述</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{incident.description}</div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">负责人</span>
            <Input value={owner} onChange={(event) => onOwnerChange(event.target.value)} placeholder="operator / team" className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">备注</span>
            <Input value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder="处置说明" className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("acknowledged")} className="h-8 bg-amber-400 text-[#171004] hover:bg-amber-300">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
            确认
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("resolved")} className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <CheckCircle2 className="size-3.5" />
            解决
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => onStatus("open")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <RotateCcw className="size-3.5" />
            重新打开
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={incidentEvidenceHref(incident, timeType)}>
              查看证据
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to={incidentBundleHref(incident, timeType)}>
              <FileText className="size-3.5" />
              证据包
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function IncidentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [status, setStatus] = useState<IncidentStatus | "all">((searchParams.get("status") as IncidentStatus) || "all");
  const [severity, setSeverity] = useState<SecuritySeverity | "all">((searchParams.get("severity") as SecuritySeverity) || "all");
  const [workspacePath, setWorkspacePath] = useState(searchParams.get("workspacePath") ?? "");
  const [agentId, setAgentId] = useState(searchParams.get("agentId") ?? "");
  const [collectorId, setCollectorId] = useState(searchParams.get("collectorId") ?? "");
  const [sourceId, setSourceId] = useState(searchParams.get("sourceId") ?? "");
  const [sessionId, setSessionId] = useState(searchParams.get("sessionId") ?? "");
  const [traceId, setTraceId] = useState(searchParams.get("traceId") ?? "");
  const [selectedIncidentId, setSelectedIncidentId] = useState(searchParams.get("incidentId") ?? "");
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const query = useMemo<IncidentQuery>(() => ({
    timeType,
    incidentId: clean(selectedIncidentId),
    status,
    severity,
    workspacePath: clean(workspacePath),
    agentId: clean(agentId),
    collectorId: clean(collectorId),
    sourceId: clean(sourceId),
    sessionId: clean(sessionId),
    traceId: clean(traceId),
    limit: 120,
  }), [agentId, collectorId, selectedIncidentId, sessionId, severity, sourceId, status, timeType, traceId, workspacePath]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.incidents(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedIncident = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.incidentId === selectedIncidentId) ?? items[0];
  }, [data, selectedIncidentId]);

  const selectIncident = (incident: IncidentListItem) => {
    setSelectedIncidentId(incident.incidentId);
    setOwner(incident.owner ?? "");
    setNote(incident.note ?? "");
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    if (status !== "all") next.set("status", status);
    if (severity !== "all") next.set("severity", severity);
    if (clean(workspacePath)) next.set("workspacePath", clean(workspacePath)!);
    if (clean(agentId)) next.set("agentId", clean(agentId)!);
    if (clean(collectorId)) next.set("collectorId", clean(collectorId)!);
    if (clean(sourceId)) next.set("sourceId", clean(sourceId)!);
    if (clean(sessionId)) next.set("sessionId", clean(sessionId)!);
    next.set("incidentId", incident.incidentId);
    next.set("traceId", incident.traceId);
    setSearchParams(next);
  };

  const clearFilters = () => {
    setStatus("all");
    setSeverity("all");
    setWorkspacePath("");
    setAgentId("");
    setCollectorId("");
    setSourceId("");
    setSessionId("");
    setTraceId("");
    setSelectedIncidentId("");
    setOwner("");
    setNote("");
    setSearchParams({});
  };

  const updateStatus = async (nextStatus: IncidentStatus) => {
    if (!selectedIncident) return;
    setSaving(true);
    try {
      const updated = await securityCenterApi.updateIncident(selectedIncident.incidentId, {
        status: nextStatus,
        owner: clean(owner),
        note: clean(note),
      });
      setSelectedIncidentId(updated.incidentId);
      setOwner(updated.owner ?? "");
      setNote(updated.note ?? "");
      await refresh();
    } finally {
      setSaving(false);
    }
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
                <Siren className="size-5 shrink-0 text-rose-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">Incident 管理</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">旁路风险自动归并 · 确认 · 解决 · 证据追踪</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 2xl:grid-cols-[120px_130px_130px_minmax(140px,1fr)_minmax(140px,1fr)_minmax(160px,1fr)_minmax(140px,1fr)_minmax(140px,1fr)_minmax(180px,1.2fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={status} onValueChange={(next) => setStatus(next as IncidentStatus | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={severity} onValueChange={(next) => setSeverity(next as SecuritySeverity | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{SEVERITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="sourceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={collectorId} onChange={(event) => setCollectorId(event.target.value)} placeholder="collectorId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="workspacePath" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="agentId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="sessionId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="traceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
          <div className="grid gap-3 md:grid-cols-3">
            <MetricTile label="待处理" value={data?.summary.open ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="已确认" value={data?.summary.acknowledged ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="已解决" value={data?.summary.resolved ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(460px,0.9fr)_minmax(0,1.4fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Search className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Incidents</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 条` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载 Incident...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无 Incident</div>
              ) : (
                <div className="max-h-[calc(100vh-270px)] overflow-y-auto">
                  {data?.items.map((incident) => (
                    <IncidentRow
                      key={incident.incidentId}
                      incident={incident}
                      active={incident.incidentId === selectedIncident?.incidentId}
                      onSelect={() => selectIncident(incident)}
                    />
                  ))}
                </div>
              )}
            </section>

            <IncidentDetail
              incident={selectedIncident}
              owner={owner}
              note={note}
              saving={saving}
              timeType={timeType}
              onOwnerChange={setOwner}
              onNoteChange={setNote}
              onStatus={updateStatus}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
