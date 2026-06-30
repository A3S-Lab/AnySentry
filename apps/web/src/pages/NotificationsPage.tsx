import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  Clock3,
  FileText,
  LoaderCircle,
  Megaphone,
  RefreshCw,
  Route,
  Save,
  Send,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AlertKind,
  type NotificationChannelItem,
  type NotificationConfigQuery,
  type NotificationDeliveryItem,
  type NotificationRouteItem,
  type SecuritySeverity,
  type SecurityTimeType,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const SEVERITY_OPTIONS: Array<{ value: SecuritySeverity | "unset"; label: string }> = [
  { value: "unset", label: "任意等级" },
  { value: "critical", label: "严重及以上" },
  { value: "high", label: "高及以上" },
  { value: "medium", label: "中及以上" },
  { value: "low", label: "低及以上" },
  { value: "info", label: "全部" },
];

const KIND_OPTIONS: Array<{ value: AlertKind; label: string }> = [
  { value: "incident", label: "Incident" },
  { value: "collector", label: "Collector" },
  { value: "agent", label: "Agent" },
  { value: "event", label: "Event" },
  { value: "source", label: "Source" },
  { value: "coverage", label: "Coverage" },
  { value: "objective", label: "Objective" },
  { value: "remediation", label: "Remediation" },
];

