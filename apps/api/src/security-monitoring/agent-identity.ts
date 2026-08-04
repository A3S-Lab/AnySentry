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
    event.attribution?.agentScopeId ?? event.attribution?.agentDisplayName ?? 'agent',
    event.workspacePath,
  ].join(':');
}

function workloadIdentityKey(event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'process' | 'attribution'>): string {
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

export function agentAssetIdForEvent(
  event: Pick<JudgedEvent, 'agentId' | 'workspacePath' | 'process' | 'attribution'>,
): string {
  return agentAssetIdForIdentityKey(workloadIdentityKey(event));
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
