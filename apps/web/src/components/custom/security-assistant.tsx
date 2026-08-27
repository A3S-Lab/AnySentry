import {
  ArrowUpRight,
  Bot,
  ChevronRight,
  ExternalLink,
  GitBranch,
  History,
  LoaderCircle,
  MessageSquareText,
  Plus,
  Radar,
  RadioTower,
  Send,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Sparkles,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { Link, useLocation } from "react-router-dom";
import remarkGfm from "remark-gfm";
import {
  COLLAPSED_SECURITY_SIDEBAR_WIDTH,
  useSecurityConsole,
} from "@/components/custom/security-console-header";
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

interface AssistantSavedSession {
  id: string;
  title: string;
  updatedAt: string;
  messages: AssistantMessage[];
}

interface AssistantLauncherPosition {
  x: number;
  y: number;
}

type SecurityAssistantMode = "floating" | "embedded";

interface AssistantCapability {
  label: string;
  description: string;
  prompts: string[];
  icon: LucideIcon;
}

const CAPABILITY_TONES = [
  {
    card: "border-violet-300/90 bg-violet-100/90",
    active: "border-violet-500 bg-violet-200/95 shadow-[0_14px_28px_rgba(124,58,237,0.18)]",
    number: "bg-violet-500",
    title: "text-violet-950",
  },
  {
    card: "border-sky-300/90 bg-sky-100/90",
    active: "border-sky-500 bg-sky-200/95 shadow-[0_14px_28px_rgba(14,165,233,0.18)]",
    number: "bg-sky-500",
    title: "text-sky-950",
  },
  {
    card: "border-amber-300/90 bg-amber-100/90",
    active: "border-amber-500 bg-amber-200/95 shadow-[0_14px_28px_rgba(245,158,11,0.18)]",
    number: "bg-amber-500",
    title: "text-amber-950",
  },
  {
    card: "border-orange-300/90 bg-orange-100/90",
    active: "border-orange-500 bg-orange-200/95 shadow-[0_14px_28px_rgba(249,115,22,0.18)]",
    number: "bg-orange-500",
    title: "text-orange-950",
  },
  {
    card: "border-cyan-300/90 bg-cyan-100/90",
    active: "border-cyan-500 bg-cyan-200/95 shadow-[0_14px_28px_rgba(6,182,212,0.18)]",
    number: "bg-cyan-500",
    title: "text-cyan-950",
  },
  {
    card: "border-teal-300/90 bg-teal-100/90",
    active: "border-teal-500 bg-teal-200/95 shadow-[0_14px_28px_rgba(20,184,166,0.18)]",
    number: "bg-teal-500",
    title: "text-teal-950",
  },
  {
    card: "border-slate-300/90 bg-slate-100/95",
    active: "border-slate-500 bg-slate-200/95 shadow-[0_14px_28px_rgba(71,85,105,0.16)]",
    number: "bg-slate-600",
    title: "text-slate-900",
  },
] as const;

const ASSISTANT_LAUNCHER_POSITION_KEY = "anysentry.assistant.launcher-position";
const ASSISTANT_PANEL_WIDTH_KEY = "anysentry.assistant.panel-width";
const ASSISTANT_HISTORY_KEY = "anysentry.assistant.history.v1";
const ASSISTANT_LAUNCHER_SIZE = 48;
const ASSISTANT_LAUNCHER_MARGIN = 8;
const ASSISTANT_PANEL_DEFAULT_WIDTH = 440;
const ASSISTANT_PANEL_MIN_WIDTH = 360;
const ASSISTANT_PANEL_MAX_WIDTH = 960;

function initialSavedSessions(): AssistantSavedSession[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(ASSISTANT_HISTORY_KEY) || "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is AssistantSavedSession => Boolean(
        item &&
        typeof item === "object" &&
        "id" in item &&
        typeof item.id === "string" &&
        "title" in item &&
        typeof item.title === "string" &&
        "updatedAt" in item &&
        typeof item.updatedAt === "string" &&
        "messages" in item &&
        Array.isArray(item.messages),
      ))
      .slice(0, 20);
  } catch {
    return [];
  }
}

function persistSavedSessions(sessions: AssistantSavedSession[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ASSISTANT_HISTORY_KEY, JSON.stringify(sessions.slice(0, 20)));
  } catch {
    // Keep the newest conversations when browser storage is close to its quota.
    try {
      window.localStorage.setItem(ASSISTANT_HISTORY_KEY, JSON.stringify(sessions.slice(0, 5)));
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }
}

