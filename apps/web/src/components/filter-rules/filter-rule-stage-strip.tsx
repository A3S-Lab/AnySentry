import { ArrowRight, CircleAlert, CircleCheck, CircleDashed, GitCompareArrows } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { FilterRuleStage, FilterRuleStageStatus } from "@/lib/api/filter-rules";

const STAGE_META: Record<FilterRuleStage, { short: string; description: string }> = {
  f0: { short: "F0", description: "身份、角色与可信上下文" },
  f1: { short: "F1", description: "完整 payload 与 Ring reserve 前" },
  f2: { short: "F2", description: "Collector 输出到 HTTP 批次" },
  f3: { short: "F3", description: "持久化与 L1/L2/L3 前" },
};

function statusIcon(status: FilterRuleStageStatus["status"]) {
  if (status === "ready") return <CircleCheck className="size-3.5 text-emerald-300" aria-hidden="true" />;
  if (status === "drifted") return <GitCompareArrows className="size-3.5 text-amber-300" aria-hidden="true" />;
  if (status === "degraded") return <CircleAlert className="size-3.5 text-rose-300" aria-hidden="true" />;
  return <CircleDashed className="size-3.5 text-[#818a9c]" aria-hidden="true" />;
}

export function FilterRuleStageStrip({
  stages,
  selectedStage,
  onSelect,
}: {
  stages?: FilterRuleStageStatus[];
  selectedStage?: FilterRuleStage;
  onSelect: (stage: FilterRuleStage) => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-label={t("过滤阶段")} className="grid grid-cols-2 overflow-hidden rounded-md border border-[#263040] bg-[#0f131a] xl:grid-cols-4">
      {(Object.keys(STAGE_META) as FilterRuleStage[]).map((stage, index) => {
        const runtime = stages?.find((item) => item.stage === stage);
        const selected = selectedStage === stage;
        return (
          <div key={stage} className="relative min-w-0 border-b border-[#263040] [&:nth-child(odd)]:border-r [&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0">
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(stage)}
              className={cn(
                "group min-h-[92px] w-full px-2.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f97316] sm:min-h-[104px] sm:px-3 sm:py-3",
                selected ? "bg-[#1b222d]" : "bg-[#0f131a] hover:bg-[#151a23]",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className={cn("font-mono text-xs font-semibold", selected ? "text-[#fb923c]" : "text-[#8d97a9]")}>{STAGE_META[stage].short}</span>
                  <span className="text-xs font-semibold text-[#e8ecf3]">{t(runtime?.label ?? STAGE_META[stage].description)}</span>
                </span>
                <span className="flex items-center gap-1 text-[11px] text-[#8d97a9]">
                  {runtime ? statusIcon(runtime.status) : <CircleDashed className="size-3.5" aria-hidden="true" />}
                  {t(runtime?.status ?? "unknown")}
                </span>
              </span>
              <span className="mt-1.5 block text-[11px] leading-5 text-[#8d97a9]">{t(STAGE_META[stage].description)}</span>
              <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-[#697386]">
                <span>v{runtime?.desiredVersion ?? "--"}</span>
                <span>{runtime?.activeRules ?? 0} {t("条规则")}</span>
                <span>{runtime?.mode ?? "--"}</span>
                {runtime?.lost ? <span className="text-rose-300">{runtime.lost} {t("丢失")}</span> : null}
              </span>
            </button>
            {index < 3 ? <ArrowRight className="absolute -right-2 top-1/2 z-10 hidden size-4 -translate-y-1/2 rounded-full bg-[#0f131a] text-[#4f596b] xl:block" aria-hidden="true" /> : null}
          </div>
        );
      })}
    </section>
  );
}
