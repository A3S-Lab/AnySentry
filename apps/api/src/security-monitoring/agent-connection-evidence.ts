/**
 * P1 ConnectionIdentity join: LlmCall ↔ Egress/TLS ClientHello via shared socket bind.
 * Product-neutral — uses only process generation + socket cookie/fd(+generation).
 */

import {
  createEvidenceLink,
  deriveConnectionIdentity,
  type ConnectionIdentity,
  type EvidenceLink,
} from './canonical-observability';
import type { AgentInteractionRecord, JudgedEvent } from './types';

export const AGENT_CONNECTION_EVIDENCE_VERSION = 1;

export type NetworkConnectionFact = {
  eventId: string;
  kernelFactId?: string;
  eventKind: 'Egress' | 'Dns' | 'Tls';
  pid?: number;
  processGenerationKey?: string;
  fd?: number;
  socketCookie?: string;
  fdGeneration?: string;
  sni?: string;
  peer?: string;
  port?: number;
  atUnixNs?: string;
};

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 4_194_304 ? n : undefined;
}

/** Prefer Observer-exported ConnectionIdentity; else derive from interaction bind fields. */
export function connectionIdentityFromInteraction(
  interaction: AgentInteractionRecord,
): ConnectionIdentity | undefined {
  if (interaction.connectionIdentity) {
    return interaction.connectionIdentity;
  }
  const processGenerationKey = text(interaction.process?.processGenerationKey, 128)
    ?? text((interaction as { processGenerationKey?: string }).processGenerationKey, 128);
  if (!processGenerationKey) return undefined;
  return deriveConnectionIdentity({
    processGenerationKey,
    socketCookie: interaction.socketCookie,
    fd: interaction.socketFd !== undefined && interaction.socketFd > 0
      ? interaction.socketFd
      : undefined,
    fdGeneration: interaction.fdGeneration,
    tlsContextId: interaction.connectionId
      ? `tlsctx_${interaction.connectionId.replace(/^tls:/u, '')}`
      : undefined,
    transport: interaction.transport === 'tls' ? 'tls'
      : interaction.transportProtocol?.includes('websocket') ? 'websocket'
        : interaction.transport === 'http' ? 'http' : 'unknown',
    sourceRefs: [
      interaction.interactionId,
      ...(interaction.rawObservationId ? [interaction.rawObservationId] : []),
    ],
  });
}

export function networkFactFromSecurityEvent(event: JudgedEvent): NetworkConnectionFact | undefined {
  if (!['Egress', 'Dns', 'Tls'].includes(event.eventKind)) return undefined;
  const attrs = (event.attributes ?? {}) as Record<string, unknown>;
  const fd = positiveInt(attrs.fd ?? attrs.socketFd ?? attrs.socket_fd);
  const socketCookie = text(attrs.socketCookie ?? attrs.socket_cookie, 240);
  const fdGeneration = text(
    attrs.fdGeneration ?? attrs.fd_generation,
    240,
  );
  const processGenerationKey = text(
    attrs.processGenerationKey
      ?? attrs.process_generation_key
      ?? event.process?.processGenerationKey,
    128,
  );
  const pid = positiveInt(event.process?.pid) ?? positiveInt(attrs.pid);
  const atUnixNs = text(event.eventAtUnixNs ?? attrs.atUnixNs, 32);
  return {
    eventId: event.eventId,
    ...(text(event.kernelFactId, 240) ? { kernelFactId: text(event.kernelFactId, 240) } : {}),
    eventKind: event.eventKind as NetworkConnectionFact['eventKind'],
    ...(pid !== undefined ? { pid } : {}),
    ...(processGenerationKey ? { processGenerationKey } : {}),
    ...(fd !== undefined ? { fd } : {}),
    ...(socketCookie ? { socketCookie } : {}),
    ...(fdGeneration ? { fdGeneration } : {}),
    ...(text(attrs.sni, 500) ? { sni: text(attrs.sni, 500) } : {}),
    ...(text(attrs.peer, 500) ? { peer: text(attrs.peer, 500) } : {}),
    ...(positiveInt(attrs.port) !== undefined ? { port: positiveInt(attrs.port) } : {}),
    ...(atUnixNs ? { atUnixNs } : {}),
  };
}

