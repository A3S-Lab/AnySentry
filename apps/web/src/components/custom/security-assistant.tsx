import {
  ArrowUpRight,
  Bot,
  ExternalLink,
  LoaderCircle,
  MessageSquareText,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useLocation } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  securityCenterApi,
  type SecurityAssistantAnswer,
  type SecurityAssistantContext,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";

interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: SecurityAssistantAnswer;
  failed?: boolean;
}

interface AssistantLauncherPosition {
  x: number;
  y: number;
}

const ASSISTANT_LAUNCHER_POSITION_KEY = "anysentry.assistant.launcher-position";
const ASSISTANT_PANEL_WIDTH_KEY = "anysentry.assistant.panel-width";
const ASSISTANT_LAUNCHER_SIZE = 48;
const ASSISTANT_LAUNCHER_MARGIN = 8;
const ASSISTANT_PANEL_DEFAULT_WIDTH = 440;
const ASSISTANT_PANEL_MIN_WIDTH = 360;
const ASSISTANT_PANEL_MAX_WIDTH = 960;

function id(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${suffix}`;
}

function pageContext(pathname: string, search: string): SecurityAssistantContext {
  const query = new URLSearchParams(search);
  return {
    path: `${pathname}${search}`,
    view: query.get("view") || undefined,
    timeType: (query.get("timeType") as SecurityAssistantContext["timeType"]) || "last_3h",
    startTime: query.get("startTime") || undefined,
    endTime: query.get("endTime") || undefined,
    agentId: query.get("agentId") || undefined,
    workspacePath: query.get("workspacePath") || undefined,
    eventId: query.get("eventId") || undefined,
    traceId: query.get("traceId") || undefined,
    agentAssetId: query.get("agentAssetId") || query.get("selectedAgentAssetId") || undefined,
    agentInstanceId: query.get("agentInstanceId") || undefined,
    invocationId: query.get("invocationId") || undefined,
    toolCallId: query.get("toolCallId") || undefined,
    incidentId: query.get("incidentId") || undefined,
    alertId: query.get("alertId") || undefined,
  };
}

function contextLabels(context: SecurityAssistantContext, locale: "en" | "zh-CN"): string[] {
  const page = context.view || context.path?.split("?")[0] || "/";
  const labels = [locale === "zh-CN" ? `页面 ${page}` : `Page ${page}`];
  if (context.agentId) labels.push(`Agent ${context.agentId}`);
  if (context.agentAssetId) labels.push(`Asset ${context.agentAssetId}`);
  if (context.invocationId) labels.push(`Invocation ${context.invocationId}`);
  if (context.workspacePath) labels.push(`Workspace ${context.workspacePath}`);
  if (context.eventId) labels.push(`Event ${context.eventId}`);
  if (context.traceId) labels.push(`Trace ${context.traceId}`);
  return labels.slice(0, 4);
}

function clampLauncherPosition(position: AssistantLauncherPosition): AssistantLauncherPosition {
  return {
    x: Math.min(
      Math.max(position.x, ASSISTANT_LAUNCHER_MARGIN),
      Math.max(ASSISTANT_LAUNCHER_MARGIN, window.innerWidth - ASSISTANT_LAUNCHER_SIZE - ASSISTANT_LAUNCHER_MARGIN),
    ),
    y: Math.min(
      Math.max(position.y, ASSISTANT_LAUNCHER_MARGIN),
      Math.max(ASSISTANT_LAUNCHER_MARGIN, window.innerHeight - ASSISTANT_LAUNCHER_SIZE - ASSISTANT_LAUNCHER_MARGIN),
    ),
  };
}

function initialLauncherPosition(): AssistantLauncherPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = JSON.parse(window.localStorage.getItem(ASSISTANT_LAUNCHER_POSITION_KEY) || "null") as Partial<AssistantLauncherPosition> | null;
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      return clampLauncherPosition({ x: Number(stored.x), y: Number(stored.y) });
    }
  } catch {
    // Ignore malformed browser state and use the default bottom-right position.
  }
  return null;
}

function clampPanelWidth(width: number): number {
  if (typeof window === "undefined") return ASSISTANT_PANEL_DEFAULT_WIDTH;
  const viewportLimit = Math.max(
    ASSISTANT_PANEL_MIN_WIDTH,
    window.innerWidth - 48,
  );
  return Math.min(
    Math.max(width, ASSISTANT_PANEL_MIN_WIDTH),
    Math.min(ASSISTANT_PANEL_MAX_WIDTH, viewportLimit),
  );
}

function initialPanelWidth(): number {
  if (typeof window === "undefined") return ASSISTANT_PANEL_DEFAULT_WIDTH;
  const stored = Number(window.localStorage.getItem(ASSISTANT_PANEL_WIDTH_KEY));
  return clampPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : ASSISTANT_PANEL_DEFAULT_WIDTH);
}

function MarkdownAnswer({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-6 text-slate-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-3 mt-5 text-lg font-semibold leading-7 text-slate-50 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2.5 mt-5 text-base font-semibold leading-7 text-slate-50 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-4 text-[15px] font-semibold leading-6 text-slate-100 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-2 mt-3 text-sm font-semibold text-slate-100 first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-slate-50">{children}</strong>,
          em: ({ children }) => <em className="text-slate-300">{children}</em>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-slate-500">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-slate-500">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-orange-400/50 bg-orange-400/5 px-3 py-1 text-slate-300">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-[#303846]" />,
          a: ({ href, children }) => {
            const external = Boolean(href && /^https?:\/\//i.test(href));
            return (
              <a
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer noopener" : undefined}
                className="font-medium text-cyan-300 underline decoration-cyan-400/40 underline-offset-2 hover:text-cyan-200"
              >
                {children}
              </a>
            );
          },
          code: ({ className, children }) => {
            const block = Boolean(className);
            return block ? (
              <code className={cn("font-mono text-[12px] leading-5 text-slate-200", className)}>{children}</code>
            ) : (
              <code className="rounded bg-black/35 px-1.5 py-0.5 font-mono text-[12px] text-orange-200">{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 max-w-full overflow-x-auto rounded-lg border border-[#303846] bg-[#090d12] p-3 text-left">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 max-w-full overflow-x-auto rounded-lg border border-[#303846]">
              <table className="w-full min-w-[520px] border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-white/[0.05] text-slate-200">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-[#29313e]">{children}</tbody>,
          tr: ({ children }) => <tr className="align-top">{children}</tr>,
          th: ({ children }) => <th className="border-r border-[#29313e] px-2.5 py-2 font-semibold last:border-r-0">{children}</th>,
          td: ({ children }) => <td className="border-r border-[#29313e] px-2.5 py-2 text-slate-300 last:border-r-0">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function SecurityAssistant() {
  const { locale } = useI18n();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [launcherPosition, setLauncherPosition] = useState<AssistantLauncherPosition | null>(initialLauncherPosition);
  const [draggingLauncher, setDraggingLauncher] = useState(false);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [resizingPanel, setResizingPanel] = useState(false);
  const sessionId = useRef(id("asa"));
  const launcherRef = useRef<HTMLButtonElement>(null);
  const launcherDrag = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const panelResize = useRef<{
    pointerId: number;
    pointerX: number;
    originWidth: number;
    currentWidth: number;
  } | null>(null);
  const suppressLauncherClick = useRef(false);
  const context = useMemo(
    () => pageContext(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const labels = useMemo(() => contextLabels(context, locale), [context, locale]);

  useEffect(() => {
    const keepLauncherVisible = () => {
      setLauncherPosition((current) => current ? clampLauncherPosition(current) : current);
      setPanelWidth((current) => clampPanelWidth(current));
    };
    window.addEventListener("resize", keepLauncherVisible);
    return () => window.removeEventListener("resize", keepLauncherVisible);
  }, []);

  const copy = locale === "zh-CN"
    ? {
        title: "AnySentry 智能助手",
        launcherHint: "点击打开，拖动可移动",
        subtitle: "由 A3S Code 提供 · 只读分析",
        resize: "拖动以调整助手宽度",
        close: "关闭助手",
        newChat: "新对话",
        context: "当前分析范围",
        welcome: "询问当前系统状态、安全风险或研判依据。",
        placeholder: "例如：当前哪些环节异常？",
        send: "发送",
        thinking: "正在汇总证据并分析…",
        sources: "相关证据",
        empty: "没有可关联的证据链接",
        failed: "助手暂时不可用，请检查模型端点后重试。",
        suggestions: ["当前哪些环节异常？", "检查当前页面的高风险事件", "最近有哪些复合攻击链？"],
      }
    : {
        title: "AnySentry Assistant",
        launcherHint: "Click to open, drag to move",
        subtitle: "Powered by A3S Code · Read-only",
        resize: "Drag to resize the assistant",
        close: "Close assistant",
        newChat: "New chat",
        context: "Current analysis scope",
        welcome: "Ask about the current system state, security risks, or judgment evidence.",
        placeholder: "For example: Which components are unhealthy?",
        send: "Send",
        thinking: "Collecting evidence and analyzing…",
        sources: "Related evidence",
        empty: "No related evidence links",
        failed: "The assistant is temporarily unavailable. Check the model endpoint and try again.",
        suggestions: ["Which components are unhealthy?", "Inspect high-risk events on this page", "What composite attack chains occurred recently?"],
      };

  const reset = () => {
    sessionId.current = id("asa");
    setMessages([]);
    setQuestion("");
  };

  const submit = async (textInput?: string) => {
    const text = (textInput ?? question).trim();
    if (!text || loading) return;
    const userMessage: AssistantMessage = { id: id("msg"), role: "user", content: text };
    const history = messages
      .filter((message) => !message.failed)
      .slice(-10)
      .map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setLoading(true);
    try {
      const response = await securityCenterApi.assistantQuery({
        sessionId: sessionId.current,
        question: text,
        locale,
        history,
        context,
      });
      sessionId.current = response.sessionId;
      setMessages((current) => [
        ...current,
        { id: id("msg"), role: "assistant", content: response.answer, response },
      ]);
    } catch (error) {
      const detail = error instanceof Error && error.message ? `\n${error.message}` : "";
      setMessages((current) => [
        ...current,
        { id: id("msg"), role: "assistant", content: `${copy.failed}${detail}`, failed: true },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        aria-label={copy.title}
        title={copy.launcherHint}
        style={launcherPosition ? { left: launcherPosition.x, top: launcherPosition.y } : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0 || open) return;
          const rect = launcherRef.current?.getBoundingClientRect();
          if (!rect) return;
          launcherDrag.current = {
            pointerId: event.pointerId,
            pointerX: event.clientX,
            pointerY: event.clientY,
            originX: rect.left,
            originY: rect.top,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = launcherDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const deltaX = event.clientX - drag.pointerX;
          const deltaY = event.clientY - drag.pointerY;
          if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
          drag.moved = true;
          setDraggingLauncher(true);
          setLauncherPosition(clampLauncherPosition({
            x: drag.originX + deltaX,
            y: drag.originY + deltaY,
          }));
        }}
        onPointerUp={(event) => {
          const drag = launcherDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          suppressLauncherClick.current = drag.moved;
          launcherDrag.current = null;
          setDraggingLauncher(false);
          if (drag.moved) {
            setLauncherPosition((current) => {
              if (current) {
                window.localStorage.setItem(ASSISTANT_LAUNCHER_POSITION_KEY, JSON.stringify(current));
              }
              return current;
            });
          }
        }}
        onPointerCancel={() => {
          launcherDrag.current = null;
          setDraggingLauncher(false);
        }}
        onClick={() => {
          if (suppressLauncherClick.current) {
            suppressLauncherClick.current = false;
            return;
          }
          setOpen(true);
        }}
        className={cn(
          "fixed z-[70] flex h-12 w-12 touch-none select-none items-center justify-center rounded-full",
          !launcherPosition && "bottom-5 right-5",
          "border border-orange-400/50 bg-[#171c25] text-orange-400 shadow-[0_12px_38px_rgba(0,0,0,0.5)]",
          "cursor-grab transition-[border-color,background-color,opacity,transform] hover:border-orange-400 hover:bg-[#202632] focus:outline-none focus:ring-2 focus:ring-orange-400/40 active:cursor-grabbing",
          !draggingLauncher && "hover:-translate-y-0.5",
          draggingLauncher && "scale-105",
          open && "pointer-events-none translate-x-20 opacity-0",
        )}
      >
        <Sparkles className="h-5 w-5" />
        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[#171c25] bg-emerald-400" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] bg-black/40 backdrop-blur-[1px] md:pointer-events-none md:bg-transparent md:backdrop-blur-none"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <aside
            aria-label={copy.title}
            style={{ "--assistant-panel-width": `${panelWidth}px` } as CSSProperties}
            className={cn(
              "pointer-events-auto absolute inset-y-0 right-0 flex w-full flex-col border-l border-[#2b3342] bg-[#0d1117]",
              "shadow-[-18px_0_50px_rgba(0,0,0,0.42)] md:w-[var(--assistant-panel-width)]",
              resizingPanel && "select-none",
            )}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={copy.resize}
              title={copy.resize}
              tabIndex={0}
              className={cn(
                "absolute inset-y-0 left-0 z-10 hidden w-3 -translate-x-1/2 touch-none cursor-col-resize items-center justify-center md:flex",
                "after:h-16 after:w-1 after:rounded-full after:bg-slate-600/40 after:transition-colors hover:after:bg-orange-400/80",
                resizingPanel && "after:bg-orange-400",
              )}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                panelResize.current = {
                  pointerId: event.pointerId,
                  pointerX: event.clientX,
                  originWidth: panelWidth,
                  currentWidth: panelWidth,
                };
                setResizingPanel(true);
                event.currentTarget.setPointerCapture(event.pointerId);
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                const resize = panelResize.current;
                if (!resize || resize.pointerId !== event.pointerId) return;
                const nextWidth = clampPanelWidth(
                  resize.originWidth + resize.pointerX - event.clientX,
                );
                resize.currentWidth = nextWidth;
                setPanelWidth(nextWidth);
              }}
              onPointerUp={(event) => {
                const resize = panelResize.current;
                if (!resize || resize.pointerId !== event.pointerId) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                window.localStorage.setItem(ASSISTANT_PANEL_WIDTH_KEY, String(resize.currentWidth));
                panelResize.current = null;
                setResizingPanel(false);
              }}
              onPointerCancel={() => {
                panelResize.current = null;
                setResizingPanel(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const direction = event.key === "ArrowLeft" ? 1 : -1;
                setPanelWidth((current) => {
                  const next = clampPanelWidth(current + direction * 24);
                  window.localStorage.setItem(ASSISTANT_PANEL_WIDTH_KEY, String(next));
                  return next;
                });
              }}
            />
            <header className="border-b border-[#252c38] bg-[#10151d] px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-orange-400/30 bg-orange-500/10 text-orange-400">
                    <Bot className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-semibold text-slate-100">{copy.title}</h2>
                    <p className="mt-0.5 truncate text-xs text-slate-500">{copy.subtitle}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon" title={copy.newChat} onClick={reset}>
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" title={copy.close} onClick={() => setOpen(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="mt-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
                  <MessageSquareText className="h-3 w-3" />
                  {copy.context}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {labels.map((label) => (
                    <span key={label} title={label} className="max-w-full truncate rounded-md border border-[#29313e] bg-[#151a22] px-2 py-1 text-[11px] text-slate-400">
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {!messages.length && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-[#28303d] bg-[#121720] p-4">
                    <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
                      <ShieldCheck className="h-5 w-5" />
                    </div>
                    <p className="text-sm leading-6 text-slate-200">{copy.welcome}</p>
                  </div>
                  <div className="space-y-2">
                    {copy.suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => void submit(suggestion)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-[#28303d] bg-[#10151c] px-3.5 py-3 text-left text-sm text-slate-300 transition hover:border-orange-400/40 hover:bg-[#161c25]"
                      >
                        <span>{suggestion}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-4">
                {messages.map((message) => (
                  <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[92%] rounded-xl px-3.5 py-3 text-sm leading-6",
                        message.role === "user"
                          ? "rounded-br-sm bg-orange-500/15 text-slate-100 ring-1 ring-orange-400/25"
                          : "rounded-bl-sm border border-[#28303d] bg-[#131820] text-slate-200",
                        message.failed && "border-red-500/30 bg-red-500/5 text-red-200",
                      )}
                    >
                      {message.role === "assistant"
                        ? <MarkdownAnswer content={message.content} />
                        : <div className="whitespace-pre-wrap break-words">{message.content}</div>}
                      {message.response && (
                        <div className="mt-3 border-t border-[#29313e] pt-3">
                          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                            <span>{message.response.model}</span>
                            <span>{(message.response.elapsedMs / 1000).toFixed(1)}s</span>
                            <span>{message.response.totalTokens} tokens</span>
                          </div>
                          <p className="text-[11px] text-slate-500">{message.response.evidenceSummary}</p>
                          {message.response.references.length > 0 && (
                            <div className="mt-3 space-y-1.5">
                              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">{copy.sources}</p>
                              {message.response.references.map((reference) => (
                                <Link
                                  key={`${reference.kind}-${reference.id}`}
                                  to={reference.href}
                                  onClick={() => setOpen(false)}
                                  className="flex items-center justify-between gap-2 rounded-md border border-[#29313e] bg-[#0d1218] px-2.5 py-2 text-xs text-cyan-300 transition hover:border-cyan-400/30 hover:bg-[#141a22]"
                                >
                                  <span className="truncate">{reference.label}</span>
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </Link>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 rounded-xl rounded-bl-sm border border-[#28303d] bg-[#131820] px-3.5 py-3 text-sm text-slate-400">
                      <LoaderCircle className="h-4 w-4 animate-spin text-orange-400" />
                      {copy.thinking}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <footer className="border-t border-[#252c38] bg-[#10151d] p-3">
              <div className="rounded-xl border border-[#303846] bg-[#0b0f15] p-2 focus-within:border-orange-400/45">
                <textarea
                  value={question}
                  rows={3}
                  maxLength={4000}
                  disabled={loading}
                  placeholder={copy.placeholder}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  className="max-h-32 min-h-[58px] w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-5 text-slate-100 outline-none placeholder:text-slate-600"
                />
                <div className="flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-[11px] text-slate-600">
                    <ShieldCheck className="h-3 w-3" />
                    Read-only
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={loading || !question.trim()}
                    onClick={() => void submit()}
                    className="bg-orange-500 text-white hover:bg-orange-400"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {copy.send}
                  </Button>
                </div>
              </div>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
