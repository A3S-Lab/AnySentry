import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  BellRing,
  Bot,
  CalendarClock,
  Clock3,
  FileCheck2,
  FileText,
  History,
  LoaderCircle,
  Megaphone,
  PlugZap,
  Target,
  RefreshCw,
  ScrollText,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  TerminalSquare,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AuditAction,
  type AuditListItem,
  type AuditQuery,
  type AuditResourceType,
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

const ACTION_OPTIONS: Array<{ value: AuditAction | "all"; label: string }> = [
  { value: "all", label: "全部动作" },
  { value: "policy.updated", label: "策略保存" },
  { value: "policy.simulated", label: "策略回放" },
  { value: "agent.metadata.updated", label: "Agent 元数据" },
  { value: "maintenance.window.updated", label: "维护窗口" },
  { value: "notification.channel.updated", label: "通知通道" },
  { value: "notification.route.updated", label: "通知路由" },
  { value: "notification.delivery_failed", label: "通知失败" },
  { value: "objective.updated", label: "监控目标" },
  { value: "source.updated", label: "接入源" },
  { value: "source.token_rotated", label: "Source Token" },
  { value: "incident.updated", label: "Incident 更新" },
  { value: "alert.updated", label: "告警更新" },
  { value: "remediation.updated", label: "处置更新" },
];

const RESOURCE_OPTIONS: Array<{ value: AuditResourceType | "all"; label: string }> = [
  { value: "all", label: "全部资源" },
  { value: "policy", label: "Policy" },
  { value: "agent", label: "Agent" },
  { value: "maintenance", label: "Maintenance" },
  { value: "notification", label: "Notification" },
  { value: "objective", label: "Objective" },
  { value: "source", label: "Source" },
  { value: "incident", label: "Incident" },
  { value: "alert", label: "Alert" },
  { value: "remediation", label: "Remediation" },
];

const ACTION_LABEL: Record<AuditAction, string> = {
  "policy.updated": "策略保存",
  "policy.simulated": "策略回放",
  "agent.metadata.updated": "Agent 元数据",
  "maintenance.window.updated": "维护窗口",
  "notification.channel.updated": "通知通道",
  "notification.route.updated": "通知路由",
  "notification.delivery_failed": "通知失败",
  "objective.updated": "监控目标",
  "source.updated": "接入源",
  "source.token_rotated": "Source Token",
  "incident.updated": "Incident 更新",
  "alert.updated": "告警更新",
  "remediation.updated": "处置更新",
};

