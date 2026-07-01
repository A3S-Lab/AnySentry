import dayjs from "dayjs";
import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  CheckCircle2,
  Copy,
  FileCode2,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { generatedSecurityCapabilityCurl } from "@/lib/api/security-capability-curl";
import {
  type SecurityApiModule,
  type SecurityApiOperation,
  type SecurityCapabilityDryRunResult,
  type SecurityCapabilityRequest,
  type SecurityCapabilityResponse,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

type JsonObject = Record<string, unknown>;
type OperationExample = {
  description?: string;
  request?: SecurityCapabilityRequest;
};
type RouteCapabilityAction = "list" | "search" | "describe";
type ValidationIssue = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function isSecurityCapabilityRequest(value: unknown): value is SecurityCapabilityRequest {
  const request = asObject(value);
  return Boolean(request && typeof request.action === "string" && typeof request.operation === "string");
}

function asDryRunResult(value: unknown): SecurityCapabilityDryRunResult | undefined {
  const item = asObject(value);
  if (!item) return undefined;
  if (item.schemaVersion === "anysentry.progressive.dry_run.v1") return item as unknown as SecurityCapabilityDryRunResult;
  const data = asObject(item.data);
  return data?.schemaVersion === "anysentry.progressive.dry_run.v1" ? (data as unknown as SecurityCapabilityDryRunResult) : undefined;
}

function operationExamples(operation?: SecurityApiOperation): OperationExample[] {
  return (operation?.examples ?? [])
    .map((example) => {
      const item = asObject(example);
      const request = isSecurityCapabilityRequest(item?.request) ? item.request : undefined;
      return request ? { description: typeof item?.description === "string" ? item.description : undefined, request } : undefined;
    })
    .filter((example): example is OperationExample => Boolean(example));
}

function schemaValue(schema: unknown): unknown {
  const item = asObject(schema);
  if (!item) return undefined;
  if ("example" in item) return item.example;
  if ("default" in item) return item.default;
  if ("const" in item) return item.const;
  if (Array.isArray(item.enum) && item.enum.length > 0) return item.enum[0];
  if (Array.isArray(item.oneOf) && item.oneOf.length > 0) return schemaValue(item.oneOf[0]);
  if (item.type === "boolean") return false;
  if (item.type === "integer" || item.type === "number") return item.minimum ?? 1;
  if (item.type === "array") {
    const child = schemaValue(item.items);
    return child === undefined ? [] : [child];
  }
  if (item.type === "object") {
    const properties = asObject(item.properties) ?? {};
    const required = Array.isArray(item.required) ? item.required.filter((key): key is string => typeof key === "string") : [];
    const generated: JsonObject = {};
    for (const [key, childSchema] of Object.entries(properties)) {
      const child = asObject(childSchema);
      const childValue = schemaValue(childSchema);
      if (childValue !== undefined && (required.includes(key) || child?.default !== undefined || child?.example !== undefined || child?.const !== undefined)) {
        generated[key] = childValue;
      }
    }
    return generated;
  }
  return undefined;
}

function schemaConstString(schema: unknown, fallback: string): string {
  const value = schemaValue(schema);
  return typeof value === "string" && value ? value : fallback;
}

function sameJsonValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function schemaTypeName(value: unknown) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function schemaPath(parent: string, key: string | number) {
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}.${key}`;
}

function schemaTypes(schema: JsonObject) {
  if (Array.isArray(schema.type)) return schema.type.filter((item): item is string => typeof item === "string");
  return typeof schema.type === "string" ? [schema.type] : [];
}

function schemaTypeMatches(value: unknown, type: string) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(asObject(value));
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function validateAgainstSchema(schema: unknown, value: unknown, path = "$", issues: ValidationIssue[] = []): ValidationIssue[] {
  const item = asObject(schema);
  if (!item) return issues;

  if (Array.isArray(item.oneOf)) {
    const matches = item.oneOf.filter((candidate) => validateAgainstSchema(candidate, value, path, []).every((issue) => issue.severity !== "error"));
    if (matches.length !== 1) issues.push({ path, message: matches.length === 0 ? "does not match oneOf" : "matches multiple oneOf entries", severity: "error" });
    return issues;
  }

  if (Array.isArray(item.anyOf)) {
    const matches = item.anyOf.filter((candidate) => validateAgainstSchema(candidate, value, path, []).every((issue) => issue.severity !== "error"));
    if (matches.length === 0) issues.push({ path, message: "does not match anyOf", severity: "error" });
    return issues;
  }

  if ("const" in item && !sameJsonValue(value, item.const)) {
    issues.push({ path, message: `must equal ${JSON.stringify(item.const)}`, severity: "error" });
  }

  if (Array.isArray(item.enum) && !item.enum.some((candidate) => sameJsonValue(value, candidate))) {
    issues.push({ path, message: `must be one of ${item.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`, severity: "error" });
  }

  const types = schemaTypes(item);
  if (types.length > 0 && !types.some((type) => schemaTypeMatches(value, type))) {
    issues.push({ path, message: `expected ${types.join(" | ")}, got ${schemaTypeName(value)}`, severity: "error" });
    return issues;
  }

  if (asObject(value)) {
    const record = value as JsonObject;
    const properties = asObject(item.properties) ?? {};
    const required = Array.isArray(item.required) ? item.required.filter((key): key is string => typeof key === "string") : [];
    for (const key of required) {
      if (!(key in record)) issues.push({ path: schemaPath(path, key), message: "is required", severity: "error" });
    }
    if (item.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) issues.push({ path: schemaPath(path, key), message: "is not allowed by schema", severity: "error" });
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) validateAgainstSchema(childSchema, record[key], schemaPath(path, key), issues);
    }
  }

  if (Array.isArray(value)) {
    if (typeof item.minItems === "number" && value.length < item.minItems) issues.push({ path, message: `requires at least ${item.minItems} items`, severity: "error" });
    if (typeof item.maxItems === "number" && value.length > item.maxItems) issues.push({ path, message: `allows at most ${item.maxItems} items`, severity: "error" });
    value.forEach((child, index) => validateAgainstSchema(item.items, child, schemaPath(path, index), issues));
  }

  if (typeof value === "number") {
    if (typeof item.minimum === "number" && value < item.minimum) issues.push({ path, message: `must be >= ${item.minimum}`, severity: "error" });
    if (typeof item.maximum === "number" && value > item.maximum) issues.push({ path, message: `must be <= ${item.maximum}`, severity: "error" });
  }

  if (typeof value === "string") {
    if (typeof item.minLength === "number" && value.length < item.minLength) issues.push({ path, message: `must be at least ${item.minLength} characters`, severity: "error" });
    if (typeof item.maxLength === "number" && value.length > item.maxLength) issues.push({ path, message: `must be at most ${item.maxLength} characters`, severity: "error" });
  }

  return issues;
}

function requestValidationIssues(requestText: string, operation?: SecurityApiOperation): ValidationIssue[] {
  try {
    const parsed = parseJson(requestText);
    const bodySchema = asObject(asObject(operation?.inputSchema)?.body);
    if (!bodySchema) return [];
    return validateAgainstSchema(bodySchema, parsed);
  } catch (cause) {
    return [{ path: "$", message: cause instanceof Error ? cause.message : "invalid JSON", severity: "error" }];
  }
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function modulesFrom(value: SecurityCapabilityResponse | SecurityApiModule[] | SecurityApiModule | SecurityApiOperation[] | SecurityApiOperation | undefined): SecurityApiModule[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item): item is SecurityApiModule => "operations" in item || "path" in item);
  if ("modules" in value && value.modules) return value.modules;
  if ("name" in value && "operations" in value) return [value as SecurityApiModule];
  return [];
}

function operationsFrom(value: SecurityCapabilityResponse | SecurityApiModule[] | SecurityApiModule | SecurityApiOperation[] | SecurityApiOperation | undefined): SecurityApiOperation[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item): item is SecurityApiOperation => "method" in item && "path" in item && !("operations" in item));
  if ("operations" in value && value.operations) return value.operations;
  if ("operation" in value && value.operation) return [value.operation];
  if ("name" in value && "method" in value) return [value as SecurityApiOperation];
  return [];
}

function operationPayload(operation?: SecurityApiOperation, example?: OperationExample): SecurityCapabilityRequest {
  const exampleRequest = example?.request ?? operationExamples(operation)[0]?.request;
  if (exampleRequest) return exampleRequest;
  const bodyProperties = asObject(asObject(asObject(operation?.inputSchema)?.body)?.properties) ?? {};
  const name = operation?.name ?? schemaConstString(bodyProperties.operation, "assessRuntimeAction");
  const params = schemaValue(bodyProperties.params);
  return {
    action: schemaConstString(bodyProperties.action, "execute"),
    module: schemaConstString(bodyProperties.module, "security-center"),
    operation: name,
    params: asObject(params) ?? {},
  };
}

function capabilityRouteAction(value: string | null): RouteCapabilityAction | undefined {
  return value === "list" || value === "search" || value === "describe" ? value : undefined;
}

function capabilityRouteParams(input: { action?: RouteCapabilityAction; query?: string; module?: string; operation?: string }) {
  const params = new URLSearchParams();
  if (input.action) params.set("action", input.action);
  if (input.query?.trim()) params.set("query", input.query.trim());
  if (input.module?.trim()) params.set("module", input.module.trim());
  if (input.operation?.trim()) params.set("operation", input.operation.trim());
  return params;
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function FieldValue({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-zinc-600">{label}</p>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-[360px] overflow-auto rounded-md border border-white/10 bg-[#080c09] p-3 font-mono text-[11px] leading-relaxed text-zinc-300", className)}>
      {formatJson(value)}
    </pre>
  );
}

function DryRunSummary({ result }: { result?: SecurityCapabilityDryRunResult }) {
  if (!result) return null;

  const errors = result.schemaIssues.filter((issue) => issue.severity === "error");
  const statusClass = result.schemaValid
    ? "border-teal-400/25 bg-teal-500/10 text-teal-100"
    : "border-rose-400/25 bg-rose-500/10 text-rose-100";
  const decisionClass =
    result.decision === "allow"
      ? "border-teal-400/25 bg-teal-500/10 text-teal-100"
      : "border-rose-400/25 bg-rose-500/10 text-rose-100";

  return (
    <div className={cn("mb-3 rounded-md border px-3 py-3", statusClass)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {result.schemaValid ? <CheckCircle2 className="size-3.5 shrink-0" /> : <AlertTriangle className="size-3.5 shrink-0" />}
          <p className="truncate text-xs font-semibold">Backend Preflight</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Pill className={statusClass}>{result.schemaValid ? "schema ok" : "schema failed"}</Pill>
          <Pill className={decisionClass}>{result.decision}</Pill>
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-5">
        <FieldValue label="Errors" value={errors.length} />
        <FieldValue label="Module" value={result.module} />
        <FieldValue label="Operation" value={result.operation} />
        <FieldValue label="Token" value={result.tokenVerified ? "verified" : "missing"} />
        <FieldValue label="Target" value={result.targetInScope ? "in-scope" : "out-of-scope"} />
      </div>
      {result.schemaIssues.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-white/10 pt-3 font-mono text-[11px] leading-relaxed">
          {result.schemaIssues.slice(0, 6).map((issue) => (
            <p key={`${issue.path}:${issue.message}`} className="break-words">
              {issue.severity} {issue.path} {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OperationRow({
  operation,
  active,
  onSelect,
}: {
  operation: SecurityApiOperation;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_58px_78px] items-center gap-2 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={operation.name}>{operation.name}</span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-600" title={operation.description}>{operation.description}</span>
      </span>
      <Pill className="border-sky-400/25 bg-sky-500/10 text-sky-100">{operation.method}</Pill>
      <Pill className="border-teal-400/25 bg-teal-500/10 text-teal-100">{operation.action ?? "unknown"}</Pill>
    </button>
  );
}

export default function CapabilitiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const routeQuery = searchParams.get("query") ?? searchParams.get("q") ?? "runtime guard";
  const routeModule = searchParams.get("module") ?? "security-center";
  const routeOperation = searchParams.get("operation") ?? "";
  const routeAction = capabilityRouteAction(searchParams.get("action")) ?? (routeOperation ? "describe" : searchParams.has("query") || searchParams.has("q") ? "search" : "list");
  const [modules, setModules] = useState<SecurityApiModule[]>([]);
  const [operations, setOperations] = useState<SecurityApiOperation[]>([]);
  const [selectedModuleName, setSelectedModuleName] = useState(routeModule);
  const [selectedOperationName, setSelectedOperationName] = useState(routeOperation);
  const [operation, setOperation] = useState<SecurityApiOperation>();
  const [query, setQuery] = useState(routeQuery);
  const [requestText, setRequestText] = useState(formatJson(operationPayload()));
  const [response, setResponse] = useState<unknown>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [copiedCurl, setCopiedCurl] = useState(false);

  const selectedModule = useMemo(
    () => modules.find((item) => item.name === selectedModuleName) ?? modules[0],
    [modules, selectedModuleName],
  );
  const selectedOperation = useMemo(
    () => operations.find((item) => item.name === selectedOperationName) ?? operation,
    [operation, operations, selectedOperationName],
  );
  const selectedOperationExamples = useMemo(() => operationExamples(selectedOperation), [selectedOperation]);
  const validationIssues = useMemo(() => requestValidationIssues(requestText, selectedOperation), [requestText, selectedOperation]);
  const validationErrors = useMemo(() => validationIssues.filter((issue) => issue.severity === "error"), [validationIssues]);
  const curlText = useMemo(() => generatedSecurityCapabilityCurl(requestText), [requestText]);
  const dryRunResult = useMemo(() => asDryRunResult(response), [response]);

  const copyCanonicalCurl = async () => {
    await navigator.clipboard?.writeText(curlText);
    setCopiedCurl(true);
    window.setTimeout(() => setCopiedCurl(false), 1600);
  };

  const refreshModules = async (moduleName = selectedModuleName, operationName = selectedOperationName, syncRoute = true, action: RouteCapabilityAction = "list") => {
    setLoading(true);
    setError("");
    try {
      const result = await securityCenterApi.securityCapabilities({ action: "list" });
      const nextModules = modulesFrom(result);
      setModules(nextModules);
      const nextModule = nextModules.find((item) => item.name === moduleName) ?? nextModules[0];
      if (nextModule) {
        setSelectedModuleName(nextModule.name);
        setOperations(nextModule.operations ?? []);
        const nextOperation = nextModule.operations?.find((item) => item.name === operationName || item.operationId === operationName) ?? nextModule.operations?.[0];
        if (nextOperation) {
          setSelectedOperationName(nextOperation.name);
          await describe(nextModule.name, nextOperation.name, false, { action, query, syncRoute });
        } else if (syncRoute) {
          setSearchParams(capabilityRouteParams({ action: "list", query, module: nextModule.name }));
        }
      }
      setResponse(result);
      setUpdatedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "capability list failed");
    } finally {
      setLoading(false);
    }
  };

  const searchOperations = async (nextQuery = query, syncRoute = true) => {
    setLoading(true);
    setError("");
    try {
      const result = await securityCenterApi.securityCapabilities({ action: "search", query: nextQuery });
      const nextOperations = operationsFrom(result);
      setOperations(nextOperations);
      const firstOperation = nextOperations[0];
      if (firstOperation) {
        setSelectedModuleName("security-center");
        setSelectedOperationName(firstOperation.name);
        setOperation(firstOperation);
        setRequestText(formatJson(operationPayload(firstOperation)));
        if (syncRoute) setSearchParams(capabilityRouteParams({ action: "search", query: nextQuery, module: "security-center", operation: firstOperation.name }));
      } else if (syncRoute) {
        setSearchParams(capabilityRouteParams({ action: "search", query: nextQuery }));
      }
      setResponse(result);
      setUpdatedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "capability search failed");
    } finally {
      setLoading(false);
    }
  };

  const describe = async (
    moduleName = selectedModuleName,
    operationName = selectedOperationName,
    showLoading = true,
    options: { action?: RouteCapabilityAction; query?: string; syncRoute?: boolean } = {},
  ) => {
    if (!moduleName || !operationName) return;
    if (showLoading) setLoading(true);
    setError("");
    try {
      const result = await securityCenterApi.securityCapabilities({ action: "describe", module: moduleName, operation: operationName });
      const nextOperation = operationsFrom(result)[0];
      if (nextOperation) {
        setOperation(nextOperation);
        setSelectedOperationName(nextOperation.name);
        setRequestText(formatJson(operationPayload(nextOperation)));
        if (options.syncRoute !== false) {
          setSearchParams(capabilityRouteParams({ action: options.action ?? "describe", query: options.query ?? query, module: moduleName, operation: nextOperation.name }));
        }
      }
      setResponse(result);
      setUpdatedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "capability describe failed");
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const execute = async () => {
    if (validationErrors.length > 0) {
      setError("request does not match described input schema");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const parsed = parseJson(requestText) as SecurityCapabilityRequest;
      const result = await securityCenterApi.executeSecurityCapability(parsed);
      setResponse(result);
      setUpdatedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "capability execute failed");
    } finally {
      setLoading(false);
    }
  };

  const dryRun = async () => {
    setLoading(true);
    setError("");
    try {
      const parsed = parseJson(requestText) as SecurityCapabilityRequest;
      const result = await securityCenterApi.executeSecurityCapability({ ...parsed, dryRun: true });
      setResponse(result);
      setUpdatedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "capability dry run failed");
    } finally {
      setLoading(false);
    }
  };

  const selectOperation = async (item: SecurityApiOperation) => {
    setSelectedOperationName(item.name);
    setOperation(item);
    setRequestText(formatJson(operationPayload(item)));
    await describe(selectedModule?.name ?? selectedModuleName, item.name, true, { query, syncRoute: true });
  };

  useEffect(() => {
    if (routeAction === "search") {
      void searchOperations(routeQuery, false);
      return;
    }
    void refreshModules(routeModule, routeOperation, false, routeAction);
    // Initial discovery should run once from URL-backed state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="h-9 shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                返回
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Sparkles className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">Progressive API</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">list · search · describe · execute</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <span>{updatedAt ? formatDate(updatedAt) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(180px,1fr)_auto_auto_auto_auto]">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search operations" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Button type="button" variant="secondary" size="sm" onClick={() => void refreshModules()} disabled={loading} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            List
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void searchOperations()} disabled={loading} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Search className="size-3.5" />
            Search
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={dryRun} disabled={loading} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Dry run
          </Button>
          <Button type="button" size="sm" onClick={execute} disabled={loading || validationErrors.length > 0} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Execute
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto grid w-full max-w-[1800px] gap-4 xl:grid-cols-[minmax(420px,0.8fr)_minmax(0,1.2fr)]">
          <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-teal-200" />
                <h2 className="text-sm font-semibold text-zinc-100">Discovery</h2>
              </div>
              <span className="text-xs text-zinc-500">{operations.length} ops</span>
            </div>
            <div className="border-b border-white/10 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <FieldValue label="Module" value={selectedModule?.name} />
                <FieldValue label="Path" value={selectedModule?.path} />
              </div>
              {selectedModule?.description ? <p className="mt-3 text-xs text-zinc-500">{selectedModule.description}</p> : null}
            </div>
            <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
              {operations.length === 0 ? (
                <div className="flex min-h-32 items-center justify-center text-sm text-zinc-500">暂无操作</div>
              ) : (
                operations.map((item) => (
                  <OperationRow
                    key={item.name}
                    operation={item}
                    active={item.name === selectedOperationName}
                    onSelect={() => void selectOperation(item)}
                  />
                ))
              )}
            </div>
          </section>

          <div className="space-y-4">
            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileCode2 className="size-4 shrink-0 text-teal-200" />
                  <h2 className="truncate text-sm font-semibold text-zinc-100">{selectedOperation?.name ?? "Operation"}</h2>
                </div>
                {selectedOperation?.action ? <Pill className="border-teal-400/25 bg-teal-500/10 text-teal-100">{selectedOperation.action}</Pill> : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <FieldValue label="Method" value={selectedOperation?.method} />
                <FieldValue label="Path" value={selectedOperation?.path} />
                <FieldValue label="Resource" value={selectedOperation?.resource} />
              </div>
              {selectedOperation?.description ? <p className="mt-3 text-xs text-zinc-500">{selectedOperation.description}</p> : null}
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-zinc-400">Input Schema</p>
                    <Button type="button" variant="secondary" size="sm" onClick={() => void describe()} disabled={loading || !selectedOperationName} className="h-7 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                      <Braces className="size-3.5" />
                      Describe
                    </Button>
                  </div>
                  <JsonBlock value={selectedOperation?.inputSchema ?? {}} />
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-zinc-400">Output Schema</p>
                  <JsonBlock value={selectedOperation?.outputSchema ?? {}} />
                </div>
              </div>
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
              <div className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-zinc-400">Execute Request</p>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setRequestText(formatJson(operationPayload(selectedOperation)))} className="h-7 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
                    Sample
                  </Button>
                </div>
                {selectedOperationExamples.length > 0 ? (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {selectedOperationExamples.map((example, index) => (
                      <Button
                        key={`${selectedOperation?.name ?? "operation"}-${index}`}
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setRequestText(formatJson(operationPayload(selectedOperation, example)))}
                        className="h-7 max-w-full border border-white/10 bg-white/5 text-xs text-zinc-100 hover:bg-white/10"
                      >
                        <span className="truncate">{example.description ?? `Example ${index + 1}`}</span>
                      </Button>
                    ))}
                  </div>
                ) : null}
                <div
                  className={cn(
                    "mb-3 rounded-md border px-3 py-2 text-xs",
                    validationErrors.length > 0 ? "border-rose-400/25 bg-rose-500/10 text-rose-100" : "border-teal-400/25 bg-teal-500/10 text-teal-100",
                  )}
                >
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 font-semibold">
                      {validationErrors.length > 0 ? <AlertTriangle className="size-3.5 shrink-0" /> : <CheckCircle2 className="size-3.5 shrink-0" />}
                      <span>Schema Check</span>
                    </div>
                    <span className="font-mono">{validationErrors.length > 0 ? `${validationErrors.length} errors` : "ok"}</span>
                  </div>
                  {validationErrors.length > 0 ? (
                    <div className="mt-2 space-y-1 font-mono text-[11px] leading-relaxed text-rose-100/85">
                      {validationErrors.slice(0, 6).map((issue) => (
                        <p key={`${issue.path}:${issue.message}`} className="break-words">
                          {issue.path} {issue.message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
                <textarea
                  value={requestText}
                  onChange={(event) => setRequestText(event.target.value)}
                  spellCheck={false}
                  className="min-h-[360px] w-full resize-y rounded-md border border-white/10 bg-[#080c09] p-3 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/50"
                />
                <div className="mt-4 rounded-[8px] border border-white/10 bg-[#0b0f0c] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-zinc-400">
                      <Terminal className="size-3.5 shrink-0 text-teal-200" />
                      <span className="truncate">Canonical curl</span>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon-sm"
                      onClick={copyCanonicalCurl}
                      title={copiedCurl ? "Copied canonical curl" : "Copy canonical curl"}
                      aria-label={copiedCurl ? "Copied canonical curl" : "Copy canonical curl"}
                      className="shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
                    >
                      {copiedCurl ? <CheckCircle2 className="size-3.5 text-teal-200" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-[#080c09] p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                    {curlText}
                  </pre>
                </div>
              </div>
              <div className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <p className="mb-2 text-xs font-medium text-zinc-400">Response</p>
                {error ? (
                  <div className="mb-3 rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</div>
                ) : null}
                <DryRunSummary result={dryRunResult} />
                <JsonBlock value={response ?? { status: "idle" }} className="min-h-[360px]" />
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
