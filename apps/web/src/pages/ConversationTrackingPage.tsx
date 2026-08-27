import { MessageSquareText } from "lucide-react";

import { useI18n } from "@/lib/i18n";

export default function ConversationTrackingPage() {
  const { t } = useI18n();

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquareText className="size-5 shrink-0 text-teal-300" />
          <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">
            {t("对话追踪")}
          </h1>
        </div>
      </header>
      <main className="min-h-0 flex-1" aria-label={t("对话追踪")} />
    </div>
  );
}
