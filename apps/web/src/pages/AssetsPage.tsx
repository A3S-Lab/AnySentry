import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Box,
  Ban,
  Clock3,
  Database,
  FileText,
  Layers3,
  ListFilter,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { OperationalEmptyState } from "@/components/custom/operational-empty-state";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { assetHref, assetsHref } from "@/lib/asset-routes";
import {
  type AgentClassification,
  type ObservedAsset,
  type ObservedAssetDetail,
  type ObservedAssetList,
  type ObservedAssetListQuery,
  type ObservationCoverageInterval,
  type SubjectAssetType,
  securityCenterApi,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const CLASSIFICATION_LABEL: Record<AgentClassification, string> = {
  confirmed_agent: "已确认 Agent",
  probable_agent: "候选 Agent",
  unknown: "待识别",
  non_agent: "已排除",
};

const TYPE_LABEL: Record<SubjectAssetType, string> = {
  agent: "Agent",
  service: "服务",
  infrastructure: "基础设施",
  workload: "工作负载",
  ephemeral_process: "临时进程",
};

const OBSERVATION_LABEL: Record<ObservedAsset["observationState"], string> = {
  full: "完整",
  structural: "结构",
  aggregate: "聚合",
  sample: "采样",
  suppressed: "常规明细已抑制",
  degraded: "降级",
  gap: "缺口",
};

const TABS = [
  { value: "all", label: "全部" },
  { value: "agent", label: "Agent" },
  { value: "service", label: "服务与基础设施" },
  { value: "unknown", label: "待识别" },
  { value: "excluded", label: "已排除" },
] as const;
type AssetTab = (typeof TABS)[number]["value"];

const SERVICE_ASSET_TYPES = ["service", "infrastructure", "workload"] as const satisfies readonly SubjectAssetType[];
type ServiceAssetType = (typeof SERVICE_ASSET_TYPES)[number];
type ServiceAssetCursor = Record<ServiceAssetType, string | null>;

function encodeServiceCursor(cursor: ServiceAssetCursor): string {
  return JSON.stringify(cursor);
}

function decodeServiceCursor(cursor?: string): ServiceAssetCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as Partial<ServiceAssetCursor>;
    if (!SERVICE_ASSET_TYPES.every((type) => parsed[type] === null || typeof parsed[type] === "string")) return undefined;
    return parsed as ServiceAssetCursor;
  } catch {
    return undefined;
  }
}

function mergeAssets(...groups: ObservedAsset[][]): ObservedAsset[] {
  return [...new Map(groups.flat().map((asset) => [asset.subjectAssetId, asset])).values()]
    .sort((left, right) => left.subjectAssetId.localeCompare(right.subjectAssetId));
}

