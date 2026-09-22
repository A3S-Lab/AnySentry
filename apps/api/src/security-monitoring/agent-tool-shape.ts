/**
 * Product-neutral tool and host-identity shape helpers.
 * Patterns are capability names (todo/plan, systemd unit, process comm), not framework products.
 */

export function looksLikeSystemdUnit(value?: string): boolean {
  const normalized = value?.trim();
  if (!normalized) return false;
  return /(?:^|\/)[^/]+\.(?:service|scope|slice)$/u.test(normalized)
    || /^user@\d+\.service$/u.test(normalized);
}

export function processFamilyLabel(process?: {
  comm?: string;
  exe?: string;
}): string | undefined {
  const comm = process?.comm?.trim();
  if (comm && comm !== '-' && !looksLikeSystemdUnit(comm)) {
    return comm.replace(/\s+/gu, ' ').slice(0, 80);
  }
  const exe = process?.exe?.trim();
  const base = exe?.split(/[\\/]/u).pop()?.trim();
  if (base && base !== '-' && !looksLikeSystemdUnit(base)) return base.slice(0, 80);
  return undefined;
}

/** Keep F0 cgroup/systemd as inventory keys; do not copy the unit into agentProduct. */
export function observedAgentProduct(input: {
  semanticProduct?: string;
  displayName?: string;
  agentId?: string;
  process?: { comm?: string; exe?: string };
}): string | undefined {
  if (input.semanticProduct && !looksLikeSystemdUnit(input.semanticProduct)) {
    return input.semanticProduct;
  }
  const family = processFamilyLabel(input.process);
  if (family) return family;
  if (input.displayName && !looksLikeSystemdUnit(input.displayName)) return input.displayName;
  if (input.agentId && !looksLikeSystemdUnit(input.agentId)) return input.agentId;
  return undefined;
}

/** In-memory plan/todo tools are not file effects even when the name contains "write". */
export function inMemoryPlanTool(label: string): boolean {
  return /(?:^|[\s._-])(?:todos?|todo_list|plan|scratchpad)(?:$|[\s._-])/iu.test(label);
}

/**
 * Capability names that imply a kernel or transport effect. Product-neutral: python/http/file,
 * not LangChain or a lab fixture. `write_todos` is excluded by {@link inMemoryPlanTool} first.
 */
const KERNEL_CAPABILITY_PATTERN =
  /(?:^|[\s._-])(?:bash|exec|shell|sandbox|python|node|code|search|http|fetch|network|mcp|read|write|edit|file|notebook)(?:$|[\s._-])/iu;

/** In-process memory/lookup capabilities. Undeclared custom tools stay on process-lineage. */
const IN_PROCESS_MEMORY_PATTERN =
  /(?:^|[\s._-])(?:lookup|remember|recall|scratch|note|memo)(?:$|[\s._-])/iu;

function toolKernelPayload(content?: unknown): boolean {
  if (toolDelegatedCode(content) || toolContentCode(content)) return true;
  if (typeof content === 'string') {
    return /(?:^|[/\s])(?:bin\/|usr\/|tmp\/|etc\/|proc\/)/u.test(content);
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
  const record = content as Record<string, unknown>;
  for (const key of ['path', 'file', 'filename', 'filepath', 'target', 'host', 'port']) {
    if (typeof record[key] === 'string' && record[key].trim()) return true;
  }
  return false;
}

/**
 * In-process memory/lookup tools, plus plan/todo even when the name contains "write".
 * Do not invent FileAccess. Undeclared custom tools still expect process-lineage Kernel.
 */
export function expectedNoKernelTool(label: string, content?: unknown): boolean {
  if (inMemoryPlanTool(label)) return true;
  if (KERNEL_CAPABILITY_PATTERN.test(label)) return false;
  if (!IN_PROCESS_MEMORY_PATTERN.test(label)) return false;
  return !toolKernelPayload(content);
}

export function toolContentCode(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? trimmed.slice(0, 16_384) : undefined;
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const record = content as Record<string, unknown>;
  for (const key of ['code', 'endpoint', 'url', 'command', 'cmd', 'script']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 16_384);
  }
  return undefined;
}

/** Delegated runtime payload. Name-agnostic: only the `code` argument, never command/argv. */
export function toolDelegatedCode(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const code = (parsed as Record<string, unknown>).code;
        if (typeof code === 'string' && code.trim()) return code.trim().slice(0, 16_384);
      }
    } catch {
      const quoted = trimmed.match(/"code"\s*:\s*"((?:\\.|[^"\\])*)"/u)?.[1];
      if (quoted) return quoted.replace(/\\"/gu, '"').slice(0, 16_384);
    }
    return undefined;
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const code = (content as Record<string, unknown>).code;
  return typeof code === 'string' && code.trim() ? code.trim().slice(0, 16_384) : undefined;
}

export function genericServiceRoute(value?: string): boolean {
  return /(?:^|\/)(?:invoke|runs|stream|chat|completions)(?:\/|$)/iu.test(value ?? '');
}
