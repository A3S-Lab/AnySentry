import type {
  CollectorHeartbeatRecord,
  CollectorPipelineAccounting,
  CollectorPipelineAccountingHealth,
  CollectorPipelineBacklog,
  CollectorPipelineContinuity,
  CollectorPipelineRingAccounting,
  CollectorPipelineStageAccounting,
} from './types';

const SCHEMA_VERSION = 'anysentry.pipeline_accounting.v1' as const;
const MAX_RINGS = 32;
const MAX_STAGES = 32;
const MAX_REASONS = 32;
const MAX_NAME_LENGTH = 80;
const MAX_PRODUCER_ID_LENGTH = 240;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

/** Closed producer labels. Unknown bounded extensions remain readable but are not metric labels. */
export const PIPELINE_STAGE_REASONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  received: Object.freeze(['input']),
  parse_error: Object.freeze(['invalid_json']),
  classified: Object.freeze([
    'collector_heartbeat',
    'confirmed_agent',
    'probable_agent',
    'infrastructure',
    'non_agent',
    'unknown',
  ]),
  filtered: Object.freeze([
    'deduplicated',
    'non_agent',
    'routine_noise',
    'unknown',
    'discovery_budget',
    'e2e_scope',
  ]),
  aggregated: Object.freeze(['file_access_coalesced']),
  queue_admitted: Object.freeze(['event', 'collector_heartbeat']),
  queue_dropped: Object.freeze([
    'serialization_error',
    'event_too_large',
    'outstanding_limit',
    'priority_evicted',
    'queue_rejected',
    'retry_exhausted',
    'shutdown',
  ]),
  api_retained: Object.freeze(['ack']),
  api_discarded: Object.freeze(['ack', 'structural_consumed']),
  api_rejected: Object.freeze([
    'ack',
    'invalid_ack',
    'http_rejected',
    'payload_too_large',
    'shutdown',
    'retry_deadline',
  ]),
  api_retryable: Object.freeze(['ack', 'transport_error', 'http_retryable']),
});

const BACKLOG_FIELDS = [
  'queueEvents',
  'queueBytes',
  'inflightEvents',
  'inflightBytes',
  'retryEvents',
  'retryBytes',
  'outstandingEvents',
  'outstandingBytes',
] as const;

const RING_COUNTER_FIELDS = [
  'ringSubmitted',
  'ringDropped',
  'collectorReceived',
  'logicalEvents',
  'queueAdmitted',
  'queueDropped',
] as const;
const OPTIONAL_RING_HANDOFF_FIELDS = ['collectorEnqueued', 'collectorDropped'] as const;

type Obj = Record<string, unknown>;

function object(value: unknown): Obj | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Obj
    : undefined;
}

function boundedText(value: unknown, maxLength = MAX_NAME_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength) return undefined;
  return text;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT
    ? value
    : undefined;
}

function unixMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Compatibility reader for the short-lived Unix-nanosecond draft used before the v1 contract. */
function legacyUnixNsToMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
    const converted = Math.trunc(value / 1_000_000);
    return Number.isSafeInteger(converted) ? converted : undefined;
  }
  if (typeof value !== 'string' || !/^\d{1,24}$/u.test(value)) return undefined;
  try {
    const converted = BigInt(value) / 1_000_000n;
    return converted <= BigInt(MAX_COUNT) ? Number(converted) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeWindow(value: unknown): CollectorPipelineAccounting['window'] | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const startedAtUnixMs = unixMs(raw.startedAtUnixMs) ?? legacyUnixNsToMs(raw.startedAtUnixNs);
  const endedAtUnixMs = unixMs(raw.endedAtUnixMs) ?? legacyUnixNsToMs(raw.endedAtUnixNs);
  if (startedAtUnixMs === undefined || endedAtUnixMs === undefined || endedAtUnixMs < startedAtUnixMs) {
    return undefined;
  }
  return { startedAtUnixMs, endedAtUnixMs };
}

