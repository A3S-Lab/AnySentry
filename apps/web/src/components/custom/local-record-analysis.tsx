import { useRequest } from 'ahooks';
import { Activity, BarChart3, Clock3, Coins, Download, FileCheck2, ShieldCheck, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { securityCenterApi, type LocalRecordDetail, type LocalRecordTimelineEvent } from '@/lib/api/security-center';
import { buildSessionAnalysis, distribution, estimateAnalysisCost, type SessionAnalysis } from '@/lib/local-record-analysis';
import type { LocalTraceRow, TraceRowType } from '@/lib/local-record-trace';

const number = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const duration = (value?: number) => value === undefined ? '—' : value < 1000 ? `${number(value)} ms`
  : value < 60_000 ? `${number(value / 1000)} s` : `${number(value / 60_000)} min`;
const time = (value?: number) => value === undefined ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false });
const control = 'min-h-9 min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600';
const typeNames: Record<TraceRowType, string> = { TURN: 'Turn', MODEL: '模型请求', TOOL: '工具记录', MESSAGE: '消息', SYSTEM: '系统证据' };
const tones: Record<TraceRowType, string> = { TURN: 'bg-teal-500', MODEL: 'bg-blue-500', TOOL: 'bg-violet-500', MESSAGE: 'bg-slate-400', SYSTEM: 'bg-amber-500' };

function Panel({ title, icon, hint, children }: { title: string; icon: ReactNode; hint?: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">{icon}{title}</h3>
    {hint && <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>}
    <div className="mt-4">{children}</div>
  </section>;
}
function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return <div className="min-w-0 rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-600">{label}</div>
    <div className="mt-1 break-words text-lg font-semibold tabular-nums text-slate-900">{value}</div>
    {hint && <div className="mt-1 text-[11px] leading-4 text-slate-500">{hint}</div>}</div>;
}
function Bar({ label, value, total, color = 'bg-teal-500' }: { label: string; value: number; total: number; color?: string }) {
  return <div><div className="mb-1 flex justify-between gap-3 text-xs"><span className="break-all text-slate-600">{label}</span><span className="shrink-0 tabular-nums text-slate-900">{compact(value)}{total > 0 && <span className="ml-2 text-slate-500">{number(value / total * 100)}%</span>}</span></div>
    <div className="h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true"><div className={`h-full rounded-full ${color}`} style={{ width: `${total > 0 ? Math.min(100, value / total * 100) : 0}%` }} /></div></div>;
}

