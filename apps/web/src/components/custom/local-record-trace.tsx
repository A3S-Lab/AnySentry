import { Fragment, useDeferredValue, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Bot, BrainCircuit, ChevronDown, ChevronRight, Columns3, Download, Filter, ListTree, MessageSquare, RefreshCw, Search, ShieldCheck, Wrench, type LucideIcon } from "lucide-react";
import type { LocalRecordDetail, LocalRecordTimelineEvent } from "@/lib/api/security-center";
import { buildLocalTraceRows, type LocalTraceRow, type TraceRowType } from "@/lib/local-record-trace";
import { cn } from "@/lib/utils";

const TYPES: Array<{ type: TraceRowType; label: string; color: string; icon: LucideIcon; iconColor: string }> = [
  { type: "TURN", label: "Turn 汇总", color: "bg-teal-50 text-teal-800 border-teal-200", icon: Bot, iconColor: "text-teal-600" },
  { type: "MODEL", label: "模型请求", color: "bg-sky-50 text-sky-800 border-sky-200", icon: BrainCircuit, iconColor: "text-sky-600" },
  { type: "TOOL", label: "工具调用", color: "bg-violet-50 text-violet-800 border-violet-200", icon: Wrench, iconColor: "text-violet-600" },
  { type: "MESSAGE", label: "对话消息", color: "bg-slate-100 text-slate-700 border-slate-200", icon: MessageSquare, iconColor: "text-slate-500" },
  { type: "SYSTEM", label: "系统事件", color: "bg-amber-50 text-amber-800 border-amber-200", icon: ShieldCheck, iconColor: "text-amber-600" },
];

function TraceTypeIcon({ type }: { type: TraceRowType }) {
  const config = TYPES.find(t => t.type === type)!;
  const Icon = config.icon;
  return <Icon aria-hidden="true" data-trace-type-icon={type} className={cn("size-3.5 shrink-0", config.iconColor)} />;
}
const COLUMNS = [
  ["time", "开始时间", 154], ["type", "类型", 92], ["name", "名称", 150],
  ["trace", "Trace / Turn", 150], ["input", "输入", 230], ["output", "输出", 230],
  ["status", "状态", 110], ["duration", "耗时", 84], ["association", "执行关联", 122],
  ["metadata", "元数据", 240], ["model", "模型", 140],
  ["pid", "PID", 88], ["callId", "Call ID", 220], ["eventId", "记录 ID", 220],
  ["sessionId", "Session ID", 260],
] as const;
type Column = typeof COLUMNS[number][0];
const PAGE_SIZE = 50;
const control = "rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-50";
const stamp = (value?: number) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const elapsed = (value?: number) => value === undefined ? "—" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
const json = (value: unknown) => JSON.stringify(value, null, 2);

function field(row: LocalTraceRow, col: Column): string {
  if (col === "time") return stamp(row.at);
  if (col === "trace") return row.traceId ?? row.turnId ?? "—";
  if (col === "duration") return elapsed(row.durationMs);
  if (col === "metadata") return JSON.stringify(row.metadata);
  return String(row[col] ?? "—");
}

function RowDetail({ row }: { row: LocalTraceRow }) {
  return <div className="space-y-3 bg-slate-50 p-4" data-trace-detail={row.id}>
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-600">
      <span>来源：{row.source}</span><span>开始：{stamp(row.at)}</span><span>结束：{stamp(row.endAt)}</span>
      <span>耗时：{elapsed(row.durationMs)}</span><span className="break-all">Session：{row.sessionId || "—"}</span>
    </div>
    <div className="grid gap-3 xl:grid-cols-2">
      {([['输入', row.input], ['输出', row.output]] as const).map(([label, content]) => <section key={label} className="min-w-0 rounded-lg border border-slate-200 bg-white">
        <h4 className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold text-slate-700">{label}</h4>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-5 text-slate-700">{content ?? (row.type === "MODEL" && label === "输出" ? "当前请求证据未提供模型响应。" : "当前记录未提供此字段。")}</pre>
      </section>)}
    </div>
    <details className="rounded-lg border border-slate-200 bg-white" open>
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">字段与来源信息</summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t border-slate-100 p-3 font-mono text-[10px] leading-5 text-slate-600">{json(row)}</pre>
    </details>
  </div>;
}