const ROUTE_SEVERITY_FILTER_OPTIONS: Array<{ value: SecuritySeverity | "all"; label: string }> = [
  { value: "all", label: "全部等级" },
  { value: "critical", label: "严重" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
  { value: "info", label: "信息" },
];

const DEFAULT_DELIVERY_LIMIT = "80";
const NOTIFICATION_EVIDENCE_TIME_TYPE: SecurityTimeType = "last_30d";
type NotificationSearchKey =
  | "channelId"
  | "routeId"
  | "kind"
  | "minSeverity"
  | "workspacePath"
  | "agentId"
  | "collectorId"
  | "sourceId"
  | "owner"
  | "team"
  | "deliveryId"
  | "alertId"
  | "incidentId"
  | "eventId"
  | "taskId"
  | "objectiveId"
  | "issueId"
  | "limit";

function clean(value: string) {
  return value.trim() || undefined;
}

function deliveryLimitValue(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_DELIVERY_LIMIT;
  return String(Math.max(1, Math.min(300, Math.round(parsed))));
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function splitList(value: string) {
  return [...new Set(value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function shortId(value?: string) {
  if (!value) return "--";
  return value.length > 24 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

function deliveryRelation(item: NotificationDeliveryItem) {
  return [
    item.incidentId ? `incident:${shortId(item.incidentId)}` : undefined,
    item.eventId ? `event:${shortId(item.eventId)}` : undefined,
    item.taskId ? `task:${shortId(item.taskId)}` : undefined,
    item.objectiveId ? `objective:${shortId(item.objectiveId)}` : undefined,
    item.issueId ? `coverage:${shortId(item.issueId)}` : undefined,
  ].filter(Boolean).join(" · ");
}

function statusTone(status?: string) {
  if (status === "ok") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (status === "error") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
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

interface ChannelDraft {
  name: string;
  webhookUrl: string;
  enabled: boolean;
  description: string;
}

interface RouteDraft {
  name: string;
  enabled: boolean;
  channelIds: string;
  minSeverity: SecuritySeverity | "";
  kinds: string;
  workspacePath: string;
  agentId: string;
  collectorId: string;
  sourceId: string;
  owner: string;
  team: string;
  q: string;
  description: string;
}

interface RouteFilterDraft {
  kind: AlertKind | "";
  minSeverity: SecuritySeverity | "";
  workspacePath: string;
  agentId: string;
  collectorId: string;
  sourceId: string;
  owner: string;
  team: string;
}

function channelDraft(item?: NotificationChannelItem): ChannelDraft {
  return {
    name: item?.name ?? "",
    webhookUrl: "",
    enabled: item?.enabled ?? true,
    description: item?.description ?? "",
  };
}

function routeDraft(item?: NotificationRouteItem): RouteDraft {
  return {
    name: item?.name ?? "",
    enabled: item?.enabled ?? true,
    channelIds: item?.channelIds.join(", ") ?? "",
    minSeverity: item?.minSeverity ?? "",
    kinds: item?.kinds.join(", ") ?? "",
    workspacePath: item?.workspacePath ?? "",
    agentId: item?.agentId ?? "",
    collectorId: item?.collectorId ?? "",
    sourceId: item?.sourceId ?? "",
    owner: item?.owner ?? "",
    team: item?.team ?? "",
    q: item?.q ?? "",
    description: item?.description ?? "",
  };
}

function isSeverity(value: string | null): value is SecuritySeverity {
  return value === "info" || value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isAlertKind(value: string | null): value is AlertKind {
  return KIND_OPTIONS.some((option) => option.value === value);
}

function routeDraftFromParams(params: URLSearchParams): RouteDraft {
  const draft = routeDraft();
  const sourceId = params.get("sourceId") ?? "";
  const collectorId = params.get("collectorId") ?? "";
  const agentId = params.get("agentId") ?? "";
  const workspacePath = params.get("workspacePath") ?? "";
  const owner = params.get("owner") ?? "";
  const team = params.get("team") ?? "";
  const channelId = params.get("channelId") ?? "";
  const kind = params.get("kind");
  const minSeverity = params.get("minSeverity");
  if (channelId) draft.channelIds = channelId;
  if (owner) {
    draft.name = `Owner alerts · ${owner}`;
    draft.owner = owner;
    draft.minSeverity = isSeverity(minSeverity) ? minSeverity : "high";
  }
  if (team) {
    draft.name = `Team alerts · ${team}`;
    draft.team = team;
    draft.minSeverity = isSeverity(minSeverity) ? minSeverity : "high";
  }
  if (sourceId) {
    draft.name = `Source alerts · ${sourceId}`;
    draft.sourceId = sourceId;
    draft.kinds = isAlertKind(kind) ? kind : "source";
    draft.minSeverity = isSeverity(minSeverity) ? minSeverity : "medium";
  } else if (collectorId) {
    draft.name = `Collector alerts · ${collectorId}`;
    draft.collectorId = collectorId;
    draft.kinds = "collector";
    draft.minSeverity = isSeverity(minSeverity) ? minSeverity : "high";
  } else if (agentId) {
    draft.name = `Agent alerts · ${agentId}`;
    draft.agentId = agentId;
    draft.kinds = "agent";
    draft.minSeverity = isSeverity(minSeverity) ? minSeverity : "high";
  } else if (workspacePath) {
    draft.name = `Workspace alerts · ${workspacePath}`;
    draft.workspacePath = workspacePath;
    draft.minSeverity = isSeverity(minSeverity) ? minSeverity : "high";
  } else if (kind && KIND_OPTIONS.some((option) => option.value === kind)) {
    draft.kinds = kind;
    draft.minSeverity = isSeverity(minSeverity) ? minSeverity : "";
  }
  return draft;
}

function routeFilterDraftFromParams(params: URLSearchParams): RouteFilterDraft {
  const kind = params.get("kind");
  const minSeverity = params.get("minSeverity");
  return {
    kind: isAlertKind(kind) ? kind : "",
    minSeverity: isSeverity(minSeverity) ? minSeverity : "",
    workspacePath: params.get("workspacePath") ?? "",
    agentId: params.get("agentId") ?? "",
    collectorId: params.get("collectorId") ?? "",
    sourceId: params.get("sourceId") ?? "",
    owner: params.get("owner") ?? "",
    team: params.get("team") ?? "",
  };
}

function routeScope(item: NotificationRouteItem) {
  const scope = [
    item.workspacePath ? `ws:${item.workspacePath}` : undefined,
    item.agentId ? `agent:${item.agentId}` : undefined,
    item.collectorId ? `collector:${item.collectorId}` : undefined,
    item.sourceId ? `source:${item.sourceId}` : undefined,
    item.owner ? `owner:${item.owner}` : undefined,
    item.team ? `team:${item.team}` : undefined,
    item.q ? `q:${item.q}` : undefined,
  ].filter(Boolean);
  return scope.length ? scope.join(" · ") : "all targets";
}

function alertHref(item: NotificationDeliveryItem) {
  const params = new URLSearchParams({ alertId: item.alertId, kind: item.alertKind });
  if (item.workspacePath) params.set("workspacePath", item.workspacePath);
  if (item.agentId) params.set("agentId", item.agentId);
  if (item.collectorId) params.set("collectorId", item.collectorId);
  if (item.sourceId) params.set("sourceId", item.sourceId);
  return `/alerts?${params.toString()}`;
}

function addNotificationScopeParams(params: URLSearchParams, item: Pick<NotificationDeliveryItem | NotificationRouteItem, "workspacePath" | "agentId" | "collectorId" | "sourceId">) {
  if (item.workspacePath) params.set("workspacePath", item.workspacePath);
  if (item.agentId) params.set("agentId", item.agentId);
  if (item.collectorId) params.set("collectorId", item.collectorId);
  if (item.sourceId) params.set("sourceId", item.sourceId);
}

function deliveryEvidenceHref(item: NotificationDeliveryItem) {
  const params = new URLSearchParams({ timeType: NOTIFICATION_EVIDENCE_TIME_TYPE, deliveryId: item.deliveryId, alertId: item.alertId });
  if (item.incidentId) params.set("incidentId", item.incidentId);
  if (item.eventId) params.set("eventId", item.eventId);
  if (item.taskId) params.set("taskId", item.taskId);
  if (item.objectiveId) params.set("objectiveId", item.objectiveId);
  if (item.issueId) params.set("issueId", item.issueId);
  addNotificationScopeParams(params, item);
  return `/evidence?${params.toString()}`;
}

function routeEvidenceHref(item: NotificationRouteItem) {
  const params = new URLSearchParams({ timeType: NOTIFICATION_EVIDENCE_TIME_TYPE });
  addNotificationScopeParams(params, item);
  return params.toString() === `timeType=${NOTIFICATION_EVIDENCE_TIME_TYPE}` ? undefined : `/evidence?${params.toString()}`;
}

function ChannelRow({ item, active, onSelect }: { item: NotificationChannelItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("grid w-full grid-cols-[minmax(0,1fr)_90px_82px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]", active && "bg-teal-400/8")}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={item.name}>{item.name}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={item.endpointPreview}>{item.endpointPreview ?? item.channelId}</span>
      </span>
      <span><Pill className={item.enabled ? "border-teal-400/30 bg-teal-500/10 text-teal-100" : "border-white/10 bg-white/5 text-zinc-300"}>{item.enabled ? "启用" : "禁用"}</Pill></span>
      <span><Pill className={statusTone(item.lastStatus)}>{item.lastStatus ?? "not_sent"}</Pill></span>
    </button>
  );
}

function RouteRow({ item, active, onSelect }: { item: NotificationRouteItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("grid w-full grid-cols-[minmax(0,1fr)_94px_76px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]", active && "bg-teal-400/8")}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={item.name}>{item.name}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={routeScope(item)}>
          {item.minSeverity ?? "any"} · {item.kinds.length ? item.kinds.join(",") : "all"} · {routeScope(item)} · {item.channelIds.length} channels
        </span>
      </span>
      <span><Pill className="border-cyan-400/30 bg-cyan-500/10 text-cyan-100">{item.minSeverity ?? "any"}</Pill></span>
      <span><Pill className={item.enabled ? "border-teal-400/30 bg-teal-500/10 text-teal-100" : "border-white/10 bg-white/5 text-zinc-300"}>{item.enabled ? "启用" : "禁用"}</Pill></span>
    </button>
  );
}

function DeliveryRow({ item, active }: { item: NotificationDeliveryItem; active: boolean }) {
  const relation = deliveryRelation(item);
  return (
    <div
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_76px_84px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05] sm:grid-cols-[minmax(0,1fr)_112px_96px_76px_84px]",
        active && "bg-violet-400/8",
      )}
    >
      <Link to={alertHref(item)} className="min-w-0 rounded-sm transition hover:text-teal-100">
        <span className="block truncate text-sm font-medium text-zinc-100" title={item.alertTitle}>{item.alertTitle}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={`${item.deliveryId} / ${item.alertId}${relation ? ` / ${relation}` : ""}`}>
          {item.action} · {item.alertKind}:{shortId(item.alertId)}{relation ? ` · ${relation}` : ""} · {item.routeName ?? item.routeId ?? "fallback"} · {item.channelName}
        </span>
      </Link>
      <span className="hidden truncate font-mono text-[11px] text-zinc-600 sm:block" title={item.endpointPreview ?? item.channelId}>
        {item.endpointPreview ?? item.channelId}
      </span>
      <span className="hidden truncate font-mono text-[11px] text-zinc-500 sm:block">{formatDate(item.sentAt)}</span>
      <span className="flex justify-end"><Pill className={statusTone(item.status)}>{item.status}</Pill></span>
      <span className="flex justify-end">
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 px-2 text-zinc-100 hover:bg-white/10">
          <Link to={deliveryEvidenceHref(item)}>
            <FileText className="size-3.5" />
            证据包
          </Link>
        </Button>
      </span>
    </div>
  );
}

export default function NotificationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedChannelId, setSelectedChannelId] = useState(searchParams.get("channelId") ?? "");
  const [selectedRouteId, setSelectedRouteId] = useState(searchParams.get("routeId") ?? "");
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(searchParams.get("deliveryId") ?? "");
  const [deliveryAlertId, setDeliveryAlertId] = useState(searchParams.get("alertId") ?? "");
  const [deliveryIncidentId, setDeliveryIncidentId] = useState(searchParams.get("incidentId") ?? "");
  const [deliveryEventId, setDeliveryEventId] = useState(searchParams.get("eventId") ?? "");
  const [deliveryTaskId, setDeliveryTaskId] = useState(searchParams.get("taskId") ?? "");
  const [deliveryObjectiveId, setDeliveryObjectiveId] = useState(searchParams.get("objectiveId") ?? "");
  const [deliveryIssueId, setDeliveryIssueId] = useState(searchParams.get("issueId") ?? "");
  const [deliveryLimit, setDeliveryLimit] = useState(deliveryLimitValue(searchParams.get("limit") ?? DEFAULT_DELIVERY_LIMIT));
  const [channel, setChannel] = useState<ChannelDraft>(() => channelDraft());
  const [route, setRoute] = useState<RouteDraft>(() => routeDraftFromParams(searchParams));
  const [routeFilters, setRouteFilters] = useState<RouteFilterDraft>(() => routeFilterDraftFromParams(searchParams));
  const [savingChannel, setSavingChannel] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  const routeKindFilter = isAlertKind(searchParams.get("kind")) ? searchParams.get("kind")! : "";
  const routeSeverityFilter = isSeverity(searchParams.get("minSeverity")) ? searchParams.get("minSeverity")! : "";
  const routeWorkspacePathFilter = searchParams.get("workspacePath") ?? "";
  const routeAgentIdFilter = searchParams.get("agentId") ?? "";
  const routeCollectorIdFilter = searchParams.get("collectorId") ?? "";
  const routeSourceIdFilter = searchParams.get("sourceId") ?? "";
  const routeOwnerFilter = searchParams.get("owner") ?? "";
  const routeTeamFilter = searchParams.get("team") ?? "";

  const notificationQuery = useMemo<NotificationConfigQuery>(() => ({
    channelId: clean(selectedChannelId),
    routeId: clean(selectedRouteId),
    kind: routeKindFilter || undefined,
    minSeverity: routeSeverityFilter || undefined,
    workspacePath: clean(routeWorkspacePathFilter),
    agentId: clean(routeAgentIdFilter),
    collectorId: clean(routeCollectorIdFilter),
    sourceId: clean(routeSourceIdFilter),
    owner: clean(routeOwnerFilter),
    team: clean(routeTeamFilter),
    deliveryId: clean(selectedDeliveryId),
    alertId: clean(deliveryAlertId),
    incidentId: clean(deliveryIncidentId),
    eventId: clean(deliveryEventId),
    taskId: clean(deliveryTaskId),
    objectiveId: clean(deliveryObjectiveId),
    issueId: clean(deliveryIssueId),
    limit: Number(deliveryLimitValue(deliveryLimit)),
  }), [deliveryAlertId, deliveryEventId, deliveryIncidentId, deliveryIssueId, deliveryLimit, deliveryObjectiveId, deliveryTaskId, routeAgentIdFilter, routeCollectorIdFilter, routeKindFilter, routeOwnerFilter, routeSeverityFilter, routeSourceIdFilter, routeTeamFilter, routeWorkspacePathFilter, selectedChannelId, selectedDeliveryId, selectedRouteId]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.notificationConfig(notificationQuery), {
    refreshDeps: [notificationQuery],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedChannel = useMemo(() => (data?.channels ?? []).find((item) => item.channelId === selectedChannelId), [data, selectedChannelId]);
  const selectedRoute = useMemo(() => (data?.routes ?? []).find((item) => item.routeId === selectedRouteId), [data, selectedRouteId]);
  const routeFilterActive = Boolean(routeKindFilter || routeSeverityFilter || routeWorkspacePathFilter || routeAgentIdFilter || routeCollectorIdFilter || routeSourceIdFilter || routeOwnerFilter || routeTeamFilter);
  const deliveryFilterActive = Boolean(selectedDeliveryId || deliveryAlertId || deliveryIncidentId || deliveryEventId || deliveryTaskId || deliveryObjectiveId || deliveryIssueId);

  const updateSearch = (overrides: Partial<Record<NotificationSearchKey, string>>) => {
    const values = {
      channelId: selectedChannelId,
      routeId: selectedRouteId,
      kind: routeKindFilter,
      minSeverity: routeSeverityFilter,
      workspacePath: routeWorkspacePathFilter,
      agentId: routeAgentIdFilter,
      collectorId: routeCollectorIdFilter,
      sourceId: routeSourceIdFilter,
      owner: routeOwnerFilter,
      team: routeTeamFilter,
      deliveryId: selectedDeliveryId,
      alertId: deliveryAlertId,
      incidentId: deliveryIncidentId,
      eventId: deliveryEventId,
      taskId: deliveryTaskId,
      objectiveId: deliveryObjectiveId,
      issueId: deliveryIssueId,
      limit: deliveryLimit,
      ...overrides,
    };
    const channelId = values.channelId ?? "";
    const routeId = values.routeId ?? "";
    const kind = values.kind ?? "";
    const minSeverity = values.minSeverity ?? "";
    const workspacePath = values.workspacePath ?? "";
    const agentId = values.agentId ?? "";
    const collectorId = values.collectorId ?? "";
    const sourceId = values.sourceId ?? "";
    const owner = values.owner ?? "";
    const team = values.team ?? "";
    const deliveryId = values.deliveryId ?? "";
    const alertId = values.alertId ?? "";
    const incidentId = values.incidentId ?? "";
    const eventId = values.eventId ?? "";
    const taskId = values.taskId ?? "";
    const objectiveId = values.objectiveId ?? "";
    const issueId = values.issueId ?? "";
    const next = new URLSearchParams();
    if (channelId.trim()) next.set("channelId", channelId.trim());
    if (routeId.trim()) next.set("routeId", routeId.trim());
    if (isAlertKind(kind.trim())) next.set("kind", kind.trim());
    if (isSeverity(minSeverity.trim())) next.set("minSeverity", minSeverity.trim());
    if (workspacePath.trim()) next.set("workspacePath", workspacePath.trim());
    if (agentId.trim()) next.set("agentId", agentId.trim());
    if (collectorId.trim()) next.set("collectorId", collectorId.trim());
    if (sourceId.trim()) next.set("sourceId", sourceId.trim());
    if (owner.trim()) next.set("owner", owner.trim());
    if (team.trim()) next.set("team", team.trim());
    if (deliveryId.trim()) next.set("deliveryId", deliveryId.trim());
    if (alertId.trim()) next.set("alertId", alertId.trim());
    if (incidentId.trim()) next.set("incidentId", incidentId.trim());
    if (eventId.trim()) next.set("eventId", eventId.trim());
    if (taskId.trim()) next.set("taskId", taskId.trim());
    if (objectiveId.trim()) next.set("objectiveId", objectiveId.trim());
    if (issueId.trim()) next.set("issueId", issueId.trim());
    const normalizedLimit = deliveryLimitValue(values.limit ?? DEFAULT_DELIVERY_LIMIT);
    if (normalizedLimit !== DEFAULT_DELIVERY_LIMIT) next.set("limit", normalizedLimit);
    setSearchParams(next);
  };

  useEffect(() => {
    setRouteFilters(routeFilterDraftFromParams(searchParams));
    setSelectedChannelId(searchParams.get("channelId") ?? "");
    setSelectedRouteId(searchParams.get("routeId") ?? "");
    setSelectedDeliveryId(searchParams.get("deliveryId") ?? "");
    setDeliveryAlertId(searchParams.get("alertId") ?? "");
    setDeliveryIncidentId(searchParams.get("incidentId") ?? "");
    setDeliveryEventId(searchParams.get("eventId") ?? "");
    setDeliveryTaskId(searchParams.get("taskId") ?? "");
    setDeliveryObjectiveId(searchParams.get("objectiveId") ?? "");
    setDeliveryIssueId(searchParams.get("issueId") ?? "");
    setDeliveryLimit(deliveryLimitValue(searchParams.get("limit") ?? DEFAULT_DELIVERY_LIMIT));
  }, [searchParams]);

  useEffect(() => {
    if (selectedChannel) setChannel(channelDraft(selectedChannel));
  }, [selectedChannel?.channelId]);

  useEffect(() => {
    if (selectedRoute) setRoute(routeDraft(selectedRoute));
    else if (!selectedRouteId) setRoute(routeDraftFromParams(searchParams));
  }, [selectedRoute?.routeId, selectedRouteId, searchParams]);

  const selectChannel = (item: NotificationChannelItem) => {
    setSelectedChannelId(item.channelId);
    setChannel(channelDraft(item));
    updateSearch({ channelId: item.channelId });
  };

  const selectRoute = (item: NotificationRouteItem) => {
    setSelectedRouteId(item.routeId);
    setRoute(routeDraft(item));
    updateSearch({ routeId: item.routeId });
  };

  const applyRouteFilters = () => {
    const next = {
      kind: routeFilters.kind,
      minSeverity: routeFilters.minSeverity,
      workspacePath: routeFilters.workspacePath.trim(),
      agentId: routeFilters.agentId.trim(),
      collectorId: routeFilters.collectorId.trim(),
      sourceId: routeFilters.sourceId.trim(),
      owner: routeFilters.owner.trim(),
      team: routeFilters.team.trim(),
    };
    setRouteFilters(next);
    updateSearch(next);
  };

  const clearRouteFilters = () => {
    const next = { kind: "", minSeverity: "", workspacePath: "", agentId: "", collectorId: "", sourceId: "", owner: "", team: "" };
    setRouteFilters(next);
    updateSearch(next);
  };

  const applyDeliveryFilters = () => {
    const limit = deliveryLimitValue(deliveryLimit);
    setSelectedDeliveryId(selectedDeliveryId.trim());
    setDeliveryAlertId(deliveryAlertId.trim());
    setDeliveryIncidentId(deliveryIncidentId.trim());
    setDeliveryEventId(deliveryEventId.trim());
    setDeliveryTaskId(deliveryTaskId.trim());
    setDeliveryObjectiveId(deliveryObjectiveId.trim());
    setDeliveryIssueId(deliveryIssueId.trim());
    setDeliveryLimit(limit);
    updateSearch({
      deliveryId: selectedDeliveryId.trim(),
      alertId: deliveryAlertId.trim(),
      incidentId: deliveryIncidentId.trim(),
      eventId: deliveryEventId.trim(),
      taskId: deliveryTaskId.trim(),
      objectiveId: deliveryObjectiveId.trim(),
      issueId: deliveryIssueId.trim(),
      limit,
    });
  };

  const clearDeliveryFilters = () => {
    setSelectedDeliveryId("");
    setDeliveryAlertId("");
    setDeliveryIncidentId("");
    setDeliveryEventId("");
    setDeliveryTaskId("");
    setDeliveryObjectiveId("");
    setDeliveryIssueId("");
    setDeliveryLimit(DEFAULT_DELIVERY_LIMIT);
    updateSearch({ deliveryId: "", alertId: "", incidentId: "", eventId: "", taskId: "", objectiveId: "", issueId: "", limit: DEFAULT_DELIVERY_LIMIT });
  };

  const deliveryRowActive = (item: NotificationDeliveryItem) =>
    item.deliveryId === selectedDeliveryId ||
    item.alertId === deliveryAlertId ||
    item.incidentId === deliveryIncidentId ||
    item.eventId === deliveryEventId ||
    item.taskId === deliveryTaskId ||
    item.objectiveId === deliveryObjectiveId ||
    item.issueId === deliveryIssueId;

  const saveChannel = async () => {
    setSavingChannel(true);
    try {
      const body = {
        name: channel.name || "Webhook",
        type: "webhook" as const,
        enabled: channel.enabled,
        webhookUrl: channel.webhookUrl || undefined,
        description: channel.description,
      };
      const updated = selectedChannelId && selectedChannel && !selectedChannel.readOnly
        ? await securityCenterApi.updateNotificationChannel(selectedChannelId, body)
        : await securityCenterApi.createNotificationChannel(body);
      setSelectedChannelId(updated.channelId);
      setChannel(channelDraft(updated));
      updateSearch({ channelId: updated.channelId });
      await refresh();
    } finally {
      setSavingChannel(false);
    }
  };

  const saveRoute = async () => {
    setSavingRoute(true);
    try {
      const kinds = splitList(route.kinds).filter((kind): kind is AlertKind => KIND_OPTIONS.some((option) => option.value === kind));
      const body = {
        name: route.name || "Alert route",
        enabled: route.enabled,
        channelIds: splitList(route.channelIds),
        minSeverity: route.minSeverity,
        kinds,
        workspacePath: route.workspacePath,
        agentId: route.agentId,
        collectorId: route.collectorId,
        sourceId: route.sourceId,
        owner: route.owner,
        team: route.team,
        q: route.q,
        description: route.description,
      };
      const updated = selectedRouteId
        ? await securityCenterApi.updateNotificationRoute(selectedRouteId, body)
        : await securityCenterApi.createNotificationRoute(body);
      setSelectedRouteId(updated.routeId);
      setRoute(routeDraft(updated));
      updateSearch({ routeId: updated.routeId });
      await refresh();
    } finally {
      setSavingRoute(false);
    }
  };

  const channelOptions = (data?.channels ?? []).filter((item) => !item.readOnly);
  const selectedRouteEvidenceHref = selectedRoute ? routeEvidenceHref(selectedRoute) : undefined;

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
                <Megaphone className="size-5 shrink-0 text-cyan-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">通知路由</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Webhook Channels · Alert Routes</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-8">
            <MetricTile label="通道" value={data?.summary.totalChannels ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="启用通道" value={data?.summary.enabledChannels ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="路由" value={data?.summary.totalRoutes ?? 0} tone="border-cyan-400/25 bg-cyan-500/10 text-cyan-100" />
            <MetricTile label="启用路由" value={data?.summary.enabledRoutes ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="投递" value={data?.summary.totalDeliveries ?? 0} tone="border-violet-400/25 bg-violet-500/10 text-violet-100" />
            <MetricTile label="成功" value={data?.summary.okDeliveries ?? 0} tone="border-emerald-400/25 bg-emerald-500/10 text-emerald-100" />
            <MetricTile label="失败" value={(data?.summary.errorDeliveries ?? 0) + (data?.summary.notSentDeliveries ?? 0)} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="Env Webhook" value={data?.summary.legacyWebhookConfigured ? "on" : "off"} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(460px,0.85fr)_minmax(0,1.15fr)]">
            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <BellRing className="size-4 text-cyan-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Channels</h2>
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={() => { setSelectedChannelId(""); setChannel(channelDraft()); updateSearch({ channelId: "" }); }} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                  新建
                </Button>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500"><LoaderCircle className="mr-2 size-4 animate-spin" />加载通道...</div>
              ) : (data?.channels.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-500"><CheckCircle2 className="size-4 text-teal-300" />暂无通道</div>
              ) : (
                <div className="max-h-[300px] overflow-y-auto">
                  {data?.channels.map((item) => <ChannelRow key={item.channelId} item={item} active={item.channelId === selectedChannelId} onSelect={() => selectChannel(item)} />)}
                </div>
              )}
            </section>

            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <h2 className="text-sm font-semibold text-zinc-100">{selectedChannelId ? "编辑通道" : "新建通道"}</h2>
                {selectedChannel?.readOnly ? <Pill className="border-amber-400/30 bg-amber-500/10 text-amber-100">env</Pill> : null}
              </div>
              <div className="space-y-3 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">名称</span>
                    <Input value={channel.name} onChange={(event) => setChannel((cur) => ({ ...cur, name: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Webhook URL</span>
                    <Input value={channel.webhookUrl} disabled={selectedChannel?.readOnly} onChange={(event) => setChannel((cur) => ({ ...cur, webhookUrl: event.target.value }))} placeholder={selectedChannel ? "留空则保留原地址" : "https://..."} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">描述</span>
                  <Input value={channel.description} disabled={selectedChannel?.readOnly} onChange={(event) => setChannel((cur) => ({ ...cur, description: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={saveChannel} disabled={savingChannel || Boolean(selectedChannel?.readOnly) || (!selectedChannelId && !clean(channel.webhookUrl))} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
                    {savingChannel ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    保存通道
                  </Button>
                  <Button type="button" variant="secondary" disabled={Boolean(selectedChannel?.readOnly)} onClick={() => setChannel((cur) => ({ ...cur, enabled: !cur.enabled }))} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                    {channel.enabled ? "禁用" : "启用"}
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <FieldValue label="Channel ID" value={selectedChannel?.channelId} />
                  <FieldValue label="Endpoint" value={selectedChannel?.endpointPreview} />
                  <FieldValue label="Last Sent" value={formatDate(selectedChannel?.lastSentAt)} />
                </div>
              </div>
            </section>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(460px,0.85fr)_minmax(0,1.15fr)]">
            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Route className="size-4 text-cyan-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Routes</h2>
                  {routeFilterActive ? <Pill className="border-cyan-400/30 bg-cyan-500/10 text-cyan-100">filtered</Pill> : null}
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={() => { setSelectedRouteId(""); setRoute(routeDraftFromParams(searchParams)); updateSearch({ routeId: "" }); }} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                  新建
                </Button>
              </div>
              <div className="grid gap-3 border-b border-white/10 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Alert kind</span>
                    <Select value={routeFilters.kind || "all"} onValueChange={(next) => setRouteFilters((cur) => ({ ...cur, kind: isAlertKind(next) ? next : "" }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部类型</SelectItem>
                        {KIND_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">最低等级</span>
                    <Select value={routeFilters.minSeverity || "all"} onValueChange={(next) => setRouteFilters((cur) => ({ ...cur, minSeverity: isSeverity(next) ? next : "" }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>{ROUTE_SEVERITY_FILTER_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Workspace</span>
                    <Input value={routeFilters.workspacePath} onChange={(event) => setRouteFilters((cur) => ({ ...cur, workspacePath: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") applyRouteFilters(); }} placeholder="workspacePath exact" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Agent</span>
                    <Input value={routeFilters.agentId} onChange={(event) => setRouteFilters((cur) => ({ ...cur, agentId: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") applyRouteFilters(); }} placeholder="agentId exact" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Collector</span>
                    <Input value={routeFilters.collectorId} onChange={(event) => setRouteFilters((cur) => ({ ...cur, collectorId: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") applyRouteFilters(); }} placeholder="collectorId exact" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Source</span>
                    <Input value={routeFilters.sourceId} onChange={(event) => setRouteFilters((cur) => ({ ...cur, sourceId: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") applyRouteFilters(); }} placeholder="sourceId exact" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Owner</span>
                    <Input value={routeFilters.owner} onChange={(event) => setRouteFilters((cur) => ({ ...cur, owner: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") applyRouteFilters(); }} placeholder="owner exact" className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Team</span>
                    <Input value={routeFilters.team} onChange={(event) => setRouteFilters((cur) => ({ ...cur, team: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") applyRouteFilters(); }} placeholder="team exact" className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                </div>
                <div className="flex items-end gap-2">
                  <Button type="button" onClick={applyRouteFilters} className="h-9 bg-cyan-500 text-[#07100c] hover:bg-cyan-400">
                    <RefreshCw className="size-3.5" />
                    应用
                  </Button>
                  <Button type="button" variant="secondary" onClick={clearRouteFilters} disabled={!routeFilterActive} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                    <X className="size-3.5" />
                    清空
                  </Button>
                </div>
              </div>
              {(data?.routes.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无路由</div>
              ) : (
                <div className="max-h-[360px] overflow-y-auto">
                  {data?.routes.map((item) => <RouteRow key={item.routeId} item={item} active={item.routeId === selectedRouteId} onSelect={() => selectRoute(item)} />)}
                </div>
              )}
            </section>

            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <h2 className="text-sm font-semibold text-zinc-100">{selectedRouteId ? "编辑路由" : "新建路由"}</h2>
                <Pill className={route.enabled ? "border-teal-400/30 bg-teal-500/10 text-teal-100" : "border-white/10 bg-white/5 text-zinc-300"}>{route.enabled ? "启用" : "禁用"}</Pill>
              </div>
              <div className="space-y-3 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">名称</span>
                    <Input value={route.name} onChange={(event) => setRoute((cur) => ({ ...cur, name: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">最低等级</span>
                    <Select value={route.minSeverity || "unset"} onValueChange={(next) => setRoute((cur) => ({ ...cur, minSeverity: next === "unset" ? "" : next as SecuritySeverity }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>{SEVERITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">通道 IDs</span>
                    <Input value={route.channelIds} onChange={(event) => setRoute((cur) => ({ ...cur, channelIds: event.target.value }))} placeholder={channelOptions.map((item) => item.channelId).join(", ")} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">Alert kind</span>
                    <Input value={route.kinds} onChange={(event) => setRoute((cur) => ({ ...cur, kinds: event.target.value }))} placeholder={KIND_OPTIONS.map((item) => item.value).join(", ")} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-4">
                  <Input value={route.workspacePath} onChange={(event) => setRoute((cur) => ({ ...cur, workspacePath: event.target.value }))} placeholder="workspacePath" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  <Input value={route.agentId} onChange={(event) => setRoute((cur) => ({ ...cur, agentId: event.target.value }))} placeholder="agentId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  <Input value={route.collectorId} onChange={(event) => setRoute((cur) => ({ ...cur, collectorId: event.target.value }))} placeholder="collectorId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  <Input value={route.sourceId} onChange={(event) => setRoute((cur) => ({ ...cur, sourceId: event.target.value }))} placeholder="sourceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <Input value={route.owner} onChange={(event) => setRoute((cur) => ({ ...cur, owner: event.target.value }))} placeholder="owner" className="h-9 border-white/10 bg-white/5 text-xs" />
                  <Input value={route.team} onChange={(event) => setRoute((cur) => ({ ...cur, team: event.target.value }))} placeholder="team" className="h-9 border-white/10 bg-white/5 text-xs" />
                  <Input value={route.q} onChange={(event) => setRoute((cur) => ({ ...cur, q: event.target.value }))} placeholder="关键字" className="h-9 border-white/10 bg-white/5 text-xs" />
                </div>
                <Input value={route.description} onChange={(event) => setRoute((cur) => ({ ...cur, description: event.target.value }))} placeholder="描述" className="h-9 border-white/10 bg-white/5 text-xs" />
	                <div className="flex flex-wrap items-center gap-2">
	                  <Button type="button" onClick={saveRoute} disabled={savingRoute || splitList(route.channelIds).length === 0} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
	                    {savingRoute ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
	                    保存路由
	                  </Button>
	                  <Button type="button" variant="secondary" onClick={() => setRoute((cur) => ({ ...cur, enabled: !cur.enabled }))} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
	                    {route.enabled ? "禁用" : "启用"}
	                  </Button>
	                  {selectedRouteEvidenceHref ? (
	                    <Button asChild variant="secondary" size="sm" className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
	                      <Link to={selectedRouteEvidenceHref}>
	                        <FileText className="size-3.5" />
	                        证据包
	                      </Link>
	                    </Button>
	                  ) : null}
	                </div>
              </div>
            </section>
          </div>

          <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Send className="size-4 text-violet-200" />
                <h2 className="text-sm font-semibold text-zinc-100">Delivery Log</h2>
                {routeFilterActive ? <Pill className="border-cyan-400/30 bg-cyan-500/10 text-cyan-100">scoped</Pill> : null}
                {deliveryFilterActive ? <Pill className="border-violet-400/30 bg-violet-500/10 text-violet-100">filtered</Pill> : null}
              </div>
              <span className="text-xs text-zinc-500">{data?.deliveries.length ?? 0} 条</span>
            </div>
            <div className="grid gap-3 border-b border-white/10 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_96px_auto]">
              <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Delivery ID</span>
                  <Input value={selectedDeliveryId} onChange={(event) => setSelectedDeliveryId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDeliveryFilters(); }} placeholder="ndl_..." className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Alert ID</span>
                  <Input value={deliveryAlertId} onChange={(event) => setDeliveryAlertId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDeliveryFilters(); }} placeholder="alt_..." className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Incident ID</span>
                  <Input value={deliveryIncidentId} onChange={(event) => setDeliveryIncidentId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDeliveryFilters(); }} placeholder="inc_..." className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Event ID</span>
                  <Input value={deliveryEventId} onChange={(event) => setDeliveryEventId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDeliveryFilters(); }} placeholder="evt_..." className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Task ID</span>
                  <Input value={deliveryTaskId} onChange={(event) => setDeliveryTaskId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDeliveryFilters(); }} placeholder="rem_..." className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Objective ID</span>
                  <Input value={deliveryObjectiveId} onChange={(event) => setDeliveryObjectiveId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDeliveryFilters(); }} placeholder="obj_..." className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Issue ID</span>
                  <Input value={deliveryIssueId} onChange={(event) => setDeliveryIssueId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyDeliveryFilters(); }} placeholder="cov_..." className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                </label>
              </div>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">Limit</span>
                <Input type="number" min={1} max={300} value={deliveryLimit} onChange={(event) => setDeliveryLimit(event.target.value)} onBlur={() => setDeliveryLimit(deliveryLimitValue(deliveryLimit))} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
              </label>
              <div className="flex items-end gap-2">
                <Button type="button" onClick={applyDeliveryFilters} className="h-9 bg-violet-500 text-white hover:bg-violet-400">
                  <RefreshCw className="size-3.5" />
                  应用
                </Button>
                <Button type="button" variant="secondary" onClick={clearDeliveryFilters} disabled={!deliveryFilterActive && deliveryLimitValue(deliveryLimit) === DEFAULT_DELIVERY_LIMIT} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                  <X className="size-3.5" />
                  清空
                </Button>
              </div>
            </div>
            {(data?.deliveries.length ?? 0) === 0 ? (
              <div className="flex min-h-32 items-center justify-center text-sm text-zinc-500">暂无投递记录</div>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                {data?.deliveries.map((item) => <DeliveryRow key={item.deliveryId} item={item} active={deliveryRowActive(item)} />)}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
