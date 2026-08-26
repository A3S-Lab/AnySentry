import { useEffect, useMemo, useRef, useState } from "react";
import { useDebounce, useRequest } from "ahooks";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenCheck,
  Boxes,
  Filter,
  GitBranch,
  LayoutList,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Workflow,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { OperationalEmptyState } from "@/components/custom/operational-empty-state";
import { FilterRuleCategoryTree } from "@/components/filter-rules/filter-rule-category-tree";
import { FilterRuleDetailPanel, type FilterRuleSimulationWindow } from "@/components/filter-rules/filter-rule-detail";
import { FilterRuleExplainPanel } from "@/components/filter-rules/filter-rule-explain";
import { FilterRuleList } from "@/components/filter-rules/filter-rule-list";
import { FilterRuleStageStrip } from "@/components/filter-rules/filter-rule-stage-strip";
import { FilterRuleWizard, type FilterRuleWizardKind } from "@/components/filter-rules/filter-rule-wizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import {
  filterRulesApi,
  type FilterRuleCatalog,
  type FilterRuleCategory,
  type FilterRuleExplain,
  type FilterRuleKind,
  type FilterRulePreview,
  type FilterRuleSimulation,
  type FilterRuleStage,
  type FilterRuleSummary,
} from "@/lib/api/filter-rules";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type FilterRuleView = "category" | "stage" | "asset";

function errorMessage(cause: unknown, fallback: string, t: (source: string) => string) {
  if (cause instanceof ApiError && cause.code === 401) return t("管理密钥未设置或无效；只读目录仍可使用，治理操作前请设置控制面密钥。");
  return cause instanceof Error && cause.message ? t(cause.message) : t(fallback);
}

function validView(value: string | null): FilterRuleView {
  return value === "stage" || value === "asset" ? value : "category";
}

function validStage(value: string | null): FilterRuleStage | undefined {
  return value === "f0" || value === "f1" || value === "f2" || value === "f3" ? value : undefined;
}

function validDraftKind(value: string | null): FilterRuleWizardKind | undefined {
  return value === "runtime_signature" || value === "agent_template" || value === "capture_profile"
    || value === "semantic_retention" || value === "persistence_retention"
    || value === "investigation_override" || value === "infrastructure"
    ? value
    : undefined;
}

const SUCCESSOR_KINDS = new Set<FilterRuleKind>([
  "runtime_signature",
  "agent_template",
  "capture_profile",
  "semantic_retention",
  "persistence_retention",
  "investigation_override",
]);

function FilterRuleExplore({
  result,
  loading,
  error,
  onExplain,
  onExample,
}: {
  result?: FilterRuleExplain;
  loading: boolean;
  error: string;
  onExplain: (type: "event" | "asset", id: string) => void;
  onExample: () => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState<"event" | "asset">("event");
  const [id, setId] = useState("");
  if (result) return <FilterRuleExplainPanel result={result} />;
  return (
    <div className="flex min-h-[520px] flex-col items-center justify-center px-5 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-md border border-cyan-400/20 bg-cyan-500/8 text-cyan-200"><Workflow className="size-6" aria-hidden="true" /></div>
      <h2 className="mt-4 text-base font-semibold text-[#edf1f7]">{t("解释一次真实过滤决策")}</h2>
      <p className="mt-2 max-w-xl text-xs leading-6 text-[#8490a2]">{t("输入 eventId 或 assetId，服务端使用真实 Catalog 和编译器返回 F0→F1→F2→F3 候选、获胜规则与 fail-open 原因。")}</p>
      <div className="mt-5 w-full max-w-xl rounded border border-[#2b3544] bg-[#111720] p-4 text-left">
        <label className="text-[11px] font-semibold text-[#aeb7c5]">{t("解释对象")}</label>
        <div className="mt-2 grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
          <Select value={type} onValueChange={(value) => setType(value as typeof type)}>
            <SelectTrigger className="min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="event">eventId</SelectItem><SelectItem value="asset">assetId</SelectItem></SelectContent>
          </Select>
          <Input value={id} onChange={(event) => setId(event.target.value)} aria-label={type === "event" ? "eventId" : "assetId"} className="min-h-11 border-[#303a49] bg-[#141a23] text-sm" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => onExplain(type, id.trim())} disabled={loading || !id.trim()} className="min-h-11 bg-[#f97316] text-white hover:bg-[#fb8128] sm:min-h-9">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}{t("为什么匹配")}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onExample} disabled={loading} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#dce2eb] hover:bg-[#1d2530] sm:min-h-9"><BookOpenCheck className="size-3.5" />{t("查看 Agent/Infrastructure 冲突案例")}</Button>
        </div>
        {error ? <p role="alert" className="mt-3 rounded border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-100">{error}</p> : null}
      </div>
    </div>
  );
}

