import type {
  AgentClassification,
  AgentEventListItem,
  AgentWorkloadRef,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

export type AgentRuntimeKind = "kubernetes" | "docker" | "local" | "unknown";

export interface ResolvedAgentIdentity {
  name: string;
  classification: AgentClassification;
  classificationLabel: string;
  runtime: AgentRuntimeKind;
  runtimeLabel?: string;
  workload?: AgentWorkloadRef;
}

const GENERIC_DISCOVERY_NAMES = new Set([
  "discovered agent candidate",
  "agent candidate",
  "unknown",
  "unknown agent",
]);

const CLASSIFICATION_META: Record<
  AgentClassification,
  { label: string; nameClassName: string; dotClassName: string; badgeClassName: string }
> = {
  confirmed_agent: {
    label: "已确认 Agent",
    nameClassName: "text-emerald-200",
    dotClassName: "bg-emerald-300",
    badgeClassName: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
  },
  probable_agent: {
    label: "候选 Agent",
    nameClassName: "text-amber-200",
    dotClassName: "bg-amber-300",
    badgeClassName: "border-amber-400/30 bg-amber-500/10 text-amber-100",
  },
  unknown: {
    label: "身份未确认",
    nameClassName: "text-zinc-300",
    dotClassName: "bg-zinc-500",
    badgeClassName: "border-white/10 bg-white/5 text-zinc-400",
  },
  non_agent: {
    label: "非 Agent",
    nameClassName: "text-slate-400",
    dotClassName: "bg-slate-500",
    badgeClassName: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  },
};

const RUNTIME_META: Record<
  Exclude<AgentRuntimeKind, "unknown">,
  { label: string; className: string }
> = {
  kubernetes: {
    label: "K8s",
    className: "border-violet-400/30 bg-violet-500/10 text-violet-200",
  },
  docker: {
    label: "Docker",
    className: "border-sky-400/30 bg-sky-500/10 text-sky-200",
  },
  local: {
    label: "本地服务",
    className: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  },
};

function text(value?: string) {
  return value?.trim() ?? "";
}

function meaningfulName(value?: string) {
  const candidate = text(value);
  return candidate && !GENERIC_DISCOVERY_NAMES.has(candidate.toLowerCase())
    ? candidate
    : "";
}

function basename(value?: string) {
  const candidate = text(value);
  return candidate.split("/").filter(Boolean).at(-1) ?? candidate;
}

function shortWorkloadId(value?: string) {
  const candidate = text(value);
  if (!candidate) return "";
  const last = candidate.split(":").filter(Boolean).at(-1) ?? candidate;
  return last.length > 16 ? last.slice(0, 12) : last;
}

function runtimeKind(event: AgentEventListItem): AgentRuntimeKind {
  const workload = event.attribution?.workloadRef;
  if (workload?.environment === "kubernetes") return "kubernetes";
  if (workload?.environment === "docker") return "docker";
  if (workload?.environment === "host") return "local";

  const source = event.attribution?.source;
  if (source === "kubernetes") return "kubernetes";
  if (source === "docker") return "docker";

  const physical = text(event.attribution?.physicalWorkloadId).toLowerCase();
  if (physical.startsWith("k8s:")) return "kubernetes";
  if (physical.startsWith("docker:")) return "docker";

  const cgroup = text(event.process?.cgroup).toLowerCase();
  if (cgroup.includes("kubepods")) return "kubernetes";
  if (/(?:docker|containerd|crio|libpod)/.test(cgroup)) return "docker";

  if (
    event.process ||
    ["process_graph", "cgroup", "systemd", "argv", "env", "workspace_hint", "process_signature"].includes(
      source ?? "",
    )
  ) {
    return "local";
  }
  return "unknown";
}

function workloadName(event: AgentEventListItem) {
  const attribution = event.attribution;
  const workload = attribution?.workloadRef;
  const displayName = meaningfulName(attribution?.agentDisplayName);
  if (displayName) return displayName;

  const structuredName =
    meaningfulName(workload?.podName) ||
    meaningfulName(workload?.containerName) ||
    meaningfulName(workload?.systemdUnit) ||
    meaningfulName(workload?.name) ||
    meaningfulName(workload?.processName) ||
    basename(workload?.executable);
  if (structuredName) return structuredName;

  const rawAgentName = meaningfulName(event.agentId);
  if (rawAgentName) return rawAgentName;

  const scopeName = meaningfulName(attribution?.agentScopeId);
  if (scopeName && !scopeName.startsWith("discovered-")) return scopeName;

  const workloadId = shortWorkloadId(attribution?.physicalWorkloadId);
  if (workloadId) return `workload-${workloadId}`;

  return scopeName || "未知 Agent";
}

export function resolveAgentIdentity(event: AgentEventListItem): ResolvedAgentIdentity {
  const classification =
    event.attribution?.classification ??
    (event.attribution?.monitored ? "probable_agent" : "unknown");
  const runtime = runtimeKind(event);
  return {
    name: workloadName(event),
    classification,
    classificationLabel: CLASSIFICATION_META[classification].label,
    runtime,
    runtimeLabel: runtime === "unknown" ? undefined : RUNTIME_META[runtime].label,
    workload: event.attribution?.workloadRef,
  };
}

export function AgentIdentityInline({
  event,
  showClassification = false,
  className,
}: {
  event: AgentEventListItem;
  showClassification?: boolean;
  className?: string;
}) {
  const identity = resolveAgentIdentity(event);
  const classification = CLASSIFICATION_META[identity.classification];
  const runtime = identity.runtime === "unknown" ? undefined : RUNTIME_META[identity.runtime];
  const title = [
    identity.name,
    identity.classificationLabel,
    runtime?.label,
    event.attribution?.source ? `来源：${event.attribution.source}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)} title={title}>
      <span className={cn("size-1.5 shrink-0 rounded-full", classification.dotClassName)} />
      <span className={cn("min-w-0 truncate font-semibold", classification.nameClassName)}>
        {identity.name}
        <span className="sr-only">（{identity.classificationLabel}）</span>
      </span>
      {showClassification ? (
        <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", classification.badgeClassName)}>
          {identity.classificationLabel}
        </span>
      ) : null}
      {runtime ? (
        <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", runtime.className)}>
          {runtime.label}
        </span>
      ) : null}
    </span>
  );
}
