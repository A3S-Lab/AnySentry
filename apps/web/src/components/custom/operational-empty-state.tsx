import type { LucideIcon } from "lucide-react";
import { ArrowRight, CircleHelp } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function OperationalEmptyState({
  icon: Icon = CircleHelp,
  title,
  description,
  primary,
  secondary,
  appearance = "dark",
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
  appearance?: "dark" | "light";
}) {
  const light = appearance === "light";
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <span
        className={
          light
            ? "flex size-10 items-center justify-center rounded-lg border border-teal-200 bg-teal-50 text-teal-700"
            : "flex size-10 items-center justify-center rounded-lg border border-teal-400/20 bg-teal-500/10 text-teal-200"
        }
      >
        <Icon className="size-5" />
      </span>
      <div>
        <p className={light ? "text-sm font-medium text-slate-900" : "text-sm font-medium text-zinc-200"}>
          {title}
        </p>
        <p className={light ? "mt-1 max-w-xl text-xs leading-5 text-slate-600" : "mt-1 max-w-xl text-xs leading-5 text-zinc-500"}>
          {description}
        </p>
      </div>
      {(primary || secondary) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {primary && (
            <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
              <Link to={primary.href}>
                {primary.label}
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          )}
          {secondary && (
            <Button
              asChild
              variant="secondary"
              size="sm"
              className={
                light
                  ? "h-8 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  : "h-8 border border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
              }
            >
              <Link to={secondary.href}>{secondary.label}</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