function checkedAdd(left: number, right: number): number | undefined {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function normalizeRings(value: unknown): CollectorPipelineRingAccounting[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_RINGS) return undefined;
  const merged = new Map<string, CollectorPipelineRingAccounting>();
  for (const item of value) {
    const raw = object(item);
    const ring = boundedText(raw?.ring);
    if (!raw || !ring) return undefined;
    const normalized = {} as CollectorPipelineRingAccounting;
    normalized.ring = ring;
    for (const field of RING_COUNTER_FIELDS) {
      const value = count(raw[field]);
      if (value === undefined) return undefined;
      normalized[field] = value;
    }
    const collectorEnqueued = count(raw.collectorEnqueued);
    const collectorDropped = count(raw.collectorDropped);
    if ((collectorEnqueued === undefined) !== (collectorDropped === undefined)) return undefined;
    if (collectorEnqueued !== undefined && collectorDropped !== undefined) {
      normalized.collectorEnqueued = collectorEnqueued;
      normalized.collectorDropped = collectorDropped;
    }
    const previous = merged.get(ring);
    if (!previous) {
      merged.set(ring, normalized);
      continue;
    }
    for (const field of RING_COUNTER_FIELDS) {
      const total = checkedAdd(previous[field], normalized[field]);
      if (total === undefined) return undefined;
      previous[field] = total;
    }
    const previousHasHandoff = previous.collectorEnqueued !== undefined;
    const currentHasHandoff = normalized.collectorEnqueued !== undefined;
    if (previousHasHandoff !== currentHasHandoff) return undefined;
    if (previousHasHandoff && currentHasHandoff) {
      for (const field of OPTIONAL_RING_HANDOFF_FIELDS) {
        const total = checkedAdd(previous[field] ?? 0, normalized[field] ?? 0);
        if (total === undefined) return undefined;
        previous[field] = total;
      }
    }
  }
  return [...merged.values()];
}

function normalizeStages(value: unknown): CollectorPipelineStageAccounting[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_STAGES) return undefined;
  const merged = new Map<string, CollectorPipelineStageAccounting>();
  for (const item of value) {
    const raw = object(item);
    const stage = boundedText(raw?.stage);
    const stageCount = count(raw?.count);
    if (!raw || !stage || stageCount === undefined || !Array.isArray(raw.reasons) || raw.reasons.length > MAX_REASONS) {
      return undefined;
    }
    const reasons = new Map<string, number>();
    for (const item of raw.reasons) {
      const rawReason = object(item);
      const reason = boundedText(rawReason?.reason);
      const reasonCount = count(rawReason?.count);
      if (!rawReason || !reason || reasonCount === undefined) return undefined;
      const total = checkedAdd(reasons.get(reason) ?? 0, reasonCount);
      if (total === undefined) return undefined;
      reasons.set(reason, total);
    }
    const previous = merged.get(stage);
    if (!previous) {
      merged.set(stage, {
        stage,
        count: stageCount,
        reasons: [...reasons].map(([reason, value]) => ({ reason, count: value })),
      });
      continue;
    }
    const total = checkedAdd(previous.count, stageCount);
    if (total === undefined) return undefined;
    previous.count = total;
    const previousReasons = new Map(previous.reasons.map((reason) => [reason.reason, reason.count]));
    for (const [reason, value] of reasons) {
      const reasonTotal = checkedAdd(previousReasons.get(reason) ?? 0, value);
      if (reasonTotal === undefined) return undefined;
      previousReasons.set(reason, reasonTotal);
    }
    previous.reasons = [...previousReasons].map(([reason, value]) => ({ reason, count: value }));
  }
  return [...merged.values()];
}

function normalizeBacklog(value: unknown): CollectorPipelineBacklog | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  if (!raw) return undefined;
  const normalized = {} as CollectorPipelineBacklog;
  for (const field of BACKLOG_FIELDS) {
    const value = count(raw[field]);
    if (value === undefined) return undefined;
    normalized[field] = value;
  }
  return normalized;
}