function ResourcePanel({ recordId }: { recordId: string }) {
  const request = useRequest(() => securityCenterApi.localRecordResources(recordId), { refreshDeps: [recordId], pollingInterval: 15_000, pollingWhenHidden: false });
  const resource = request.data?.recordId === recordId ? request.data : undefined;
  const samples = request.error ? [] : resource?.samples ?? [];
  const current = samples.at(-1);
  const cpu = samples.flatMap(sample => sample.cpuPercent === undefined ? [] : [sample.cpuPercent]);
  const rss = samples.flatMap(sample => sample.rssBytes === undefined ? [] : [sample.rssBytes]);
  const available = !request.error && resource?.state === 'observed';
  const reason = request.error ? '资源采样请求失败' : request.loading && !resource ? '正在读取进程资源…'
    : resource?.state === 'shared' ? '该进程被多个会话共享，无法分摊资源'
      : resource?.state === 'unbound' ? '尚无唯一、有效的 Session 进程绑定'
        : resource?.state === 'unavailable' ? '宿主机 /proc 不可读取，或进程已退出' : undefined;
  return <Panel title="资源与进程" icon={<Activity className="size-4 text-teal-600" />} hint="绑定进程的实时采样；不包含子进程，也不回填历史资源。">
    <div className="grid grid-cols-2 gap-2">
      <Stat label="当前 CPU" value={current?.cpuPercent === undefined ? '—' : `${number(current.cpuPercent)}%`} hint={available && cpu.length === 0 ? '等待第二次采样' : '单核 100%，多核可超过 100%'} />
      <Stat label="当前 RSS" value={current?.rssBytes === undefined ? '—' : `${number(current.rssBytes / 1048576)} MiB`} />
      <Stat label="采样峰值 CPU" value={cpu.length ? `${number(Math.max(...cpu))}%` : '—'} />
      <Stat label="采样峰值 RSS" value={rss.length ? `${number(Math.max(...rss) / 1048576)} MiB` : '—'} />
    </div>
    {samples.length > 1 && <div className="mt-3">
      <div className="mb-1 text-xs text-slate-500">RSS 趋势 · {samples.length} 个采样</div>
      <svg viewBox="0 0 400 64" className="h-16 w-full" role="img" aria-label="绑定进程 RSS 采样趋势，具体数值见下方采样明细">
        <polyline fill="none" stroke="#0d9488" strokeWidth="2" points={samples.filter(sample => sample.rssBytes !== undefined).map(sample => `${(sample.at - samples[0].at) / Math.max(1, samples.at(-1)!.at - samples[0].at) * 396 + 2},${60 - sample.rssBytes! / Math.max(1, ...rss) * 52}`).join(' ')} />
      </svg>
    </div>}
    <p className="mt-3 text-xs leading-5 text-slate-600" role="status">{reason ?? `PID ${resource?.pid} · ${samples.length} 个采样 · 最近 ${time(current?.at)}`}</p>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500"><span>每 15 秒读取 · 内存中最多保留 240 点</span><Button variant="outline" size="sm" onClick={() => request.refresh()}>刷新资源</Button></div>
    {samples.length > 0 && <details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer">采样明细 · 平均 CPU {cpu.length ? `${number(cpu.reduce((a, b) => a + b, 0) / cpu.length)}%` : '—'}</summary>
      <div className="mt-2 max-h-32 overflow-auto"><table className="w-full text-left"><thead><tr><th>时间</th><th>CPU</th><th>RSS</th></tr></thead><tbody>{samples.slice(-20).reverse().map(sample => <tr key={sample.at}><td>{time(sample.at)}</td><td>{sample.cpuPercent === undefined ? '—' : `${number(sample.cpuPercent)}%`}</td><td>{sample.rssBytes === undefined ? '—' : `${number(sample.rssBytes / 1048576)} MiB`}</td></tr>)}</tbody></table></div>
    </details>}
  </Panel>;
}

function CostPanel({ analysis }: { analysis: SessionAnalysis }) {
  const [rates, setRates] = useState(['', '', '']);
  const [currency, setCurrency] = useState('CNY');
  const cost = estimateAnalysisCost(analysis.tokens, rates);
  return <Panel title="费用估算" icon={<Coins className="size-4 text-teal-600" />} hint="按当前报告用量与填写的统一单价估算，不代表账单或订阅额度。">
    <div className="flex items-center justify-between gap-3"><div className="text-2xl font-semibold tabular-nums text-slate-900" data-analysis-cost>{cost === undefined ? '—' : `${currency} ${cost.toFixed(4)}`}</div>
      <label className="text-xs text-slate-600">币种 <select className={control} aria-label="估算币种" value={currency} onChange={event => setCurrency(event.target.value)}><option>CNY</option><option>USD</option></select></label></div>
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">{['非缓存输入单价', '缓存综合单价', '输出单价'].map((label, index) => <label key={label} className="text-xs text-slate-600">{label}<input aria-label={label} className={`${control} mt-1 w-full`} type="number" min="0" step="any" placeholder="待配置" value={rates[index]} onChange={event => setRates(values => values.map((value, i) => i === index ? event.target.value : value))} /><span className="mt-1 block text-[11px]">{currency} / 百万 Token</span></label>)}</div>
    <p className="mt-3 text-xs leading-5 text-slate-500">{!analysis.tokens.consistent ? '当前 Token 分类与报告总量未对齐，暂不计算费用。' : analysis.tokens.cacheIncludesWrites ? '缓存计数包含读与写，请填写综合单价。' : '缓存输入单独计费，推理用量不会重复相加。'} 模型切换时请使用加权单价；当前数据没有逐模型用量账本。</p>
  </Panel>;
}

