/**
 * Read-path Run projection: copy a captured inbound run/invocation onto same-runtime
 * child hops as producerRunId. Does not invent IDs that were never observed.
 */

import type { AgentInteractionRecord } from './types';

const CLOCK_SKEW_MS = 2_000;
const DONOR_WINDOW_MS = 30 * 60_000;

function text(value: unknown, limit = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= limit ? trimmed : undefined;
}

export function observedRunId(record: AgentInteractionRecord): string | undefined {
  return text(record.invocationId) ?? text(record.runId) ?? text(record.producerRunId);
}

function sameRuntime(left: AgentInteractionRecord, right: AgentInteractionRecord): boolean {
  const leftRuntime = left.runtimeInstanceId
    ?? left.canonicalAgentInstanceId
    ?? left.agentInstanceId;
  const rightRuntime = right.runtimeInstanceId
    ?? right.canonicalAgentInstanceId
    ?? right.agentInstanceId;
  return Boolean(leftRuntime && rightRuntime && leftRuntime === rightRuntime);
}

function hopCompatible(donor: AgentInteractionRecord, child: AgentInteractionRecord): boolean {
  const donorHop = text(donor.hop, 120);
  const childHop = text(child.hop, 120);
  if (!donorHop || !childHop || donorHop === childHop) return true;
  const donorDelegation = text(donor.delegationId);
  const childDelegation = text(child.delegationId);
  return Boolean(donorDelegation && donorDelegation === childDelegation);
}

/**
 * Interactions that already carry a run stay unchanged. Children without a run receive
 * `producerRunId` from the unique nearest same-runtime donor. Ambiguous equal-distance
 * donors with different runs are left unresolved.
 */
export function bindInferredProducerRun(
  records: readonly AgentInteractionRecord[],
): AgentInteractionRecord[] {
  const donors = records.filter((record) => observedRunId(record));
  if (donors.length === 0) return [...records];
  return records.map((record) => {
    if (observedRunId(record)) return record;
    const peers = donors
      .filter((donor) => donor.interactionId !== record.interactionId)
      .filter((donor) => sameRuntime(donor, record) && hopCompatible(donor, record))
      .map((donor) => ({ donor, distance: record.at - donor.at }))
      .filter((entry) => entry.distance >= -CLOCK_SKEW_MS && entry.distance <= DONOR_WINDOW_MS)
      .sort((left, right) =>
        Math.abs(left.distance) - Math.abs(right.distance)
        || left.donor.interactionId.localeCompare(right.donor.interactionId));
    if (peers.length === 0) return record;
    const winner = observedRunId(peers[0]!.donor);
    if (!winner) return record;
    if (
      peers.length > 1
      && Math.abs(peers[0]!.distance) === Math.abs(peers[1]!.distance)
      && observedRunId(peers[1]!.donor) !== winner
    ) {
      return record;
    }
    return { ...record, producerRunId: winner };
  });
}