/**
 * Fail-closed accounting decoder. The entire optional envelope is omitted when a required value is
 * malformed, so corrupt telemetry can never look like a conserved zero-loss window. Unknown
 * object fields are ignored; bounded future ring/stage names remain available for inspection.
 */
export function normalizePipelineAccounting(value: unknown): CollectorPipelineAccounting | undefined {
  const raw = object(value);
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION) return undefined;
  const producerInstanceId = boundedText(raw.producerInstanceId, MAX_PRODUCER_ID_LENGTH);
  const producer = raw.producer === undefined ? undefined : boundedText(raw.producer);
  const sequence = count(raw.sequence);
  const window = normalizeWindow(raw.window);
  const temporality = raw.temporality === 'delta' || raw.temporality === 'cumulative'
    ? raw.temporality
    : undefined;
  const rawUnit = object(raw.unit);
  const rings = normalizeRings(raw.rings);
  const stages = normalizeStages(raw.stages);
  const backlog = normalizeBacklog(raw.backlog);
  if (
    !producerInstanceId || sequence === undefined || !window || !temporality || !rawUnit ||
    rawUnit.queue !== 'logical_event' ||
    (raw.rings !== undefined && rings === undefined) ||
    (raw.stages !== undefined && stages === undefined) ||
    (raw.backlog !== undefined && backlog === undefined) ||
    (!rings && !stages) ||
    (rings && rawUnit.ring !== 'physical_record') ||
    (stages && rawUnit.input !== 'logical_event')
  ) return undefined;

  return {
    schemaVersion: SCHEMA_VERSION,
    ...(producer ? { producer } : {}),
    producerInstanceId,
    sequence,
    window,
    temporality,
    unit: {
      ...(rings ? { ring: 'physical_record' as const } : {}),
      ...(stages ? { input: 'logical_event' as const } : {}),
      queue: 'logical_event',
    },
    ...(rings ? { rings } : {}),
    ...(stages ? { stages } : {}),
    ...(backlog ? { backlog } : {}),
  };
}

export function isKnownPipelineStageReason(stage: string, reason: string): boolean {
  return PIPELINE_STAGE_REASONS[stage]?.includes(reason) === true;
}

export interface PipelineDeltaResult {
  continuity: CollectorPipelineContinuity;
  accepted: boolean;
  complete: boolean;
  delta?: CollectorPipelineAccounting;
  next: CollectorPipelineAccounting;
}

function subtractAccounting(
  current: CollectorPipelineAccounting,
  previous: CollectorPipelineAccounting,
): CollectorPipelineAccounting | undefined {
  const previousRings = new Map((previous.rings ?? []).map((ring) => [ring.ring, ring]));
  const rings: CollectorPipelineRingAccounting[] = [];
  if ((current.rings?.length ?? 0) !== previousRings.size) return undefined;
  for (const ring of current.rings ?? []) {
    const before = previousRings.get(ring.ring);
    if (!before) return undefined;
    const delta = { ring: ring.ring } as CollectorPipelineRingAccounting;
    for (const field of RING_COUNTER_FIELDS) {
      if (ring[field] < before[field]) return undefined;
      delta[field] = ring[field] - before[field];
    }
    const beforeHasHandoff = before.collectorEnqueued !== undefined;
    const currentHasHandoff = ring.collectorEnqueued !== undefined;
    if (beforeHasHandoff !== currentHasHandoff) return undefined;
    if (currentHasHandoff) {
      for (const field of OPTIONAL_RING_HANDOFF_FIELDS) {
        const currentValue = ring[field];
        const previousValue = before[field];
        if (currentValue === undefined || previousValue === undefined || currentValue < previousValue) {
          return undefined;
        }
        delta[field] = currentValue - previousValue;
      }
    }
    rings.push(delta);
  }

  const previousStages = new Map((previous.stages ?? []).map((stage) => [stage.stage, stage]));
  const stages: CollectorPipelineStageAccounting[] = [];
  if ((current.stages?.length ?? 0) !== previousStages.size) return undefined;
  for (const stage of current.stages ?? []) {
    const before = previousStages.get(stage.stage);
    if (!before || stage.count < before.count) return undefined;
    const previousReasons = new Map(before.reasons.map((reason) => [reason.reason, reason.count]));
    if (stage.reasons.length !== previousReasons.size) return undefined;
    const reasons = stage.reasons.map((reason) => {
      const previousCount = previousReasons.get(reason.reason);
      if (previousCount === undefined || reason.count < previousCount) return undefined;
      return { reason: reason.reason, count: reason.count - previousCount };
    });
    if (reasons.some((reason) => reason === undefined)) return undefined;
    stages.push({
      stage: stage.stage,
      count: stage.count - before.count,
      reasons: reasons as Array<{ reason: string; count: number }>,
    });
  }
  return {
    ...current,
    temporality: 'delta',
    ...(current.rings ? { rings } : {}),
    ...(current.stages ? { stages } : {}),
  };
}