type Review = { score: string; note: string; updatedAt?: number };
function ReviewPanel({ recordId }: { recordId: string }) {
  const key = `anysentry.session-review.v1:${recordId}`;
  const [review, setReview] = useState<Review>({ score: '', note: '' });
  const [message, setMessage] = useState('');
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (value && /^[1-5]$/.test(value.score) && typeof value.note === 'string') setReview({ score: value.score, note: value.note.slice(0, 2000), updatedAt: value.updatedAt });
    } catch { setMessage('浏览器存储不可用，评价无法持久保存。'); }
  }, [key]);
  function save() {
    try { const value = { ...review, updatedAt: Date.now() }; localStorage.setItem(key, JSON.stringify(value)); setReview(value); setMessage('已保存到当前浏览器。'); }
    catch { setMessage('保存失败：浏览器存储不可用或空间不足。'); }
  }
  return <Panel title="会话评价" icon={<FileCheck2 className="size-4 text-teal-600" />} hint="人工评价任务完成质量，与工具错误率分别记录。仅保存在当前浏览器，不同步团队。">
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-600">完成质量</span>{[1, 2, 3, 4, 5].map(score => <button key={score} type="button" aria-pressed={review.score === String(score)} aria-label={`评价 ${score} 分`} className={`${control} w-10 ${review.score === String(score) ? 'border-teal-600 bg-teal-50 font-semibold text-teal-800' : ''}`} onClick={() => { setReview(value => ({ ...value, score: String(score), updatedAt: undefined })); setMessage('尚未保存'); }}>{score}</button>)}<span className="text-xs text-slate-500">1 低 · 5 高</span></div>
    <label className="mt-3 block text-xs text-slate-600">评价说明<textarea aria-label="评价说明" className={`${control} mt-1 min-h-20 w-full resize-y`} maxLength={2000} placeholder="记录是否完成任务、结果是否正确，以及需要改进的地方。" value={review.note} onChange={event => { setReview(value => ({ ...value, note: event.target.value, updatedAt: undefined })); setMessage('尚未保存'); }} /></label>
    <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="sm" disabled={!review.score} onClick={save}>保存评价</Button><Button size="sm" variant="outline" onClick={() => { try { localStorage.removeItem(key); setReview({ score: '', note: '' }); setMessage('本地评价已删除'); } catch { setMessage('无法删除浏览器中的评价'); } }}>清除</Button><span role="status" className="text-xs text-slate-500">{message || (review.updatedAt ? `保存于 ${time(review.updatedAt)}` : '未评价 · 不自动推断成功')}</span></div>
  </Panel>;
}

