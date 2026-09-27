import { useRequest } from "ahooks";
import { ChevronUp, ShieldCheck, UserRoundCog } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { securityCenterApi, type PlatformUserItem, type PlatformUserRole } from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<PlatformUserRole, string> = {
  administrator: "管理员",
  security_analyst: "安全分析师",
  operator: "操作员",
  viewer: "只读用户",
};

const FALLBACK_USER: Pick<PlatformUserItem, "username" | "displayName" | "role"> = {
  username: "admin",
  displayName: "admin",
  role: "administrator",
};

function initials(displayName: string, username: string): string {
  const value = displayName.trim() || username.trim() || "A";
  return Array.from(value)[0]?.toUpperCase() || "A";
}

export function SidebarUserControl({ collapsed }: { collapsed: boolean }) {
  const { pathname, search } = useLocation();
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { data } = useRequest(
    () => securityCenterApi.platformUsers({ status: "active", limit: 100 }),
    {
      cacheKey: "anysentry-sidebar-platform-users",
      staleTime: 60_000,
      cacheTime: 5 * 60_000,
    },
  );

  const currentUser = useMemo(() => {
    return data?.items.find((item) => item.role === "administrator")
      ?? data?.items[0]
      ?? FALLBACK_USER;
  }, [data?.items]);
  const active = pathname === "/users" || pathname.startsWith("/users/");

  useEffect(() => {
    setOpen(false);
  }, [pathname, search]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0 border-t border-[#232a37] bg-[#0f131a] p-1.5">
      {open ? (
        <div
          role="dialog"
          aria-label={t("当前用户")}
          className="absolute bottom-[calc(100%+6px)] left-1.5 z-[80] w-[244px] overflow-hidden rounded-md border border-[#24364d] bg-[#0a1524] shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-center gap-2.5 border-b border-[#262e3b] px-3 py-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2962ff] text-sm font-semibold text-white">
              {initials(currentUser.displayName, currentUser.username)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-[#e8ecf3]">
                {currentUser.displayName}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-[#7f899b]">
                {currentUser.username} · {t(ROLE_LABEL[currentUser.role])}
              </span>
            </span>
            <ShieldCheck className="size-4 shrink-0 text-teal-400" />
          </div>

          <div className="border-b border-[#262e3b] px-3 py-2">
            <div className="flex items-center justify-between text-[10px] text-[#7f899b]">
              <span>{t("本地用户目录")}</span>
              <span>{data?.summary.activeUsers ?? 1} {t("个活跃用户")}</span>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-[#5f6879]">
              {t("当前为本地模式，无需登录；角色仅用于目录与审计标注。")}
            </p>
          </div>

          <div className="p-1.5">
            <Link
              to="/users"
              className="flex h-8 items-center gap-2 rounded px-2 text-[11px] font-medium text-[#c5d2e6] hover:bg-[#10233a] hover:text-white"
            >
              <UserRoundCog className="size-3.5 text-[#8d97aa]" />
              {t("用户管理")}
            </Link>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("当前用户")}
        title={collapsed ? `${currentUser.displayName} · ${currentUser.username}` : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex min-h-9 w-full items-center rounded px-1.5 text-left transition-colors hover:bg-[#151a23] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500/60",
          active && "bg-[#1c222d] shadow-[inset_2px_0_0_#f97316]",
          collapsed ? "justify-center" : "gap-2.5",
        )}
      >
        <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-[#2962ff] text-[11px] font-semibold text-white">
          {initials(currentUser.displayName, currentUser.username)}
          <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-[#0f131a] bg-emerald-400" />
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[#cbd2df]">
              {currentUser.displayName}
            </span>
            <ChevronUp className={cn("size-3.5 shrink-0 text-[#657084] transition-transform", open && "rotate-180")} />
          </>
        ) : null}
      </button>
    </div>
  );
}
