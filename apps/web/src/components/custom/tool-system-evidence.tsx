import { ChevronRight, ShieldCheck } from "lucide-react";
import type { LocalRecordTimelineEvent } from "@/lib/api/security-center";
import type { SystemEvent, ToolEvidenceMatch } from "@/lib/tool-system-evidence";

export function SystemEventRows({ events }: { events: SystemEvent[] }) {
  return <div className="space-y-1.5">
    {events.map((event) => <details key={event.eventId} className="rounded border border-slate-200 bg-white text-[10px]">
      <summary className="cursor-pointer break-words px-2.5 py-2 text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400">
        <span className="font-semibold">{event.eventKind}</span> · PID {event.pid ?? "未知"} · {new Date(event.at).toLocaleString("zh-CN", { hour12: false })}
        <span className="ml-2">{event.subject}</span>
      </summary>
      <div className="space-y-1.5 border-t border-slate-100 p-2.5 [overflow-wrap:anywhere]">
        <p className="font-mono">{event.eventId} · {event.processInstanceKey}</p>
        <p>Session 归属：{event.relation} · PPID {event.ppid ?? "未知"} · {event.verdict}</p>
        {event.command ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{event.command}</pre> : null}
        {event.toolCallBinding ? <p className="font-mono">Call {event.toolCallBinding.toolCallId} · Invocation {event.toolCallBinding.invocationId ?? "未记录"}</p> : null}
        <a href={`/events?eventId=${encodeURIComponent(event.eventId)}`} className="inline-flex items-center text-teal-800 underline focus-visible:ring-2 focus-visible:ring-teal-400">查看原始系统事件 <ChevronRight aria-hidden="true" className="size-3" /></a>
      </div>
    </details>)}
  </div>;
}

export function ToolSystemEvidence({ call, match, loading, error }: {
  call: LocalRecordTimelineEvent;
  match?: ToolEvidenceMatch;
  loading: boolean;
  error: boolean;
}) {
  const confirmed = match?.confirmed ?? [];
  const candidates = match?.candidates ?? [];
  const label = loading ? "证据加载中" : error ? "证据读取失败"
    : match?.ambiguousCallId ? "Call ID 重复，待复核"
    : confirmed.length ? `已确认 ${confirmed.length} 条`
    : candidates.length ? `候选 ${candidates.length} 条 · ${match?.status === "ambiguous" ? "存在歧义" : "待确认"}`
    : match?.checked === false ? "该调用尚未核对"
    : match?.evidencePartial ? "证据未查全 · 暂无调用明细"
    : match?.sessionAssociated ? "会话已关联 · 调用待确认" : "尚未取得会话证据";
  return <details data-tool-system-evidence={call.eventId} className="ml-5 rounded-lg border border-cyan-200 bg-cyan-50/50">
    <summary className="cursor-pointer px-3 py-2 text-[11px] text-cyan-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400">
      <ShieldCheck aria-hidden="true" className="mx-1 inline size-3.5" />Tool Call 系统证据
      <span className="ml-2 rounded border border-cyan-200 bg-white px-1.5 py-0.5 text-[10px]">{label}</span>
    </summary>
    <div className="space-y-2 border-t border-cyan-100 p-3">
      <p className="font-mono text-[10px] text-slate-600 [overflow-wrap:anywhere]">Call {call.callId ?? "未记录"} · Turn {call.turnId ?? "未记录"}</p>
      {error ? <p role="alert" className="text-[10px] text-rose-700">本次证据读取失败，以下已有结果可能过期。请刷新系统证据重试。</p> : null}
      {confirmed.length ? <>
        <p className="text-[10px] text-teal-800">已确认：同一 Session 的系统事件携带服务端验证的适配器 Tool Call 标识。不是按时间或命令猜测。</p>
        <SystemEventRows events={confirmed} />
      </> : <p className="text-[10px] leading-5 text-slate-600">
        {loading ? "正在读取 Session 系统证据。" : error ? "本次证据查询失败，不能据此认定没有执行。请重试。"
          : match?.ambiguousCallId ? "已加载记录存在重复 Call ID，不能唯一确认调用归属。"
          : match?.checked === false ? "此调用不在本次后端核对的语义窗口内，不能判断其关联状态。"
          : match?.status === "pending" ? "尚未取得同一调用的结果，执行窗口未确定。"
          : match?.status === "unsupported" ? "当前调用包含未支持或动态生成的命令，无法安全建立静态命令候选。"
          : match?.sessionAssociated ? "已有属于该会话的系统证据；该调用尚无可信执行绑定，不能据此认定未执行或漏采。"
          : "当前未取得可用于此会话的系统证据，无法判断该调用的执行关联。"}
      </p>}
      {candidates.length ? <>
        <p className="text-[10px] leading-5 text-amber-800">候选／待确认：同一 Session 内的静态命令匹配（含受支持的 Shell 包装），以及执行窗口内的进程血缘。并发或重复命令可能产生歧义；候选不代表可信调用绑定，也不改写原始事实。</p>
        <SystemEventRows events={candidates} />
      </> : null}
      {match?.evidencePartial && <p data-tool-evidence-partial className="text-[10px] leading-5 text-amber-800">当前系统证据尚未查全，未显示事件不代表没有采集到。可在上方加载更多系统关系；达到查询上限后仍可能不完整。</p>}
      <p className="text-[10px] text-slate-500">仅检查当前已加载的调用和系统事件；更早记录、动态命令及后续异步执行可能尚未覆盖。</p>
    </div>
  </details>;
}
