import { AgentReviewRevisionRecord, AgentWorkloadRef } from './types';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const FULL_CONTAINER_ID = /^[a-f0-9]{32,64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const MAX_REVIEW_KEYS = 32;
export const MAX_AGENT_REVIEW_REVISIONS = 256;

function text(value: unknown, limit = 500): string | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized && !CONTROL_CHARACTERS.test(normalized)
    ? normalized.slice(0, limit)
    : undefined;
}

function displayText(value: unknown, limit: number): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && !CONTROL_CHARACTERS.test(normalized)
    ? normalized.slice(0, limit)
    : undefined;
}

function exactWorkloadIdentity(
  key: string,
  physicalWorkloadId: string | undefined,
  agentInstanceId: string | undefined,
  workload: AgentWorkloadRef | undefined,
): boolean {
  const physical = text(physicalWorkloadId);
  const instance = text(agentInstanceId);
  const podUid = text(workload?.podUid, 240);
  const namespace = text(workload?.namespace, 160);
  const containerName = text(workload?.containerName, 240);
  const containerImage = text(workload?.containerImage);
  const systemdUnit = text(workload?.systemdUnit, 240);

  if (workload?.environment === 'kubernetes' && podUid && namespace && containerName) {
    if (key === podUid) return true;
    if (key === physical || key === instance) return key.includes(podUid);
    if (key.startsWith('logical:k8s:')) {
      const parts = key.split(':');
      return parts.length >= 7 &&
        parts[2] === namespace &&
        parts[5] === containerName &&
        !parts.some((part) => !part || part === 'unknown' || part === 'start-unknown');
    }
  }

  if (workload?.environment === 'docker' && containerName && (containerImage || physical || instance)) {
    if (key === physical || key === instance) {
      return /^(?:container|docker):/u.test(key) && !key.endsWith(':unknown');
    }
    if (key.startsWith('logical:docker:')) {
      return key.includes(`:${containerName}:`) && !key.includes(':unknown:');
    }
  }

  if (
    workload?.environment === 'host' &&
    systemdUnit?.endsWith('.service') &&
    !systemdUnit.startsWith('session-')
  ) {
    if (key === physical || key === instance) {
      return key.includes(systemdUnit) && /(?:^|:)systemd:/u.test(key);
    }
    if (key.startsWith('systemd:') || key.startsWith('logical:systemd:')) {
      return key.includes(`:${systemdUnit}`);
    }
  }

  return false;
}

function exactContainerIdentity(key: string): boolean {
  if (FULL_CONTAINER_ID.test(key)) return true;
  const parts = key.split(':');
  const candidate = parts.at(-1) ?? '';
  return /^(?:container|docker|k8s):/u.test(key) && FULL_CONTAINER_ID.test(candidate);
}

function exactProcessIdentity(key: string): boolean {
  const parts = key.split(':');
  if (parts[0] === 'host' && parts.length >= 6 && (parts[3] === 'root' || parts[3] === 'process')) {
    return POSITIVE_DECIMAL.test(parts[4] ?? '') && POSITIVE_DECIMAL.test(parts[5] ?? '');
  }
  if ((parts[0] === 'host-root' || parts[0] === 'host-process') && parts.length >= 5) {
    return POSITIVE_DECIMAL.test(parts[3] ?? '') && POSITIVE_DECIMAL.test(parts[4] ?? '');
  }
  return false;
}

export function stableAgentReviewIdentityKeys(input: {
  identityKeys?: unknown[];
  physicalWorkloadId?: unknown;
  agentInstanceId?: unknown;
  workloadRef?: AgentWorkloadRef;
}): string[] {
  const physicalWorkloadId = text(input.physicalWorkloadId);
  const agentInstanceId = text(input.agentInstanceId);
  const candidates = [
    ...(Array.isArray(input.identityKeys) ? input.identityKeys : []),
    physicalWorkloadId,
    agentInstanceId,
  ];
  const stable = candidates
    .map((value) => text(value))
    .filter((value): value is string => Boolean(value))
    .filter((key) =>
      exactContainerIdentity(key) ||
      exactProcessIdentity(key) ||
      exactWorkloadIdentity(
        key,
        physicalWorkloadId,
        agentInstanceId,
        input.workloadRef,
      )
    );
  return [...new Set(stable)].slice(0, MAX_REVIEW_KEYS);
}

export function validReviewEffectiveAt(value: unknown, fallback = Date.now()): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizedReviewHistory(
  value: unknown,
  legacy?: Omit<AgentReviewRevisionRecord, 'revision'> & { revision?: number },
): AgentReviewRevisionRecord[] {
  const raw = Array.isArray(value) ? value : [];
  const byRevision = new Map<number, AgentReviewRevisionRecord>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const input = item as Partial<AgentReviewRevisionRecord>;
    const revision = Number(input.revision);
    const effectiveAt = Number(input.effectiveAt);
    const decision = input.decision;
    if (!Number.isSafeInteger(revision) || revision <= 0) continue;
    if (!Number.isSafeInteger(effectiveAt) || effectiveAt < 0) continue;
    if (!['confirmed_agent', 'unknown', 'non_agent', 'clear'].includes(String(decision))) continue;
    const normalized: AgentReviewRevisionRecord = {
      revision,
      decision: decision!,
      effectiveAt,
      reviewedBy: displayText(input.reviewedBy, 240),
      note: typeof input.note === 'string' ? input.note.slice(0, 2_000) : undefined,
      identityKeys: [...new Set((input.identityKeys ?? []).map((key) => text(key)).filter((key): key is string => Boolean(key)))].slice(0, MAX_REVIEW_KEYS),
      clearedIdentityKeys: [...new Set((input.clearedIdentityKeys ?? []).map((key) => text(key)).filter((key): key is string => Boolean(key)))].slice(0, MAX_REVIEW_KEYS),
      physicalWorkloadId: text(input.physicalWorkloadId),
      agentInstanceId: text(input.agentInstanceId),
      workloadRef: input.workloadRef,
    };
    const previous = byRevision.get(revision);
    if (!previous || normalized.effectiveAt >= previous.effectiveAt) byRevision.set(revision, normalized);
  }
  if (byRevision.size === 0 && legacy) {
    const effectiveAt = validReviewEffectiveAt(legacy.effectiveAt, 0);
    byRevision.set(legacy.revision ?? 1, {
      ...legacy,
      revision: legacy.revision ?? 1,
      effectiveAt,
      identityKeys: [...legacy.identityKeys],
      clearedIdentityKeys: legacy.clearedIdentityKeys ? [...legacy.clearedIdentityKeys] : undefined,
    });
  }
  return [...byRevision.values()]
    .sort((left, right) => left.revision - right.revision || left.effectiveAt - right.effectiveAt)
    .slice(-MAX_AGENT_REVIEW_REVISIONS);
}
