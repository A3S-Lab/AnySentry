import {
  CollectorCaptureProbeMetrics,
  CollectorCaptureProbeName,
  CollectorCaptureProfileMetrics,
  CollectorCaptureProfileMode,
} from './types';

export const COLLECTOR_CAPTURE_PROBES: readonly CollectorCaptureProbeName[] = [
  'exec', 'exit', 'tls', 'connect', 'dns', 'file_access', 'file_delete', 'llm', 'ssl', 'security', 'file_read',
];

const MODES = new Set<CollectorCaptureProfileMode>(['legacy', 'shadow', 'enforce']);
const COUNTER_FIELDS = [
  'attempted',
  'fullSelected',
  'aggregateSelected',
  'sampleSelected',
  'sampleRejected',
  'dropSelected',
  'notEnabled',
  'decisionError',
  'probeError',
  'payloadSelected',
  'payloadError',
  'ringSubmitted',
  'ringDropped',
  'wouldFull',
  'wouldAggregate',
  'wouldSample',
  'wouldDrop',
  'ruleHit',
  'ruleMiss',
  'staleRule',
  'promotionHit',
  'promotionError',
  'aggregateError',
] as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function counter(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

function signedBigInt(value: bigint): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit) return Number.MAX_SAFE_INTEGER;
  if (value < -limit) return -Number.MAX_SAFE_INTEGER;
  return Number(value);
}

function parseProbe(value: unknown): CollectorCaptureProbeMetrics | undefined {
  const input = object(value);
  const probe = input?.probe;
  if (!input || typeof probe !== 'string' || !COLLECTOR_CAPTURE_PROBES.includes(probe as CollectorCaptureProbeName)) {
    return undefined;
  }
  const counts = {} as Record<(typeof COUNTER_FIELDS)[number], number>;
  let countersClamped = false;
  for (const field of COUNTER_FIELDS) {
    const raw = field === 'notEnabled' && input[field] === undefined ? 0 : input[field];
    const parsed = counter(raw);
    if (parsed === undefined) return undefined;
    if (raw !== parsed) countersClamped = true;
    counts[field] = parsed;
  }
  const terminal = BigInt(counts.fullSelected)
    + BigInt(counts.aggregateSelected)
    + BigInt(counts.sampleSelected)
    + BigInt(counts.sampleRejected)
    + BigInt(counts.dropSelected)
    + BigInt(counts.notEnabled)
    + BigInt(counts.decisionError);
  const decisionResidualBig = BigInt(counts.attempted) - terminal;
  const payloadResidualBig = BigInt(counts.payloadSelected)
    - BigInt(counts.payloadError)
    - BigInt(counts.ringSubmitted)
    - BigInt(counts.ringDropped);
  return {
    probe: probe as CollectorCaptureProbeName,
    ...counts,
    countersClamped,
    decisionResidual: signedBigInt(decisionResidualBig),
    decisionConserved: !countersClamped && decisionResidualBig === 0n,
    ...(probe === 'exec' ? {} : {
      payloadResidual: signedBigInt(payloadResidualBig),
      payloadConserved: !countersClamped && payloadResidualBig === 0n,
    }),
  };
}

/**
 * Fail-closed parser for the raw Collector's S5 accounting envelope.
 *
 * The legacy ten and current eleven probe labels and all units are closed sets. Counters are bounded numbers, while
 * conservation is calculated with BigInt after bounding so summation cannot introduce another
 * precision error. The Forwarder channel never calls this parser as an authority decision.
 */
export function parseCollectorCaptureProfileMetrics(value: unknown): CollectorCaptureProfileMetrics | undefined {
  const input = object(value);
  if (!input || !MODES.has(input.mode as CollectorCaptureProfileMode)) return undefined;
  if (
    input.decisionUnit !== 'decision_op'
    || input.payloadUnit !== 'single_record_candidate'
    || input.deliveryUnit !== 'physical_record'
    || typeof input.destructiveEnabled !== 'boolean'
    || typeof input.aggregateLedgerDegraded !== 'boolean'
  ) return undefined;

  const scalarFields = [
    'activeEpoch',
    'sampleNodeLimitPerWindow',
    'aggregateKeys',
    'aggregateEmitted',
    'aggregateOutputRetried',
    'aggregateCleaned',
    'aggregateReadErrors',
  ] as const;
  const scalars = {} as Record<(typeof scalarFields)[number], number>;
  let scalarClamped = false;
  for (const field of scalarFields) {
    const raw = input[field];
    const parsed = counter(raw);
    if (parsed === undefined) return undefined;
    if (raw !== parsed) scalarClamped = true;
    scalars[field] = parsed;
  }

  if (
    !Array.isArray(input.probes)
    || ![COLLECTOR_CAPTURE_PROBES.length - 1, COLLECTOR_CAPTURE_PROBES.length].includes(input.probes.length)
  ) {
    return undefined;
  }
  const byProbe = new Map<CollectorCaptureProbeName, CollectorCaptureProbeMetrics>();
  for (const rawProbe of input.probes) {
    const parsed = parseProbe(rawProbe);
    if (!parsed || byProbe.has(parsed.probe)) return undefined;
    byProbe.set(parsed.probe, parsed);
  }
  if (!byProbe.has('file_read') && input.probes.length === COLLECTOR_CAPTURE_PROBES.length - 1) {
    byProbe.set('file_read', {
      probe: 'file_read',
      attempted: 0,
      fullSelected: 0,
      aggregateSelected: 0,
      sampleSelected: 0,
      sampleRejected: 0,
      dropSelected: 0,
      notEnabled: 0,
      decisionError: 0,
      probeError: 0,
      promotionError: 0,
      aggregateError: 0,
      countersClamped: false,
      payloadSelected: 0,
      payloadError: 0,
      ringSubmitted: 0,
      ringDropped: 0,
      wouldFull: 0,
      wouldAggregate: 0,
      wouldSample: 0,
      wouldDrop: 0,
      ruleHit: 0,
      ruleMiss: 0,
      staleRule: 0,
      promotionHit: 0,
      decisionResidual: 0,
      decisionConserved: true,
      payloadResidual: 0,
      payloadConserved: true,
    });
  }
  if (COLLECTOR_CAPTURE_PROBES.some((probe) => !byProbe.has(probe))) return undefined;
  const probes = COLLECTOR_CAPTURE_PROBES.map((probe) => byProbe.get(probe) as CollectorCaptureProbeMetrics);
  const aggregateLedgerDegraded = input.aggregateLedgerDegraded
    || scalars.aggregateReadErrors > 0
    || probes.some((probe) => probe.aggregateError > 0);
  const countersClamped = scalarClamped || probes.some((probe) => probe.countersClamped);
  return {
    mode: input.mode as CollectorCaptureProfileMode,
    ...scalars,
    destructiveEnabled: input.destructiveEnabled,
    decisionUnit: 'decision_op',
    payloadUnit: 'single_record_candidate',
    deliveryUnit: 'physical_record',
    aggregateLedgerDegraded,
    countersClamped,
    decisionConserved: !countersClamped && probes.every((probe) => probe.decisionConserved),
    payloadConserved: !countersClamped && probes.every((probe) => probe.probe === 'exec' || probe.payloadConserved === true),
    probes,
  };
}
