import { useRequest } from "ahooks";
import {
  ArrowLeft,
  CheckCircle2,
  CircleSlash2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
  UserRoundCog,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { OperationalEmptyState } from "@/components/custom/operational-empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type PlatformRoleDefinition,
  type PlatformUserItem,
  type PlatformUserRole,
  type PlatformUserStatus,
  type PlatformUserUpdateRequest,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<PlatformUserRole, string> = {
  administrator: "管理员",
  security_analyst: "安全分析员",
  operator: "运营人员",
  viewer: "只读观察员",
};

const PERMISSION_LABEL: Record<string, string> = {
  "platform.manage": "平台管理",
  "security.review": "安全研判",
  "incident.respond": "事件处置",
  "data.read": "数据查看",
};

interface Draft {
  username: string;
  displayName: string;
  email: string;
  team: string;
  role: PlatformUserRole;
  status: PlatformUserStatus;
  note: string;
}

function emptyDraft(): Draft {
  return {
    username: "",
    displayName: "",
    email: "",
    team: "",
    role: "viewer",
    status: "active",
    note: "",
  };
}

function draftFrom(item?: PlatformUserItem): Draft {
  if (!item) return emptyDraft();
  return {
    username: item.username,
    displayName: item.displayName,
    email: item.email ?? "",
    team: item.team ?? "",
    role: item.role,
    status: item.status,
    note: item.note ?? "",
  };
}

function clean(value: string) {
  return value.trim() || undefined;
}

function initials(item: Pick<PlatformUserItem, "displayName" | "username">) {
  return (item.displayName || item.username).trim().slice(0, 2).toUpperCase();
}

function roleTone(role: PlatformUserRole) {
  if (role === "administrator") return "border-rose-400/25 bg-rose-500/10 text-rose-100";
  if (role === "security_analyst") return "border-violet-400/25 bg-violet-500/10 text-violet-100";
  if (role === "operator") return "border-sky-400/25 bg-sky-500/10 text-sky-100";
  return "border-zinc-400/20 bg-zinc-500/10 text-zinc-200";
}

function Metric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof Users;
  tone: string;
}) {
  return (
    <div className={cn("flex min-h-[84px] items-center justify-between border px-4 py-3", tone)}>
      <div>
        <div className="text-[11px] text-zinc-400">{label}</div>
        <div className="mt-1 font-mono text-2xl font-semibold text-zinc-100">{value}</div>
      </div>
      <Icon className="size-5 opacity-75" />
    </div>
  );
}

