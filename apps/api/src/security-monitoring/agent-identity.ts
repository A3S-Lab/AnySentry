import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  AgentClassification,
  AgentWorkloadRef,
  JudgedEvent,
} from './types';

export type AgentRuntime = 'kubernetes' | 'docker' | 'host' | 'unknown';

export interface DetectedAgentIdentity {
  agentAssetId: string;
  detectedClassification: AgentClassification;
  detectedName?: string;
  rawAgentId: string;
  runtime: AgentRuntime;
  locationLabel?: string;
}

function text(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function basename(value?: string): string | undefined {
  const normalized = text(value);
  return normalized ? path.posix.basename(normalized) : undefined;
}

function canonicalAgentName(value?: string): string | undefined {
  const normalized = text(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'a3s' || normalized === 'a3s-code' || normalized === 'a3s code') return 'a3s code';
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claude code') return 'claude code';
  return normalized;
}

export function isInternalAgentHelperRootEvent(
  event: Pick<JudgedEvent, 'process' | 'attribution' | 'attributes'>,
): boolean {
  const argv = String(event.attributes?.argv ?? '').toLowerCase();
  const tokens = argv.split(/\s+/u).filter(Boolean);
  return Boolean(
    event.process?.pid &&
    event.attribution?.rootPid === event.process.pid &&
    (
      tokens.includes('--codex-run-as-fs-helper') ||
      basename(tokens[0]) === 'codex-linux-sandbox' ||
      tokens.includes('--sandbox-policy-cwd')
    )
  );
}

export function hasDirectAgentRootEvidence(
  event: Pick<JudgedEvent, 'eventKind' | 'process' | 'attribution' | 'attributes'>,
): boolean {
  // A process signature is only a discovery hint. A short-lived `codex ...` command can be
  // observed after its parent has exited and must not become a standalone Agent asset until
  // process-graph or workload evidence confirms the runtime root.
  if (
    event.eventKind === 'ProcessExit' ||
    event.attribution?.source === 'process_signature' ||
    isInternalAgentHelperRootEvent(event)
  ) return false;
  const rootPid = event.attribution?.rootPid;
  if (!rootPid || event.process?.pid !== rootPid) return false;
  const scope = canonicalAgentName(
    event.attribution?.agentScopeId ??
    event.attribution?.agentDisplayName,
  );
  if (!scope) return false;
  const executableNames = new Set([
    canonicalAgentName(basename(event.process?.comm)),
    canonicalAgentName(basename(event.process?.exe)),
  ].filter((value): value is string => Boolean(value)));
  return executableNames.has(scope);
}

export function hasAgentRuntimeLineageEvidence(
  event: Pick<JudgedEvent, 'eventKind' | 'process' | 'attribution' | 'attributes'>,
): boolean {
  if (!event.attribution?.rootStartTime) return false;
  if (hasDirectAgentRootEvidence(event)) return true;
  return Boolean(
    event.attribution.rootPid &&
    event.process?.pid &&
    event.attribution.rootPid !== event.process.pid &&
    (
      event.attribution.source === 'process_graph' ||
      event.attribution.evidence?.some((item) =>
        item.startsWith('process_lineage:')
      )
    )
  );
}

function shortWorkspace(value?: string): string | undefined {
  const normalized = text(value)?.replace(/\/+$/u, '');
  if (!normalized || normalized === 'unknown') return undefined;
  const parts = normalized.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || normalized;
}

function runtimeFor(event: Pick<JudgedEvent, 'process' | 'attribution'>): AgentRuntime {
  const workload = event.attribution?.workloadRef;
  if (workload?.environment) return workload.environment;
  const physical = event.attribution?.physicalWorkloadId?.toLowerCase() ?? '';
  const cgroup = event.process?.cgroup?.toLowerCase() ?? '';
  if (physical.startsWith('k8s:') || cgroup.includes('kubepods')) return 'kubernetes';
  if (
    physical.startsWith('docker:') ||
    physical.startsWith('container:') ||
    /(?:docker|containerd|crio|libpod)/u.test(cgroup)
  ) {
    return 'docker';
  }
  if (
    event.process ||
    ['process_graph', 'cgroup', 'systemd', 'argv', 'env', 'workspace_hint', 'process_signature']
      .includes(event.attribution?.source ?? '')
  ) {
    return 'host';
  }
  return 'unknown';
}

function detectedNameFor(event: Pick<JudgedEvent, 'agentId' | 'attribution'>): string | undefined {
  const workload = event.attribution?.workloadRef;
  return (
    text(event.attribution?.agentDisplayName) ??
    text(workload?.podName) ??
    text(workload?.containerName) ??
    text(workload?.systemdUnit) ??
    text(workload?.name) ??
    text(workload?.processName) ??
    basename(workload?.executable) ??
    text(event.attribution?.agentScopeId) ??
    text(event.agentId)
  );
}

function localInstanceKey(event: Pick<JudgedEvent, 'workspacePath' | 'process' | 'attribution'>): string | undefined {
  const rootPid = event.attribution?.rootPid;
  if (!rootPid) return undefined;
  return [
    'host-root',
    event.process?.hostId ?? 'host',
    event.process?.bootId ?? 'boot',
    rootPid,
    event.attribution?.rootStartTime ?? 'start-unknown',
  ].join(':');
}

export function agentIdentityKeyForEvent(event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'process' | 'attribution'>): string {
  const attribution = event.attribution;
  const workload = attribution?.workloadRef;
  return (
    text(attribution?.physicalWorkloadId) ??
    text(attribution?.agentInstanceId) ??
    (
      workload?.podUid
        ? `k8s:${workload.podUid}:${workload.containerName ?? workload.name ?? 'container'}`
        : undefined
    ) ??
    localInstanceKey(event) ??
    [
      'logical',
      event.workspacePath,
      attribution?.agentScopeId ?? attribution?.agentDisplayName ?? event.agentId,
    ].join(':')
  );
}

/**
 * Stable identity for one concrete Agent runtime.
 *
 * Human/AI review is intentionally inherited through a logical Agent identity, but a review must
 * never collapse two terminal windows or two PID lifetimes into one runtime instance. For host
 * processes the observed root PID and start time therefore win over any review-carried
 * agentInstanceId. Container orchestrator identities remain authoritative when present.
 */
export function agentRuntimeInstanceIdForEvent(
  event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'sessionId' | 'process' | 'attribution'>,
): string {
  const attribution = event.attribution;
  const workload = attribution?.workloadRef;
  if (workload?.podUid) {
    return `k8s:${workload.podUid}:${workload.containerName ?? workload.name ?? 'container'}`;
  }

  const physical = text(attribution?.physicalWorkloadId);
  const attributedInstance = text(attribution?.agentInstanceId);
  const containerIdentity = [attributedInstance, physical].find((value) =>
    /^(?:container|docker|k8s):/u.test(value ?? ''),
  );
  if (containerIdentity) return containerIdentity;

  const rootPid = attribution?.rootPid;
  if (rootPid) {
    const rootStartTime =
      text(attribution?.rootStartTime) ??
      (
        event.process?.pid === rootPid
          ? text(event.process.startTimeNs) ?? text(event.process.startTimeTicks)
          : undefined
      );
    return [
      'host-root',
      event.process?.hostId ?? 'host',
      event.process?.bootId ?? 'boot',
      rootPid,
      rootStartTime ?? 'start-unknown',
    ].join(':');
  }

  if (attributedInstance) return attributedInstance;
  if (physical) return physical;
  if (event.process?.pid) {
    return [
      'host-process',
      event.process.hostId ?? 'host',
      event.process.bootId ?? 'boot',
      event.process.pid,
      event.process.startTimeNs ?? event.process.startTimeTicks ?? 'start-unknown',
    ].join(':');
  }
  return `session:${event.sessionId}:${event.agentId}`;
}

export function agentAssetIdForEvent(
  event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'process' | 'attribution'>,
): string {
  return agentAssetIdForIdentityKey(agentIdentityKeyForEvent(event));
}

export function agentAssetIdForIdentityKey(identityKey: string): string {
  const digest = createHash('sha256')
    .update(identityKey)
    .digest('hex')
    .slice(0, 24);
  return `agent_${digest}`;
}

export function locationLabelFor(
  workspacePath: string,
  runtime: AgentRuntime,
  workload?: AgentWorkloadRef,
  rootPid?: number,
  process?: JudgedEvent['process'],
): string | undefined {
  if (runtime === 'kubernetes') {
    const parts = [workload?.namespace, workload?.podName, workload?.containerName]
      .map(text)
      .filter((value): value is string => Boolean(value));
    if (parts.length > 0) return parts.join('/');
  }
  if (runtime === 'docker') {
    const parts = [
      text(workload?.containerName),
      shortWorkspace(workspacePath),
    ].filter((value): value is string => Boolean(value));
    if (parts.length > 0) return [...new Set(parts)].join(' · ');
  }
  const workspace = shortWorkspace(workspacePath);
  const processName =
    text(workload?.processName) ??
    basename(workload?.executable) ??
    text(process?.comm) ??
    basename(process?.exe);
  const parts = [
    workspace ?? processName,
    rootPid ? `PID ${rootPid}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function detectedAgentIdentity(
  event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'process' | 'attribution'>,
): DetectedAgentIdentity {
  const runtime = runtimeFor(event);
  return {
    agentAssetId: agentAssetIdForEvent(event),
    detectedClassification: event.attribution?.classification ?? 'unknown',
    detectedName: detectedNameFor(event),
    rawAgentId: event.agentId,
    runtime,
    locationLabel: locationLabelFor(
      event.workspacePath,
      runtime,
      event.attribution?.workloadRef,
      event.attribution?.rootPid,
      event.process,
    ),
  };
}

export function isAgentAssetClassification(classification: AgentClassification): boolean {
  return classification === 'confirmed_agent' || classification === 'probable_agent';
}