function AnalysisTimeline({ rows }: { rows: LocalTraceRow[] }) {
  const [type, setType] = useState('all'), [source, setSource] = useState('all'), [pid, setPid] = useState('all');
  const [onlyFailed, setOnlyFailed] = useState(false), [zoom, setZoom] = useState(1), [position, setPosition] = useState(0);
  const [page, setPage] = useState(0), [selectedId, setSelectedId] = useState<string>();
  const filtered = useMemo(() => rows.filter(row => (type === 'all' || row.type === type)
    && (source === 'all' || row.source === source) && (pid === 'all' || String(row.pid) === pid)
    && (!onlyFailed || row.status.includes('失败') || /^(deny|block|blocked)$/i.test(row.status))), [rows, type, source, pid, onlyFailed]);
  const timestamps = filtered.flatMap(row => row.at === undefined ? [] : [row.at, row.endAt ?? row.at]);
  const start = timestamps.length ? Math.min(...timestamps) : 0;
  const end = timestamps.length ? Math.max(...timestamps) : start;
  const span = Math.max(1, end - start), width = span / zoom;
  const left = start + (span - width) * position / 100, right = left + width;
  const visible = filtered.filter(row => row.at === undefined ? zoom === 1 : row.at <= right && (row.endAt ?? row.at) >= left);
  const pages = Math.max(1, Math.ceil(visible.length / 25)), safePage = Math.min(page, pages - 1);
  const selected = rows.find(row => row.id === selectedId);
  useEffect(() => { setPage(0); }, [type, source, pid, onlyFailed, zoom, position]);
  const lanes = (Object.keys(typeNames) as TraceRowType[]).map(kind => {
    const bins: LocalTraceRow[][] = Array.from({ length: 40 }, () => []);
    for (const row of visible.filter(row => row.type === kind && row.at !== undefined)) {
      const index = Math.min(39, Math.max(0, Math.floor((row.at! - left) / width * 40)));
      bins[index].push(row);
    }
    return { kind, bins };
  });
  return <Panel title="执行时间线" icon={<Activity className="size-4 text-teal-600" />} hint="按事件发生时间分布；原生工具记录与 Observer 系统证据分轨显示。点击时间格查看事件。">
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-slate-600">类型<select aria-label="分析事件类型" className={`${control} ml-2`} value={type} onChange={event => setType(event.target.value)}><option value="all">全部类型</option>{Object.entries(typeNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label className="text-xs text-slate-600">来源<select aria-label="分析事件来源" className={`${control} ml-2`} value={source} onChange={event => setSource(event.target.value)}><option value="all">全部来源</option>{[...new Set(rows.map(row => row.source))].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="text-xs text-slate-600">PID<select aria-label="分析事件 PID" className={`${control} ml-2`} value={pid} onChange={event => setPid(event.target.value)}><option value="all">全部 PID</option>{[...new Set(rows.flatMap(row => row.pid === undefined ? [] : [row.pid]))].sort((a, b) => a - b).map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="flex min-h-9 items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={onlyFailed} onChange={event => setOnlyFailed(event.target.checked)} />仅失败 / 拦截</label>
      <div className="ml-auto flex items-center gap-2"><Button size="sm" variant="outline" aria-label="缩小时间线" disabled={zoom === 1} onClick={() => setZoom(value => Math.max(1, value / 2))}>−</Button><span className="text-xs text-slate-600">{zoom}×</span><Button size="sm" variant="outline" aria-label="放大时间线" disabled={zoom === 16} onClick={() => setZoom(value => Math.min(16, value * 2))}>+</Button><Button size="sm" variant="outline" onClick={() => { setZoom(1); setPosition(0); setType('all'); setSource('all'); setPid('all'); setOnlyFailed(false); }}>重置</Button></div>
    </div>
    {zoom > 1 && <label className="mt-3 flex items-center gap-3 text-xs text-slate-600">时间窗口位置<input aria-label="时间窗口位置" className="min-w-0 flex-1 accent-teal-600" type="range" min="0" max="100" value={position} onChange={event => setPosition(Number(event.target.value))} /></label>}
    <div className="mt-4 space-y-2">{lanes.filter(lane => type === 'all' || lane.kind === type).map(lane => <div key={lane.kind} className="grid grid-cols-[70px_minmax(0,1fr)] items-center gap-2"><span className="text-xs text-slate-600">{typeNames[lane.kind]}</span><div className="grid h-8 grid-cols-[repeat(40,minmax(0,1fr))] gap-px rounded bg-slate-50">{lane.bins.map((bin, i) => bin.length ? <button type="button" key={i} aria-label={`${typeNames[lane.kind]} ${time(left + width * i / 40)}，${bin.length} 条事件`} title={`${bin.length} 条 · ${time(left + width * i / 40)}`} className={`my-1 rounded-sm ${tones[lane.kind]} focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-900`} style={{ opacity: .45 + Math.min(bin.length, 10) * .055 }} onClick={() => setSelectedId(bin[0].id)} /> : <span key={i} />)}</div></div>)}</div>
    <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-slate-500"><span>{timestamps.length ? time(left) : '没有可用时间戳'}</span><span>{visible.length} 条记录 · {timestamps.length ? duration(right - left) : '—'}</span><span>{timestamps.length ? time(right) : ''}</span></div>
    <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs" data-analysis-events><thead className="border-b text-slate-500"><tr>{['时间', '类型 / 名称', '来源', '耗时', '状态', '详情'].map(label => <th key={label} className="px-2 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{visible.slice(safePage * 25, safePage * 25 + 25).map(row => <tr key={row.id} className="border-b border-slate-100 text-slate-700"><td className="whitespace-nowrap px-2 py-2">{time(row.at)}</td><td className="max-w-52 truncate px-2 py-2" title={row.name}>{typeNames[row.type]} · {row.name}</td><td className="px-2 py-2">{row.source}</td><td className="whitespace-nowrap px-2 py-2">{duration(row.durationMs)}</td><td className="px-2 py-2">{row.status}</td><td><button type="button" className="rounded px-2 py-2 text-teal-700 underline focus-visible:outline" onClick={() => setSelectedId(row.id)}>查看</button></td></tr>)}</tbody></table></div>
    {visible.length === 0 && <p className="py-5 text-center text-sm text-slate-500">当前筛选范围没有事件</p>}
    <div className="mt-3 flex items-center justify-end gap-3 text-xs text-slate-600"><Button size="sm" variant="outline" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</Button>{safePage + 1} / {pages}<Button size="sm" variant="outline" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>下一页</Button></div>
    {selected && <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50/40 p-3 text-xs text-slate-700" role="region" aria-label="分析事件详情"><div className="flex justify-between gap-2"><strong>{selected.name} · {selected.source}</strong><button type="button" className="rounded px-2 text-teal-700 underline" onClick={() => setSelectedId(undefined)}>关闭详情</button></div><p className="mt-2 break-all">{time(selected.at)} · {selected.status} · {selected.association ?? '原生记录'}{selected.pid !== undefined ? ` · PID ${selected.pid}` : ''}</p><p className="mt-1 break-all">Turn {selected.turnId ?? '—'} · Call {selected.callId ?? '—'}</p><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono">{[selected.input, selected.output].filter(Boolean).join('\n\n') || '该事件没有可展示的输入输出'}</pre></div>}
  </Panel>;
}

