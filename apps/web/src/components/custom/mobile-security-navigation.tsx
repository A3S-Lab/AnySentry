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
                  <section key={group.label} className={cn(groupIndex > 0 && "mt-3")}>
                    <p className="flex h-9 items-center gap-2 px-2 text-[16px] font-medium text-[#d7dee8]">
                      <GroupIcon className="size-4 shrink-0 text-[#9aa3b5]" aria-hidden="true" />
                      {t(group.label)}
                    </p>
                    <div className="space-y-0.5">
                      {group.items.map((item) => {
                        const active = isSecurityNavigationItemActive(pathname, search, item);
                        return (
                          <Link
                            key={item.href}
                            to={item.href}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex min-h-11 items-center rounded-md py-2 pl-8 pr-3 text-[15px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#f97316]/60",
                              active
                                ? "bg-[radial-gradient(circle_at_100%_50%,rgba(37,99,235,0.72),transparent_24%),linear-gradient(90deg,rgba(6,28,54,0.96),rgba(15,43,98,0.92))] text-[#f4f8ff] shadow-[inset_2px_0_0_#22d3ee,inset_0_0_22px_rgba(37,99,235,0.18)]"
                                : "text-[#c5ccd6] hover:bg-[#151a23] hover:text-white",
                            )}
                          >
                            {t(item.label)}
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
