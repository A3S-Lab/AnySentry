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