const RESOURCE_LABEL: Record<AuditResourceType, string> = {
  policy: "Policy",
  agent: "Agent",
  maintenance: "Maintenance",
  notification: "Notification",
  objective: "Objective",
  source: "Source",
  incident: "Incident",
  alert: "Alert",
  remediation: "Remediation",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function toneByResource(resource?: AuditResourceType) {
  if (resource === "policy") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (resource === "agent") return "border-violet-400/30 bg-violet-500/10 text-violet-100";
  if (resource === "maintenance") return "border-indigo-400/30 bg-indigo-500/10 text-indigo-100";
  if (resource === "notification") return "border-cyan-400/30 bg-cyan-500/10 text-cyan-100";
  if (resource === "objective") return "border-lime-400/30 bg-lime-500/10 text-lime-100";
  if (resource === "source") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
  if (resource === "incident") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (resource === "alert") return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  return "border-amber-400/30 bg-amber-500/10 text-amber-100";
}

function toneByResult(result?: string) {
  return result === "failure"
    ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
    : "border-teal-400/30 bg-teal-500/10 text-teal-100";
}

function iconForResource(resource: AuditResourceType) {
  if (resource === "policy") return <SlidersHorizontal className="size-4 text-teal-200" />;
  if (resource === "agent") return <Bot className="size-4 text-violet-200" />;
  if (resource === "maintenance") return <CalendarClock className="size-4 text-indigo-200" />;
  if (resource === "notification") return <Megaphone className="size-4 text-cyan-200" />;
  if (resource === "objective") return <Target className="size-4 text-lime-200" />;
  if (resource === "source") return <PlugZap className="size-4 text-emerald-200" />;
  if (resource === "incident") return <ShieldAlert className="size-4 text-rose-200" />;
  if (resource === "alert") return <BellRing className="size-4 text-sky-200" />;
  return <FileCheck2 className="size-4 text-amber-200" />;
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

function detailValue(value: unknown): string {
  if (value === null || value === undefined) return "--";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function detailText(item: AuditListItem, key: string): string {
  const value = item.details?.[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function AuditRow({ item, active, onSelect }: { item: AuditListItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_98px_98px_96px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(item.at)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={item.summary}>{item.summary}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={item.resourceId}>
          {item.actor.displayName ?? item.actor.id} · {item.resourceId}
        </span>
      </span>
      <span><Pill className={toneByResource(item.resourceType)}>{RESOURCE_LABEL[item.resourceType]}</Pill></span>
      <span><Pill className="border-white/10 bg-white/5 text-zinc-200">{ACTION_LABEL[item.action]}</Pill></span>
      <span><Pill className={toneByResult(item.result)}>{item.result}</Pill></span>
    </button>
  );
}

function addDetailParam(params: URLSearchParams, item: AuditListItem, key: string) {
  const value = detailText(item, key);
  if (value) params.set(key, value);
}

function addOperationalScopeParams(params: URLSearchParams, item: AuditListItem) {
  addDetailParam(params, item, "workspacePath");
  addDetailParam(params, item, "agentId");
  addDetailParam(params, item, "collectorId");
  addDetailParam(params, item, "sourceId");
}

function evidenceParamsForAudit(item: AuditListItem, timeType: SecurityTimeType) {
  const qs = new URLSearchParams({ timeType, auditId: item.auditId });
  if (item.resourceType === "incident") qs.set("incidentId", item.resourceId);
  if (item.resourceType === "alert") qs.set("alertId", item.resourceId);
  if (item.resourceType === "remediation") qs.set("taskId", item.resourceId);
  if (item.resourceType === "objective") qs.set("objectiveId", item.resourceId);
  if (item.resourceType === "source") qs.set("sourceId", item.resourceId);
  if (item.resourceType === "maintenance") qs.set("windowId", item.resourceId);
  if (item.resourceType === "notification" && item.action === "notification.delivery_failed") qs.set("deliveryId", item.resourceId);
  addDetailParam(qs, item, "eventId");
  addDetailParam(qs, item, "edgeId");
  addDetailParam(qs, item, "incidentId");
  addDetailParam(qs, item, "alertId");
  addDetailParam(qs, item, "deliveryId");
  addDetailParam(qs, item, "windowId");
  addDetailParam(qs, item, "taskId");
  addDetailParam(qs, item, "objectiveId");
  addDetailParam(qs, item, "issueId");
  addDetailParam(qs, item, "workspacePath");
  addDetailParam(qs, item, "agentId");
  addDetailParam(qs, item, "collectorId");
  addDetailParam(qs, item, "sourceId");
  return qs;
}

function hasEvidenceScope(params: URLSearchParams) {
  return ["auditId", "edgeId", "eventId", "incidentId", "alertId", "deliveryId", "windowId", "taskId", "objectiveId", "issueId", "workspacePath", "agentId", "collectorId", "sourceId"].some((key) => params.has(key));
}

function ResourceLinks({ item, timeType }: { item: AuditListItem; timeType: SecurityTimeType }) {
  const qs = new URLSearchParams();
  if (item.resourceType === "incident") {
    qs.set("incidentId", item.resourceId);
    addOperationalScopeParams(qs, item);
    addDetailParam(qs, item, "traceId");
    addDetailParam(qs, item, "eventId");
  }
  if (item.resourceType === "alert") {
    qs.set("alertId", item.resourceId);
    addOperationalScopeParams(qs, item);
    addDetailParam(qs, item, "incidentId");
    addDetailParam(qs, item, "eventId");
    addDetailParam(qs, item, "taskId");
    addDetailParam(qs, item, "objectiveId");
    addDetailParam(qs, item, "issueId");
  }
  if (item.resourceType === "remediation") {
    const sourceType = detailText(item, "sourceType");
    const ingestionSourceId = detailText(item, "ingestionSourceId");
    qs.set("taskId", item.resourceId);
    addDetailParam(qs, item, "incidentId");
    addDetailParam(qs, item, "alertId");
    addDetailParam(qs, item, "eventId");
    addDetailParam(qs, item, "objectiveId");
    addDetailParam(qs, item, "issueId");
    if (sourceType) qs.set("sourceType", sourceType);
    if (ingestionSourceId) qs.set("sourceId", ingestionSourceId);
    else if (sourceType !== "coverage") addDetailParam(qs, item, "sourceId");
    addDetailParam(qs, item, "workspacePath");
    addDetailParam(qs, item, "agentId");
    addDetailParam(qs, item, "collectorId");
  }
  if (item.resourceType === "agent") {
    const agentId = detailText(item, "agentId");
    const workspacePath = detailText(item, "workspacePath");
    if (agentId) qs.set("agentId", agentId);
    if (workspacePath) qs.set("workspacePath", workspacePath);
    if (!agentId) qs.set("q", item.resourceId);
  }
  if (item.resourceType === "maintenance") {
    qs.set("windowId", item.resourceId);
    addDetailParam(qs, item, "targetType");
    addDetailParam(qs, item, "targetId");
  }
  if (item.resourceType === "notification") {
    const deliveryId = detailText(item, "deliveryId");
    const alertId = detailText(item, "alertId");
    const channelId = detailText(item, "channelId");
    const routeId = detailText(item, "routeId");
    const alertKind = detailText(item, "alertKind");
    if (deliveryId) qs.set("deliveryId", deliveryId);
    if (alertId) qs.set("alertId", alertId);
    if (alertKind) qs.set("kind", alertKind);
    addDetailParam(qs, item, "incidentId");
    addDetailParam(qs, item, "eventId");
    addDetailParam(qs, item, "taskId");
    addDetailParam(qs, item, "objectiveId");
    addDetailParam(qs, item, "issueId");
    addDetailParam(qs, item, "minSeverity");
    addDetailParam(qs, item, "workspacePath");
    addDetailParam(qs, item, "agentId");
    addDetailParam(qs, item, "collectorId");
    addDetailParam(qs, item, "sourceId");
    addDetailParam(qs, item, "owner");
    addDetailParam(qs, item, "team");
    if (channelId) qs.set("channelId", channelId);
    else if (routeId) qs.set("routeId", routeId);
    else if (item.action === "notification.channel.updated") qs.set("channelId", item.resourceId);
    else if (item.action === "notification.route.updated") qs.set("routeId", item.resourceId);
    else if (item.action === "notification.delivery_failed") qs.set("deliveryId", item.resourceId);
    else qs.set("q", item.resourceId);
  }
  if (item.resourceType === "objective") {
    qs.set("objectiveId", item.resourceId);
    addDetailParam(qs, item, "targetType");
    addDetailParam(qs, item, "targetId");
    addDetailParam(qs, item, "metric");
  }
  if (item.resourceType === "source") {
    qs.set("sourceId", item.resourceId);
    addDetailParam(qs, item, "collectorId");
    addDetailParam(qs, item, "workspacePath");
  }

  const href =
    item.resourceType === "policy" ? "/admin/policy" :
    item.resourceType === "agent" ? `/agents?${qs.toString()}` :
    item.resourceType === "maintenance" ? `/maintenance?${qs.toString()}` :
    item.resourceType === "notification" ? `/notifications?${qs.toString()}` :
    item.resourceType === "objective" ? `/objectives?${qs.toString()}` :
    item.resourceType === "source" ? `/sources?${qs.toString()}` :
    item.resourceType === "incident" ? `/incidents?${qs.toString()}` :
    item.resourceType === "alert" ? `/alerts?${qs.toString()}` :
    `/remediation?${qs.toString()}`;
  const evidenceQs = evidenceParamsForAudit(item, timeType);
  const evidenceHref = hasEvidenceScope(evidenceQs) ? `/evidence?${evidenceQs.toString()}` : undefined;

  return (
    <>
      <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
        <Link to={href}>
          <Search className="size-3.5" />
          关联资源
        </Link>
      </Button>
      {evidenceHref ? (
        <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
          <Link to={evidenceHref}>
            <FileText className="size-3.5" />
            证据包
          </Link>
        </Button>
      ) : null}
    </>
  );
}

function AuditDetail({ item, timeType }: { item?: AuditListItem; timeType: SecurityTimeType }) {
  if (!item) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一条审计记录</div>
      </section>
    );
  }

  const details = Object.entries(item.details ?? {});

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {iconForResource(item.resourceType)}
          <h2 className="truncate text-sm font-semibold text-zinc-100">{item.summary}</h2>
        </div>
        <Pill className={toneByResult(item.result)}>{item.result}</Pill>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Audit ID" value={item.auditId} />
          <FieldValue label="Action" value={item.action} />
          <FieldValue label="Resource" value={`${item.resourceType}:${item.resourceId}`} />
          <FieldValue label="Actor" value={item.actor.displayName ?? item.actor.id} />
          <FieldValue label="Actor Type" value={item.actor.type} />
          <FieldValue label="Source IP" value={item.actor.sourceIp} />
          <FieldValue label="At" value={formatDate(item.at)} />
          <FieldValue label="User Agent" value={item.actor.userAgent} />
          <FieldValue label="Schema" value={item.schemaVersion} />
        </div>

        {details.length ? (
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 flex items-center gap-2">
              <TerminalSquare className="size-4 text-teal-200" />
              <h3 className="text-sm font-semibold text-zinc-100">Details</h3>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {details.map(([key, value]) => (
                <FieldValue key={key} label={key} value={detailValue(value)} />
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <ResourceLinks item={item} timeType={timeType} />
        </div>
      </div>
    </section>
  );
}

export default function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [action, setAction] = useState<AuditAction | "all">((searchParams.get("action") as AuditAction) || "all");
  const [resourceType, setResourceType] = useState<AuditResourceType | "all">((searchParams.get("resourceType") as AuditResourceType) || "all");
  const [resourceId, setResourceId] = useState(searchParams.get("resourceId") ?? "");
  const [actorId, setActorId] = useState(searchParams.get("actorId") ?? "");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedAuditId, setSelectedAuditId] = useState(searchParams.get("auditId") ?? "");

  const query = useMemo<AuditQuery>(() => ({
    timeType,
    auditId: clean(selectedAuditId),
    action,
    resourceType,
    resourceId: clean(resourceId),
    actorId: clean(actorId),
    q: clean(queryText),
    limit: 250,
  }), [action, actorId, queryText, resourceId, resourceType, selectedAuditId, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.auditLog(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedItem = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.auditId === selectedAuditId) ?? items[0];
  }, [data, selectedAuditId]);

  const selectAudit = (item: AuditListItem) => {
    setSelectedAuditId(item.auditId);
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("auditId", item.auditId);
    next.set("action", item.action);
    next.set("resourceType", item.resourceType);
    next.set("resourceId", item.resourceId);
    next.set("actorId", item.actor.id);
    if (clean(queryText)) next.set("q", queryText.trim());
    setSearchParams(next);
  };

  const clearFilters = () => {
    setAction("all");
    setResourceType("all");
    setResourceId("");
    setActorId("");
    setQueryText("");
    setSelectedAuditId("");
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
                <History className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">审计日志</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Policy · Incident · Alert · Remediation</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" />
              {data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}
            </span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-[120px_150px_150px_minmax(140px,1fr)_minmax(120px,0.8fr)_minmax(180px,1.2fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={action} onValueChange={(next) => setAction(next as AuditAction | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{ACTION_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={resourceType} onValueChange={(next) => setResourceType(next as AuditResourceType | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{RESOURCE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="resourceId exact" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={actorId} onChange={(event) => setActorId(event.target.value)} placeholder="actorId exact" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="actor / resource / summary" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
            <MetricTile label="审计记录" value={data?.summary.totalRecords ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="策略动作" value={data?.summary.policyActions ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="Agent 管理" value={data?.summary.agentActions ?? 0} tone="border-violet-400/25 bg-violet-500/10 text-violet-100" />
            <MetricTile label="维护窗口" value={data?.summary.maintenanceActions ?? 0} tone="border-indigo-400/25 bg-indigo-500/10 text-indigo-100" />
            <MetricTile label="通知动作" value={data?.summary.notificationActions ?? 0} tone="border-cyan-400/25 bg-cyan-500/10 text-cyan-100" />
            <MetricTile label="监控目标" value={data?.summary.objectiveActions ?? 0} tone="border-lime-400/25 bg-lime-500/10 text-lime-100" />
            <MetricTile label="接入源" value={data?.summary.sourceActions ?? 0} tone="border-emerald-400/25 bg-emerald-500/10 text-emerald-100" />
            <MetricTile label="Incident" value={data?.summary.incidentActions ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(620px,1fr)_minmax(0,1.1fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <ScrollText className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Audit</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 条` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载审计...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无审计记录</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((item) => (
                    <AuditRow
                      key={item.auditId}
                      item={item}
                      active={item.auditId === selectedItem?.auditId}
                      onSelect={() => selectAudit(item)}
                    />
                  ))}
                </div>
              )}
            </section>

            <AuditDetail item={selectedItem} timeType={timeType} />
          </div>
        </div>
      </main>
    </div>
  );
}