export function LocalRecordTrace({ detail, events, hasMore, olderLoading, onLoadOlder, evidenceLoading,
  evidenceError, contentLoading, contentError, onRetryEvidence, onRetryContent, onLoadMoreEvidence }: {
  detail: LocalRecordDetail; events: LocalRecordTimelineEvent[];
  hasMore: boolean; olderLoading: boolean; onLoadOlder: () => void;
  evidenceLoading: boolean; evidenceError: boolean; contentLoading: boolean; contentError: boolean;
  onRetryEvidence: () => void; onRetryContent: () => void; onLoadMoreEvidence: () => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [types, setTypes] = useState<TraceRowType[]>(TYPES.map(t => t.type));
  const [status, setStatus] = useState("");
  const [columns, setColumns] = useState<Column[]>(COLUMNS.slice(0, 10).map(c => c[0]));
  const [sort, setSort] = useState<{ field: "time" | "duration"; asc: boolean }>({ field: "time", asc: false });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const rows = useMemo(() => buildLocalTraceRows({ ...detail,
    ...(evidenceError ? { systemEvidence: undefined, toolEvidence: undefined } : {}),
    observedLlmRequests: contentError ? detail.observedLlmRequests.map(r => ({ ...r, content: undefined, contentAvailability: "unavailable" })) : detail.observedLlmRequests,
  }, events), [detail, events, evidenceError, contentError]);
  const typeCounts = useMemo(() => new Map(TYPES.map(t => [t.type, rows.filter(r => r.type === t.type).length])), [rows]);
  const statuses = useMemo(() => [...new Set(rows.map(r => r.status))].sort(), [rows]);
  const indexed = useMemo(() => rows.map(row => ({ row, text: [row.name, row.type, row.input, row.output, row.turnId,
    row.traceId, row.callId, row.eventId, row.model, row.pid, row.status, row.source, row.association, JSON.stringify(row.metadata)].join(" ").toLocaleLowerCase() })), [rows]);
  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLocaleLowerCase();
    return indexed.filter(({ row, text }) => types.includes(row.type) && (!status || row.status === status) && (!q || text.includes(q)))
      .map(({ row }) => row).sort((a, b) => {
        const x = sort.field === "time" ? a.at : a.durationMs;
        const y = sort.field === "time" ? b.at : b.durationMs;
        if (x === undefined || y === undefined) return x === y ? a.id.localeCompare(b.id) : x === undefined ? 1 : -1;
        return (sort.asc ? x - y : y - x) || a.id.localeCompare(b.id);
      });
  }, [indexed, deferredQuery, types, status, sort]);
  const histogram = useMemo(() => {
    const times = filtered.flatMap(r => r.at === undefined ? [] : [r.at]);
    if (!times.length) return undefined;
    const min = Math.min(...times), max = Math.max(...times), step = Math.max(1, (max - min + 1) / 32);
    const bins = Array.from({ length: 32 }, (_, i) => ({ at: min + i * step, count: 0 }));
    for (const time of times) bins[Math.min(31, Math.floor((time - min) / step))].count++;
    return { bins, min, max, peak: Math.max(...bins.map(b => b.count)) };
  }, [filtered]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleRows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const visibleColumns = COLUMNS.filter(c => columns.includes(c[0]));
  const download = () => {
    const blob = new Blob([json({ scope: "loaded_filtered_window", recordId: detail.record.recordId, exportedAt: new Date().toISOString(), rows: filtered })], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `anysentry-trace-${detail.record.recordId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const reset = () => { setQuery(""); setTypes(TYPES.map(t => t.type)); setStatus(""); setPage(0); };
  return <section data-trace-panel className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ListTree aria-hidden="true" className="size-4 text-teal-600" />Trace</h3>
      <div className="flex flex-wrap gap-2 text-[10px] text-slate-600">
        <span className="rounded-md bg-slate-50 px-2 py-1">{rows.length} 行 · 当前窗口</span>
        <span className="rounded-md bg-sky-50 px-2 py-1 text-sky-800">{typeCounts.get("MODEL")} 条 Observer 请求</span>
      </div>
    </header>
    {(evidenceError || contentError) && <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-900">
      <span>{evidenceError ? "系统证据读取失败，已暂时移除旧证据及关联状态。" : "模型请求内容读取失败，已暂时移除旧正文。"}</span>
      {evidenceError && <button className={control} onClick={onRetryEvidence}>重试系统证据</button>}
      {contentError && <button className={control} onClick={onRetryContent}>重试请求内容</button>}
    </div>}
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
      <label className="relative min-w-48 flex-1"><Search aria-hidden="true" className="absolute left-2.5 top-2 size-3.5 text-slate-400" />
        <input aria-label="搜索 Trace" placeholder="搜索名称、输入 / 输出、ID 或字段值…" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} className="w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-3 text-xs text-slate-800 outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500" /></label>
      <select aria-label="Trace 状态筛选" value={status} onChange={e => { setStatus(e.target.value); setPage(0); }} className={control}>
        <option value="">全部状态</option>{statuses.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <details className="relative" data-trace-columns><summary className={cn(control, "flex cursor-pointer list-none items-center gap-1.5")}><Columns3 aria-hidden="true" className="size-3.5" />字段列 {columns.length}/{COLUMNS.length}</summary>
        <div className="absolute right-0 top-full z-30 mt-2 grid w-64 grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
          {COLUMNS.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-[11px] text-slate-700"><input type="checkbox" className="accent-teal-600" checked={columns.includes(key)} disabled={columns.length === 1 && columns.includes(key)} onChange={() => setColumns(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])} />{label}</label>)}
        </div>
      </details>
      <button onClick={download} disabled={!filtered.length} className={cn(control, "flex items-center gap-1.5")}><Download aria-hidden="true" className="size-3.5" />导出 JSON</button>
      <button onClick={() => { onRetryEvidence(); onRetryContent(); }} disabled={evidenceLoading || contentLoading} className={cn(control, "flex items-center gap-1.5")}><RefreshCw aria-hidden="true" className={cn("size-3.5", (evidenceLoading || contentLoading) && "animate-spin")} />刷新证据</button>
    </div>
    <div className="grid min-w-0 lg:grid-cols-[170px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-50/60 p-3 lg:border-b-0 lg:border-r" aria-label="Trace 类型筛选">
        <div className="mb-3 flex items-center justify-between text-[11px]"><span className="flex items-center gap-1.5 font-semibold text-slate-700"><Filter aria-hidden="true" className="size-3.5" />筛选类型</span><button onClick={reset} className="rounded text-teal-700 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-teal-500">重置</button></div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1">{TYPES.map(t => <label key={t.type} className="flex cursor-pointer items-center gap-2 rounded-md py-1.5 text-[11px] text-slate-700">
          <input type="checkbox" className="accent-teal-600" checked={types.includes(t.type)} onChange={() => { setTypes(prev => prev.includes(t.type) ? prev.filter(v => v !== t.type) : [...prev, t.type]); setPage(0); }} />
          <TraceTypeIcon type={t.type} /><span>{t.label}</span><span className="ml-auto font-mono text-slate-500">{typeCounts.get(t.type)}</span>
        </label>)}</div>
        {(evidenceLoading || contentLoading) && <p role="status" className="mt-2 text-[10px] text-teal-700">正在读取独立采集证据…</p>}
      </aside>
      <div className="min-w-0">
        <div className="border-b border-slate-200 px-4 py-3" aria-label="Trace 时间分布">
          <div className="mb-2 flex justify-between text-[10px] text-slate-500"><span>记录分布 · 已筛选窗口</span><span aria-live="polite">{filtered.length} / {rows.length} 行</span></div>
          {histogram ? <><div className="flex h-12 items-end gap-1 border-b border-slate-100" role="img" aria-label={`${filtered.length} 行记录的时间分布，${stamp(histogram.min)} 至 ${stamp(histogram.max)}`}>
            {histogram.bins.map((bin, i) => <div key={i} title={`${stamp(bin.at)} · ${bin.count} 行`} className="min-w-0 flex-1 rounded-t-sm bg-teal-400/80" style={{ height: `${bin.count ? Math.max(5, bin.count / histogram.peak * 100) : 0}%` }} />)}
          </div><div className="mt-1 flex justify-between font-mono text-[9px] text-slate-400"><span>{stamp(histogram.min)}</span><span>{stamp(histogram.max)}</span></div></> : <p className="py-3 text-[11px] text-slate-400">当前筛选没有可展示的时间记录</p>}
        </div>
        <div className="max-h-[620px] overflow-auto" data-trace-scroll tabIndex={0} aria-label="Trace 明细表，可横向滚动">
          <table className="w-full table-fixed border-collapse text-left text-[11px]" style={{ minWidth: visibleColumns.reduce((sum, c) => sum + c[2], 40) }}>
            <caption className="sr-only">Trace 逐行明细。使用每行展开按钮查看输入、输出和字段信息。</caption>
            <colgroup><col style={{ width: 40 }} />{visibleColumns.map(c => <col key={c[0]} style={{ width: c[2] }} />)}</colgroup>
            <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] text-slate-500"><tr><th className="border-b border-slate-200"><span className="sr-only">展开</span></th>
              {visibleColumns.map(([key, label]) => <th key={key} scope="col" className="border-b border-slate-200 px-3 py-2.5 font-medium" aria-sort={(key === "time" || key === "duration") && sort.field === key ? sort.asc ? "ascending" : "descending" : undefined}>
                {key === "time" || key === "duration" ? <button onClick={() => { setSort({ field: key, asc: sort.field === key ? !sort.asc : false }); setPage(0); }} className="flex items-center gap-1 rounded focus-visible:ring-2 focus-visible:ring-teal-500">{label}{sort.field === key && (sort.asc ? <ArrowUp aria-hidden="true" className="size-3" /> : <ArrowDown aria-hidden="true" className="size-3" />)}</button> : label}
              </th>)}
            </tr></thead>
            <tbody>{visibleRows.map(row => <Fragment key={row.id}>
              <tr data-trace-row={row.id} data-trace-type={row.type} className={cn("group border-b border-slate-100 hover:bg-teal-50/40", expanded === row.id && "bg-teal-50/50")}>
                <td className="text-center"><button aria-label={`展开 ${row.name} ${row.eventId ?? row.turnId ?? ""}`} aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? undefined : row.id)} className="rounded p-2 text-slate-500 hover:text-teal-700 focus-visible:ring-2 focus-visible:ring-teal-500">{expanded === row.id ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button></td>
                {visibleColumns.map(([key]) => <td key={key} className={cn("px-3 py-2 text-slate-600", key === "input" && "bg-slate-50/60", key === "output" && "bg-teal-50/35")}>
                  {key === "type" ? <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[9px]", TYPES.find(t => t.type === row.type)?.color)}><TraceTypeIcon type={row.type} />{row.type}</span>
                    : <span className={cn("block truncate", ["time", "duration", "trace", "callId", "eventId", "pid", "metadata"].includes(key) && "font-mono text-[10px]", key === "name" && "font-medium text-slate-800", key === "status" && row.status.includes("失败") && "font-medium text-rose-700")}>{field(row, key)}</span>}
                </td>)}
              </tr>
              {expanded === row.id && <tr><td colSpan={visibleColumns.length + 1}><RowDetail row={row} /></td></tr>}
            </Fragment>)}</tbody>
          </table>
          {!visibleRows.length && <div className="p-10 text-center text-xs text-slate-500">没有符合当前筛选的记录。<button onClick={reset} className="ml-2 text-teal-700 underline">清除筛选</button></div>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-3 py-2">
          <span className="text-[10px] text-slate-500">{filtered.length ? currentPage * PAGE_SIZE + 1 : 0}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length} 行 · 每页 {PAGE_SIZE}</span>
          <div className="flex flex-wrap gap-2">
            {hasMore && <button className={control} disabled={olderLoading} onClick={onLoadOlder}>{olderLoading ? "加载中…" : "加载更早记录"}</button>}
            {detail.systemEvidence?.page.hasMore && <button className={control} disabled={evidenceLoading} onClick={onLoadMoreEvidence}>加载更多系统事件</button>}
            <button className={control} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
            <button className={control} disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>下一页</button>
          </div>
        </footer>
      </div>
    </div>
  </section>;
}