/**
 * Turns one producer's next snapshot into an at-most-once delta. Delta windows remain usable after
 * a restart or sequence gap; cumulative windows establish a baseline before subtraction.
 */
export function derivePipelineAccountingDelta(
  previous: CollectorPipelineAccounting | undefined,
  current: CollectorPipelineAccounting,
): PipelineDeltaResult {
  if (!previous) {
    return current.temporality === 'delta'
      ? { continuity: 'initial', accepted: true, complete: true, delta: current, next: current }
      : { continuity: 'initial', accepted: false, complete: false, next: current };
  }
  if (previous.producerInstanceId !== current.producerInstanceId) {
    return current.temporality === 'delta'
      ? { continuity: 'restart', accepted: true, complete: true, delta: current, next: current }
      : { continuity: 'restart', accepted: false, complete: false, next: current };
  }
  if (current.sequence === previous.sequence) {
    return { continuity: 'duplicate', accepted: false, complete: true, next: previous };
  }
  if (current.sequence < previous.sequence) {
    return { continuity: 'out_of_order', accepted: false, complete: false, next: previous };
  }
  if (current.temporality !== previous.temporality) {
    return { continuity: 'temporality_change', accepted: false, complete: false, next: current };
  }
  const continuity: CollectorPipelineContinuity = current.sequence === previous.sequence + 1
    ? 'continuous'
    : 'sequence_gap';
  if (current.temporality === 'delta') {
    return {
      continuity,
      accepted: true,
      complete: continuity === 'continuous',
      delta: current,
      next: current,
    };
  }
  const delta = subtractAccounting(current, previous);
  if (!delta) {
    return { continuity: 'counter_reset', accepted: false, complete: false, next: current };
  }
  return {
    continuity,
    accepted: true,
    complete: continuity === 'continuous',
    delta,
    next: current,
  };
}

export interface AsyncBacklogConservationInput {
  opening: number;
  admitted: number;
  completed: number;
  dropped: number;
  closing: number;
}

export interface AsyncBacklogConservation {
  expectedClosing: number;
  residual: number;
  conserved: boolean;
}

/** `opening + admitted = completed + dropped + closing`; never compare async windows directly. */
export function computeAsyncBacklogConservation(
  input: AsyncBacklogConservationInput,
): AsyncBacklogConservation {
  const values = [input.opening, input.admitted, input.completed, input.dropped, input.closing];
  if (values.some((value) => count(value) === undefined)) {
    return { expectedClosing: Number.NaN, residual: Number.NaN, conserved: false };
  }
  const expectedClosing = input.opening + input.admitted - input.completed - input.dropped;
  const residual = input.closing - expectedClosing;
  return {
    expectedClosing,
    residual,
    conserved: Number.isSafeInteger(expectedClosing) && expectedClosing >= 0 && residual === 0,
  };
}