function sameProcessGeneration(
  left?: string,
  right?: string,
): boolean {
  return Boolean(left && right && left === right);
}

function bindMatch(
  identity: ConnectionIdentity,
  fact: NetworkConnectionFact,
): { method: 'connection_stream'; confidence: number; status: EvidenceLink['status'] } | undefined {
  if (identity.socketCookie && fact.socketCookie && identity.socketCookie === fact.socketCookie) {
    if (sameProcessGeneration(identity.processGenerationKey, fact.processGenerationKey)
      || (!fact.processGenerationKey && fact.pid === undefined)) {
      return { method: 'connection_stream', confidence: 0.99, status: 'confirmed' };
    }
    return { method: 'connection_stream', confidence: 0.98, status: 'strong' };
  }
  if (
    identity.fd !== undefined
    && fact.fd !== undefined
    && identity.fd === fact.fd
  ) {
    const generationAligned = !identity.fdGeneration
      || !fact.fdGeneration
      || identity.fdGeneration === fact.fdGeneration;
    if (!generationAligned) return undefined;
    if (sameProcessGeneration(identity.processGenerationKey, fact.processGenerationKey)) {
      return {
        method: 'connection_stream',
        confidence: identity.quality === 'exact' ? 0.98 : 0.95,
        status: 'strong',
      };
    }
    // Same fd without process generation is only a weak temporal/runtime hint — callers may
    // still accept it as inferred when they already scoped candidates to one runtime.
    return { method: 'connection_stream', confidence: 0.75, status: 'inferred' };
  }
  return undefined;
}

/**
 * Build `emitted_by` EvidenceLinks from an interaction's ConnectionIdentity to matching
 * Egress/Tls network facts. Does not pick a single owner when multiple candidates match —
 * each match becomes its own link (ambiguous status when >1 exact/strong).
 */
export function linkLlmCallToNetworkFacts(input: {
  interaction: AgentInteractionRecord;
  facts: NetworkConnectionFact[];
  llmCallId?: string;
}): EvidenceLink[] {
  const identity = connectionIdentityFromInteraction(input.interaction);
  if (!identity) return [];
  const fromId = text(input.llmCallId, 512)
    ?? text(input.interaction.modelCallId, 512)
    ?? input.interaction.interactionId;
  const validFrom = input.interaction.startedAtUnixNs || '1000000000';
  const matches: Array<{ fact: NetworkConnectionFact; confidence: number; status: EvidenceLink['status'] }> = [];
  for (const fact of input.facts) {
    const hit = bindMatch(identity, fact);
    if (!hit) continue;
    matches.push({ fact, confidence: hit.confidence, status: hit.status });
  }
  if (matches.length === 0) return [];
  const strongCount = matches.filter((m) => m.status === 'confirmed' || m.status === 'strong').length;
  return matches.map(({ fact, confidence, status }) => createEvidenceLink({
    fromType: 'llm_call',
    fromId,
    toType: 'kernel_fact',
    toId: fact.kernelFactId ?? fact.eventId,
    relation: 'emitted_by',
    method: 'connection_stream',
    confidence,
    authority: 'attested_observer',
    evidenceRefs: [
      input.interaction.interactionId,
      identity.connectionId,
      fact.eventId,
      ...(input.interaction.rawObservationId ? [input.interaction.rawObservationId] : []),
    ],
    algorithmVersion: `agent-connection-evidence.v${AGENT_CONNECTION_EVIDENCE_VERSION}`,
    status: strongCount > 1 && (status === 'confirmed' || status === 'strong')
      ? 'ambiguous'
      : status,
    validFromUnixNs: validFrom,
    resolutionRevision: 1,
  }));
}

/** SNI/peer fallback for `endpoint=unknown` when a strong emitted_by neighbor carries SNI. */
export function endpointFromNetworkFacts(
  links: EvidenceLink[],
  facts: NetworkConnectionFact[],
): string | undefined {
  const byId = new Map(facts.map((fact) => [fact.kernelFactId ?? fact.eventId, fact]));
  for (const link of links) {
    if (link.relation !== 'emitted_by' || link.status === 'unmatched' || link.status === 'coverage_gap') {
      continue;
    }
    if (link.confidence < 0.75) continue;
    const fact = byId.get(link.toId);
    const sni = text(fact?.sni, 500);
    if (sni) return sni;
  }
  return undefined;
}
