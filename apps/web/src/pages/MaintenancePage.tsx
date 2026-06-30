import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  ScrollText,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type MaintenanceStatus,
  type MaintenanceTargetType,
  type MaintenanceWindowItem,
  type MaintenanceWindowQuery,
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

const STATUS_OPTIONS: Array<{ value: MaintenanceStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "生效中" },
  { value: "scheduled", label: "待生效" },
  { value: "expired", label: "已过期" },
  { value: "disabled", label: "已禁用" },
];

type MaintenanceTargetFilter = Exclude<MaintenanceTargetType, "all"> | "all-filter";

const TARGET_OPTIONS: Array<{ value: MaintenanceTargetFilter; label: string }> = [
  { value: "all-filter", label: "全部目标" },
  { value: "workspace", label: "Workspace" },
  { value: "agent", label: "Agent" },
  { value: "collector", label: "Collector" },
  { value: "source", label: "Source" },
];

const TARGET_FORM_OPTIONS: Array<{ value: MaintenanceTargetType; label: string }> = [
  { value: "all", label: "全局" },
  { value: "workspace", label: "Workspace" },
  { value: "agent", label: "Agent" },
  { value: "collector", label: "Collector" },
  { value: "source", label: "Source" },
];

const STATUS_LABEL: Record<MaintenanceStatus, string> = {
  active: "生效中",
  scheduled: "待生效",
  expired: "已过期",
  disabled: "已禁用",
};

const TARGET_LABEL: Record<MaintenanceTargetType, string> = {
  all: "全局",
  workspace: "Workspace",
  agent: "Agent",
  collector: "Collector",
  source: "Source",
};

interface Draft {
  title: string;
  targetType: MaintenanceTargetType;
  targetId: string;
  startAt: string;
  endAt: string;
  enabled: boolean;
  owner: string;
  reason: string;
  note: string;
}

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function toDateTimeLocal(value?: string) {
  const parsed = value ? dayjs(value) : dayjs();
  return parsed.isValid() ? parsed.format("YYYY-MM-DDTHH:mm") : "";
}

function fromDateTimeLocal(value: string) {
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.toISOString() : undefined;
}

function defaultDraft(): Draft {
  const start = dayjs();
  return {
    title: "",
    targetType: "agent",
    targetId: "",
    startAt: start.format("YYYY-MM-DDTHH:mm"),
    endAt: start.add(2, "hour").format("YYYY-MM-DDTHH:mm"),
    enabled: true,
    owner: "",
    reason: "",
    note: "",
  };
}

function isMaintenanceTargetType(value: string | null): value is MaintenanceTargetType {
  return value === "all" || value === "workspace" || value === "agent" || value === "collector" || value === "source";
}

function isMaintenanceTargetFilter(value: string | null): value is MaintenanceTargetFilter {
  return value === "workspace" || value === "agent" || value === "collector" || value === "source";
}

function draftFromParams(params: URLSearchParams): Draft {
  const draft = defaultDraft();
  const rawType = params.get("targetType");
  const targetType = isMaintenanceTargetType(rawType) ? rawType : undefined;
  const targetId = params.get("targetId") ?? params.get("sourceId") ?? "";
  if (!targetType) return draft;
  draft.targetType = targetType;
  draft.targetId = targetType === "all" ? "" : targetId;
  if (targetType === "source" && targetId) {
    draft.title = `Source 维护 · ${targetId}`;
    draft.reason = "接入源维护";
  }
  return draft;
}

function draftFromWindow(item?: MaintenanceWindowItem): Draft {
  if (!item) return defaultDraft();
  return {
    title: item.title,
    targetType: item.targetType,
    targetId: item.targetId === "*" ? "" : item.targetId,
    startAt: toDateTimeLocal(item.startAt),
    endAt: toDateTimeLocal(item.endAt),
    enabled: item.enabled,
    owner: item.owner ?? "",
    reason: item.reason ?? "",
    note: item.note ?? "",
  };
}

function statusTone(status?: MaintenanceStatus) {
  if (status === "active") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (status === "scheduled") return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  if (status === "disabled") return "border-zinc-400/20 bg-zinc-500/10 text-zinc-200";
  return "border-amber-400/30 bg-amber-500/10 text-amber-100";
}