interface Props {
  detail: LocalRecordDetail; events: LocalRecordTimelineEvent[]; hasMore: boolean; olderLoading: boolean;
  onLoadOlder: () => void; evidenceLoading: boolean; evidenceError: boolean; onRetryEvidence: () => void; onLoadMoreEvidence: () => void;
}
export function LocalRecordAnalysis({ detail, events, hasMore, olderLoading, onLoadOlder, evidenceLoading, evidenceError, onRetryEvidence, onLoadMoreEvidence }: Props) {
  const analysis = useMemo(() => buildSessionAnalysis(detail, events), [detail, events]);
  const { record } = detail;
  const tokenColors = ['bg-teal-500', 'bg-blue-500', 'bg-violet-500', 'bg-amber-500'];
  function download() {
    const payload = { schemaVersion: 'anysentry.session-analysis.v1', generatedAt: new Date().toISOString(), sessionId: record.sessionId,
      scope: 'loaded_events', loadedEvents: events.length, hasMore, tokenScope: record.adapter === 'codex' ? 'reported_cumulative' : detail.metrics.scope,
      tokens: analysis.tokens, latency: analysis.latency, tools: analysis.tools, evidence: { events: analysis.system.length, confirmedCalls: analysis.confirmed, candidateCalls: analysis.candidate },
      note: '不包含会话原文、浏览器内人工评价或账单。' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `anysentry-analysis-${record.recordId}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="space-y-4 text-slate-900" data-session-analysis>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-semibold"><BarChart3 className="size-5 text-teal-600" />会话分析</h2></div><div className="flex flex-wrap gap-2">{hasMore && <Button size="sm" variant="outline" disabled={olderLoading} onClick={onLoadOlder}>{olderLoading ? '加载中…' : '加载更早记录'}</Button>}<Button size="sm" variant="outline" onClick={download}><Download className="mr-1 size-3.5" />导出分析</Button></div></div>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
      <Stat label="已加载 Turn" value={analysis.turns} hint={`${analysis.completed} 个完成事件 · ${analysis.users} 条用户消息`} />
      <Stat label="工具调用" value={analysis.calls.length} hint={`${analysis.success} 成功 · ${analysis.failure} 失败 · ${analysis.unknown} 未定`} />
      <Stat label="已知结果失败率" value={analysis.failureRate === undefined ? '—' : `${number(analysis.failureRate * 100)}%`} hint="失败 /（成功 + 失败），不含未定" />
      <Stat label="完成 Turn 耗时合计" value={duration(analysis.completedDuration)} hint={`有效样本 ${analysis.latency.turn.count} · 不等于会话跨度`} />
      <Stat label="报告 Token" value={compact(analysis.tokens.total)} hint={record.adapter === 'codex' ? '源记录累计值 · 与加载窗口不同' : detail.metrics.scope === 'full_record' ? '完整记录报告值' : '解析窗口报告值'} />
    </div>
    <div className="grid gap-4 xl:grid-cols-3">
      <Panel title="Token 构成" icon={<BarChart3 className="size-4 text-teal-600" />} hint="输入与缓存拆分展示，避免重复累加。">
        <div className="space-y-4">{analysis.tokens.parts.map((part, index) => <Bar key={part.key} label={part.label} value={part.value} total={analysis.tokens.accounted} color={tokenColors[index]} />)}</div>
        {!analysis.tokens.consistent && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">{analysis.tokens.total === 0 ? '源记录未报告有效 Token 用量。' : '分类合计与报告总量不一致，占比仅针对已解析分类。'}</p>}
        <dl className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-xs"><div className="flex justify-between gap-3"><dt className="text-slate-500">最近记录模型</dt><dd className="break-all text-right">{record.model || '未记录'}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">缓存占输入</dt><dd>{analysis.tokens.uncached + analysis.tokens.cached > 0 ? `${number(analysis.tokens.cached / (analysis.tokens.uncached + analysis.tokens.cached) * 100)}%` : '—'}</dd></div><div className="flex justify-between"><dt className="text-slate-500">报告推理 Token</dt><dd>{compact(analysis.tokens.reasoning)}</dd></div><div className="flex justify-between"><dt className="text-slate-500">上下文容量</dt><dd>{analysis.usage.contextWindow ? compact(analysis.usage.contextWindow) : '未记录'}</dd></div></dl>
        <p className="mt-3 text-[11px] leading-5 text-slate-500">未将总用量归给最近模型；当前接口不提供逐模型 Token 分账。</p>
      </Panel>
      <Panel title="耗时分布" icon={<Clock3 className="size-4 text-teal-600" />} hint="P50 为中位数，P95 反映较慢样本。缺失或未配对的耗时不记为 0。">
        <table className="w-full text-left text-xs"><thead className="border-b text-slate-500"><tr><th className="py-2 font-medium">指标 / 样本</th><th className="font-medium">P50</th><th className="font-medium">P95</th><th className="font-medium">最大</th></tr></thead><tbody>{([['Turn', analysis.latency.turn], ['工具', analysis.latency.tool], ['TTFT', analysis.latency.ttft]] as const).map(([name, stats]) => <tr key={name} className="border-b border-slate-100"><td className="py-3">{name} <span className="text-slate-500">({stats.count})</span></td><td>{duration(stats.p50)}</td><td>{duration(stats.p95)}</td><td>{duration(stats.max)}</td></tr>)}</tbody></table>
        <p className="mt-3 text-xs leading-5 text-slate-500">工具耗时使用同 Turn、同 Call ID 的唯一结果配对。模型请求尚无完整响应耗时，不能替代 LLM 延迟。</p>
        <div className="mt-4 grid grid-cols-2 gap-2"><Stat label="记录跨度" value={duration(Math.max(0, record.updatedAt - record.startedAt))} hint="首条元数据至最后更新" /><Stat label="独立工具结果" value={analysis.orphanResults} hint="调用未加载或无法唯一配对" /></div>
      </Panel>
      <ResourcePanel recordId={record.recordId} />
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="工具执行分布" icon={<Wrench className="size-4 text-teal-600" />} hint="原生工具调用统计；失败来自 Tool Result，不代表最终任务失败。">
        {analysis.tools.length ? <div className="max-h-80 space-y-4 overflow-auto pr-1">{analysis.tools.map(tool => <div key={tool.name}><Bar label={tool.name} value={tool.calls} total={analysis.calls.length} color="bg-violet-500" /><div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500"><span>成功 {tool.success}</span><span className={tool.failure ? 'text-rose-700' : ''}>失败 {tool.failure}</span><span>未定 {tool.unknown}</span><span>P95 {duration(distribution(tool.durations).p95)}</span></div></div>)}</div> : <p className="py-6 text-sm text-slate-500">已加载记录中没有工具调用</p>}
      </Panel>
      <Panel title="系统活动与证据覆盖" icon={<ShieldCheck className="size-4 text-teal-600" />} hint="仅统计归属于此 Session 的 Observer 事件；候选关联不计入可信调用。">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Stat label="系统事件" value={analysis.evidence ? analysis.system.length : '—'} /><Stat label="进程代际" value={analysis.evidence ? analysis.processes : '—'} /><Stat label="可信 Call" value={analysis.evidence ? analysis.confirmed : '—'} /><Stat label="候选 Call" value={analysis.evidence ? analysis.candidate : '—'} /></div>
        <p className="mt-3 text-xs leading-5 text-slate-600">{evidenceError ? '系统证据加载失败，已有值可能过期。' : evidenceLoading ? '正在加载系统证据…' : analysis.evidence ? `${analysis.blocked} 条系统拦截 · ${analysis.unchecked} 个调用未获可信或候选关联 · ${analysis.evidence.completeness === 'complete_as_observed' ? '已观测范围' : '部分覆盖'}` : '尚无可用的会话级系统证据，不能据此判断没有系统活动。'}</p>
        <div className="mt-3 flex flex-wrap gap-2">{analysis.categories.slice(0, 12).map(([name, value]) => <span key={name} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">{name} <strong>{value}</strong></span>)}</div>
        <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={evidenceLoading} onClick={onRetryEvidence}>刷新证据</Button>{analysis.evidence?.page.hasMore && <Button size="sm" variant="outline" disabled={evidenceLoading} onClick={onLoadMoreEvidence}>加载更多系统事件</Button>}</div>
      </Panel>
      <CostPanel analysis={analysis} />
      <ReviewPanel recordId={record.recordId} />
    </div>
    <AnalysisTimeline rows={analysis.rows} />
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600"><summary className="cursor-pointer font-medium text-slate-800">数据来源与统计范围</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><p>Session：{record.adapter} · CLI {record.cliVersion || '未知'}<br />源文件 {(record.fileBytes / 1048576).toFixed(1)} MiB · 当前扫描 {(detail.metrics.scannedBytes / 1048576).toFixed(1)} MiB<br />已加载原生事件 {analysis.events.length} · API 扫描范围 {detail.metrics.scope === 'full_record' ? '完整记录' : '有界窗口'}{detail.page.truncatedLines ? ` · ${detail.page.truncatedLines} 条超限行` : ''}</p><p>原生记录：Agent 声明及结果；Observer：独立系统观测；资源：宿主机 /proc。<br />费用是自定义单价估算；质量评分由人工填写。<br />未采集、未加载和未能归属的数据均不代表零活动或任务成功。</p></div></details>
  </div>;
}
