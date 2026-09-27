import type { WorkloadIdentitySnapshotEntry } from './types';
import type { FilterRuleDraftRequest, FilterRuleHumanSummary } from './filter-rule.types';

export interface AssistantWorkloadView {
  containerName?: string;
  containerImage?: string;
  classification: string;
  workloadRole?: string;
  environment?: string;
  namespace?: string;
  podName?: string;
  ownerKind?: string;
  ownerName?: string;
  physicalWorkloadId: string;
  systemdUnit?: string;
  processes?: Array<{ comm?: string; exeBasename?: string }>;
  evidence: string[];
}

export interface AssistantWorkloadInspection {
  schemaVersion: 'anysentry.assistant_workload_inspection.v1';
  shell: false;
  source: 'workload_identity_snapshot';
  note: string;
  snapshotReady: boolean;
  generatedAt: string;
  matched: AssistantWorkloadView[];
  filterNote?: {
    hint: string;
    available: { total: number; bySource: Record<string, number>; byClassification: Record<string, number> };
  };
  ruleHints: Array<{ ruleId: string; name: string; lifecycleStage: string; matcherText: string }>;
}

export interface AssistantIdentityDraftInput {
  name?: string;
  description?: string;
  reason?: string;
  comm?: string;
  exeBasename?: string;
  container?: string;
  image?: string;
  placement?: string;
  confirm?: boolean;
}

// Mirrored from scripts/observer-agent-runtime-signatures.js (GENERIC_LAUNCHERS). The observer
// rejects any runtime signature whose every match field is a generic interpreter ("cannot match
// only generic launchers"); validating here gives the model actionable feedback up front instead
// of a rule that enforces in the catalog but never loads on the collector.
const GENERIC_LAUNCHERS = new Set([
  'bash', 'busybox', 'bun', 'cmd', 'corepack', 'dash', 'deno', 'dotnet', 'env', 'fish', 'java',
  'node', 'npm', 'npx', 'perl', 'php', 'pip', 'pip3', 'pipx', 'pnpm', 'powershell', 'python',
  'python3', 'pwsh', 'ruby', 'sh', 'ts-node', 'tsx', 'uv', 'uvx', 'yarn', 'zsh',
]);

function basename(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

const NOTE = 'Host-side workload inventory and current classification. This is not a shell inside the container.';

function text(value: unknown, limit = 160): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, limit) : undefined;
}

function view(entry: WorkloadIdentitySnapshotEntry): AssistantWorkloadView {
  return {
    ...(entry.containerName ? { containerName: entry.containerName } : {}),
    ...(entry.containerImage ? { containerImage: entry.containerImage } : {}),
    classification: entry.classification,
    ...(entry.workloadRole ? { workloadRole: entry.workloadRole } : {}),
    ...(entry.environment ? { environment: entry.environment } : {}),
    ...(entry.namespace ? { namespace: entry.namespace } : {}),
    ...(entry.podName ? { podName: entry.podName } : {}),
    ...(entry.ownerKind ? { ownerKind: entry.ownerKind } : {}),
    ...(entry.ownerName ? { ownerName: entry.ownerName } : {}),
    physicalWorkloadId: entry.physicalWorkloadId,
    ...(entry.systemdUnit ? { systemdUnit: entry.systemdUnit } : {}),
    ...(entry.processes?.length
      ? { processes: entry.processes.slice(0, 4).map((process) => ({ ...process })) }
      : {}),
    evidence: entry.evidence.slice(0, 6),
  };
}

function haystack(entry: WorkloadIdentitySnapshotEntry): string {
  return [
    entry.containerName,
    entry.containerImage,
    entry.classification,
    entry.workloadRole,
    entry.namespace,
    entry.podName,
    entry.ownerName,
    entry.systemdUnit,
    entry.physicalWorkloadId,
    ...(entry.processes ?? []).map((process) => `${process.comm ?? ''}\n${process.exeBasename ?? ''}`),
    ...entry.ids,
    ...entry.evidence,
  ].filter(Boolean).join('\n').toLowerCase();
}