function targetTone(type?: MaintenanceTargetType) {
  if (type === "source") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (type === "collector") return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  if (type === "agent") return "border-violet-400/30 bg-violet-500/10 text-violet-100";
  if (type === "workspace") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-teal-400/30 bg-teal-500/10 text-teal-100";
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

function addMaintenanceTargetScope(params: URLSearchParams, item: MaintenanceWindowItem) {
  if (!item.targetId || item.targetId === "*") return;
  if (item.targetType === "workspace") params.set("workspacePath", item.targetId);
  if (item.targetType === "agent") {
    const scope = splitAgentTargetId(item.targetId);
    if (scope.workspacePath) params.set("workspacePath", scope.workspacePath);
    params.set("agentId", scope.agentId);
  }
  if (item.targetType === "collector") params.set("collectorId", item.targetId);
  if (item.targetType === "source") params.set("sourceId", item.targetId);
}

function splitAgentTargetId(targetId: string) {
  const separator = targetId.lastIndexOf(":");
  if (separator <= 0 || separator >= targetId.length - 1) return { agentId: targetId };
  return {
    workspacePath: targetId.slice(0, separator),
    agentId: targetId.slice(separator + 1),
  };
}

function maintenanceEvidenceHref(item: MaintenanceWindowItem, timeType: SecurityTimeType) {
  const params = new URLSearchParams({ timeType, windowId: item.windowId });
  addMaintenanceTargetScope(params, item);
  return `/evidence?${params.toString()}`;
}

function maintenanceAuditHref(item: MaintenanceWindowItem, timeType: SecurityTimeType) {
  return `/audit?${new URLSearchParams({ timeType, resourceType: "maintenance", resourceId: item.windowId }).toString()}`;
}

function maintenanceTargetHref(item: MaintenanceWindowItem) {
  if (!item.targetId || item.targetId === "*") return undefined;
  if (item.targetType === "workspace") return `/workspaces?${new URLSearchParams({ workspacePath: item.targetId }).toString()}`;
  if (item.targetType === "agent") {
    const scope = splitAgentTargetId(item.targetId);
    const params = new URLSearchParams({ agentId: scope.agentId });
    if (scope.workspacePath) params.set("workspacePath", scope.workspacePath);
    return `/agents?${params.toString()}`;
  }
  if (item.targetType === "collector") return `/collectors?${new URLSearchParams({ collectorId: item.targetId }).toString()}`;
  if (item.targetType === "source") return `/sources?${new URLSearchParams({ sourceId: item.targetId }).toString()}`;
  return undefined;
}

function WindowRow({ item, active, onSelect }: { item: MaintenanceWindowItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_94px_82px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(item.startAt)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={item.title}>{item.title}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={item.targetId}>
          {TARGET_LABEL[item.targetType]} · {item.targetId}
        </span>
      </span>
      <span><Pill className={targetTone(item.targetType)}>{TARGET_LABEL[item.targetType]}</Pill></span>
      <span><Pill className={statusTone(item.status)}>{STATUS_LABEL[item.status]}</Pill></span>
    </button>
  );
}

export default function MaintenancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const routeTargetId = searchParams.get("targetId") ?? searchParams.get("sourceId") ?? "";
  const routeTargetType = searchParams.get("targetType");
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_7d");
  const [status, setStatus] = useState<MaintenanceStatus | "all">((searchParams.get("status") as MaintenanceStatus) || "all");
  const [targetType, setTargetType] = useState<MaintenanceTargetFilter>(isMaintenanceTargetFilter(routeTargetType) ? routeTargetType : "all-filter");
  const [targetIdFilter, setTargetIdFilter] = useState(routeTargetId);
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedWindowId, setSelectedWindowId] = useState(searchParams.get("windowId") ?? "");
  const [draft, setDraft] = useState<Draft>(() => draftFromParams(searchParams));
  const [saving, setSaving] = useState(false);

  const query = useMemo<MaintenanceWindowQuery>(() => ({
    timeType,
    windowId: clean(selectedWindowId),
    status,
    targetType: targetType === "all-filter" ? "all" : targetType,
    targetId: clean(targetIdFilter),
    q: clean(queryText),
    limit: 200,
  }), [queryText, selectedWindowId, status, targetIdFilter, targetType, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.maintenanceWindows(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedWindow = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.windowId === selectedWindowId);
  }, [data, selectedWindowId]);

  useEffect(() => {
    if (selectedWindow) setDraft(draftFromWindow(selectedWindow));
    else if (!selectedWindowId) setDraft(draftFromParams(searchParams));
  }, [selectedWindow?.windowId, selectedWindowId]);

  const selectWindow = (item: MaintenanceWindowItem) => {
    setSelectedWindowId(item.windowId);
    setTargetType(item.targetType === "all" ? "all-filter" : item.targetType);
    setTargetIdFilter(item.targetId);
    setDraft(draftFromWindow(item));
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("windowId", item.windowId);
    next.set("status", item.status);
    next.set("targetType", item.targetType);
    next.set("targetId", item.targetId);
    setSearchParams(next);
  };

  const clearFilters = () => {
    setStatus("all");
    setTargetType("all-filter");
    setTargetIdFilter("");
    setQueryText("");
    setSelectedWindowId("");
    setDraft(defaultDraft());
    setSearchParams({});
  };

  const saveWindow = async () => {
    setSaving(true);
    try {
      const body = {
        title: draft.title || `${TARGET_LABEL[draft.targetType]} 维护`,
        targetType: draft.targetType,
        targetId: draft.targetType === "all" ? "*" : draft.targetId,
        startAt: fromDateTimeLocal(draft.startAt),
        endAt: fromDateTimeLocal(draft.endAt),
        enabled: draft.enabled,
        owner: draft.owner,
        reason: draft.reason,
        note: draft.note,
      };
      const updated = selectedWindowId
        ? await securityCenterApi.updateMaintenanceWindow(selectedWindowId, body)
        : await securityCenterApi.createMaintenanceWindow(body);
      setSelectedWindowId(updated.windowId);
      setDraft(draftFromWindow(updated));
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
                <CalendarClock className="size-5 shrink-0 text-indigo-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">维护窗口</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">计划维护 · 告警抑制 · 覆盖标注</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_140px_minmax(160px,0.7fr)_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={status} onValueChange={(next) => setStatus(next as MaintenanceStatus | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={targetType} onValueChange={(next) => setTargetType(next as MaintenanceTargetFilter)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TARGET_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={targetIdFilter} onChange={(event) => setTargetIdFilter(event.target.value)} placeholder="targetId exact" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="title / owner / reason / keyword" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricTile label="生效中" value={data?.summary.activeWindows ?? 0} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
            <MetricTile label="待生效" value={data?.summary.scheduledWindows ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="已禁用" value={data?.summary.disabledWindows ?? 0} tone="border-zinc-400/20 bg-zinc-500/10 text-zinc-100" />
            <MetricTile label="已过期" value={data?.summary.expiredWindows ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="总数" value={data?.summary.totalWindows ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(540px,1fr)_minmax(0,1.15fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <CalendarClock className="size-4 text-indigo-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Windows</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 条` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载维护窗口...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-500">
                  <CheckCircle2 className="size-4 text-teal-300" />
                  暂无维护窗口
                </div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((item) => (
                    <WindowRow key={item.windowId} item={item} active={item.windowId === selectedWindowId} onSelect={() => selectWindow(item)} />
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Search className="size-4 text-indigo-200" />
                  <h2 className="truncate text-sm font-semibold text-zinc-100">{selectedWindowId ? "编辑维护窗口" : "新建维护窗口"}</h2>
                </div>
                {selectedWindow ? <Pill className={statusTone(selectedWindow.status)}>{STATUS_LABEL[selectedWindow.status]}</Pill> : null}
              </div>

              <div className="space-y-4 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">标题</span>
                    <Input value={draft.title} onChange={(event) => setDraft((cur) => ({ ...cur, title: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">负责人</span>
                    <Input value={draft.owner} onChange={(event) => setDraft((cur) => ({ ...cur, owner: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)]">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">目标类型</span>
                    <Select value={draft.targetType} onValueChange={(next) => setDraft((cur) => ({ ...cur, targetType: next as MaintenanceTargetType, targetId: next === "all" ? "" : cur.targetId }))}>
                      <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
                      <SelectContent>{TARGET_FORM_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">目标 ID</span>
                    <Input
                      value={draft.targetId}
                      disabled={draft.targetType === "all"}
                      onChange={(event) => setDraft((cur) => ({ ...cur, targetId: event.target.value }))}
                      placeholder="agentId / workspacePath / collectorId / sourceId"
                      className="h-9 border-white/10 bg-white/5 font-mono text-xs"
                    />
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">开始</span>
                    <Input type="datetime-local" value={draft.startAt} onChange={(event) => setDraft((cur) => ({ ...cur, startAt: event.target.value }))} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">结束</span>
                    <Input type="datetime-local" value={draft.endAt} onChange={(event) => setDraft((cur) => ({ ...cur, endAt: event.target.value }))} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
                  </label>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">原因</span>
                  <Input value={draft.reason} onChange={(event) => setDraft((cur) => ({ ...cur, reason: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">备注</span>
                  <Input value={draft.note} onChange={(event) => setDraft((cur) => ({ ...cur, note: event.target.value }))} className="h-9 border-white/10 bg-white/5 text-xs" />
                </label>

	                {selectedWindow ? (
	                  <div className="grid gap-3 md:grid-cols-3">
	                    <FieldValue label="Window ID" value={selectedWindow.windowId} />
	                    <FieldValue label="Created" value={formatDate(selectedWindow.createdAt)} />
	                    <FieldValue label="Updated" value={formatDate(selectedWindow.updatedAt)} />
	                  </div>
	                ) : null}

	                {selectedWindow ? (
	                  <div className="flex flex-wrap items-center gap-2">
	                    <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
	                      <Link to={maintenanceEvidenceHref(selectedWindow, timeType)}>
	                        <FileText className="size-3.5" />
	                        证据包
	                      </Link>
	                    </Button>
	                    <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
	                      <Link to={maintenanceAuditHref(selectedWindow, timeType)}>
	                        <ScrollText className="size-3.5" />
	                        审计
	                      </Link>
	                    </Button>
	                    {maintenanceTargetHref(selectedWindow) ? (
	                      <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
	                        <Link to={maintenanceTargetHref(selectedWindow)!}>
	                          <Search className="size-3.5" />
	                          目标
	                        </Link>
	                      </Button>
	                    ) : null}
	                  </div>
	                ) : null}

	                <div className="flex flex-wrap items-center gap-2">
	                  <Button type="button" onClick={saveWindow} disabled={saving || (draft.targetType !== "all" && !clean(draft.targetId))} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
                    {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    保存
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setDraft((cur) => ({ ...cur, enabled: !cur.enabled }))} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                    {draft.enabled ? "禁用" : "启用"}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => { setSelectedWindowId(""); setDraft(defaultDraft()); }} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                    新建
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
