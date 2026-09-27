import { Menu, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import {
  isSecurityNavigationItemActive,
  SECURITY_NAVIGATION_GROUPS,
} from "@/components/custom/security-sidebar";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function MobileSecurityNavigation() {
  const { pathname, search } = useLocation();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname, search]);
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("打开导航")}
        aria-expanded={open}
        aria-controls="mobile-security-navigation"
        className="inline-flex size-11 items-center justify-center rounded-md border border-[#2e3645] bg-[#151a23] text-[#b6bdcc] outline-none transition-colors hover:bg-[#1c222d] hover:text-[#e8ecf3] focus-visible:ring-2 focus-visible:ring-[#f97316]/60"
      >
        <Menu className="size-5" />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label={t("关闭导航")}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[80] cursor-default bg-black/65"
          />
          <aside
            ref={dialogRef}
            id="mobile-security-navigation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-security-navigation-title"
            tabIndex={-1}
            className="fixed inset-y-0 left-0 z-[90] flex w-[min(88vw,340px)] flex-col border-r border-[#2e3645] bg-[#0f131a] text-[#e8ecf3] shadow-2xl shadow-black/50"
          >
            <div className="flex min-h-16 items-center justify-between gap-3 border-b border-[#232a37] px-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <ShieldCheck className="size-5 shrink-0 text-[#f97316]" />
                <div className="min-w-0">
                  <p id="mobile-security-navigation-title" className="truncate text-sm font-semibold">AnySentry</p>
                  <p className="truncate text-[11px] text-[#818a9c]">{t("安全监控中台")}</p>
                </div>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("关闭导航")}
                className="inline-flex size-11 items-center justify-center rounded-md text-[#818a9c] outline-none hover:bg-[#151a23] hover:text-[#e8ecf3] focus-visible:ring-2 focus-visible:ring-[#f97316]/60"
              >
                <X className="size-5" />
              </button>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label={t("安全监控模块")}>
              {SECURITY_NAVIGATION_GROUPS.map((group, groupIndex) => {
                const GroupIcon = group.icon;
                return (
                  <section key={group.label} className={cn(groupIndex > 0 && "mt-3 border-t border-[#232a37] pt-3")}>
                    <p className="flex min-h-8 items-center gap-2 px-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
                      <GroupIcon className="size-3.5" />
                      {t(group.label)}
                    </p>
                    <div className="space-y-1">
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        const active = isSecurityNavigationItemActive(pathname, search, item);
                        return (
                          <Link
                            key={item.href}
                            to={item.href}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex min-h-12 items-start gap-3 rounded-md border px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#f97316]/60",
                              active
                                ? "border-transparent bg-[#1c222d] text-[#e8ecf3] shadow-[inset_2px_0_0_#f97316]"
                                : "border-transparent text-[#b6bdcc] hover:bg-[#151a23] hover:text-[#e8ecf3]",
                            )}
                          >
                            <Icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-[#f97316]" : "text-[#818a9c]")} />
                            <span className="min-w-0">
                              <span className="block text-sm font-semibold">{t(item.label)}</span>
                              {item.description ? <span className="mt-0.5 block text-xs leading-4 text-[#818a9c]">{t(item.description)}</span> : null}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </nav>
            <div className="border-t border-[#232a37] p-2"><AdminTokenControl navigation inlineNavigationPanel /></div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
