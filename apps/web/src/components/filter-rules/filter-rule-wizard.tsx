import { useMemo, useState } from "react";
import { useRequest } from "ahooks";
import { ArrowLeft, CheckCircle2, FlaskConical, LoaderCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { filterRulesApi, type CaptureProfile, type FilterRuleDraft, type FilterRuleSimulation } from "@/lib/api/filter-rules";
import { securityCenterApi, type ObservedAsset } from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";

export type FilterRuleWizardKind =
  | "runtime_signature"
  | "agent_template"
  | "capture_profile"
  | "semantic_retention"
  | "persistence_retention"
  | "investigation_override"
  | "infrastructure";

const KIND_COPY: Record<FilterRuleWizardKind, { label: string; description: string }> = {
  runtime_signature: { label: "Runtime Signature", description: "精确进程签名，最高只产生 probable Agent。" },
  agent_template: { label: "Agent Template", description: "按部署与稳定工作负载字段建立身份模板。" },
  infrastructure: { label: "Infrastructure 规则", description: "从 server-owned 资产创建可跨重启复用的精确规则。" },
  capture_profile: { label: "Capture Profile", description: "按身份或角色选择受保护的 Probe 动作矩阵。" },
  semantic_retention: { label: "Forwarder Retention", description: "控制 F2 的保留、聚合、采样或抑制。" },
  persistence_retention: { label: "API Retention", description: "控制 F3 的完整保留、L1-only 或 non-Agent 丢弃。" },
  investigation_override: { label: "Investigation Override", description: "对精确 Asset/Runtime 做最长 24 小时临时 FULL 升档。" },
};

function initialMatcher(kind: FilterRuleWizardKind, assetId?: string) {
  if (kind === "agent_template") return { field: "workload.container", value: "" };
  if (kind === "capture_profile") return { field: "identity.classification", value: "probable_agent" };
  if (kind === "semantic_retention" || kind === "persistence_retention") return { field: "identity.classification", value: "non_agent" };
  if (kind === "investigation_override") return { field: "asset.id", value: assetId ?? "" };
  return { field: "process.exe_basename", value: "" };
}

function errorMessage(cause: unknown, fallback: string, t: (source: string) => string) {
  if (cause instanceof ApiError && cause.code === 401) return t("管理密钥未设置或无效；请先设置控制面密钥。");
  return cause instanceof Error && cause.message ? t(cause.message) : t(fallback);
}

export function FilterRuleWizard({
  onClose,
  onCreated,
  initialKind,
  initialAssetId,
  predecessorRuleId,
}: {
  onClose: () => void;
  onCreated: (ruleId: string) => void;
  initialKind?: FilterRuleWizardKind;
  initialAssetId?: string;
  predecessorRuleId?: string;
}) {
  const { t } = useI18n();
  const startingKind = initialKind ?? "runtime_signature";
  const startingMatcher = initialMatcher(startingKind, initialAssetId);
  const [kind, setKind] = useState<FilterRuleWizardKind>(startingKind);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [matchField, setMatchField] = useState(startingMatcher.field);
  const [matchValue, setMatchValue] = useState(startingMatcher.value);
  const [placement, setPlacement] = useState("kubernetes");
  const [classification, setClassification] = useState("probable_agent");
  const [profile, setProfile] = useState<CaptureProfile>("probable_investigation");
  const [retentionAction, setRetentionAction] = useState("keep");
  const [assetId, setAssetId] = useState(initialAssetId ?? "");
  const [infraIntent, setInfraIntent] = useState<"full" | "aggregate" | "sample" | "drop">("aggregate");
  const [expiresInMinutes, setExpiresInMinutes] = useState("30");
  const [simulation, setSimulation] = useState<FilterRuleSimulation>();
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState("");
  const { data: assetPage, loading: assetsLoading } = useRequest(
    () => securityCenterApi.observedAssets({ limit: 200 }),
    { ready: kind === "infrastructure" },
  );
  const assets = (assetPage?.items ?? []).filter((asset) =>
    asset.subjectAssetType !== "agent" && (asset.bindingQuality === "exact" || asset.bindingQuality === "logical"));
  const selectedAsset = assets.find((asset) => asset.subjectAssetId === assetId);

  const draft = useMemo<FilterRuleDraft | undefined>(() => {
    if (kind === "infrastructure" || !name.trim() || !description.trim() || !reason.trim() || !matchValue.trim()) return undefined;
    const condition = { field: matchField, operator: matchField === "process.argv_prefix" ? "prefix" as const : "equals" as const, value: matchValue.trim() };
    const common = {
      name: name.trim(),
      description: description.trim(),
      reason: reason.trim(),
      matcher: { all: [condition], description: `${matchField} ${condition.operator} ${matchValue.trim()}` },
      ...(predecessorRuleId ? { predecessorRuleId } : {}),
    };
    if (kind === "runtime_signature") {
      return { ...common, category: "agent_identity", ruleKind: "runtime_signature", effect: { type: "emit_identity", classification: "probable_agent", confidence: 0.85, captureProfile: "probable_investigation" } };
    }
    if (kind === "agent_template") {
      return {
        ...common,
        category: "agent_identity",
        ruleKind: "agent_template",
        matcher: { all: [{ ...condition }, { field: "workload.placement", operator: "equals", value: placement }], description: `${placement} / ${matchField}=${matchValue.trim()}` },
        effect: { type: "emit_identity", classification, confidence: classification === "non_agent" ? 1 : 0.8, ...(classification === "probable_agent" ? { captureProfile: "probable_investigation" } : {}) },
      };
    }
    if (kind === "capture_profile") {
      return { ...common, category: "capture_profile", ruleKind: "capture_profile", effect: { type: "assign_capture_profile", captureProfile: profile } };
    }
    if (kind === "semantic_retention") {
      const action = retentionAction === "suppress" && matchValue.trim() !== "non_agent" ? "keep" : retentionAction;
      return { ...common, category: "forwarder_retention", ruleKind: "semantic_retention", effect: { type: "semantic_retention", action, reasonCode: "operator_semantic_retention" } };
    }
    if (kind === "persistence_retention") {
      const action = ["discard", "reject"].includes(retentionAction) && matchValue.trim() !== "non_agent" ? "retain_l1_only" : retentionAction;
      return { ...common, category: "api_retention", ruleKind: "persistence_retention", effect: { type: "persistence_retention", action, reasonCode: "operator_persistence_retention" } };
    }
    const minutes = Math.max(1, Math.min(1_440, Number(expiresInMinutes) || 30));
    return {
      ...common,
      category: "investigation",
      ruleKind: "investigation_override",
      effect: { type: "investigation", captureProfile: "investigation_full", expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(), reasonCode: "operator_investigation" },
    };
  }, [classification, description, expiresInMinutes, kind, matchField, matchValue, name, placement, predecessorRuleId, profile, reason, retentionAction]);

  const changeKind = (next: FilterRuleWizardKind) => {
    if (predecessorRuleId && next !== kind) return;
    setKind(next);
    setSimulation(undefined);
    setError("");
    if (next === "runtime_signature") { setMatchField("process.exe_basename"); setMatchValue(""); }
    if (next === "agent_template") { setMatchField("workload.container"); setMatchValue(""); }
    if (next === "capture_profile") { setMatchField("identity.classification"); setMatchValue("probable_agent"); }
    if (next === "semantic_retention" || next === "persistence_retention") { setMatchField("identity.classification"); setMatchValue("non_agent"); }
    if (next === "investigation_override") { setMatchField("asset.id"); setMatchValue(""); }
  };

  const simulate = async () => {
    if (!draft) return;
    setSimulating(true);
    setError("");
    try {
      setSimulation(await filterRulesApi.simulate({ draft }));
    } catch (cause) {
      setError(errorMessage(cause, "规则模拟失败", t));
    } finally {
      setSimulating(false);
    }
  };

  const create = async () => {
    setSaving(true);
    setError("");
    try {
      if (kind === "infrastructure") {
        if (!selectedAsset || !reason.trim()) return;
        const result = await filterRulesApi.createInfrastructureDraft({ assetId: selectedAsset.subjectAssetId, intent: infraIntent, name: name.trim() || undefined, reason: reason.trim() });
        onCreated(result.rule.ruleId);
      } else if (draft && simulation?.preview.valid) {
        const result = await filterRulesApi.createDraft(draft);
        onCreated(result.rule.ruleId);
      }
    } catch (cause) {
      setError(errorMessage(cause, "过滤规则草稿创建失败", t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#27303d] pb-4">
        <div>
          <h2 className="text-base font-semibold text-[#edf1f7]">{t("新增过滤规则")}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[#7f899b]">{t("使用 Typed Matcher 和受限 Effect 创建草稿；浏览器不能上传脚本、cgroup、epoch 或 grant。")}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onClose} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#dce2eb] hover:bg-[#1d2530] sm:min-h-9"><ArrowLeft className="size-3.5" />{t("取消")}</Button>
      </div>

      {predecessorRuleId ? <div className="mt-4 rounded border border-cyan-400/20 bg-cyan-500/5 px-3 py-2 text-xs leading-5 text-cyan-100">{t("正在创建后继草稿；规则类型必须与前序规则一致，原规则不会被原地覆盖。")} <span className="font-mono text-[10px] text-cyan-300">{predecessorRuleId}</span></div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <nav aria-label={t("规则类型")} className="space-y-1 rounded border border-[#27303d] bg-[#10151d] p-2">
          {(Object.entries(KIND_COPY) as Array<[FilterRuleWizardKind, typeof KIND_COPY[FilterRuleWizardKind]]>)
            .filter(([value]) => !predecessorRuleId || value === kind)
            .map(([value, copy]) => (
            <button key={value} type="button" aria-current={kind === value ? "step" : undefined} onClick={() => changeKind(value)} className={`min-h-14 w-full rounded px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f97316] ${kind === value ? "bg-[#202733]" : "hover:bg-[#171d26]"}`}>
              <span className="block text-xs font-semibold text-[#e3e8ef]">{t(copy.label)}</span>
              <span className="mt-1 block text-[10px] leading-4 text-[#7f899b]">{t(copy.description)}</span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          <section className="rounded border border-[#27303d] bg-[#10151d] p-4">
            <p className="text-xs font-semibold text-[#cbd2dd]">1. {t("定义规则目的")}</p>
            <label className="mt-3 block text-[11px] text-[#9aa4b4]" htmlFor="filter-rule-name">{t("规则名称")} *</label>
            <Input id="filter-rule-name" value={name} onChange={(event) => { setName(event.target.value); setSimulation(undefined); }} className="mt-1 min-h-11 border-[#303a49] bg-[#141a23] text-sm" />
            <label className="mt-3 block text-[11px] text-[#9aa4b4]" htmlFor="filter-rule-description">{t("规则说明")} *</label>
            <Input id="filter-rule-description" value={description} onChange={(event) => { setDescription(event.target.value); setSimulation(undefined); }} className="mt-1 min-h-11 border-[#303a49] bg-[#141a23] text-sm" />
            <label className="mt-3 block text-[11px] text-[#9aa4b4]" htmlFor="filter-rule-reason">{t("创建原因")} *</label>
            <Input id="filter-rule-reason" value={reason} onChange={(event) => { setReason(event.target.value); setSimulation(undefined); }} className="mt-1 min-h-11 border-[#303a49] bg-[#141a23] text-sm" />
          </section>

          <section className="rounded border border-[#27303d] bg-[#10151d] p-4">
            <p className="text-xs font-semibold text-[#cbd2dd]">2. {t(kind === "infrastructure" ? "选择受信资产与采集意图" : "配置 Typed Matcher 与 Effect")}</p>
            {kind === "infrastructure" ? (
              <div className="mt-3">
                <label className="block text-[11px] text-[#9aa4b4]">{t("受信资产")} *</label>
                {assetsLoading ? <p className="mt-2 text-xs text-[#7f899b]">{t("正在读取资产")}</p> : (
                  <Select value={assetId} onValueChange={setAssetId}>
                    <SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue placeholder={t("选择 exact / logical 资产")} /></SelectTrigger>
                    <SelectContent>{assets.map((asset: ObservedAsset) => <SelectItem key={asset.subjectAssetId} value={asset.subjectAssetId}>{asset.displayName} · {asset.bindingQuality}</SelectItem>)}</SelectContent>
                  </Select>
                )}
                <label className="mt-3 block text-[11px] text-[#9aa4b4]">{t("采集意图")}</label>
                <Select value={infraIntent} onValueChange={(value) => setInfraIntent(value as typeof infraIntent)}>
                  <SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">FULL</SelectItem><SelectItem value="aggregate">AGGREGATE</SelectItem><SelectItem value="sample">SAMPLE</SelectItem><SelectItem value="drop">DROP</SelectItem>
                  </SelectContent>
                </Select>
                {selectedAsset ? <p className="mt-2 text-[11px] text-[#7f899b]">{selectedAsset.role.role} · {selectedAsset.identity.classification} · {selectedAsset.runtimeSummary.total} {t("实例")}</p> : null}
              </div>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] text-[#9aa4b4]">{t("匹配字段")}</label>
                  <Select value={matchField} onValueChange={(value) => { setMatchField(value); setSimulation(undefined); }}>
                    <SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {kind === "runtime_signature" ? <><SelectItem value="process.comm">process.comm</SelectItem><SelectItem value="process.exe_basename">process.exe_basename</SelectItem><SelectItem value="process.argv0_basename">process.argv0_basename</SelectItem><SelectItem value="process.argv_prefix">process.argv_prefix</SelectItem></> : null}
                      {kind === "agent_template" ? <><SelectItem value="workload.namespace">workload.namespace</SelectItem><SelectItem value="workload.owner_name">workload.owner_name</SelectItem><SelectItem value="workload.container">workload.container</SelectItem><SelectItem value="process.exe_basename">process.exe_basename</SelectItem></> : null}
                      {kind === "capture_profile" || kind === "semantic_retention" || kind === "persistence_retention" ? <><SelectItem value="identity.classification">identity.classification</SelectItem><SelectItem value="workload.role">workload.role</SelectItem><SelectItem value="event.kind">event.kind</SelectItem></> : null}
                      {kind === "investigation_override" ? <><SelectItem value="asset.id">asset.id</SelectItem><SelectItem value="runtime.id">runtime.id</SelectItem></> : null}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label htmlFor="filter-rule-match-value" className="block text-[11px] text-[#9aa4b4]">{t("精确值")} *</label>
                  <Input id="filter-rule-match-value" value={matchValue} onChange={(event) => { setMatchValue(event.target.value); setSimulation(undefined); }} className="mt-1 min-h-11 border-[#303a49] bg-[#141a23] text-sm" />
                </div>
                {kind === "agent_template" ? <><div><label className="block text-[11px] text-[#9aa4b4]">{t("部署环境")}</label><Select value={placement} onValueChange={setPlacement}><SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="kubernetes">Kubernetes</SelectItem><SelectItem value="docker">Docker</SelectItem><SelectItem value="host">Host</SelectItem></SelectContent></Select></div><div><label className="block text-[11px] text-[#9aa4b4]">{t("身份结果")}</label><Select value={classification} onValueChange={setClassification}><SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="probable_agent">probable_agent</SelectItem><SelectItem value="non_agent">non_agent</SelectItem></SelectContent></Select></div></> : null}
                {kind === "capture_profile" ? <div><label className="block text-[11px] text-[#9aa4b4]">Capture Profile</label><Select value={profile} onValueChange={(value) => setProfile(value as CaptureProfile)}><SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger><SelectContent>{["agent_full", "probable_investigation", "business_context", "infrastructure_aggregate", "unknown_discovery", "self_health"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div> : null}
                {kind === "semantic_retention" ? <div><label className="block text-[11px] text-[#9aa4b4]">F2 Action</label><Select value={retentionAction} onValueChange={setRetentionAction}><SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="keep">KEEP</SelectItem><SelectItem value="aggregate">AGGREGATE</SelectItem><SelectItem value="sample">SAMPLE</SelectItem><SelectItem value="suppress">SUPPRESS</SelectItem></SelectContent></Select></div> : null}
                {kind === "persistence_retention" ? <div><label className="block text-[11px] text-[#9aa4b4]">F3 Action</label><Select value={retentionAction} onValueChange={setRetentionAction}><SelectTrigger className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="retain_full">RETAIN_FULL</SelectItem><SelectItem value="retain_l1_only">RETAIN_L1_ONLY</SelectItem><SelectItem value="structural_consume">STRUCTURAL_CONSUME</SelectItem><SelectItem value="discard">DISCARD</SelectItem></SelectContent></Select></div> : null}
                {kind === "investigation_override" ? <div><label htmlFor="filter-rule-expiry" className="block text-[11px] text-[#9aa4b4]">{t("有效分钟数（1–1440）")}</label><Input id="filter-rule-expiry" type="number" min={1} max={1440} value={expiresInMinutes} onChange={(event) => setExpiresInMinutes(event.target.value)} className="mt-1 min-h-11 border-[#303a49] bg-[#141a23]" /></div> : null}
              </div>
            )}
          </section>

          <section className="rounded border border-[#27303d] bg-[#10151d] p-4">
            <p className="text-xs font-semibold text-[#cbd2dd]">3. {t("模拟并创建安全草稿")}</p>
            <p className="mt-1 text-[11px] leading-5 text-[#7f899b]">{t(kind === "infrastructure" ? "资产规则创建后再使用统一 Preview；DROP 仍需 Inventory、独立批准、ACK 与 grant。" : "创建前由服务端使用当前 Inventory 和真实编译器模拟 F0/F1/F2/F3 变化。")}</p>
            {simulation ? <div className="mt-3 rounded border border-emerald-400/20 bg-emerald-500/5 p-3"><p className="flex items-center gap-2 text-xs font-semibold text-emerald-100"><CheckCircle2 className="size-4" />{t("模拟通过")}</p><p className="mt-1 text-[11px] text-[#b9c1ce]">{simulation.preview.matchedAssets} {t("匹配对象")} · {simulation.stageChanges.reduce((total, stage) => total + stage.changed, 0)} {t("阶段变化")}</p></div> : null}
            {error ? <p role="alert" className="mt-3 rounded border border-rose-400/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-100">{error}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {kind !== "infrastructure" ? <Button type="button" variant="secondary" size="sm" onClick={() => void simulate()} disabled={simulating || !draft} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#dce2eb] hover:bg-[#1d2530] sm:min-h-9">{simulating ? <LoaderCircle className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}{t("模拟草稿")}</Button> : null}
              <Button type="button" size="sm" onClick={() => void create()} disabled={saving || !name.trim() || !reason.trim() || (kind === "infrastructure" ? !selectedAsset : !draft || !simulation?.preview.valid)} className="min-h-11 bg-[#f97316] text-white hover:bg-[#fb8128] sm:min-h-9">{saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}{t("创建草稿")}</Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