interface HeartbeatWithPipeline {
  at: number;
  pipelineAccounting?: CollectorPipelineAccounting;
}

/** Builds a bounded, producer-aware health ledger without treating backlog gauges as counters. */
export function summarizePipelineAccounting(
  heartbeats: readonly HeartbeatWithPipeline[],
): CollectorPipelineAccountingHealth | undefined {
  const records = heartbeats
    .map((heartbeat, index) => ({
      at: heartbeat.at,
      index,
      accounting: normalizePipelineAccounting(heartbeat.pipelineAccounting),
    }))
    .filter((item): item is { at: number; index: number; accounting: CollectorPipelineAccounting } => Boolean(item.accounting))
    .sort((left, right) => left.at - right.at || left.index - right.index);
  if (!records.length) return undefined;

  const heads = new Map<string, CollectorPipelineAccounting>();
  const activeInstanceByProducer = new Map<string, string>();
  let latest = records[0];
  let latestContinuity: CollectorPipelineContinuity = 'initial';
  let acceptedWindowCount = 0;
  let restartCount = 0;
  let sequenceGapCount = 0;
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let counterResetCount = 0;
  let ringSubmitted = 0;
  let ringDropped = 0;
  let collectorReceived = 0;
  let collectorReceivedWithHandoff = 0;
  let collectorEnqueued = 0;
  let collectorDropped = 0;
  let collectorHandoffReported = false;
  let logicalEvents = 0;
  let queueAdmitted = 0;
  let queueDropped = 0;
  let stageCountResidual = 0;
  let exact = true;

  const safeAccumulate = (current: number, value: number): number => {
    const total = current + value;
    if (!Number.isSafeInteger(total)) {
      exact = false;
      return MAX_COUNT;
    }
    return total;
  };

  for (const record of records) {
    const previous = heads.get(record.accounting.producerInstanceId);
    const result = derivePipelineAccountingDelta(previous, record.accounting);
    let continuity = result.continuity;
    const producer = record.accounting.producer ??
      (record.accounting.rings && !record.accounting.stages
        ? 'observer'
        : record.accounting.stages && !record.accounting.rings
          ? 'forwarder'
          : 'unspecified');
    const activeInstance = activeInstanceByProducer.get(producer);
    if (!previous && activeInstance && activeInstance !== record.accounting.producerInstanceId) {
      continuity = 'restart';
      restartCount += 1;
    }
    if (!activeInstance || !previous) {
      activeInstanceByProducer.set(producer, record.accounting.producerInstanceId);
    }
    if (continuity === 'sequence_gap') {
      sequenceGapCount += 1;
      exact = false;
    } else if (continuity === 'duplicate') {
      duplicateCount += 1;
    } else if (continuity === 'out_of_order') {
      outOfOrderCount += 1;
      exact = false;
    } else if (continuity === 'counter_reset' || continuity === 'temporality_change') {
      counterResetCount += 1;
      exact = false;
    }
    if (!result.complete && continuity !== 'duplicate') exact = false;
    heads.set(record.accounting.producerInstanceId, result.next);
    if (record.at > latest.at || (record.at === latest.at && record.index >= latest.index)) {
      latest = record;
      latestContinuity = continuity;
    }
    if (!result.accepted || !result.delta) continue;
    acceptedWindowCount += 1;
    for (const ring of result.delta.rings ?? []) {
      ringSubmitted = safeAccumulate(ringSubmitted, ring.ringSubmitted);
      ringDropped = safeAccumulate(ringDropped, ring.ringDropped);
      collectorReceived = safeAccumulate(collectorReceived, ring.collectorReceived);
      if (ring.collectorEnqueued !== undefined && ring.collectorDropped !== undefined) {
        collectorHandoffReported = true;
        collectorReceivedWithHandoff = safeAccumulate(
          collectorReceivedWithHandoff,
          ring.collectorReceived,
        );
        collectorEnqueued = safeAccumulate(collectorEnqueued, ring.collectorEnqueued);
        collectorDropped = safeAccumulate(collectorDropped, ring.collectorDropped);
      }
      logicalEvents = safeAccumulate(logicalEvents, ring.logicalEvents);
      queueAdmitted = safeAccumulate(queueAdmitted, ring.queueAdmitted);
      queueDropped = safeAccumulate(queueDropped, ring.queueDropped);
    }
    for (const stage of result.delta.stages ?? []) {
      const reasonTotal = stage.reasons.reduce((sum, reason) => safeAccumulate(sum, reason.count), 0);
      stageCountResidual += stage.count - reasonTotal;
    }
  }

  const physicalBacklogDelta = ringSubmitted - collectorReceived;
  // During a rolling upgrade, legacy windows/rings do not report the S4 handoff pair. Compare
  // only the received records covered by that pair, otherwise a healthy mixed-version window
  // would look lossy.
  const collectorHandoffResidual = collectorReceivedWithHandoff - collectorEnqueued - collectorDropped;
  const logicalResidual = logicalEvents - queueAdmitted - queueDropped;
  if (
    logicalResidual !== 0
    || stageCountResidual !== 0
    || (collectorHandoffReported && collectorHandoffResidual !== 0)
  ) exact = false;
  return {
    reported: true,
    lastReportedAt: new Date(latest.at).toISOString(),
    latest: {
      producerInstanceId: latest.accounting.producerInstanceId,
      sequence: latest.accounting.sequence,
      temporality: latest.accounting.temporality,
      continuity: latestContinuity,
      ...(latest.accounting.backlog ? { backlog: latest.accounting.backlog } : {}),
    },
    window: {
      heartbeatCount: records.length,
      acceptedWindowCount,
      producerCount: heads.size,
      restartCount,
      sequenceGapCount,
      duplicateCount,
      outOfOrderCount,
      counterResetCount,
      ringSubmitted,
      ringDropped,
      collectorReceived,
      ...(collectorHandoffReported
        ? { collectorEnqueued, collectorDropped, collectorHandoffResidual }
        : {}),
      logicalEvents,
      queueAdmitted,
      queueDropped,
      physicalBacklogDelta,
      logicalResidual,
      stageCountResidual,
      exact,
    },
  };
}

