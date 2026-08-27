import {
  Bot,
  Boxes,
  Braces,
  Database,
  FlaskConical,
  Layers3,
  LockKeyhole,
  Radar,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  FilterRuleCategory,
  FilterRuleCategorySummary,
  FilterRuleKind,
  FilterRuleKindSummary,
} from "@/lib/api/filter-rules";

const CATEGORY_ICON: Record<FilterRuleCategory, typeof Bot> = {
  agent_identity: Bot,
  infrastructure: Database,
  capture_profile: Radar,
  forwarder_retention: Layers3,
  api_retention: Boxes,
  safety_guardrail: LockKeyhole,
  investigation: FlaskConical,
  learning_candidate: Braces,
};

export function FilterRuleCategoryTree({
  categories,
  kinds,
  selectedCategory,
  selectedKind,
  total,
  onSelect,
}: {
  categories: FilterRuleCategorySummary[];
  kinds: FilterRuleKindSummary[];
  selectedCategory?: FilterRuleCategory;
  selectedKind?: FilterRuleKind;
  total: number;
  onSelect: (category?: FilterRuleCategory, kind?: FilterRuleKind) => void;
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("规则分类")} className="min-h-0 overflow-y-auto px-2 py-2">
      <button
        type="button"
        aria-current={!selectedCategory && !selectedKind ? "page" : undefined}
        onClick={() => onSelect()}
        className={cn(
          "flex min-h-11 w-full items-center justify-between rounded px-2.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f97316]",
          !selectedCategory && !selectedKind ? "bg-[#202733] text-[#f2f5fa]" : "text-[#b8c0ce] hover:bg-[#171d26]",
        )}
      >
        <span className="font-semibold">{t("全部规则")}</span>
        <span className="font-mono text-[11px] text-[#7f899b]">{total}</span>
      </button>
      <div className="mt-1 space-y-1">
        {categories.map((category) => {
          const Icon = CATEGORY_ICON[category.category];
          const selected = selectedCategory === category.category && !selectedKind;
          const children = kinds.filter((kind) => kind.category === category.category);
          return (
            <section key={category.category} aria-labelledby={`filter-category-${category.category}`}>
              <button
                type="button"
                id={`filter-category-${category.category}`}
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelect(category.category)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded px-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f97316]",
                  selected ? "bg-[#202733] text-[#f2f5fa]" : "text-[#b8c0ce] hover:bg-[#171d26]",
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", selected ? "text-[#fb923c]" : "text-[#7f899b]")} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{t(category.label)}</span>
                <span className="font-mono text-[11px] text-[#7f899b]">{category.total}</span>
              </button>
              <div className="ml-5 border-l border-[#283140] pl-2">
                {children.map((kind) => {
                  const childSelected = selectedKind === kind.kind;
                  return (
                    <button
                      key={kind.kind}
                      type="button"
                      aria-current={childSelected ? "page" : undefined}
                      onClick={() => onSelect(category.category, kind.kind)}
                      className={cn(
                        "flex min-h-9 w-full items-center justify-between gap-2 rounded px-2 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f97316]",
                        childSelected ? "bg-[#1a212c] text-[#f2f5fa]" : "text-[#8892a4] hover:bg-[#151b24] hover:text-[#cbd2dd]",
                      )}
                    >
                      <span className="truncate">{t(kind.label)}</span>
                      <span className={cn("font-mono", kind.total === 0 ? "text-[#4d5665]" : "text-[#737d8f]")}>{kind.total}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
