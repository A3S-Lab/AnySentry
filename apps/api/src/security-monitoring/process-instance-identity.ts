import { createHash } from 'node:crypto';

export interface CanonicalProcessInstanceInput {
  trustedSourceId: string;
  bootId?: string;
  hostId?: string;
  collectorNode?: unknown;
  cgroup?: string;
  cgroupId?: string;
  pid?: number;
  startTimeTicks?: string;
  startTimeNs?: string;
  startTimeSource?: string;
}
function text(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

export function canonicalContainerId(cgroup?: string): string | undefined {
  if (!cgroup) return undefined;
  return cgroup.match(/(?:docker[-/]|cri-containerd[-/])([a-f0-9]{12,64})/i)?.[1]
    ?? cgroup.match(/([a-f0-9]{64})(?:\.scope)?$/i)?.[1];
}

/**
 * The one ProcessInstance identifier shared by the canonical stream and trusted-correlation view.
 * Explicit kernel boottime events prefer ns; legacy events retain the original v1 precedence.
 */
export function canonicalProcessInstanceId(input: CanonicalProcessInstanceInput): string {
  const preferNs = input.startTimeSource === 'kernel_start_boottime';
  const stableStartTime = preferNs
    ? input.startTimeNs ?? input.startTimeTicks
    : input.startTimeTicks ?? input.startTimeNs;
  const stableStartTimeKind = preferNs
    ? input.startTimeNs ? 'ns' : input.startTimeTicks ? 'ticks' : undefined
    : input.startTimeTicks ? 'ticks' : input.startTimeNs ? 'ns' : undefined;
  const parts: Array<string | number | undefined> = [
    input.trustedSourceId,
    input.bootId,
    input.hostId ?? text(input.collectorNode),
    canonicalContainerId(input.cgroup),
    input.cgroupId,
    input.pid,
    stableStartTimeKind,
    stableStartTime,
  ];
  return `pri_${createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\0'))
    .digest('hex')
    .slice(0, 24)}`;
}