function countBy(entries: readonly WorkloadIdentitySnapshotEntry[], key: (entry: WorkloadIdentitySnapshotEntry) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const bucket = key(entry);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

export function inspectWorkloads(input: {
  entries: readonly WorkloadIdentitySnapshotEntry[];
  rules?: readonly FilterRuleHumanSummary[];
  q?: string;
  classification?: string;
  source?: string;
  ready?: boolean;
  generatedAt?: string;
  limit?: number;
}): AssistantWorkloadInspection {
  const q = text(input.q, 160)?.toLowerCase();
  const classification = text(input.classification, 40);
  const source = text(input.source, 40);
  const limit = Math.max(1, Math.min(24, Number(input.limit) || 12));
  const matched = input.entries
    .filter((entry) => !classification || entry.classification === classification)
    .filter((entry) => !source || (entry.source ?? entry.environment) === source)
    .filter((entry) => !q || haystack(entry).includes(q))
    .slice(0, limit)
    .map(view);
  // When filters match nothing but inventory exists, tell the model what is
  // available so it can retry without the bad filter instead of reporting an
  // empty host.
  const filterNote = matched.length || !input.entries.length
    ? undefined
    : {
        hint: 'filters matched nothing; retry without q/classification/source to list everything',
        available: {
          total: input.entries.length,
          bySource: countBy(input.entries, (entry) => entry.source ?? entry.environment ?? 'unknown'),
          byClassification: countBy(input.entries, (entry) => entry.classification),
        },
      };
  const ruleHints = (input.rules ?? [])
    .filter((rule) => !q || `${rule.ruleId} ${rule.name} ${rule.matcherText}`.toLowerCase().includes(q))
    .slice(0, 8)
    .map((rule) => ({
      ruleId: rule.ruleId,
      name: rule.name,
      lifecycleStage: rule.lifecycleStage,
      matcherText: rule.matcherText.slice(0, 240),
    }));
  return {
    schemaVersion: 'anysentry.assistant_workload_inspection.v1',
    shell: false,
    source: 'workload_identity_snapshot',
    note: NOTE,
    snapshotReady: input.ready !== false,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    matched,
    ...(filterNote ? { filterNote } : {}),
    ruleHints,
  };
}

export function buildIdentityDraft(input: AssistantIdentityDraftInput): {
  persisted: false;
  draft: FilterRuleDraftRequest;
} {
  const comm = text(input.comm, 80);
  const exeBasename = text(input.exeBasename, 120);
  const container = text(input.container, 160);
  const image = text(input.image, 200);
  const placementInput = text(input.placement, 40);
  if (!comm && !exeBasename && !container && !image) {
    throw new Error('one of container, image, comm or exeBasename is required');
  }
  // Workload-scope conditions route to agent_template: the observer template registry evaluates
  // container/image/deployment per workload, which process signatures cannot express. This is the
  // only safe way to identify generic-interpreter services (python server.py et al.).
  if (container || image) {
    const placement = ['docker', 'kubernetes', 'host'].includes(placementInput ?? '')
      ? placementInput!
      : 'docker';
    const conditions = [
      ...(container ? [{ field: 'workload.container' as const, operator: 'equals' as const, value: container }] : []),
      ...(image ? [{ field: 'workload.image' as const, operator: 'equals' as const, value: image }] : []),
      { field: 'workload.placement' as const, operator: 'equals' as const, value: placement },
    ];
    const name = text(input.name, 240) ?? `candidate ${container ?? image}`;
    const description = text(input.description, 1_000)
      ?? `Candidate workload identity for ${[container, image].filter(Boolean).join(', ')} on ${placement}.`;
    const reason = text(input.reason, 500) ?? 'assistant candidate for an unmatched running workload';
    return {
      persisted: false,
      draft: {
        name,
        description,
        category: 'agent_identity',
        ruleKind: 'agent_template',
        matcher: {
          description: `workload template ${conditions.map((item) => `${item.field}=${item.value}`).join(', ')}`,
          all: conditions,
        },
        effect: {
          type: 'emit_identity',
          classification: 'probable_agent',
          confidence: 0.6,
        },
        reason,
      },
    };
  }
  const signatureFields: Array<[string, string]> = [
    ...(comm ? [['process.comm', comm] as [string, string]] : []),
    ...(exeBasename ? [['process.exe_basename', exeBasename] as [string, string]] : []),
  ];
  if (signatureFields.every(([, value]) => GENERIC_LAUNCHERS.has(basename(value)))) {
    throw new Error(
      `process signature ${signatureFields.map(([field, value]) => `${field}=${value}`).join(', ')} matches only generic interpreters; `
      + 'the observer rejects such signatures ("cannot match only generic launchers"). '
      + 'Pass container or image instead to build a workload-scoped agent_template rule, '
      + 'or use a more specific comm/exe_basename.',
    );
  }
  const conditions = [
    ...(comm ? [{ field: 'process.comm' as const, operator: 'equals' as const, value: comm }] : []),
    ...(exeBasename ? [{ field: 'process.exe_basename' as const, operator: 'equals' as const, value: exeBasename }] : []),
  ];
  const name = text(input.name, 240) ?? `candidate ${comm ?? exeBasename}`;
  const description = text(input.description, 1_000)
    ?? `Candidate identity for an already-running workload (${[comm, exeBasename].filter(Boolean).join(', ')}).`;
  const reason = text(input.reason, 500) ?? 'assistant candidate for an unmatched running workload';
  return {
    persisted: false,
    draft: {
      name,
      description,
      category: 'agent_identity',
      ruleKind: 'runtime_signature',
      matcher: {
        description: `process signature ${conditions.map((item) => `${item.field}=${item.value}`).join(', ')}`,
        all: conditions,
      },
      effect: {
        type: 'emit_identity',
        classification: 'probable_agent',
        confidence: 0.6,
      },
      reason,
    },
  };
}
