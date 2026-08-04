import { useRequest } from "ahooks";
import { Bot, BrainCircuit, CircleCheck, LoaderCircle, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type IdentityAiReviewRecord,
  type IdentityAiReviewRequest,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error || "AI 辅助审核失败");
}

export function IdentityAiReview({
  targetType,
  eventId,
  agentAssetId,
  timeType,
  startTime,
  endTime,
  compact = false,
}: IdentityAiReviewRequest & { compact?: boolean }) {
  const [result, setResult] = useState<IdentityAiReviewRecord>();
  const [error, setError] = useState("");
  const queryKey = `${targetType}:${eventId ?? ""}:${agentAssetId ?? ""}`;
  const { runAsync, loading } = useRequest(
    () => securityCenterApi.runIdentityAiReview({ targetType, eventId, agentAssetId, timeType, startTime, endTime }),
    { manual: true },
  );
  const { data: history } = useRequest(
    () => securityCenterApi.identityAiReviews({ targetType, eventId, agentAssetId }),
    { refreshDeps: [queryKey], ready: Boolean(eventId || agentAssetId) },
  );

  useEffect(() => {
    setResult(history?.items[0]);
  }, [history, queryKey]);

  const run = async () => {
    setError("");
    try {
      const next = await runAsync();
      setResult(next);
      if (next.status === "failed") setError(next.error ?? "AI 辅助审核失败");
    } catch (nextError) {
      setError(errorText(nextError));
    }
  };

  return (
    <div className={cn("rounded-md border border-sky-400/20 bg-sky-500/[0.06]", compact ? "p-3" : "p-4")}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BrainCircuit className="size-4 text-sky-200" />
            <h3 className="text-sm font-semibold text-zinc-100">AI 身份辅助审核</h3>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-500">只读建议</span>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-zinc-400">
            使用当前 L2/L3 模型配置，由受限 A3S Code SDK Agent 读取证据快照。结果不会自动改变身份分类。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={loading || !agentAssetId}
          onClick={run}
          className="h-8 shrink-0 bg-sky-400 text-slate-950 hover:bg-sky-300"
        >
          {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
          {loading ? "正在读取证据..." : result ? "重新辅助审核" : "开始辅助审核"}
        </Button>
      </div>

      {result?.status === "succeeded" ? (
        <div className="mt-3 rounded-md border border-white/10 bg-black/15 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <CircleCheck className="size-4 text-teal-200" />
            <span className={cn(
              "rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              result.verdict === "agent"
                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                : "border-slate-400/30 bg-slate-500/10 text-slate-200",
            )}>
              {result.verdict === "agent" ? "建议：是 Agent" : "建议：不是 Agent"}
            </span>
            <span className="font-mono text-[11px] text-zinc-500">置信度 {Math.round((result.confidence ?? 0) * 100)}%</span>
            <span className="font-mono text-[11px] text-zinc-600">{result.model ?? "model"}</span>
          </div>
          <p className="mt-2 text-sm font-medium text-zinc-200">{result.summary}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{result.reason}</p>
          <p className="mt-2 font-mono text-[10px] text-zinc-600" title={result.evidenceDigest}>
            证据 {result.evidenceRefs.join(" · ") || "--"} · digest {result.evidenceDigest.slice(0, 12)}
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-100">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
