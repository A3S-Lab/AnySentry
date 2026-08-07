import { useRequest } from "ahooks";
import { KeyRound, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getAdminToken, hasAdminToken, setAdminToken } from "@/lib/api/client";
import { securityCenterApi } from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function AdminTokenControl({
  compact = false,
  navigation = false,
}: {
  compact?: boolean;
  navigation?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [navigationPanelPosition, setNavigationPanelPosition] = useState({ left: 228, top: 12 });
  const { data: platformHealth } = useRequest(() => securityCenterApi.healthz(), {
    pollingInterval: 30000,
    pollingWhenHidden: false,
    refreshOnWindowFocus: true,
  });
  const enabled = platformHealth?.managementAuth?.enabled;

  useEffect(() => {
    const sync = () => {
      setSaved(hasAdminToken());
      setDraft(getAdminToken());
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("anysentry-admin-token-change", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("anysentry-admin-token-change", sync);
    };
  }, []);

  const save = () => {
    setAdminToken(draft);
    setSaved(Boolean(draft.trim()));
    setOpen(false);
  };
  const clear = () => {
    setDraft("");
    setAdminToken("");
    setSaved(false);
    setOpen(false);
  };
  const tone =
    enabled && !saved
      ? "border-amber-300/30 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
      : saved
        ? "border-teal-300/30 bg-teal-400/10 text-teal-100 hover:bg-teal-400/15"
        : "border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10";
  const panel = (
    <div
      className={cn(
        "z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-[7px] border border-white/10 bg-[#101511] p-3 text-zinc-100 shadow-2xl shadow-black/40",
        navigation ? "fixed" : "absolute right-0 top-11",
      )}
      style={navigation ? navigationPanelPosition : undefined}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold">{t("控制面密钥")}</div>
          <div className={cn("mt-0.5 text-[11px]", enabled ? "text-amber-200" : "text-zinc-500")}>
            {t(enabled ? "服务端已启用" : "服务端未启用")}
          </div>
        </div>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", saved ? "border-teal-300/25 bg-teal-400/10 text-teal-100" : "border-zinc-500/25 bg-zinc-500/10 text-zinc-300")}>
          {t(saved ? "已保存" : "未保存")}
        </span>
      </div>
      <Input
        type="password"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="ANYSENTRY_ADMIN_TOKEN"
        className="h-9 border-white/10 bg-white/5 font-mono text-xs text-zinc-100"
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={clear} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          {t("清除")}
        </Button>
        <Button type="button" size="sm" onClick={save} className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
          {t("保存")}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="relative">
      <Button
        type="button"
        variant="secondary"
        size={compact ? "icon-sm" : "sm"}
        title={t(enabled ? (saved ? "管理密钥已设置" : "需要管理密钥") : "管理密钥")}
        aria-expanded={open}
        onClick={(event) => {
          if (navigation && !open) {
            const rect = event.currentTarget.getBoundingClientRect();
            const panelHeight = 174;
            setNavigationPanelPosition({
              left: rect.right + 8,
              top: Math.max(12, Math.min(rect.top, window.innerHeight - panelHeight - 12)),
            });
          }
          setOpen((value) => !value);
        }}
        className={cn(
          compact ? "h-8 w-8" : "h-9",
          navigation && "h-auto w-full justify-start gap-2.5 rounded-md border-transparent bg-transparent px-2.5 py-2 text-left shadow-none hover:bg-[#151a23]",
          tone,
        )}
      >
        {saved ? (
          <LockKeyhole className={cn("size-3.5", !compact && !navigation && "mr-1.5", navigation && "ml-0.5 shrink-0")} />
        ) : (
          <KeyRound className={cn("size-3.5", !compact && !navigation && "mr-1.5", navigation && "ml-0.5 shrink-0")} />
        )}
        {compact ? null : (
          <span className={cn(navigation && "text-xs font-semibold leading-[1.45]")}>{t("管理密钥")}</span>
        )}
      </Button>
      {open ? (navigation ? createPortal(panel, document.body) : panel) : null}
    </div>
  );
}