function RoleDefinition({ item }: { item: PlatformRoleDefinition }) {
  return (
    <div className="border border-white/8 bg-white/[0.02] px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-100">{item.label}</div>
          <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{item.role}</div>
        </div>
        <span className={cn("border px-2 py-0.5 font-mono text-[10px]", roleTone(item.role))}>{item.userCount} 人</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-zinc-400">{item.description}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.permissions.map((permission) => (
          <span key={permission} className="border border-white/8 bg-[#0b0f15] px-1.5 py-0.5 text-[10px] text-zinc-400">
            {PERMISSION_LABEL[permission] ?? permission}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function UsersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [role, setRole] = useState<PlatformUserRole | "all">((searchParams.get("role") as PlatformUserRole) || "all");
  const [status, setStatus] = useState<PlatformUserStatus | "all">((searchParams.get("status") as PlatformUserStatus) || "all");
  const [selectedId, setSelectedId] = useState(searchParams.get("userId") ?? "");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PlatformUserItem>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saveError, setSaveError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  const request = useMemo(() => ({ q: clean(query), role, status, limit: 1_000 }), [query, role, status]);
  const { data, loading, error, refresh } = useRequest(() => securityCenterApi.platformUsers(request), {
    refreshDeps: [request.q, request.role, request.status],
  });

  useEffect(() => {
    if (!selectedId || !data?.items.some((item) => item.userId === selectedId)) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("userId", selectedId);
      return next;
    }, { replace: true });
  }, [data?.items, selectedId, setSearchParams]);

  const openEditor = (item?: PlatformUserItem) => {
    setEditing(item);
    setDraft(draftFrom(item));
    setSaveError("");
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(undefined);
    setSaveError("");
  };

  const save = async () => {
    if (!draft.username.trim()) {
      setSaveError("用户名不能为空");
      return;
    }
    setSaveError("");
    const body: PlatformUserUpdateRequest = {
      username: draft.username.trim(),
      displayName: draft.displayName.trim() || draft.username.trim(),
      email: clean(draft.email),
      team: clean(draft.team),
      role: draft.role,
      status: draft.status,
      note: clean(draft.note),
    };
    try {
      const updated = editing
        ? await securityCenterApi.updatePlatformUser(editing.userId, body)
        : await securityCenterApi.createPlatformUser(body);
      setSelectedId(updated.userId);
      setSavedMessage(`${updated.displayName} 已保存`);
      closeEditor();
      refresh();
      window.setTimeout(() => setSavedMessage(""), 3_000);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0a0d12] text-zinc-100">
      <header className="border-b border-[#252c38] bg-[#0f131a] px-4 py-3">
        <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="outline" size="sm" className="h-9 border-white/10 bg-white/[0.02] text-zinc-200">
              <Link to="/"><ArrowLeft className="size-4" />返回</Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Users className="size-5 text-teal-300" />
                <h1 className="text-lg font-semibold tracking-tight">用户管理</h1>
                <span className="border border-teal-400/25 bg-teal-500/10 px-2 py-0.5 text-[10px] font-semibold text-teal-100">本地目录</span>
                <span className="border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-100">无需登录</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">人员、职责与固定角色目录 · 当前角色不参与访问拦截</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AdminTokenControl />
            <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading} className="h-9 border-white/10 bg-white/[0.02]">
              {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
            <Button type="button" size="sm" onClick={() => openEditor()} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
              <Plus className="size-3.5" />新增用户
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-3">
          <section className="flex flex-wrap items-center gap-2 border border-white/8 bg-[#0e1319] p-2">
            <div className="relative min-w-[260px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="用户名 / 姓名 / 邮箱 / 团队" className="h-9 border-white/10 bg-[#090d12] pl-9" />
            </div>
            <Select value={role} onValueChange={(value) => setRole(value as PlatformUserRole | "all")}>
              <SelectTrigger className="h-9 w-[170px] border-white/10 bg-[#090d12]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部角色</SelectItem>
                {Object.entries(ROLE_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as PlatformUserStatus | "all")}>
              <SelectTrigger className="h-9 w-[140px] border-white/10 bg-[#090d12]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">启用</SelectItem>
                <SelectItem value="disabled">停用</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {savedMessage ? (
            <div className="flex items-center gap-2 border border-teal-400/20 bg-teal-500/8 px-3 py-2 text-xs text-teal-100">
              <CheckCircle2 className="size-4" />{savedMessage}
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="用户总数" value={data?.summary.totalUsers ?? 0} icon={Users} tone="border-white/10 bg-[#10151c]" />
            <Metric label="已启用" value={data?.summary.activeUsers ?? 0} icon={UserCheck} tone="border-teal-400/20 bg-teal-500/[0.06]" />
            <Metric label="已停用" value={data?.summary.disabledUsers ?? 0} icon={CircleSlash2} tone="border-zinc-400/15 bg-zinc-500/[0.04]" />
            <Metric label="管理员" value={data?.summary.administratorUsers ?? 0} icon={ShieldCheck} tone="border-rose-400/20 bg-rose-500/[0.06]" />
          </div>

          <div className="grid min-h-[600px] gap-3 xl:grid-cols-[minmax(760px,1fr)_340px]">
            <section className="overflow-hidden border border-white/10 bg-[#0e1319]">
              <div className="flex min-h-11 items-center justify-between border-b border-white/10 px-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Users className="size-4 text-teal-300" />用户目录
                </div>
                <span className="font-mono text-[11px] text-zinc-500">{data?.total ?? 0} 条</span>
              </div>
              {error ? (
                <div className="flex min-h-44 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
                  <CircleSlash2 className="size-6 text-rose-300" />
                  <div>
                    <p className="text-sm font-medium text-zinc-200">用户目录读取失败</p>
                    <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-500">{error.message}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={refresh} className="h-8 border-white/10 bg-white/[0.03]">重新加载</Button>
                </div>
              ) : !loading && data?.items.length === 0 ? (
                <OperationalEmptyState title="没有匹配的用户" description="调整筛选条件，或新建一个本地用户记录。" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-left text-xs">
                    <thead className="border-b border-white/10 bg-white/[0.02] text-[10px] uppercase tracking-[0.08em] text-zinc-500">
                      <tr>
                        <th className="px-3 py-2.5 font-medium">用户</th>
                        <th className="px-3 py-2.5 font-medium">团队 / 联系方式</th>
                        <th className="px-3 py-2.5 font-medium">角色</th>
                        <th className="px-3 py-2.5 font-medium">状态</th>
                        <th className="px-3 py-2.5 font-medium">最近更新</th>
                        <th className="w-16 px-3 py-2.5 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.07]">
                      {data?.items.map((item) => (
                        <tr key={item.userId} className={cn("cursor-pointer hover:bg-white/[0.025]", selectedId === item.userId && "bg-teal-500/[0.05]")} onClick={() => setSelectedId(item.userId)}>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="flex size-8 shrink-0 items-center justify-center border border-white/10 bg-[#151b24] font-mono text-[10px] font-semibold text-teal-200">{initials(item)}</div>
                              <div className="min-w-0">
                                <div className="truncate font-semibold text-zinc-100">{item.displayName}</div>
                                <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">@{item.username} · {item.userId}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="text-zinc-300">{item.team || "未分配团队"}</div>
                            <div className="mt-0.5 text-[10px] text-zinc-500">{item.email || "未配置邮箱"}</div>
                          </td>
                          <td className="px-3 py-3"><span className={cn("inline-flex border px-2 py-0.5 text-[10px] font-semibold", roleTone(item.role))}>{ROLE_LABEL[item.role]}</span></td>
                          <td className="px-3 py-3">
                            <span className={cn("inline-flex items-center gap-1.5 text-[11px]", item.status === "active" ? "text-teal-200" : "text-zinc-500")}>
                              <span className={cn("size-1.5 rounded-full", item.status === "active" ? "bg-teal-400" : "bg-zinc-600")} />
                              {item.status === "active" ? "启用" : "停用"}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="font-mono text-[11px] text-zinc-300">{item.updatedAt}</div>
                            <div className="mt-0.5 text-[10px] text-zinc-500">by {item.updatedBy}</div>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <Button type="button" variant="ghost" size="icon" className="size-8 text-zinc-400 hover:text-zinc-100" onClick={(event) => { event.stopPropagation(); openEditor(item); }} aria-label={`编辑 ${item.displayName}`}>
                              <Pencil className="size-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <aside className="border border-white/10 bg-[#0e1319]">
              <div className="border-b border-white/10 px-3 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-violet-300" />固定角色</div>
                <p className="mt-1 text-[11px] leading-5 text-zinc-500">角色来自轻量治理模型，当前只记录职责，不执行登录鉴权。</p>
              </div>
              <div className="space-y-2 p-2">
                {data?.roles.map((item) => <RoleDefinition key={item.role} item={item} />)}
              </div>
            </aside>
          </div>
        </div>
      </main>

      {editorOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={editing ? "编辑用户" : "新增用户"}>
          <button type="button" className="absolute inset-0 bg-black/65" onClick={closeEditor} aria-label="关闭用户编辑面板" />
          <aside className="relative flex h-full w-full max-w-[460px] flex-col border-l border-white/10 bg-[#0d1218] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold"><UserRoundCog className="size-4 text-teal-300" />{editing ? "编辑用户" : "新增用户"}</div>
                <p className="mt-1 text-[11px] text-zinc-500">不创建密码，不改变当前免登录访问方式。</p>
              </div>
              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={closeEditor} aria-label="关闭"><X className="size-4" /></Button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs text-zinc-400">
                  <span>用户名 *</span>
                  <Input value={draft.username} onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))} placeholder="zhangsan" className="h-9 border-white/10 bg-[#080c11]" />
                </label>
                <label className="space-y-1.5 text-xs text-zinc-400">
                  <span>显示名称</span>
                  <Input value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="张三" className="h-9 border-white/10 bg-[#080c11]" />
                </label>
              </div>
              <label className="block space-y-1.5 text-xs text-zinc-400">
                <span>邮箱</span>
                <Input type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} placeholder="name@example.com" className="h-9 border-white/10 bg-[#080c11]" />
              </label>
              <label className="block space-y-1.5 text-xs text-zinc-400">
                <span>团队</span>
                <Input value={draft.team} onChange={(event) => setDraft((current) => ({ ...current, team: event.target.value }))} placeholder="Security / Platform" className="h-9 border-white/10 bg-[#080c11]" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs text-zinc-400">
                  <span>角色</span>
                  <Select value={draft.role} onValueChange={(value) => setDraft((current) => ({ ...current, role: value as PlatformUserRole }))}>
                    <SelectTrigger className="h-9 border-white/10 bg-[#080c11]"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(ROLE_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                  </Select>
                </label>
                <label className="space-y-1.5 text-xs text-zinc-400">
                  <span>状态</span>
                  <Select value={draft.status} onValueChange={(value) => setDraft((current) => ({ ...current, status: value as PlatformUserStatus }))}>
                    <SelectTrigger className="h-9 border-white/10 bg-[#080c11]"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="active">启用</SelectItem><SelectItem value="disabled">停用</SelectItem></SelectContent>
                  </Select>
                </label>
              </div>
              <label className="block space-y-1.5 text-xs text-zinc-400">
                <span>备注</span>
                <textarea value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} rows={5} placeholder="职责范围、交接信息或治理说明" className="w-full resize-y border border-white/10 bg-[#080c11] px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-teal-400/50" />
              </label>
              <div className="border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-5 text-amber-100/80">
                停用用户仅更新目录状态。由于当前尚未启用登录和权限拦截，它不会使任何浏览器会话退出。
              </div>
              {saveError ? <div className="border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{saveError}</div> : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-white/10 p-3">
              <Button type="button" variant="outline" size="sm" onClick={closeEditor} className="h-9 border-white/10 bg-white/[0.02]">取消</Button>
              <Button type="button" size="sm" onClick={() => void save()} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400"><CheckCircle2 className="size-3.5" />保存</Button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