export default function FilterRulesPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = validView(searchParams.get("view"));
  const selectedCategory = (searchParams.get("category") || undefined) as FilterRuleCategory | undefined;
  const selectedKind = (searchParams.get("kind") || undefined) as FilterRuleKind | undefined;
  const selectedStage = validStage(searchParams.get("stage"));
  const selectedRuleId = searchParams.get("ruleId") ?? "";
  const newMode = searchParams.get("mode") === "new";
  const explainMode = searchParams.get("mode") === "explain" || view === "asset";
  const exampleRequested = searchParams.get("example") === "agent-infrastructure-conflict";
  const linkedAssetId = searchParams.get("assetId")?.trim() ?? "";
  const initialDraftKind = validDraftKind(searchParams.get("draftKind"));
  const predecessorRuleId = searchParams.get("predecessorRuleId")?.trim() || undefined;
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const debouncedQuery = useDebounce(queryText, { wait: 250 });
  const [catalogItems, setCatalogItems] = useState<FilterRuleSummary[]>([]);
  const [catalogCursor, setCatalogCursor] = useState<string>();
  const [catalogMeta, setCatalogMeta] = useState<FilterRuleCatalog>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [preview, setPreview] = useState<FilterRulePreview>();
  const [simulation, setSimulation] = useState<FilterRuleSimulation>();
  const [simulationWindow, setSimulationWindow] = useState<FilterRuleSimulationWindow>("current");
  const [actionReason, setActionReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [explain, setExplain] = useState<FilterRuleExplain>();
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState("");
  const automaticallyExplainedAsset = useRef("");

  const updateParams = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (debouncedQuery === current) return;
    const next = new URLSearchParams(searchParams);
    if (debouncedQuery) next.set("q", debouncedQuery);
    else next.delete("q");
    next.delete("ruleId");
    setSearchParams(next, { replace: true });
  }, [debouncedQuery, searchParams, setSearchParams]);

  const catalogQuery = useMemo(() => ({
    q: debouncedQuery || undefined,
    category: selectedCategory,
    kind: selectedKind,
    stage: view === "stage" ? selectedStage : undefined,
    limit: 100,
  }), [debouncedQuery, selectedCategory, selectedKind, selectedStage, view]);
  const catalogKey = JSON.stringify(catalogQuery);
  const { data: catalogResponse, loading, error, refresh } = useRequest(async () => ({
    key: catalogKey,
    response: await filterRulesApi.catalog(catalogQuery),
  }), { refreshDeps: [catalogKey], pollingInterval: 15_000, pollingWhenHidden: false });
  useEffect(() => {
    if (!catalogResponse || catalogResponse.key !== catalogKey) return;
    setCatalogItems(catalogResponse.response.items);
    setCatalogCursor(catalogResponse.response.nextCursor);
    setCatalogMeta(catalogResponse.response);
    setLoadMoreError("");
  }, [catalogKey, catalogResponse]);
  const { data: systemStatus, loading: statusLoading, refresh: refreshStatus } = useRequest(filterRulesApi.status, {
    pollingInterval: 10_000,
    pollingWhenHidden: false,
  });
  const { data: linkedExample, loading: linkedExampleLoading, error: linkedExampleError } = useRequest(filterRulesApi.example, {
    ready: exampleRequested,
  });
  const { data: rule, loading: detailLoading, error: detailError, refresh: refreshDetail } = useRequest(
    () => filterRulesApi.detail(selectedRuleId),
    { ready: Boolean(selectedRuleId && !newMode), refreshDeps: [selectedRuleId], pollingInterval: 15_000, pollingWhenHidden: false },
  );

  useEffect(() => {
    setPreview(undefined);
    setSimulation(undefined);
    setActionReason("");
    setActionError("");
  }, [selectedRuleId]);

  const loadMore = async () => {
    if (!catalogCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const page = await filterRulesApi.catalog({ ...catalogQuery, cursor: catalogCursor });
      setCatalogItems((items) => [...new Map([...items, ...page.items].map((item) => [item.ruleId, item])).values()]);
      setCatalogCursor(page.nextCursor);
      setCatalogMeta(page);
    } catch (cause) {
      setLoadMoreError(errorMessage(cause, "加载更多规则失败", t));
    } finally {
      setLoadingMore(false);
    }
  };

  const refreshAll = () => {
    refresh();
    refreshStatus();
    if (selectedRuleId) refreshDetail();
  };

  const runPreview = async () => {
    if (!selectedRuleId) return;
    setActionLoading(true);
    setActionError("");
    try {
      setPreview(await filterRulesApi.preview(selectedRuleId));
    } catch (cause) {
      setActionError(errorMessage(cause, "规则 Preview 失败", t));
    } finally {
      setActionLoading(false);
    }
  };

  const runSimulation = async () => {
    if (!selectedRuleId) return;
    setActionLoading(true);
    setActionError("");
    try {
      setSimulation(await filterRulesApi.simulate({
        ruleId: selectedRuleId,
        ...(simulationWindow === "current" ? {} : { historyWindow: simulationWindow, sampleLimit: 200 }),
      }));
    } catch (cause) {
      setActionError(errorMessage(cause, "规则模拟失败", t));
    } finally {
      setActionLoading(false);
    }
  };

  const transition = async (action: "shadow" | "promote" | "revoke") => {
    if (!rule || !actionReason.trim()) return;
    if (action === "revoke" && !window.confirm(t("确认停用该规则？历史 revision 和审计会保留。"))) return;
    setActionLoading(true);
    setActionError("");
    try {
      await filterRulesApi.transition(rule.ruleId, action, { expectedRevision: rule.revision, reason: actionReason.trim() });
      setActionReason("");
      setPreview(undefined);
      setSimulation(undefined);
      refreshAll();
    } catch (cause) {
      setActionError(errorMessage(cause, `规则 ${action} 失败`, t));
    } finally {
      setActionLoading(false);
    }
  };

  const runExplain = async (type: "event" | "asset", id: string) => {
    setExplainLoading(true);
    setExplainError("");
    try {
      setExplain(await filterRulesApi.explain(type === "event" ? { eventId: id } : { assetId: id }));
    } catch (cause) {
      setExplainError(errorMessage(cause, "规则解释失败", t));
    } finally {
      setExplainLoading(false);
    }
  };
  const runExample = async () => {
    setExplainLoading(true);
    setExplainError("");
    try {
      setExplain(await filterRulesApi.example());
    } catch (cause) {
      setExplainError(errorMessage(cause, "示例加载失败", t));
    } finally {
      setExplainLoading(false);
    }
  };

  useEffect(() => {
    if (!explainMode || !linkedAssetId || automaticallyExplainedAsset.current === linkedAssetId) return;
    automaticallyExplainedAsset.current = linkedAssetId;
    setExplainLoading(true);
    setExplainError("");
    void filterRulesApi.explain({ assetId: linkedAssetId })
      .then(setExplain)
      .catch((cause) => {
        automaticallyExplainedAsset.current = "";
        setExplainError(errorMessage(cause, "规则解释失败", t));
      })
      .finally(() => setExplainLoading(false));
  }, [explainMode, linkedAssetId, t]);

  const chooseRule = (ruleId: string) => {
    setExplain(undefined);
    updateParams({ ruleId, mode: undefined });
  };
  const chooseCategory = (category?: FilterRuleCategory, kind?: FilterRuleKind) => {
    updateParams({ view: "category", category, kind, stage: undefined, ruleId: undefined, mode: undefined });
  };
  const chooseStage = (stage: FilterRuleStage) => {
    updateParams({ view: "stage", stage, category: undefined, kind: undefined, ruleId: undefined, mode: undefined });
  };
  const setView = (next: FilterRuleView) => {
    setExplain(undefined);
    updateParams({ view: next === "category" ? undefined : next, category: undefined, kind: undefined, stage: next === "stage" ? selectedStage ?? "f0" : undefined, ruleId: undefined, mode: next === "asset" ? "explain" : undefined });
  };

  const focused = Boolean(selectedRuleId || newMode || explainMode);
  const categories = catalogMeta?.categories ?? catalogResponse?.response.categories ?? [];
  const kinds = catalogMeta?.kinds ?? catalogResponse?.response.kinds ?? [];
  const total = catalogMeta?.total ?? catalogItems.length;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0a0d12] text-[#e8ecf3]">
      <header className="shrink-0 border-b border-[#27303d] bg-[#0e131a] px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="min-h-11 shrink-0 border border-[#303a49] bg-[#151b24] text-[#e2e7ee] hover:bg-[#1d2530] sm:min-h-9"><Link to="/"><ArrowLeft className="size-3.5" />{t("返回")}</Link></Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><Filter className="size-5 shrink-0 text-[#f97316]" aria-hidden="true" /><h1 className="truncate text-lg font-semibold">{t("过滤规则")}</h1></div>
              <p className="mt-0.5 text-xs text-[#8490a2]">{t("统一 Catalog · F0 身份解析 · F1 Ring 前 · F2 Forwarder · F3 API")}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AdminTokenControl compact />
            <Button type="button" variant="secondary" size="sm" onClick={() => updateParams({ mode: "new", ruleId: undefined })} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#e2e7ee] hover:bg-[#1d2530] sm:min-h-9"><Plus className="size-3.5" />{t("新增")}</Button>
            <div className="order-last flex min-h-11 min-w-0 basis-full items-center gap-2 rounded border border-[#303a49] bg-[#151b24] px-3 sm:order-none sm:min-w-64 sm:basis-auto">
              <Search className="size-3.5 shrink-0 text-[#8490a2]" aria-hidden="true" />
              <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder={t("搜索规则、Matcher 或来源")} className="h-10 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0" />
            </div>
            <Button type="button" size="sm" onClick={refreshAll} disabled={loading || statusLoading} className="min-h-11 bg-[#f97316] text-white hover:bg-[#fb8128] sm:min-h-9">{loading || statusLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{t("刷新")}</Button>
          </div>
        </div>
        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
          <div className={cn(focused && "hidden md:block")}><FilterRuleStageStrip stages={systemStatus?.stages} selectedStage={view === "stage" ? selectedStage : undefined} onSelect={chooseStage} /></div>
          <div role="group" aria-label={t("规则视角")} className="flex min-h-11 rounded border border-[#303a49] bg-[#111720] p-1">
            {([
              ["category", "按类别", LayoutList],
              ["stage", "按阶段", GitBranch],
              ["asset", "按资产/信号", Boxes],
            ] as const).map(([value, label, Icon]) => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={cn("flex min-h-9 items-center gap-1.5 rounded px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f97316]", view === value ? "bg-[#252e3b] text-[#f3f5f9]" : "text-[#8490a2] hover:text-[#cdd4de]")}><Icon className="size-3.5" />{t(label)}</button>)}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#697386]">
          <span>{systemStatus?.totalRules ?? total} {t("条规则")}</span>
          <span>Catalog {systemStatus?.catalogVersion ?? catalogMeta?.catalogVersion ?? "--"}</span>
          <span>F0 v{systemStatus?.domainVersions.identity ?? "--"} · F1 v{systemStatus?.domainVersions.capture ?? "--"} · F2 v{systemStatus?.domainVersions.forwarder ?? "--"} · F3 v{systemStatus?.domainVersions.retention ?? "--"}</span>
          <span>{systemStatus ? <>{systemStatus.conflicts} {t("冲突")} · {systemStatus.degradedStages} {t("异常阶段")}</> : t("正在读取阶段状态")}</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        <div className={cn("mx-auto grid h-full min-w-0 w-full max-w-[1760px] gap-3", newMode ? "xl:grid-cols-[240px_minmax(0,1fr)]" : "lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_390px_minmax(0,1fr)]")}>
          <section className={cn("min-h-0 flex-col overflow-hidden rounded border border-[#27303d] bg-[#0f141c]", focused ? "hidden xl:flex" : "hidden lg:flex")}>
            <div className="flex min-h-12 items-center justify-between border-b border-[#27303d] px-3"><h2 className="text-sm font-semibold">{t(view === "stage" ? "阶段目录" : "规则分类")}</h2><span className="font-mono text-[10px] text-[#697386]">{categories.length}</span></div>
            <FilterRuleCategoryTree categories={categories} kinds={kinds} selectedCategory={selectedCategory} selectedKind={selectedKind} total={systemStatus?.totalRules ?? catalogMeta?.total ?? 0} onSelect={chooseCategory} />
          </section>

          {!newMode ? <section className={cn("min-h-0 flex-col overflow-hidden rounded border border-[#27303d] bg-[#0f141c]", focused ? "hidden xl:flex" : "flex")}>
            <div className="flex min-h-12 items-center justify-between gap-2 border-b border-[#27303d] px-3"><div><h2 className="text-sm font-semibold">{t("规则目录")}</h2><p className="mt-0.5 text-[10px] text-[#697386]">{catalogItems.length}/{total}</p></div><div className="flex items-center gap-2">{view === "asset" ? <span className="text-[10px] text-cyan-200">Explain</span> : null}<div className="lg:hidden"><Select value={selectedCategory ?? "all"} onValueChange={(value) => chooseCategory(value === "all" ? undefined : value as FilterRuleCategory)}><SelectTrigger aria-label={t("规则分类")} className="min-h-9 w-[150px] border-[#303a49] bg-[#151b24] text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("全部规则")}</SelectItem>{categories.map((category) => <SelectItem key={category.category} value={category.category}>{t(category.label)} · {category.total}</SelectItem>)}</SelectContent></Select></div></div></div>
            {loading && !catalogItems.length ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[#8490a2]"><LoaderCircle className="size-4 animate-spin" />{t("加载过滤规则")}</div> : error ? <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center"><AlertTriangle className="size-5 text-rose-300" /><p className="mt-2 text-sm text-rose-100">{t("过滤规则加载失败")}</p><p className="mt-1 text-xs leading-5 text-[#8490a2]">{errorMessage(error, "请检查统一规则控制面。", t)}</p><Button type="button" variant="secondary" size="sm" onClick={refresh} className="mt-3 min-h-11 border border-[#303a49] bg-[#151b24] sm:min-h-9">{t("重试")}</Button></div> : !catalogItems.length ? <OperationalEmptyState icon={Filter} title={t("当前分类已加载 0 条规则")} description={t("该规则类别已纳入统一 Catalog，但当前没有配置项。")} /> : <FilterRuleList items={catalogItems} total={total} selectedRuleId={selectedRuleId} loadingMore={loadingMore} canLoadMore={Boolean(catalogCursor)} onSelect={chooseRule} onLoadMore={() => void loadMore()} />}
            {loadMoreError ? <p role="alert" className="m-3 rounded border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-100">{loadMoreError}</p> : null}
          </section> : null}

          <section className={cn("min-h-0 min-w-0 overflow-hidden rounded border border-[#27303d] bg-[#0f141c]", newMode ? "xl:col-span-1" : "", !focused && "hidden xl:block")}>
            {focused ? <div className="flex min-h-12 items-center border-b border-[#27303d] px-3 xl:hidden"><button type="button" onClick={() => { setExplain(undefined); updateParams({ ruleId: undefined, mode: undefined, view: view === "asset" ? undefined : searchParams.get("view") ?? undefined }); }} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#b9c1ce]"><ArrowLeft className="size-4" />{t("返回规则目录")}</button></div> : null}
            {newMode ? <FilterRuleWizard initialKind={initialDraftKind} initialAssetId={linkedAssetId || undefined} predecessorRuleId={predecessorRuleId} onClose={() => updateParams({ mode: undefined, draftKind: undefined, predecessorRuleId: undefined })} onCreated={(ruleId) => { refreshAll(); updateParams({ mode: undefined, draftKind: undefined, predecessorRuleId: undefined, assetId: undefined, ruleId }); }} /> : explainMode && !selectedRuleId ? <div className="h-full overflow-y-auto"><FilterRuleExplore result={explain ?? linkedExample} loading={explainLoading || linkedExampleLoading} error={explainError || (linkedExampleError ? errorMessage(linkedExampleError, "示例加载失败", t) : "")} onExplain={(type, id) => void runExplain(type, id)} onExample={() => void runExample()} /></div> : selectedRuleId && detailError && !detailLoading ? <div className="flex min-h-72 flex-col items-center justify-center px-5 text-center"><AlertTriangle className="size-5 text-rose-300" /><p className="mt-2 text-sm text-rose-100">{t("规则详情加载失败")}</p><p className="mt-1 text-xs text-[#8490a2]">{errorMessage(detailError, "请检查统一规则控制面。", t)}</p></div> : rule ? <div className="h-full min-w-0 overflow-y-auto"><FilterRuleDetailPanel rule={rule} preview={preview} simulation={simulation} reason={actionReason} actionLoading={actionLoading} simulationWindow={simulationWindow} onSimulationWindowChange={(window) => { setSimulationWindow(window); setSimulation(undefined); }} onReasonChange={setActionReason} onPreview={() => void runPreview()} onSimulate={() => void runSimulation()} onShadow={() => void transition("shadow")} onPromote={() => void transition("promote")} onRevoke={() => void transition("revoke")} onCreateSuccessor={rule.editable && SUCCESSOR_KINDS.has(rule.ruleKind) ? () => updateParams({ mode: "new", ruleId: undefined, draftKind: rule.ruleKind, predecessorRuleId: rule.ruleId }) : undefined} />{actionError ? <p role="alert" className="mx-4 mb-4 rounded border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-100">{actionError}</p> : null}</div> : <div className="flex min-h-[520px] flex-col items-center justify-center px-5 text-center"><Workflow className="size-8 text-[#596373]" /><p className="mt-3 text-sm font-semibold text-[#b9c1ce]">{t("选择一条规则查看完整因果链")}</p><p className="mt-1 max-w-lg text-xs leading-5 text-[#7f899b]">{t("详情会展示 Typed Matcher、F0/F1/F2/F3 投影、物化状态、Revision 与审计。")}</p><Button type="button" variant="secondary" size="sm" onClick={() => { setExplain(undefined); updateParams({ view: "asset", mode: "explain" }); }} className="mt-4 min-h-11 border border-[#303a49] bg-[#151b24] text-[#dce2eb] hover:bg-[#1d2530] sm:min-h-9"><BookOpenCheck className="size-3.5" />{t("打开规则 Explain")}</Button></div>}
          </section>
        </div>
      </main>
    </div>
  );
}