function cumulativeDelta(current: number, previous: number | undefined): number {
  if (previous === undefined || current < previous) return current;
  return current - previous;
}

/**
 * Legacy operational fields keep their public names. Their arithmetic is source-aware: the Rust
 * heartbeat counters are cumulative, while the Forwarder resets output/error counters per window.
 */
export function collectorHeartbeatFailureDelta(
  heartbeat: Pick<CollectorHeartbeatRecord, 'origin' | 'droppedEvents' | 'outputDropped' | 'errorCount' | 'legacyCounterTemporality'>,
  previous?: Pick<CollectorHeartbeatRecord, 'droppedEvents' | 'outputDropped' | 'errorCount'>,
): { droppedDelta: number; errorDelta: number } {
  const temporality = heartbeat.legacyCounterTemporality ??
    (heartbeat.origin === 'raw_collector' ? 'cumulative' : 'delta');
  if (temporality === 'cumulative') {
    return {
      droppedDelta:
        cumulativeDelta(heartbeat.droppedEvents, previous?.droppedEvents) +
        cumulativeDelta(heartbeat.outputDropped, previous?.outputDropped),
      errorDelta: cumulativeDelta(heartbeat.errorCount, previous?.errorCount),
    };
  }
  return {
    droppedDelta: heartbeat.droppedEvents + heartbeat.outputDropped,
    errorDelta: heartbeat.errorCount,
  };
}
