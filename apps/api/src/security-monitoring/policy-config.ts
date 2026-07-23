// The editable judge policy — the "intervention" control surface behind the config panels.
//
// AnySentry embeds @a3s-lab/sentry, whose ONLY config lever is the ACL string passed to
// Sentry.create(). So a config change = regenerate the ACL from this model + recreate the judge
// (done in SentryJudgeService.applyPolicy). Verified against the SDK: custom `rules` are ADDITIVE to
// the built-in protections; `llm`/`agent` blocks must be multi-line HCL; L2/L3 only fire when an L1
// rule escalates, and degrade gracefully (allow/escalate) when their backend is unreachable.

import { Severity, Verdict } from './types';

export type RuleKind = 'ToolExec' | 'Egress' | 'Dns' | 'FileAccess' | 'SslContent' | 'SecurityAction';
export type RuleAction = '' | 'deny-exec' | 'deny-egress' | 'deny-file';

/** One L1 regex rule, layered on top of the built-in rule set. */
export interface L1Rule {
  name: string;
  on: RuleKind;
  match: string; // regex
  verdict: Verdict;
  severity: Severity;
  reason: string;
  action?: RuleAction;
}
export interface L2Config { url: string; model: string; timeoutS: number } // LLM judge endpoint
/** `bin` and `timeoutS` are retained for policy and UOS upgrade compatibility;
 * the async L3 worker uses the in-process SDK and its own execution timeout. */
export interface L3Config { bin: string; skills: string; timeoutS: number }

/** The whole judge policy. `null` tiers are "not configured" → the dashboard hides them. */
export interface PolicyConfig {
  failClosed: boolean;
  speculate: 'off' | 'low' | 'medium' | 'high';
  rules: L1Rule[];
  llm: L2Config | null;
  agent: L3Config | null;
}

export class PolicyConfigError extends Error {
  constructor(message = 'invalid policy') {
    super(message);
    this.name = 'PolicyConfigError';
  }
}

export function policyConfigError(error: unknown): PolicyConfigError {
  if (error instanceof PolicyConfigError) return error;
  const message = error instanceof Error && error.message ? error.message : String(error || 'invalid policy');
  return new PolicyConfigError(message);
}

export const DEFAULT_POLICY: PolicyConfig = {
  failClosed: false,
  speculate: 'off',
  rules: [],
  llm: null,
  agent: null,
};

const DEFAULT_L3_BIN = '/opt/anysentry/l3/l3-agent.mjs';
const DEFAULT_L3_SKILLS = '/opt/anysentry/l3/skills';

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/** Seed a fresh installation from its protected systemd EnvironmentFile. Secrets deliberately do
 * not enter this serializable policy object; they are supplied only while building the in-memory ACL. */
export function policyFromEnvironment(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const url = (env.ANYSENTRY_LLM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!url) return { ...DEFAULT_POLICY, rules: [] };
  const l3Enabled = enabled(env.ANYSENTRY_L3_ENABLED);
  return sanitizePolicy({
    ...DEFAULT_POLICY,
    llm: {
      url,
      model: env.ANYSENTRY_LLM_MODEL,
      timeoutS: env.ANYSENTRY_LLM_TIMEOUT,
    },
    agent: l3Enabled
      ? {
          bin: env.ANYSENTRY_L3_BIN || DEFAULT_L3_BIN,
          skills: env.ANYSENTRY_L3_SKILLS || DEFAULT_L3_SKILLS,
          timeoutS: env.ANYSENTRY_L3_TIMEOUT,
        }
      : null,
  });
}

const KINDS: RuleKind[] = ['ToolExec', 'Egress', 'Dns', 'FileAccess', 'SslContent', 'SecurityAction'];
const VERDICTS: Verdict[] = ['allow', 'block', 'escalate'];
const SEVERITIES: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
const ACTIONS: RuleAction[] = ['', 'deny-exec', 'deny-egress', 'deny-file'];

/** Coerce arbitrary input (the PUT body) into a valid PolicyConfig — never trust the wire. */
export function sanitizePolicy(input: unknown): PolicyConfig {
  const o = (input ?? {}) as Record<string, unknown>;
  const pick = <T>(v: unknown, allowed: T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);
  const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };

  const rules: L1Rule[] = Array.isArray(o.rules)
    ? (o.rules as unknown[]).slice(0, 200).map((r) => {
        const x = (r ?? {}) as Record<string, unknown>;
        return {
          name: str(x.name, 80) || 'rule',
          on: pick(x.on, KINDS, 'ToolExec'),
          match: str(x.match, 1000),
          verdict: pick(x.verdict, VERDICTS, 'block'),
          severity: pick(x.severity, SEVERITIES, 'medium'),
          reason: str(x.reason, 200) || 'custom rule',
          action: pick(x.action, ACTIONS, ''),
        };
      }).filter((r) => r.match)
    : [];

  const llmIn = o.llm as Record<string, unknown> | null | undefined;
  const llm: L2Config | null = llmIn && str(llmIn.url) ? { url: str(llmIn.url, 500), model: str(llmIn.model, 100) || 'default', timeoutS: num(llmIn.timeoutS, 1, 600, 45) } : null;

  const agentIn = o.agent as Record<string, unknown> | null | undefined;
  const agent: L3Config | null = agentIn && str(agentIn.bin)
    ? { bin: str(agentIn.bin, 500), skills: str(agentIn.skills, 500), timeoutS: num(agentIn.timeoutS, 1, 3600, 120) }
    : null;

  return { failClosed: o.failClosed === true, speculate: pick(o.speculate, ['off', 'low', 'medium', 'high'], 'off'), rules, llm, agent };
}

/** HCL double-quoted string. */
function q(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Render the policy as a sentry ACL (HCL). Blocks are multi-line; the rules list uses object
 *  literals. Built-in rules always apply underneath these. */
export function buildAcl(c: PolicyConfig, secrets: { llmApiKey?: string } = {}): string {
  const out: string[] = [`fail_closed = ${c.failClosed}`];
  if (c.speculate !== 'off') out.push(`speculate = ${q(c.speculate)}`);
  if (c.llm) {
    const key = secrets.llmApiKey ? `\n  key = ${q(secrets.llmApiKey)}` : '';
    out.push(`llm {\n  url = ${q(c.llm.url)}\n  model = ${q(c.llm.model)}${key}\n  timeout_s = ${c.llm.timeoutS | 0}\n}`);
  }
  if (c.agent) out.push(`agent {\n  bin = ${q(c.agent.bin)}\n  skills = ${q(c.agent.skills)}\n  timeout_s = ${c.agent.timeoutS | 0}\n}`);
  if (c.rules.length) {
    out.push('rules = [');
    for (const r of c.rules) {
      const action = r.action ? `, action = ${q(r.action)}` : '';
      out.push(`  { name = ${q(r.name)}, on = ${q(r.on)}, match = ${q(r.match)}, verdict = ${q(r.verdict)}, severity = ${q(r.severity)}, reason = ${q(r.reason)}${action} },`);
    }
    out.push(']');
  }
  return out.join('\n') + '\n';
}

/** Build the API/Fast Judge policy without an in-process L3 agent. */
export function buildFastAcl(c: PolicyConfig): string {
  return buildAcl({ ...c, agent: null, speculate: 'off' });
}

/** Which tiers the dashboard should show (`如果没配置就前端不展示`). L1 is always active (built-ins). */
export function tierStatus(c: PolicyConfig): { l1: boolean; l2: boolean; l3: boolean } {
  return { l1: true, l2: !!c.llm, l3: !!c.agent };
}