function id(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${suffix}`;
}

interface AssistantConversationContextValue {
  activeCapability: number;
  context: SecurityAssistantContext;
  currentSessionId: string;
  deleteSession: (sessionId: string) => void;
  loading: boolean;
  messages: AssistantMessage[];
  question: string;
  reset: () => void;
  restoreSession: (session: AssistantSavedSession) => void;
  savedSessions: AssistantSavedSession[];
  setActiveCapability: (index: number) => void;
  setQuestion: (value: string) => void;
  submit: (question?: string) => Promise<void>;
}

const AssistantConversationContext = createContext<AssistantConversationContextValue | null>(null);

export function SecurityAssistantProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const location = useLocation();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeCapability, setActiveCapability] = useState(0);
  const [savedSessions, setSavedSessions] = useState<AssistantSavedSession[]>(initialSavedSessions);
  const sessionId = useRef(id("asa"));
  const context = useMemo(
    () => pageContext(location.pathname, location.search),
    [location.pathname, location.search],
  );

  useEffect(() => {
    if (!messages.length) return;
    const firstQuestion = messages.find((message) => message.role === "user")?.content.trim();
    if (!firstQuestion) return;
    const saved: AssistantSavedSession = {
      id: sessionId.current,
      title: firstQuestion.length > 56 ? `${firstQuestion.slice(0, 56)}…` : firstQuestion,
      updatedAt: new Date().toISOString(),
      messages,
    };
    setSavedSessions((current) => {
      const next = [saved, ...current.filter((session) => session.id !== saved.id)].slice(0, 20);
      persistSavedSessions(next);
      return next;
    });
  }, [messages]);

  const reset = () => {
    if (loading) return;
    sessionId.current = id("asa");
    setMessages([]);
    setQuestion("");
    setActiveCapability(0);
  };

  const restoreSession = (session: AssistantSavedSession) => {
    if (loading) return;
    sessionId.current = session.id;
    setMessages(session.messages);
    setQuestion("");
  };

  const deleteSession = (savedSessionId: string) => {
    setSavedSessions((current) => {
      const next = current.filter((session) => session.id !== savedSessionId);
      persistSavedSessions(next);
      return next;
    });
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
      const fallback = locale === "zh-CN"
        ? "助手暂时不可用，请检查模型端点后重试。"
        : "The assistant is temporarily unavailable. Check the model endpoint and try again.";
      const detail = error instanceof Error && error.message ? `\n${error.message}` : "";
      setMessages((current) => [
        ...current,
        { id: id("msg"), role: "assistant", content: `${fallback}${detail}`, failed: true },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const value = useMemo<AssistantConversationContextValue>(() => ({
    activeCapability,
    context,
    currentSessionId: sessionId.current,
    deleteSession,
    loading,
    messages,
    question,
    reset,
    restoreSession,
    savedSessions,
    setActiveCapability,
    setQuestion,
    submit,
  }), [activeCapability, context, loading, messages, question, savedSessions]);

  return (
    <AssistantConversationContext.Provider value={value}>
      {children}
    </AssistantConversationContext.Provider>
  );
}

function useAssistantConversation(): AssistantConversationContextValue {
  const value = useContext(AssistantConversationContext);
  if (!value) {
    throw new Error("SecurityAssistant must be rendered inside SecurityAssistantProvider");
  }
  return value;
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

function MarkdownAnswer({
  content,
  appearance = "dark",
}: {
  content: string;
  appearance?: "dark" | "light";
}) {
  const light = appearance === "light";
  return (
    <div className={cn("min-w-0 break-words text-sm leading-6", light ? "text-slate-700" : "text-slate-200")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className={cn("mb-3 mt-5 text-lg font-semibold leading-7 first:mt-0", light ? "text-slate-950" : "text-slate-50")}>{children}</h1>,
          h2: ({ children }) => <h2 className={cn("mb-2.5 mt-5 text-base font-semibold leading-7 first:mt-0", light ? "text-slate-950" : "text-slate-50")}>{children}</h2>,
          h3: ({ children }) => <h3 className={cn("mb-2 mt-4 text-[15px] font-semibold leading-6 first:mt-0", light ? "text-slate-900" : "text-slate-100")}>{children}</h3>,
          h4: ({ children }) => <h4 className={cn("mb-2 mt-3 text-sm font-semibold first:mt-0", light ? "text-slate-900" : "text-slate-100")}>{children}</h4>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className={cn("font-semibold", light ? "text-slate-950" : "text-slate-50")}>{children}</strong>,
          em: ({ children }) => <em className={light ? "text-slate-600" : "text-slate-300"}>{children}</em>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-slate-500">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-slate-500">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className={cn("my-3 border-l-2 border-orange-400/50 bg-orange-400/5 px-3 py-1", light ? "text-slate-600" : "text-slate-300")}>
              {children}
            </blockquote>
          ),
          hr: () => <hr className={cn("my-4", light ? "border-slate-200" : "border-[#303846]")} />,
          a: ({ href, children }) => {
            const external = Boolean(href && /^https?:\/\//i.test(href));
            return (
              <a
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer noopener" : undefined}
                className={cn(
                  "font-medium underline underline-offset-2",
                  light
                    ? "text-blue-600 decoration-blue-300 hover:text-blue-500"
                    : "text-cyan-300 decoration-cyan-400/40 hover:text-cyan-200",
                )}
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
              <code className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[12px]",
                light ? "bg-slate-100 text-orange-700" : "bg-black/35 text-orange-200",
              )}>{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 max-w-full overflow-x-auto rounded-lg border border-[#303846] bg-[#090d12] p-3 text-left">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className={cn("my-3 max-w-full overflow-x-auto rounded-lg border", light ? "border-slate-200" : "border-[#303846]")}>
              <table className="w-full min-w-[520px] border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className={light ? "bg-slate-50 text-slate-700" : "bg-white/[0.05] text-slate-200"}>{children}</thead>,
          tbody: ({ children }) => <tbody className={light ? "divide-y divide-slate-200" : "divide-y divide-[#29313e]"}>{children}</tbody>,
          tr: ({ children }) => <tr className="align-top">{children}</tr>,
          th: ({ children }) => <th className={cn("border-r px-2.5 py-2 font-semibold last:border-r-0", light ? "border-slate-200" : "border-[#29313e]")}>{children}</th>,
          td: ({ children }) => <td className={cn("border-r px-2.5 py-2 last:border-r-0", light ? "border-slate-200 text-slate-600" : "border-[#29313e] text-slate-300")}>{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function EmbeddedSecurityAssistant({
  capabilities,
  activeCapability,
  onCapabilityChange,
  contextLabels: labels,
  messages,
  question,
  loading,
  onQuestionChange,
  onSubmit,
  onReset,
  currentSessionId,
  savedSessions,
  onRestoreSession,
  onDeleteSession,
}: {
  capabilities: AssistantCapability[];
  activeCapability: number;
  onCapabilityChange: (index: number) => void;
  contextLabels: string[];
  messages: AssistantMessage[];
  question: string;
  loading: boolean;
  onQuestionChange: (value: string) => void;
  onSubmit: (question?: string) => void;
  onReset: () => void;
  currentSessionId: string;
  savedSessions: AssistantSavedSession[];
  onRestoreSession: (session: AssistantSavedSession) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  const { locale } = useI18n();
  const { sidebarWidth, sidebarCollapsed } = useSecurityConsole();
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyCloseButtonRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const isChinese = locale === "zh-CN";
  const hour = new Date().getHours();
  const greeting = isChinese
    ? `${hour < 12 ? "上午好" : hour < 18 ? "下午好" : "晚上好"}，有什么可以帮您分析？`
    : "How can I help you investigate?";
  const conversationStarted = messages.length > 0 || loading;
  const active = capabilities[activeCapability] ?? capabilities[0];
  const suggestions = active?.prompts ?? [];
  const roundCount = messages.filter((message) => message.role === "user").length;
  const visibleSidebarWidth = sidebarCollapsed ? COLLAPSED_SECURITY_SIDEBAR_WIDTH : sidebarWidth;
  const toolbarPosition = {
    "--assistant-toolbar-left": `${visibleSidebarWidth + 20}px`,
    "--assistant-toolbar-left-wide": `${visibleSidebarWidth + 28}px`,
  } as CSSProperties;

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [loading, messages]);

  useEffect(() => {
    if (!historyOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => historyCloseButtonRef.current?.focus());
    const handleDrawerKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHistoryOpen(false);
        historyButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = document.getElementById("assistant-history-panel");
      const focusable = panel?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDrawerKeyboard);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleDrawerKeyboard);
    };
  }, [historyOpen]);

  const closeHistory = () => {
    setHistoryOpen(false);
    window.requestAnimationFrame(() => historyButtonRef.current?.focus());
  };

  return (
    <section
      data-overview-ai-assistant
      className={cn(
        "relative mx-auto flex w-full max-w-[1180px] flex-col text-slate-900",
        conversationStarted ? "min-h-[calc(100vh-112px)]" : "min-h-[calc(100vh-96px)] justify-center py-6",
      )}
    >
      <div
        className="fixed left-5 top-20 z-30 flex items-center gap-2 lg:left-[var(--assistant-toolbar-left)] xl:left-[var(--assistant-toolbar-left-wide)]"
        style={toolbarPosition}
      >
        <button
          ref={historyButtonRef}
          type="button"
          aria-label={isChinese ? "历史会话" : "Conversation history"}
          title={isChinese ? "历史会话" : "Conversation history"}
          aria-expanded={historyOpen}
          aria-controls="assistant-history-panel"
          onClick={() => setHistoryOpen((open) => !open)}
          className="inline-flex size-9 items-center justify-center rounded-[10px] border border-slate-200/90 bg-white/80 text-slate-500 shadow-[0_8px_20px_rgba(47,61,92,0.08)] backdrop-blur transition-colors hover:border-blue-300 hover:bg-white hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <History className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={isChinese ? "新建会话" : "New conversation"}
          title={isChinese ? "新建会话" : "New conversation"}
          disabled={loading}
          onClick={onReset}
          className="inline-flex size-9 items-center justify-center rounded-[10px] border border-slate-200/90 bg-white/80 text-slate-500 shadow-[0_8px_20px_rgba(47,61,92,0.08)] backdrop-blur transition-colors hover:border-blue-300 hover:bg-white hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>

      {historyOpen ? (
        <div className="fixed inset-0 z-[90]" data-assistant-history-drawer>
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-slate-950/15"
            aria-label={isChinese ? "关闭历史会话" : "Close conversation history"}
            onClick={closeHistory}
          />
          <aside
            id="assistant-history-panel"
            role="dialog"
            aria-modal="true"
            aria-label={isChinese ? "历史会话" : "Conversation history"}
            className="absolute inset-y-0 right-0 flex w-[340px] max-w-[calc(100vw-20px)] flex-col border-l border-slate-200 bg-white shadow-[-20px_0_60px_rgba(15,23,42,0.16)]"
          >
            <div className="flex min-h-16 items-center justify-between border-b border-slate-200 px-5">
              <div>
                <h3 className="text-[15px] font-bold text-slate-900">{isChinese ? "历史会话" : "Conversation history"}</h3>
                <p className="mt-0.5 text-[10px] text-slate-400">
                  {isChinese ? "保存在当前浏览器，最多 20 条" : "Saved in this browser, up to 20"}
                </p>
              </div>
              <button
                ref={historyCloseButtonRef}
                type="button"
                aria-label={isChinese ? "关闭历史会话" : "Close conversation history"}
                onClick={closeHistory}
                className="inline-flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="border-b border-slate-100 p-3">
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  onReset();
                  closeHistory();
                }}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-[10px] border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {isChinese ? "新建会话" : "New conversation"}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
              {savedSessions.length ? savedSessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-xl border p-1",
                    session.id === currentSessionId
                      ? "border-blue-200 bg-blue-50"
                      : "border-transparent hover:border-slate-200 hover:bg-slate-50",
                  )}
                >
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      onRestoreSession(session);
                      closeHistory();
                    }}
                    className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="block truncate text-xs font-semibold text-slate-700">{session.title}</span>
                    <span className="mt-1 block text-[10px] text-slate-400">
                      {new Date(session.updatedAt).toLocaleString(isChinese ? "zh-CN" : "en")}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={isChinese ? `删除会话：${session.title}` : `Delete conversation: ${session.title}`}
                    title={isChinese ? "删除会话" : "Delete conversation"}
                    onClick={() => onDeleteSession(session.id)}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-300 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-500 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              )) : (
                <div className="px-4 py-10 text-center">
                  <History className="mx-auto size-6 text-slate-300" aria-hidden="true" />
                  <p className="mt-2 text-xs font-medium text-slate-500">{isChinese ? "暂无历史会话" : "No saved conversations"}</p>
                  <p className="mt-1 text-[10px] text-slate-400">{isChinese ? "发送第一条问题后会自动保存" : "Your first question will be saved automatically"}</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {!conversationStarted ? (
        <div className="shrink-0">
          <div className="relative mb-4 flex items-center justify-center">
            <span className="inline-flex h-9 select-none items-center gap-2 rounded-full border border-violet-300/70 bg-white/75 px-4 text-sm font-extrabold tracking-[0.03em] text-indigo-800 shadow-[0_8px_24px_rgba(79,70,229,0.12)] backdrop-blur">
              <Sparkles className="size-4 text-violet-500" aria-hidden="true" />
              AnySentry
            </span>
            <span className="absolute right-1 hidden items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur lg:inline-flex">
              <ShieldCheck className="size-3" aria-hidden="true" />
              {isChinese ? "点击能力切换推荐调查" : "Select a capability to switch prompts"}
            </span>
          </div>

          <div className="flex items-stretch gap-2 overflow-x-auto px-2 pb-3 pt-2">
            {capabilities.map((capability, index) => {
              const Icon = capability.icon;
              const selected = index === activeCapability;
              const tone = CAPABILITY_TONES[index] ?? CAPABILITY_TONES[CAPABILITY_TONES.length - 1];
              return (
                <div key={capability.label} className="contents">
                  <button
                    type="button"
                    data-ai-capability={index}
                    aria-pressed={selected}
                    aria-current={selected ? "step" : undefined}
                    disabled={selected}
                    onClick={() => onCapabilityChange(index)}
                    className={cn(
                      "group flex min-w-[122px] flex-1 flex-col items-center rounded-[14px] px-2 py-3 text-center transition-[transform,box-shadow,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
                      selected
                        ? cn(tone.active, "border-2 cursor-default outline outline-2 outline-offset-1 outline-slate-900/10")
                        : cn(tone.card, "border-[1.5px] hover:-translate-y-0.5 hover:shadow-lg"),
                    )}
                  >
                    <span className={cn("inline-flex size-6 select-none items-center justify-center rounded-full text-[11px] font-extrabold text-white shadow-sm", tone.number)}>
                      {index + 1}
                    </span>
                    <span className={cn("mt-1.5 flex items-center gap-1 text-[13px]", selected ? "font-extrabold" : "font-bold", tone.title)}>
                      <Icon className="size-3.5" aria-hidden="true" />
                      {capability.label}
                    </span>
                    <span className={cn("mt-1 max-w-full truncate text-[10.5px] text-slate-500", selected && "font-semibold text-slate-600")}>
                      {capability.description}
                    </span>
                  </button>
                  {index < capabilities.length - 1 ? (
                    <ChevronRight className="my-auto size-4 shrink-0 text-slate-400" aria-hidden="true" />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {!conversationStarted ? (
        <div className="flex shrink-0 flex-col items-center px-4 py-8 text-center">
          <div className="relative mb-5 flex size-24 items-center justify-center rounded-full border border-blue-200/80 bg-white/55 shadow-[0_22px_50px_rgba(37,99,235,0.16)] backdrop-blur">
            <span className="absolute inset-3 rounded-full border border-cyan-200/80 bg-white/70" />
            <span className="absolute left-7 top-7 size-9 rounded-full bg-cyan-300/80 blur-md" />
            <span className="absolute bottom-6 right-6 size-9 rounded-full bg-violet-400/70 blur-md" />
            <span className="absolute bottom-8 left-8 size-8 rounded-full bg-orange-300/75 blur-md" />
            <span className="relative size-12 rounded-full bg-[conic-gradient(from_180deg,#22d3ee,#3b82f6,#8b5cf6,#fb923c,#22d3ee)] opacity-80 blur-[1px]" />
            <Sparkles className="absolute size-5 text-white drop-shadow" aria-hidden="true" />
          </div>
          <h2 className="text-[28px] font-bold leading-tight tracking-[-0.025em] text-slate-950">{greeting}</h2>
          <p className="mt-2 text-sm text-slate-500">
            {isChinese ? `当前会话已进行 ${roundCount} 轮 · 基于运行状态、安全证据与调查上下文回答` : `${roundCount} rounds in this session · grounded in runtime state and security evidence`}
          </p>
        </div>
      ) : (
        <div
          className="min-h-[420px] flex-1 space-y-5 overflow-y-auto px-2 py-6"
          aria-live="polite"
          aria-busy={loading}
        >
          {messages.map((message) => (
            <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm",
                  message.role === "user"
                    ? "rounded-br-md border border-blue-200 bg-blue-50/95 text-slate-900"
                    : "rounded-bl-md border border-slate-200/90 bg-white/95 text-slate-700 shadow-[0_10px_28px_rgba(15,23,42,0.06)]",
                  message.failed && "border-rose-200 bg-rose-50 text-rose-800",
                )}
              >
                {message.role === "assistant"
                  ? <MarkdownAnswer content={message.content} appearance="light" />
                  : <div className="whitespace-pre-wrap break-words">{message.content}</div>}
                {message.response ? (
                  <div className="mt-3 border-t border-slate-200 pt-2.5">
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
                      <span>{message.response.model}</span>
                      <span>{(message.response.elapsedMs / 1000).toFixed(1)}s</span>
                      <span>{message.response.totalTokens} tokens</span>
                    </div>
                    {message.response.references.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {message.response.references.map((reference) => (
                          <Link
                            key={`${reference.kind}-${reference.id}`}
                            to={reference.href}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700 hover:border-blue-300 hover:bg-blue-100"
                          >
                            <span className="truncate">{reference.label}</span>
                            <ExternalLink className="size-2.5 shrink-0" aria-hidden="true" />
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {loading ? (
            <div className="flex justify-start" role="status">
              <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-white/90 px-4 py-3 text-xs font-medium text-slate-500 shadow-sm">
                <LoaderCircle className="size-4 animate-spin text-blue-500" aria-hidden="true" />
                {isChinese ? "正在汇总证据并分析…" : "Collecting evidence and analyzing…"}
              </div>
            </div>
          ) : null}
          <div ref={conversationEndRef} />
        </div>
      )}

      <div className={cn(
        "shrink-0",
        conversationStarted && "sticky bottom-0 z-10 bg-gradient-to-b from-transparent via-[#f7f9ff]/95 to-[#f7f9ff] pb-3 pt-5",
      )}>
        <div className="relative rounded-[18px] bg-gradient-to-r from-blue-300 via-violet-300 to-cyan-300 p-px shadow-[0_24px_58px_rgba(43,55,86,0.16)]">
          <div className="rounded-[17px] border border-white/80 bg-white/95 backdrop-blur">
            <textarea
              data-ai-composer
              value={question}
              rows={3}
              maxLength={4000}
              disabled={loading}
              aria-label={isChinese ? "AI 调查问题" : "AI investigation question"}
              placeholder={isChinese ? "输入要分析的问题，可询问 Agent、Trace、事件、Attack Episode 或供应链风险…" : "Ask about Agents, traces, events, Attack Episodes, or supply-chain risk…"}
              onChange={(event) => onQuestionChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              className="max-h-44 min-h-[78px] w-full resize-none bg-transparent px-5 pb-2 pt-4 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50/70 px-3 text-xs font-semibold text-slate-600">
                  <Bot className="size-3.5 text-blue-500" aria-hidden="true" />
                  AnySentry Assistant
                </span>
                {labels.slice(0, 1).map((label) => (
                  <span key={label} className="max-w-[220px] truncate rounded-full bg-slate-100 px-3 py-2 text-[10px] text-slate-500" title={label}>
                    {label}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] text-slate-400">{question.length}/4000</span>
                <button
                  type="button"
                  disabled={loading || !question.trim()}
                  onClick={() => onSubmit()}
                  className="inline-flex size-9 items-center justify-center rounded-full bg-blue-600 text-white shadow-[0_8px_18px_rgba(37,99,235,0.25)] transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
                  aria-label={isChinese ? "发送" : "Send"}
                >
                  <Send className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {!conversationStarted ? (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] text-slate-700">
                <strong className="font-extrabold text-slate-900">{active?.label}</strong>
                <span className="font-semibold"> · {active?.description}</span>
              </span>
              <span className="text-[11px] text-slate-400">
                {isChinese ? "点击问题开始调查" : "Select a question to investigate"}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion}
                  type="button"
                  data-ai-suggestion={index}
                  onClick={() => onSubmit(suggestion)}
                  className="group flex min-h-[56px] items-center justify-between gap-3 rounded-[14px] border border-slate-200/90 bg-white/85 px-4 text-left text-[13px] text-slate-600 shadow-[0_10px_22px_rgba(43,55,86,0.05)] transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-blue-300 hover:bg-white hover:text-slate-900 hover:shadow-[0_16px_30px_rgba(37,99,235,0.10)]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className={cn(
                      "inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-extrabold",
                      index % 2 === 0 ? "bg-blue-50 text-blue-600" : "bg-teal-50 text-teal-600",
                    )}>{index + 1}</span>
                    <span className="truncate">{suggestion}</span>
                  </span>
                  <ArrowUpRight className="size-4 shrink-0 text-slate-300 transition-colors group-hover:text-blue-500" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function SecurityAssistant({ mode = "floating" }: { mode?: SecurityAssistantMode }) {
  const { locale } = useI18n();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [launcherPosition, setLauncherPosition] = useState<AssistantLauncherPosition | null>(initialLauncherPosition);
  const [draggingLauncher, setDraggingLauncher] = useState(false);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [resizingPanel, setResizingPanel] = useState(false);
  const [floatingHistoryOpen, setFloatingHistoryOpen] = useState(false);
  const {
    activeCapability,
    context,
    currentSessionId,
    deleteSession,
    loading,
    messages,
    question,
    reset,
    restoreSession,
    savedSessions,
    setActiveCapability,
    setQuestion,
    submit,
  } = useAssistantConversation();
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
  const labels = useMemo(() => contextLabels(context, locale), [context, locale]);
  const isDedicatedAssistantPage = location.pathname === "/ai/chat";

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
        subtitle: "与 AI 对话共享会话 · 只读分析",
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
        subtitle: "Shared with AI Chat · Read-only",
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

  const capabilities = useMemo<AssistantCapability[]>(() => locale === "zh-CN"
    ? [
        {
          label: "运行观测",
          description: "Observer 实时事件",
          prompts: ["当前平台哪些组件异常？", "总结最近 3 小时的运行状态", "哪些 Agent 的事件量出现异常？", "检查当前采集链路健康度"],
          icon: RadioTower,
        },
        {
          label: "身份归因",
          description: "Agent / Instance",
          prompts: ["分析当前 Agent 与运行实例的归因情况", "找出身份不明确的 Agent 事件", "哪些 Instance 最近最活跃？", "检查 Agent 与 Workspace 的关联"],
          icon: Bot,
        },
        {
          label: "链路还原",
          description: "Trace / Span",
          prompts: ["找出最近值得调查的 Trace", "还原高风险事件的 Span 链路", "哪些 Trace 同时包含多个异常事件？", "总结最近一次异常调用链"],
          icon: GitBranch,
        },
        {
          label: "分层研判",
          description: "L1 / L2 / L3",
          prompts: ["总结当前 L1、L2、L3 研判状态", "哪些事件已升级到 L2 或 L3？", "检查最近的研判异常与失败", "解释一个高风险事件的研判依据"],
          icon: Radar,
        },
        {
          label: "攻击关联",
          description: "Attack Episode",
          prompts: ["最近有哪些 Attack Episode 需要关注？", "找出包含多个行为阶段的攻击链", "哪些 Agent 关联了高风险 Episode？", "总结最近一次复合攻击的证据链"],
          icon: Siren,
        },
        {
          label: "供应链风险",
          description: "OSV / Runtime",
          prompts: ["检查当前供应链与 OSV 风险", "哪些漏洞已关联运行时活动？", "列出优先级最高的依赖漏洞", "总结 Workspace 的供应链暴露面"],
          icon: ShieldAlert,
        },
        {
          label: "调查响应",
          description: "Evidence / Action",
          prompts: ["基于现有证据给出调查摘要", "为当前高风险事件生成响应建议", "列出需要进一步收集的证据", "整理一份只读处置检查清单"],
          icon: Wrench,
        },
      ]
    : [
        { label: "Observe", description: "Observer events", prompts: ["Which platform components are unhealthy?", "Summarize runtime health over the last 3 hours", "Which Agents show abnormal event volume?", "Inspect collector pipeline health"], icon: RadioTower },
        { label: "Attribute", description: "Agent / Instance", prompts: ["Analyze Agent and runtime-instance attribution", "Find events with uncertain Agent identity", "Which instances are most active?", "Inspect Agent-to-Workspace relationships"], icon: Bot },
        { label: "Trace", description: "Trace / Span", prompts: ["Find recent traces worth investigating", "Reconstruct spans for high-risk events", "Which traces contain multiple anomalies?", "Summarize the latest abnormal call chain"], icon: GitBranch },
        { label: "Judge", description: "L1 / L2 / L3", prompts: ["Summarize L1, L2, and L3 judgment states", "Which events escalated to L2 or L3?", "Inspect recent judgment failures", "Explain the evidence behind a high-risk judgment"], icon: Radar },
        { label: "Correlate", description: "Attack Episode", prompts: ["Which recent Attack Episodes need attention?", "Find attack chains spanning multiple stages", "Which Agents relate to high-risk Episodes?", "Summarize the latest composite attack evidence"], icon: Siren },
        { label: "Supply chain", description: "OSV / Runtime", prompts: ["Inspect supply-chain and OSV risk", "Which vulnerabilities have runtime activity?", "List the highest-priority dependency risks", "Summarize Workspace supply-chain exposure"], icon: ShieldAlert },
        { label: "Respond", description: "Evidence / Action", prompts: ["Create an investigation summary from current evidence", "Recommend a response for the current high-risk event", "List evidence that still needs collection", "Prepare a read-only response checklist"], icon: Wrench },
      ], [locale]);

  if (mode === "floating" && isDedicatedAssistantPage) return null;

  if (mode === "embedded") {
    return (
      <EmbeddedSecurityAssistant
        capabilities={capabilities}
        activeCapability={activeCapability}
        onCapabilityChange={(index) => {
          setActiveCapability(index);
          setQuestion("");
        }}
        contextLabels={labels}
        messages={messages}
        question={question}
        loading={loading}
        onQuestionChange={setQuestion}
        onSubmit={(nextQuestion) => void submit(nextQuestion)}
        onReset={reset}
        currentSessionId={currentSessionId}
        savedSessions={savedSessions}
        onRestoreSession={restoreSession}
        onDeleteSession={deleteSession}
      />
    );
  }

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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={locale === "zh-CN" ? "历史会话" : "Conversation history"}
                    aria-label={locale === "zh-CN" ? "历史会话" : "Conversation history"}
                    aria-expanded={floatingHistoryOpen}
                    onClick={() => setFloatingHistoryOpen(true)}
                  >
                    <History className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={copy.newChat}
                    aria-label={copy.newChat}
                    disabled={loading}
                    onClick={() => {
                      reset();
                      setFloatingHistoryOpen(false);
                    }}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={copy.close}
                    aria-label={copy.close}
                    onClick={() => setOpen(false)}
                  >
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
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {capabilities.map((capability, index) => {
                      const Icon = capability.icon;
                      return (
                        <button
                          key={capability.label}
                          type="button"
                          aria-pressed={activeCapability === index}
                          onClick={() => {
                            setActiveCapability(index);
                            setQuestion("");
                          }}
                          className={cn(
                            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60",
                            activeCapability === index
                              ? "border-orange-400/50 bg-orange-500/10 text-orange-200"
                              : "border-[#28303d] bg-[#10151c] text-slate-400 hover:border-slate-500 hover:text-slate-200",
                          )}
                        >
                          <Icon className="size-3.5" aria-hidden="true" />
                          {capability.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="rounded-xl border border-[#28303d] bg-[#121720] p-4">
                    <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
                      <ShieldCheck className="h-5 w-5" />
                    </div>
                    <p className="text-sm leading-6 text-slate-200">{copy.welcome}</p>
                  </div>
                  <div className="space-y-2">
                    {(capabilities[activeCapability]?.prompts ?? copy.suggestions).map((suggestion) => (
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

            {floatingHistoryOpen ? (
              <section
                role="dialog"
                aria-modal="true"
                aria-label={locale === "zh-CN" ? "历史会话" : "Conversation history"}
                className="absolute inset-0 z-20 flex flex-col bg-[#0d1117]"
              >
                <header className="flex min-h-16 items-center justify-between border-b border-[#252c38] bg-[#10151d] px-4">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      {locale === "zh-CN" ? "历史会话" : "Conversation history"}
                    </h3>
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      {locale === "zh-CN"
                        ? "与 AI 对话页共享，当前浏览器最多保存 20 条"
                        : "Shared with AI Chat, up to 20 conversations in this browser"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={locale === "zh-CN" ? "关闭历史会话" : "Close conversation history"}
                    aria-label={locale === "zh-CN" ? "关闭历史会话" : "Close conversation history"}
                    onClick={() => setFloatingHistoryOpen(false)}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </header>

                <div className="border-b border-[#252c38] p-3">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      reset();
                      setFloatingHistoryOpen(false);
                    }}
                    className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-orange-400/35 bg-orange-500/10 text-xs font-semibold text-orange-200 transition-colors hover:bg-orange-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {locale === "zh-CN" ? "新建会话" : "New conversation"}
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                  {savedSessions.length ? savedSessions.map((session) => (
                    <div
                      key={session.id}
                      className={cn(
                        "group flex items-center gap-1 rounded-xl border p-1",
                        session.id === currentSessionId
                          ? "border-orange-400/35 bg-orange-500/[0.08]"
                          : "border-transparent hover:border-[#2b3342] hover:bg-white/[0.03]",
                      )}
                    >
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          restoreSession(session);
                          setFloatingHistoryOpen(false);
                        }}
                        className="min-w-0 flex-1 rounded-lg px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="block truncate text-xs font-semibold text-slate-200">{session.title}</span>
                        <span className="mt-1 block text-[10px] text-slate-500">
                          {new Date(session.updatedAt).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en")}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={locale === "zh-CN" ? `删除会话：${session.title}` : `Delete conversation: ${session.title}`}
                        title={locale === "zh-CN" ? "删除会话" : "Delete conversation"}
                        onClick={() => deleteSession(session.id)}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-600 opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-300 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  )) : (
                    <div className="px-4 py-12 text-center">
                      <History className="mx-auto size-6 text-slate-700" aria-hidden="true" />
                      <p className="mt-2 text-xs font-medium text-slate-400">
                        {locale === "zh-CN" ? "暂无历史会话" : "No saved conversations"}
                      </p>
                      <p className="mt-1 text-[10px] text-slate-600">
                        {locale === "zh-CN" ? "在任一入口发送问题后会自动保存" : "Conversations are saved from either assistant surface"}
                      </p>
                    </div>
                  )}
                </div>

                <div className="border-t border-[#252c38] p-3">
                  <Link
                    to="/ai/chat"
                    onClick={() => {
                      setFloatingHistoryOpen(false);
                      setOpen(false);
                    }}
                    className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#303846] bg-[#10151d] text-xs font-medium text-cyan-300 transition-colors hover:border-cyan-400/35 hover:bg-[#161c25] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                  >
                    {locale === "zh-CN" ? "进入完整 AI 对话" : "Open full AI Chat"}
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </section>
            ) : null}
          </aside>
        </div>
      )}
    </>
  );
}