async function readAssetPage(
  query: ObservedAssetListQuery,
  tab: AssetTab,
  cursor?: string,
): Promise<ObservedAssetList> {
  if (tab !== "service") return securityCenterApi.observedAssets({ ...query, cursor });

  const previous = decodeServiceCursor(cursor);
  const activeTypes = SERVICE_ASSET_TYPES.filter((type) => previous?.[type] !== null);
  const pages = await Promise.all(activeTypes.map(async (type) => ({
    type,
    page: await securityCenterApi.observedAssets({
      ...query,
      subjectAssetType: type,
      cursor: previous?.[type] ?? undefined,
    }),
  })));
  const first = pages[0]?.page;
  if (!first) throw new Error("服务与基础设施分页状态已结束，请刷新目录");

  const next = Object.fromEntries(SERVICE_ASSET_TYPES.map((type) => {
    const page = pages.find((candidate) => candidate.type === type)?.page;
    return [type, page ? page.nextCursor ?? null : previous?.[type] ?? null];
  })) as ServiceAssetCursor;
  const hasMore = SERVICE_ASSET_TYPES.some((type) => next[type] !== null);
  const reasons = [...new Set(pages.flatMap(({ page }) => page.readStatus.reasons))];
  return {
    ...first,
    items: mergeAssets(...pages.map(({ page }) => page.items)),
    total: pages.reduce((total, { page }) => total + page.total, 0),
    nextCursor: hasMore ? encodeServiceCursor(next) : undefined,
    snapshotRevision: Math.max(...pages.map(({ page }) => page.snapshotRevision)),
    readStatus: {
      ...first.readStatus,
      partial: pages.some(({ page }) => page.readStatus.partial),
      reasons,
      modelRevision: Math.max(...pages.map(({ page }) => page.readStatus.modelRevision)),
      reconciledAt: pages.map(({ page }) => page.readStatus.reconciledAt).sort().at(-1) ?? first.readStatus.reconciledAt,
    },
    updateTime: pages.map(({ page }) => page.updateTime).sort().at(-1) ?? first.updateTime,
  };
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function classificationClass(value: AgentClassification) {
  if (value === "confirmed_agent") return "border-emerald-400/25 bg-emerald-500/10 text-emerald-100";
  if (value === "probable_agent") return "border-amber-400/25 bg-amber-500/10 text-amber-100";
  if (value === "non_agent") return "border-slate-500/30 bg-slate-500/10 text-slate-300";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function assetIcon(asset: ObservedAsset) {
  if (asset.subjectAssetType === "agent") return Bot;
  if (asset.subjectAssetType === "service") return Server;
  if (asset.subjectAssetType === "infrastructure") return Database;
  if (asset.subjectAssetType === "workload") return Box;
  return Activity;
}

function Field({ label, value, mono = false }: { label: string; value?: string | number; mono?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 border-b border-[#232a37] py-2.5 last:border-b-0">
      <p className="text-[11px] text-[#818a9c]">{t(label)}</p>
      <p className={cn("mt-1 break-words text-sm text-[#e8ecf3]", mono && "font-mono text-xs")} title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function queryForTab(tab: AssetTab): Pick<ObservedAssetListQuery, "subjectAssetType" | "identity"> {
  if (tab === "agent") return { subjectAssetType: "agent" };
  if (tab === "unknown") return { identity: "unknown" };
  if (tab === "excluded") return { identity: "non_agent" };
  return {};
}

function AssetRow({ asset, active, query }: { asset: ObservedAsset; active: boolean; query: URLSearchParams }) {
  const { t } = useI18n();
  const Icon = assetIcon(asset);
  return (
    <Link
      to={assetHref(asset.subjectAssetId, query)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "grid min-h-16 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[#232a37] px-3 py-2.5 text-left transition-colors",
        active ? "bg-[#1c222d] shadow-[inset_2px_0_0_#f97316]" : "hover:bg-[#151a23]",
      )}
    >
      <span className="flex size-8 items-center justify-center rounded-md border border-[#2e3645] bg-[#151a23] text-[#818a9c]"><Icon className="size-4" /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-[#e8ecf3]" title={asset.displayName}>{asset.displayName}</span>
        <span className="mt-1 block truncate text-[11px] text-[#818a9c]">{t(TYPE_LABEL[asset.subjectAssetType])} · {asset.role.role.replaceAll("_", " ")} · {asset.bindingQuality}</span>
      </span>
      <span className="text-right">
        <span className={cn("inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold", classificationClass(asset.identity.classification))}>{t(CLASSIFICATION_LABEL[asset.identity.classification])}</span>
        <span className="mt-1 block font-mono text-[10px] text-[#5b6373]">{asset.eventSummary.eventCount} {t("事件")}</span>
      </span>
    </Link>
  );
}

function CoverageMatrix({ interval }: { interval?: ObservationCoverageInterval }) {
  const { t } = useI18n();
  const signals = interval ? Object.entries(interval.signalCoverage) : [];
  return (
    <section className="border-t border-[#232a37] px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[#e8ecf3]">{t("当前观测覆盖")}</h3>
          <p className="mt-1 text-xs leading-5 text-[#818a9c]">{t("说明这段时间实际保留了哪些信号；抑制不等于资产停止运行。")}</p>
        </div>
        {interval ? <span className="rounded border border-[#2e3645] bg-[#151a23] px-2 py-1 text-[11px] text-[#b6bdcc]">{interval.captureProfile}</span> : null}
      </div>
      {!interval ? (
        <p className="mt-3 rounded-md border border-amber-400/20 bg-amber-500/5 px-3 py-3 text-xs leading-5 text-amber-100">{t("当前没有可验证的 Coverage Interval。平台会保持 partial，不会假装该资产健康或完全可见。")}</p>
      ) : (
        <div className="mt-3 grid gap-px overflow-hidden rounded-md border border-[#232a37] bg-[#232a37] sm:grid-cols-3 xl:grid-cols-6">
          {signals.map(([signal, coverage]) => <div key={signal} className="bg-[#0f131a] px-3 py-2.5"><p className="text-[10px] uppercase tracking-wide text-[#697386]">{signal}</p><p className="mt-1 text-xs font-semibold text-[#d6dbe5]">{coverage}</p></div>)}
        </div>
      )}
    </section>
  );
}

function AssetDetail({
  detail,
  loading,
  onRefresh,
}: {
  detail?: ObservedAssetDetail;
  loading: boolean;
  onRefresh: () => Promise<unknown> | void;
}) {
  const { t } = useI18n();
  const assetId = detail?.asset.subjectAssetId ?? "";
  const [reviewReason, setReviewReason] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewNotice, setReviewNotice] = useState("");
  const { data: reviewImpact, loading: reviewImpactLoading, refresh: refreshImpact } = useRequest(
    () => securityCenterApi.observedAssetReviewImpact(assetId),
    { ready: Boolean(assetId && detail?.asset.subjectAssetType !== "agent"), refreshDeps: [assetId] },
  );
  const submitReview = async (decision: "non_agent" | "unknown" | "clear") => {
    if (!reviewImpact || !reviewReason.trim()) return;
    setReviewSaving(true);
    setReviewError("");
    setReviewNotice("");
    try {
      const result = await securityCenterApi.reviewObservedAsset(assetId, {
        decision,
        expectedReviewRevision: reviewImpact.reviewRevision,
        expectedBindingRevision: reviewImpact.bindingRevision,
        reason: reviewReason.trim(),
      });
      setReviewNotice(
        decision === "clear"
          ? t("已恢复自动识别；历史审核和观测缺口保持不变。")
          : decision === "non_agent"
            ? t("已标记为非 Agent；常规信号是否在 Ring 前降低仍由独立规则审批决定。")
            : t("已设为待确认；这不会恢复自动识别。"),
      );
      if (!result.review.durable) setReviewError(t("审核已在当前 API 生效，但持久化存储不可用；重启前请恢复 PostgreSQL。"));
      setReviewReason("");
      await onRefresh();
      refreshImpact();
    } catch (error) {
      setReviewError(error instanceof Error ? t(error.message) : t("资产审核失败"));
    } finally {
      setReviewSaving(false);
    }
  };
  if (loading && !detail) return <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-[#818a9c]"><LoaderCircle className="size-4 animate-spin" />{t("正在读取资产事实")}</div>;
  if (!detail) {
    return <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center"><Layers3 className="size-7 text-[#5b6373]" /><p className="mt-3 text-sm font-medium text-[#b6bdcc]">{t("选择一个资产查看当前事实")}</p><p className="mt-1 max-w-md text-xs leading-5 text-[#818a9c]">{t("资产、Runtime、身份与观测覆盖独立展示；缺失数据会明确标记 partial。")}</p></div>;
  }
  const asset = detail.asset;
  const Icon = assetIcon(asset);
  const eventsQuery = new URLSearchParams({ subjectAssetId: asset.subjectAssetId, scope: "raw", classificationView: "current_effective", includeUnknown: "true" });
  const currentCoverage = [...detail.observationCoverage].reverse().find((item) => item.state === "active");
  const recentFacts = detail.lifecycleFacts.slice(-30).reverse();
  const explainRules = new URLSearchParams({ view: "asset", mode: "explain", assetId: asset.subjectAssetId });
  const createRule = new URLSearchParams({ mode: "new", draftKind: "infrastructure", assetId: asset.subjectAssetId });
  return (
    <div className="min-h-0">
      <div className="flex flex-col gap-3 border-b border-[#232a37] px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="size-4 text-[#f97316]" /><span className="text-xs font-semibold text-[#818a9c]">{t(TYPE_LABEL[asset.subjectAssetType])}</span>
            <span className={cn("inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold", classificationClass(asset.identity.classification))}>{t(CLASSIFICATION_LABEL[asset.identity.classification])}</span>
            <span className="rounded border border-[#2e3645] px-2 py-0.5 text-[10px] text-[#b6bdcc]">{t("观测")}：{t(OBSERVATION_LABEL[asset.observationState])}</span>
          </div>
          <h2 className="mt-2 break-words text-lg font-semibold text-[#f4f6fa]">{asset.displayName}</h2>
          <p className="mt-1 font-mono text-[11px] text-[#697386]">{asset.subjectAssetId}</p>
          <p className="mt-2 text-xs leading-5 text-[#818a9c]">{t("当前资产口径")} · review r{detail.reviewRevision} · binding r{detail.assetBindingRevision}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm" className="min-h-11 border border-[#2e3645] bg-[#151a23] text-[#e8ecf3] hover:bg-[#1c222d] sm:min-h-9"><Link to={`/filter-rules?${explainRules.toString()}`}><ListFilter className="size-3.5" />{t("解释过滤规则")}</Link></Button>
          <Button asChild variant="secondary" size="sm" className="min-h-11 border border-[#2e3645] bg-[#151a23] text-[#e8ecf3] hover:bg-[#1c222d] sm:min-h-9"><Link to={`/events?${eventsQuery.toString()}`}><FileText className="size-3.5" />{t("查看关联事件")}</Link></Button>
        </div>
      </div>

      {detail.readStatus.partial ? <div className="border-b border-amber-400/15 bg-amber-500/5 px-4 py-2 text-xs leading-5 text-amber-100">{t("当前视图为部分数据：")}{detail.readStatus.reasons.join(" / ")}{t("。资产仍可能运行，不能把缺少明细解释为没有行为。")}</div> : null}

      <div className="grid gap-0 px-4 py-2 md:grid-cols-2 md:gap-x-6">
        <Field label="当前身份" value={t(CLASSIFICATION_LABEL[asset.identity.classification])} /><Field label="工作负载角色" value={asset.role.role} />
        <Field label="资产存在状态" value={asset.existenceState} /><Field label="观测状态" value={t(OBSERVATION_LABEL[asset.observationState])} />
        <Field label="绑定质量" value={`${asset.bindingQuality} · r${asset.bindingRevision}`} /><Field label="采集档位" value={asset.captureProfile} />
        <Field label="Workspace" value={asset.scope.workspacePath} /><Field label="位置" value={[asset.scope.clusterId, asset.scope.namespace, asset.scope.ownerName, asset.scope.hostId].filter(Boolean).join(" / ")} />
        <Field label="首次发现" value={formatDate(asset.firstSeenAt)} /><Field label="最近 Inventory" value={formatDate(asset.lastInventoryAt)} />
        <Field label="最近活动" value={formatDate(asset.lastActivityAt)} /><Field label="事件窗口" value={asset.eventSummary.eventCount} />
      </div>

      <section className="border-t border-[#232a37] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[#e8ecf3]">{t("身份审核与影响")}</h3>
            <p className="mt-1 text-xs leading-5 text-[#818a9c]">{t("审核修改当前资产身份，不改写历史 verdict，也不等同于直接修改 Ring 前规则。")}</p>
          </div>
          <AdminTokenControl compact />
        </div>
        {asset.subjectAssetType === "agent" ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#2e3645] bg-[#151a23] px-3 py-3">
            <p className="text-xs leading-5 text-[#b6bdcc]">{t("Agent 资产继续使用强身份键审核流程，避免统一资产的通用操作绕过 Agent recall 保护。")}</p>
            <Button asChild size="sm" className="min-h-11 bg-[#f97316] text-white hover:bg-[#fb8128] sm:min-h-9"><Link to={`/agents?selectedAgentAssetId=${encodeURIComponent(asset.subjectAssetId)}&focus=review`}>{t("打开 Agent 审核")}</Link></Button>
          </div>
        ) : reviewImpactLoading ? (
          <p className="mt-3 text-xs text-[#818a9c]">{t("正在计算当前绑定与规则影响…")}</p>
        ) : !reviewImpact ? (
          <p className="mt-3 rounded-md border border-rose-400/20 bg-rose-500/5 px-3 py-3 text-xs text-rose-100">{t("无法读取审核影响。请检查管理 Token 与资产绑定状态。")}</p>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="grid gap-px overflow-hidden rounded-md border border-[#232a37] bg-[#232a37] sm:grid-cols-4">
              <div className="bg-[#0f131a] px-3 py-2"><p className="text-[10px] text-[#697386]">{t("绑定")}</p><p className="mt-1 text-xs text-[#d6dbe5]">{reviewImpact.bindingQuality}</p></div>
              <div className="bg-[#0f131a] px-3 py-2"><p className="text-[10px] text-[#697386]">{t("活动实例")}</p><p className="mt-1 text-xs text-[#d6dbe5]">{reviewImpact.runtimeInstances}</p></div>
              <div className="bg-[#0f131a] px-3 py-2"><p className="text-[10px] text-[#697386]">{t("当前窗口事件")}</p><p className="mt-1 text-xs text-[#d6dbe5]">{reviewImpact.recentWindowEvents}</p></div>
              <div className="bg-[#0f131a] px-3 py-2"><p className="text-[10px] text-[#697386]">{t("命中规则")}</p><p className="mt-1 text-xs text-[#d6dbe5]">{reviewImpact.matchedRules}</p></div>
            </div>
            <p className="text-xs leading-5 text-amber-100">{t(reviewImpact.warning)}</p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm" className="min-h-11 border border-cyan-400/20 bg-cyan-500/5 text-cyan-100 hover:bg-cyan-500/10 sm:min-h-9"><Link to={`/filter-rules?${explainRules.toString()}`}><ListFilter className="size-3.5" />{t("查找并复用全局规则")}</Link></Button>
              {reviewImpact.canReview ? <Button asChild variant="secondary" size="sm" className="min-h-11 border border-[#2e3645] bg-[#151a23] text-[#d6dbe5] hover:bg-[#1c222d] sm:min-h-9"><Link to={`/filter-rules?${createRule.toString()}`}><Plus className="size-3.5" />{t("创建安全规则草稿")}</Link></Button> : null}
            </div>
            {!reviewImpact.canReview ? <p className="rounded-md border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-100">{t("当前不能长期审核：")}{reviewImpact.reasons.join(" / ")}</p> : (
              <>
                <Input value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder={t("填写审核原因（必填）")} className="min-h-11 border-[#2e3645] bg-[#151a23] text-sm" />
                <div className="flex flex-wrap gap-2">
                  {reviewImpact.actions.markNonAgent ? <Button type="button" variant="secondary" size="sm" disabled={reviewSaving || !reviewReason.trim()} onClick={() => void submitReview("non_agent")} className="min-h-11 border border-slate-400/20 bg-slate-500/10 text-slate-200 hover:bg-slate-500/20 sm:min-h-9"><Ban className="size-3.5" />{t("标记为非 Agent")}</Button> : null}
                  {reviewImpact.actions.setPending ? <Button type="button" variant="secondary" size="sm" disabled={reviewSaving || !reviewReason.trim()} onClick={() => void submitReview("unknown")} className="min-h-11 border border-[#2e3645] bg-[#151a23] text-[#d6dbe5] hover:bg-[#1c222d] sm:min-h-9">{t("设为待确认")}</Button> : null}
                  {reviewImpact.actions.restoreAutomatic ? <Button type="button" size="sm" disabled={reviewSaving || !reviewReason.trim()} onClick={() => void submitReview("clear")} className="min-h-11 bg-[#f97316] text-white hover:bg-[#fb8128] sm:min-h-9"><RotateCcw className="size-3.5" />{t("恢复自动识别")}</Button> : null}
                </div>
              </>
            )}
            {reviewNotice ? <p className="rounded-md border border-emerald-400/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-100">{reviewNotice}</p> : null}
            {reviewError ? <p className="rounded-md border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-100">{reviewError}</p> : null}
          </div>
        )}
      </section>

      <section className="border-t border-[#232a37] px-4 py-4">
        <h3 className="text-sm font-semibold text-[#e8ecf3]">{t("Runtime 实例")}</h3>
        {detail.runtimes.length === 0 ? <p className="mt-2 text-xs text-[#818a9c]">{t("暂无可信 Runtime；不会根据事件沉默推断退出。")}</p> : (
          <div className="mt-3 overflow-hidden rounded-md border border-[#232a37]">
            {detail.runtimes.slice(0, 20).map((runtime) => <div key={runtime.runtimeInstanceId} className="grid gap-2 border-b border-[#232a37] px-3 py-2.5 last:border-b-0 sm:grid-cols-[120px_minmax(0,1fr)_160px]"><span className="text-xs font-semibold text-[#d6dbe5]">{runtime.state}</span><span className="truncate font-mono text-[11px] text-[#818a9c]" title={runtime.runtimeInstanceId}>{runtime.runtimeInstanceId}</span><span className="text-[11px] text-[#697386]">{formatDate(runtime.updatedAt)}</span></div>)}
          </div>
        )}
      </section>

      <CoverageMatrix interval={currentCoverage} />

      <section className="border-t border-[#232a37] px-4 py-4">
        <h3 className="text-sm font-semibold text-[#e8ecf3]">{t("生命周期与规则边界")}</h3>
        {recentFacts.length === 0 ? <p className="mt-2 text-xs text-[#818a9c]">{t("暂无低频生命周期事实。")}</p> : (
          <div className="mt-3 border-l border-[#343c4b] pl-4">
            {recentFacts.map((fact) => <div key={fact.factId} className="relative border-b border-[#232a37] py-3 last:border-b-0"><span className="absolute -left-[19px] top-4 size-2 rounded-full border border-[#f97316] bg-[#0f131a]" /><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold text-[#d6dbe5]">{fact.factKind.replaceAll("_", " ")}</span><span className="font-mono text-[10px] text-[#697386]">{formatDate(fact.effectiveAt)}</span></div><p className="mt-1 text-[11px] leading-5 text-[#818a9c]">{fact.reasonCode}{fact.nextState ? ` → ${fact.nextState}` : ""}</p></div>)}
          </div>
        )}
      </section>
    </div>
  );
}

export default function AssetsPage() {
  const { t } = useI18n();
  const { assetId = "" } = useParams<{ assetId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const requestedTab = searchParams.get("view");
  const tab = (TABS.some((item) => item.value === requestedTab) ? requestedTab : "all") as AssetTab;
  const commonQuery = useMemo(() => { const params = new URLSearchParams(searchParams); params.delete("selectedAgentAssetId"); params.delete("agentAssetId"); return params; }, [searchParams]);
  const listQuery = useMemo<ObservedAssetListQuery>(() => ({ ...queryForTab(tab), q: queryText.trim() || undefined, limit: 200 }), [queryText, tab]);
  const paginationKey = useMemo(() => JSON.stringify({ tab, ...listQuery }), [listQuery, tab]);
  const { data: listResponse, loading, error, refresh } = useRequest(async () => ({
    key: paginationKey,
    page: await readAssetPage(listQuery, tab),
  }), { refreshDeps: [listQuery, paginationKey, tab], pollingInterval: 10000, pollingWhenHidden: false });
  const data = listResponse?.key === paginationKey ? listResponse.page : undefined;
  const [pagination, setPagination] = useState<{ key: string; snapshotRevision: number; items: ObservedAsset[]; nextCursor?: string }>();
  const [loadMoreState, setLoadMoreState] = useState<{ key: string; loading: boolean; error?: string }>({ key: paginationKey, loading: false });
  const { data: detail, loading: detailLoading, error: detailError, refresh: refreshDetail } = useRequest(() => securityCenterApi.observedAsset(assetId), { ready: Boolean(assetId), refreshDeps: [assetId], pollingInterval: 10000, pollingWhenHidden: false });
  const paginated = Boolean(data && pagination?.key === paginationKey && pagination.snapshotRevision === data.snapshotRevision);
  const visibleItems = paginated ? pagination!.items : data?.items ?? [];
  const nextCursor = paginated ? pagination?.nextCursor : data?.nextCursor;
  const selectedFromList = visibleItems.find((item) => item.subjectAssetId === assetId);
  const selectedId = detail?.asset.subjectAssetId ?? selectedFromList?.subjectAssetId;

  const loadMore = async () => {
    if (!data || !nextCursor || loadMoreState.loading) return;
    setLoadMoreState({ key: paginationKey, loading: true });
    try {
      const page = await readAssetPage(listQuery, tab, nextCursor);
      const currentItems = paginated ? pagination!.items : data.items;
      setPagination({
        key: paginationKey,
        snapshotRevision: data.snapshotRevision,
        items: mergeAssets(currentItems, page.items),
        nextCursor: page.nextCursor,
      });
      setLoadMoreState({ key: paginationKey, loading: false });
    } catch (cause) {
      setLoadMoreState({
        key: paginationKey,
        loading: false,
        error: cause instanceof Error ? t(cause.message) : t("加载更多资产失败"),
      });
    }
  };
  const refreshDirectory = () => {
    setPagination(undefined);
    setLoadMoreState({ key: paginationKey, loading: false });
    refresh();
  };

  const applySearch = () => { const next = new URLSearchParams(searchParams); if (queryText.trim()) next.set("q", queryText.trim()); else next.delete("q"); setSearchParams(next, { replace: true }); };
  const selectTab = (value: AssetTab) => { const next = new URLSearchParams(searchParams); next.set("view", value); next.delete("q"); setQueryText(""); setSearchParams(next, { replace: true }); };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0a0d12] text-[#e8ecf3]">
      <header className="shrink-0 border-b border-[#232a37] bg-[#0f131a] px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="min-h-11 shrink-0 border border-[#2e3645] bg-[#151a23] text-[#e8ecf3] hover:bg-[#1c222d] sm:min-h-9"><Link to="/"><ArrowLeft className="size-3.5" />{t("返回")}</Link></Button>
            <div className="min-w-0"><div className="flex items-center gap-2"><Layers3 className="size-5 shrink-0 text-[#f97316]" /><h1 className="truncate text-lg font-semibold">{t("资产与身份")}</h1></div><p className="mt-0.5 truncate text-xs text-[#818a9c]">{t("当前资产口径 · 资产、Runtime、身份、角色与观测状态独立")}</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-[#2e3645] bg-[#151a23] px-3 sm:min-h-9 sm:min-w-64"><Search className="size-3.5 shrink-0 text-[#818a9c]" /><Input value={queryText} onChange={(event) => setQueryText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applySearch(); }} placeholder={t("搜索资产、服务或位置")} className="h-11 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 sm:h-8" /></div>
            <Button type="button" variant="secondary" size="sm" onClick={applySearch} className="min-h-11 border border-[#2e3645] bg-[#151a23] text-[#e8ecf3] hover:bg-[#1c222d] sm:min-h-9">{t("搜索")}</Button>
            <Button type="button" size="sm" onClick={refreshDirectory} disabled={loading} className="min-h-11 bg-[#f97316] text-white hover:bg-[#fb8128] sm:min-h-9">{loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{t("刷新")}</Button>
          </div>
        </div>
        <div className="mt-3 flex gap-1 overflow-x-auto border-t border-[#232a37] pt-2" aria-label={t("资产分类")}>
          {TABS.map((item) => <button key={item.value} type="button" onClick={() => selectTab(item.value)} className={cn("min-h-11 min-w-11 shrink-0 rounded px-3 text-xs font-medium sm:min-h-9 sm:min-w-0", tab === item.value ? "bg-[#272d38] text-[#f4f6fa] shadow-[inset_0_-2px_0_#f97316]" : "text-[#818a9c] hover:bg-[#151a23] hover:text-[#d6dbe5]")}>{t(item.label)}</button>)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#818a9c]">
          <span>{data ? `${data.total} ${t("个资产")}` : t("正在读取资产")}</span><span>Agent {data?.summary.byType.agent ?? "--"} · {t("服务")} {data?.summary.byType.service ?? "--"} · {t("基础设施")} {data?.summary.byType.infrastructure ?? "--"} · {t("工作负载")} {data?.summary.byType.workload ?? "--"} · {t("待识别")} {data?.summary.byIdentity.unknown ?? "--"} · {t("已排除")} {data?.summary.byIdentity.non_agent ?? "--"}</span><span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{data?.updateTime ? formatDate(data.updateTime) : t("等待刷新")}</span>{data?.readStatus.partial ? <span className="text-amber-200">partial: {data.readStatus.reasons.slice(0, 3).join(" / ")}</span> : null}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        <div className="mx-auto grid h-full w-full max-w-[1680px] gap-3 lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
          <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-md border border-[#232a37] bg-[#0f131a]", assetId && "hidden lg:flex")}>
            <div className="flex min-h-12 items-center justify-between border-b border-[#232a37] px-3"><h2 className="text-sm font-semibold">{t("资产目录")}</h2><span className="text-xs text-[#818a9c]">{data ? `${visibleItems.length}/${data.total}` : "--"}</span></div>
            {loading && !data ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[#818a9c]"><LoaderCircle className="size-4 animate-spin" />{t("加载资产目录")}</div> : error ? <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center"><AlertTriangle className="size-5 text-rose-300" /><p className="mt-2 text-sm text-rose-200">{t("资产目录加载失败")}</p><p className="mt-1 text-xs text-[#818a9c]">{t(error.message || "请检查 API 与采集链路")}</p></div> : visibleItems.length === 0 ? <OperationalEmptyState icon={Layers3} title={t("当前没有匹配资产")} description={t("清除搜索条件，或检查 Collector、Inventory 和接入源。")} primary={{ label: t("检查采集链路"), href: "/collectors" }} /> : <div className="min-h-0 flex-1 overflow-y-auto">{visibleItems.map((asset) => <AssetRow key={asset.subjectAssetId} asset={asset} active={asset.subjectAssetId === selectedId} query={commonQuery} />)}{nextCursor ? <div className="flex flex-col items-center gap-2 border-t border-[#232a37] px-3 py-3"><Button type="button" variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadMoreState.key === paginationKey && loadMoreState.loading} className="min-h-11 w-full border border-[#2e3645] bg-[#151a23] text-[#e8ecf3] hover:bg-[#1c222d]">{loadMoreState.key === paginationKey && loadMoreState.loading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}{t("加载更多资产")}</Button><span className="text-[11px] text-[#697386]">{t("已加载")} {visibleItems.length} / {t("服务端")} {data?.total ?? visibleItems.length}</span></div> : null}{loadMoreState.key === paginationKey && loadMoreState.error ? <p className="border-t border-rose-400/15 bg-rose-500/5 px-3 py-2 text-xs text-rose-100">{t(loadMoreState.error)}</p> : null}</div>}
          </section>

          <section className={cn("min-h-0 overflow-hidden rounded-md border border-[#232a37] bg-[#0f131a]", !assetId && "hidden lg:block")}>
            {assetId ? <div className="flex min-h-12 items-center border-b border-[#232a37] px-3 lg:hidden"><Link to={assetsHref(commonQuery)} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#b6bdcc]"><ArrowLeft className="size-4" />{t("返回资产目录")}</Link></div> : null}
            {detailError && !detail ? <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center"><AlertTriangle className="size-5 text-rose-300" /><p className="mt-2 text-sm text-rose-200">{t("未能读取指定资产")}</p><p className="mt-1 text-xs text-[#818a9c]">{t("该资产可能已合并、过期，或不在当前访问范围。")}</p></div> : <div className="h-full overflow-y-auto"><AssetDetail detail={detail} loading={detailLoading} onRefresh={async () => { refresh(); refreshDetail(); }} /></div>}
          </section>
        </div>
      </main>
    </div>
  );
}
